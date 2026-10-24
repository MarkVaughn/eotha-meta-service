import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID, sign } from 'node:crypto';
import { addCrew, app, call, closeApp, credits, json, newPilot, receiptAtOrigin, rtseKey, setCredits, signedOffer } from './helpers.js';
import { canonicalClaimPayload } from '../src/lib/mission-claim.js';
import { canonicalSaleRecordPayload } from '../src/lib/cargo.js';
import { computeShipAttributes } from '../src/config/components.js';
import {
  CREW_CAPABILITY,
  CREW_TRAINING_FEE_CREDITS,
  CREW_TRAINING_XP_REQ,
  MORALE_DECAY_DEFERRED_PAY,
  MORALE_DECAY_UNUTILIZED,
  MORALE_GAIN_PAY_ARREARS,
  MORALE_GAIN_UTILIZED_PAID,
  UNUTILIZED_GRACE_MISSIONS,
  crewCapabilityFlags
} from '../src/config/crew.js';
import {
  SETTLEMENT,
  doctorCooldownReduction,
  moraleAfterCappedGain,
  moraleAfterLoss,
  moraleBand,
  promotionRefusal,
  promotionTerms,
  restedMoraleCap,
  settleUtilization
} from '../src/config/crew-morale.js';
import { MISSION_COOLDOWN_MS } from '../src/config/missions.js';

before(async () => { await app.ready(); });
after(async () => { await closeApp(); });

// Q08 (Nervous Tell) moves no morale or class numbers, so the plain +4 / -6 / -25 apply.
const NEUTRAL = 'Q08';
const member = (overrides = {}) => ({
  crewClass: 'PILOT', rank: 'NOVICE', morale: 75, quirkId: NEUTRAL, unutilizedStreak: 0, seniorityXp: 0, ...overrides
});

const passage = { kind: SETTLEMENT.MISSION, type: 'MISSION_TYPE_PASSAGE', distanceHexes: 2, requiredBerths: 2, covert: false };
const research = { ...passage, type: 'MISSION_TYPE_RESEARCH', requiredBerths: 0 };
const ctx = { weaponsTier: 1, subsystemUse: 0.5, activeCrew: 1 };

describe('morale constants', () => {
  test('pin the plan values', () => {
    assert.deepEqual(
      [MORALE_GAIN_UTILIZED_PAID, UNUTILIZED_GRACE_MISSIONS, MORALE_DECAY_UNUTILIZED, MORALE_DECAY_DEFERRED_PAY, MORALE_GAIN_PAY_ARREARS],
      [4, 2, 6, 25, 15]
    );
    assert.deepEqual(CREW_TRAINING_XP_REQ, { ADEPT: 1500, MASTER: 5000 });
    assert.deepEqual(CREW_TRAINING_FEE_CREDITS, { ADEPT: 800, MASTER: 2500 });
    assert.deepEqual(
      [CREW_CAPABILITY.HOT_CASTOFF, CREW_CAPABILITY.COLD_DRIFT, CREW_CAPABILITY.COARSE_GRADE_REVEAL, CREW_CAPABILITY.HARMONIC_AUTOTRIM, CREW_CAPABILITY.BELT_CLEARANCE],
      [0x01, 0x02, 0x04, 0x40, 0x80]
    );
  });

  test('morale bands', () => {
    assert.deepEqual([85, 84, 50, 49, 25, 24, 1, 0].map((m) => moraleBand(m, NEUTRAL)),
      ['INSPIRED', 'NOMINAL', 'NOMINAL', 'DISGRUNTLED', 'DISGRUNTLED', 'MUTINOUS', 'MUTINOUS', 'RESIGNED']);
    assert.equal(moraleBand(85, 'Q15'), 'NOMINAL'); // Perfectionist is Inspired from 88
  });
});

describe('utilization and morale (pure)', () => {
  test('a paid, utilized settlement gains 4 and resets the streak', () => {
    const out = settleUtilization(member({ morale: 82, unutilizedStreak: 2 }), passage, ctx, { deferred: false, traits: [] });
    assert.deepEqual(out, { utilized: true, unutilizedStreak: 0, morale: 86 });
  });

  test('a deferred settlement gains nothing', () => {
    assert.equal(settleUtilization(member(), passage, ctx, { deferred: true, traits: [] }).morale, 75);
  });

  test('an idle member holds through the grace and then loses 6 a settlement', () => {
    let m = member({ crewClass: 'SCIENCE' });
    for (const [streak, morale] of [[1, 75], [2, 75], [3, 69], [4, 63]]) {
      const out = settleUtilization(m, passage, ctx, { deferred: false, traits: [] });
      assert.deepEqual([out.utilized, out.unutilizedStreak, out.morale], [false, streak, morale]);
      m = { ...m, ...out };
    }
  });

  test('GOOD_NATURED adds one to gains and takes one off losses; LAZY / AMBITIOUS move the grace; C2 scales losses', () => {
    assert.equal(settleUtilization(member({ quirkId: 'Q01' }), passage, ctx, { deferred: false, traits: [] }).morale, 80);
    assert.equal(moraleAfterLoss(member({ quirkId: 'Q01' }), 25), 51);
    assert.equal(moraleAfterLoss(member({ quirkId: 'Q01' }), 1), 74); // a loss is never below 1
    assert.equal(settleUtilization(member({ crewClass: 'SCIENCE', quirkId: 'Q10', unutilizedStreak: 2 }), passage, ctx, { deferred: false, traits: [] }).morale, 75);
    assert.equal(settleUtilization(member({ crewClass: 'SCIENCE', quirkId: 'Q11', unutilizedStreak: 1 }), passage, ctx, { deferred: false, traits: [] }).morale, 66);
    assert.equal(moraleAfterLoss(member(), 25, ['C2_SHORE_CONTACTS']), 75 - 19);
  });

  test('each class is utilized by its own settlements', () => {
    const used = (crewClass, settlement, over = {}) =>
      settleUtilization(member({ crewClass }), settlement, { ...ctx, ...over }, { deferred: false, traits: [] }).utilized;
    const sale = { kind: SETTLEMENT.CARGO_SALE };
    assert.equal(used('PILOT', { ...passage, distanceHexes: 0 }), false);
    assert.equal(used('SCIENCE', research), true);
    assert.equal(used('SCIENCE', { kind: SETTLEMENT.CHART_SALE, chart: 'PLANET' }), true);
    assert.equal(used('NAVIGATOR', { kind: SETTLEMENT.CHART_SALE, chart: 'PLANET' }), false);
    assert.equal(used('NAVIGATOR', { kind: SETTLEMENT.CHART_SALE, chart: 'SYSTEM' }), true);
    assert.equal(used('ENGINEER', sale), true);
    assert.equal(used('ENGINEER', passage), false);
    assert.equal(used('ENGINEER', passage, { subsystemUse: 0.8 }), true);
    assert.equal(used('GUNNER', sale), true);
    assert.equal(used('GUNNER', sale, { weaponsTier: 0 }), false);
    assert.equal(used('CHEF', passage), true);
    assert.equal(used('CHEF', research, { activeCrew: 2 }), true);
    assert.equal(used('CHEF', research), false);
    assert.equal(used('DOCTOR', passage), true);
    assert.equal(used('DOCTOR', research), false);
  });

  test('paid arrears and shore leave stop at the rested cap, and a Master Chef raises it to 90', () => {
    assert.equal(moraleAfterCappedGain(member({ morale: 70 }), 15, 80), 80);
    assert.equal(moraleAfterCappedGain(member({ morale: 90 }), 15, 80), 90); // never lowered
    const chef = { crewClass: 'CHEF', rank: 'MASTER', morale: 60 };
    assert.equal(restedMoraleCap([]), 80);
    assert.equal(restedMoraleCap([chef]), 90);
    assert.equal(restedMoraleCap([{ ...chef, morale: 40 }]), 80);
  });

  test('promotion terms and refusals', () => {
    assert.deepEqual(promotionTerms(member({ quirkId: NEUTRAL })), { toRank: 'ADEPT', requiredXp: 1500, feeCredits: 800 });
    assert.equal(promotionTerms(member({ quirkId: 'Q03' })).feeCredits, 680);
    assert.equal(promotionTerms(member({ quirkId: 'Q07' })).feeCredits, 920);
    assert.equal(promotionTerms(member({ rank: 'MASTER' })), null);
    assert.equal(promotionRefusal(member({ rank: 'MASTER' })).code, 'already_master');
    assert.equal(promotionRefusal(member({ seniorityXp: 1499 })).code, 'insufficient_seniority_xp');
    assert.equal(promotionRefusal(member({ seniorityXp: 1500, morale: 24 })).code, 'crew_refuses_promotion');
    assert.equal(promotionRefusal(member({ seniorityXp: 1500 })), null);
  });

  test('the Doctor takes 20 / 35 / 50% off the cooldown while Nominal', () => {
    const doctor = (rank, morale = 75) => ({ crewClass: 'DOCTOR', rank, morale });
    assert.deepEqual(['NOVICE', 'ADEPT', 'MASTER'].map((r) => doctorCooldownReduction([doctor(r)])), [0.2, 0.35, 0.5]);
    assert.equal(doctorCooldownReduction([doctor('MASTER', 49)]), 0);
    assert.equal(doctorCooldownReduction([]), 0);
  });
});

describe('capabilities and resists in the ship attributes', () => {
  const attrs = (crew) => computeShipAttributes([], 0, [], crew);

  test('ASSERT-3.1.3: an Adept Pilot at morale 42 does not set HOT_CASTOFF; at 75 it does', () => {
    const pilot = (morale, rank = 'ADEPT') => ({ crewClass: 'PILOT', rank, morale, quirkId: NEUTRAL });
    assert.equal(attrs([pilot(42)]).crew_capability_flags & CREW_CAPABILITY.HOT_CASTOFF, 0);
    assert.equal(attrs([pilot(75)]).crew_capability_flags, CREW_CAPABILITY.HOT_CASTOFF);
    assert.equal(attrs([pilot(75, 'NOVICE')]).crew_capability_flags, 0);
    assert.equal(attrs([pilot(75, 'MASTER')]).crew_capability_flags, CREW_CAPABILITY.HOT_CASTOFF | CREW_CAPABILITY.COLD_DRIFT);
  });

  test('every class sets only the bits the contracts assigned', () => {
    const flags = (crewClass, rank) => crewCapabilityFlags([{ crewClass, rank, morale: 75, quirkId: NEUTRAL }]);
    assert.equal(flags('NAVIGATOR', 'ADEPT'), CREW_CAPABILITY.COARSE_GRADE_REVEAL);
    assert.equal(flags('ENGINEER', 'ADEPT'), 0);
    assert.equal(flags('ENGINEER', 'MASTER'), CREW_CAPABILITY.HARMONIC_AUTOTRIM);
    assert.equal(flags('GUNNER', 'ADEPT'), CREW_CAPABILITY.BELT_CLEARANCE);
    for (const crewClass of ['SCIENCE', 'CHEF', 'DOCTOR']) assert.equal(flags(crewClass, 'MASTER'), 0);
    const all = ['PILOT', 'NAVIGATOR', 'ENGINEER', 'GUNNER'].map((crewClass) => ({ crewClass, rank: 'MASTER', morale: 75, quirkId: NEUTRAL }));
    assert.equal(crewCapabilityFlags(all) & (0x08 | 0x10 | 0x20), 0);
  });

  test('resists scale with rank and morale and switch off below Nominal', () => {
    const engineer = (rank, morale) => attrs([{ crewClass: 'ENGINEER', rank, morale, quirkId: NEUTRAL }]).ion_fog_shield_resist;
    assert.deepEqual([engineer('NOVICE', 75), engineer('ADEPT', 75), engineer('MASTER', 75)], [0.25, 0.5, 0.75]);
    assert.equal(engineer('MASTER', 90), 0.8625);
    assert.equal(engineer('MASTER', 49), 0);
    const nav = (rank) => attrs([{ crewClass: 'NAVIGATOR', rank, morale: 75, quirkId: NEUTRAL }]).node_interference_resist;
    assert.deepEqual([nav('NOVICE'), nav('ADEPT'), nav('MASTER')], [0.2, 0.35, 0.5]);
    assert.equal(attrs([]).crew_capability_flags, 0);
  });

  test('the signed token and loadout carry them', async () => {
    const pilot = await newPilot('Flags');
    await addCrew(pilot, { crewClass: 'PILOT', rank: 'ADEPT', quirkId: NEUTRAL, morale: 75, wageShareBp: 800 });
    const loadout = json(await call(pilot, 'GET', '/ship/loadout'));
    assert.equal(loadout.ship_attributes.crew_capability_flags, CREW_CAPABILITY.HOT_CASTOFF);
    await app.prisma.crewMember.updateMany({ where: { playerId: pilot.id }, data: { morale: 42 } });
    assert.equal(json(await call(pilot, 'GET', '/ship/loadout')).ship_attributes.crew_capability_flags, 0);
  });
});

// A passage or research mission held and completed through the routes.
async function hold(pilot, overrides = {}) {
  const offer = signedOffer(pilot, overrides);
  const res = await call(pilot, 'POST', '/game/missions/accept', { offer, dockedReceipt: receiptAtOrigin(pilot, offer) });
  assert.equal(res.statusCode, 200, res.body);
  return json(res).active;
}

function claimFor(pilot, active, overrides = {}) {
  const claim = {
    missionId: active.mission_id,
    playerShipId: pilot.id,
    destinationStationId: active.offer.destination_station_id,
    acceptedAtMs: active.accepted_at_ms,
    completedAtMs: active.accepted_at_ms + 60_000,
    rewardCredits: active.offer.reward_credits,
    reputationChange: active.offer.reputation_change,
    ...overrides
  };
  claim.durationTakenMs = claim.completedAtMs - claim.acceptedAtMs;
  claim.signature = sign(null, canonicalClaimPayload(claim), rtseKey).toString('base64');
  return claim;
}

const complete = (pilot, active, extra = {}) => call(pilot, 'POST', '/game/missions/complete', { claim: claimFor(pilot, active), ...extra });
const crewRow = (id) => app.prisma.crewMember.findUnique({ where: { id } });

describe('mission settlement moves morale and seniority', () => {
  test('ASSERT-3.2.1: a paid 2-hex Passage lifts an 82 Pilot to 86 INSPIRED, and the token carries 1.15x', async () => {
    const pilot = await newPilot('Paid');
    const crew = await addCrew(pilot, { crewClass: 'PILOT', quirkId: NEUTRAL, morale: 82 });
    const res = await complete(pilot, await hold(pilot));
    assert.equal(res.statusCode, 200, res.body);
    const body = json(res);
    assert.equal((await crewRow(crew.id)).morale, 86);
    assert.equal(body.crew_morale.length, 1);
    assert.deepEqual([body.crew_morale[0].morale, body.crew_morale[0].moraleBand, body.crew_morale[0].utilized], [86, 'INSPIRED', true]);
    const listed = json(await call(pilot, 'GET', '/game/crew')).active[0];
    assert.deepEqual([listed.moraleBand, listed.moraleMult], ['INSPIRED', 1.15]);
  });

  test('ASSERT-3.2.2: a Science officer idle for a third Passage loses 6 (75 -> 69)', async () => {
    const pilot = await newPilot('Idle');
    const crew = await addCrew(pilot, { crewClass: 'SCIENCE', quirkId: NEUTRAL, morale: 75, unutilizedStreak: 2 });
    assert.equal((await complete(pilot, await hold(pilot))).statusCode, 200);
    const after = await crewRow(crew.id);
    assert.deepEqual([after.unutilizedStreak, after.morale], [3, 69]);
  });

  test('a utilized mission grants seniority XP equal to the Captain XP it awarded, scaled by the quirk', async () => {
    const pilot = await newPilot('Xp');
    const plain = await addCrew(pilot, { crewClass: 'PILOT', quirkId: NEUTRAL });
    const quick = await addCrew(pilot, { crewClass: 'SCIENCE', quirkId: 'Q03' });
    const idle = await addCrew(pilot, { crewClass: 'GUNNER', quirkId: NEUTRAL });
    const body = json(await complete(pilot, await hold(pilot, { type: 'MISSION_TYPE_RESEARCH', required_berths: 0 })));
    assert.ok(body.xpGained > 0);
    assert.equal((await crewRow(plain.id)).seniorityXp, body.xpGained);
    assert.equal((await crewRow(quick.id)).seniorityXp, Math.round(body.xpGained * 1.15));
    assert.equal((await crewRow(idle.id)).seniorityXp, 0);
  });

  test('ASSERT-3.2.3: deferCrewPay pays the pilot the whole reward, owes the crew, and costs 25 morale', async () => {
    const pilot = await newPilot('Defer');
    const crew = await addCrew(pilot, { crewClass: 'PILOT', quirkId: NEUTRAL, morale: 75, wageShareBp: 500 });
    const active = await hold(pilot, { reward_credits: 2500 });
    const res = await complete(pilot, active, { deferCrewPay: true });
    assert.equal(res.statusCode, 200, res.body);
    const body = json(res);
    assert.deepEqual([body.credits, body.crewShareCredits, body.netCredits, body.deferredCrewShareCredits], [2500, 0, 2500, 125]);
    assert.deepEqual(body.crewPayouts.map((p) => [p.shareCredits, p.deferredCredits]), [[0, 125]]);
    const after = await crewRow(crew.id);
    assert.deepEqual([after.unpaidArrearsCredits, after.morale], [125, 50]);
    assert.equal(await credits(pilot), 2500);
  });

  test('standby crew owed a deferred cut lose morale too, and are owed it', async () => {
    const pilot = await newPilot('DeferStandby');
    const crew = await addCrew(pilot, { crewClass: 'CHEF', quirkId: NEUTRAL, status: 'STANDBY', spaceshipId: null, wageShareBp: 500 });
    assert.equal((await complete(pilot, await hold(pilot), { deferCrewPay: true })).statusCode, 200);
    const after = await crewRow(crew.id);
    assert.deepEqual([after.unpaidArrearsCredits, after.morale, after.unutilizedStreak], [125, 50, 0]);
  });

  test('a pilot without crew is unchanged: no crew_morale, full pay, and deferCrewPay does nothing', async () => {
    const pilot = await newPilot('NoCrew');
    const body = json(await complete(pilot, await hold(pilot), { deferCrewPay: true }));
    assert.equal(body.crew_morale, undefined);
    assert.deepEqual([body.crewShareCredits, body.netCredits, body.crewPayouts], [0, 2500, []]);
    assert.equal(body.deferredCrewShareCredits, 0);
  });

  test('an active Doctor shortens the origin station cooldown', async () => {
    const without = await newPilot('NoDoc');
    const withDoc = await newPilot('Doc');
    await addCrew(withDoc, { crewClass: 'DOCTOR', rank: 'MASTER', wageShareBp: 1200, quirkId: NEUTRAL });
    const remaining = async (pilot) => {
      const active = await hold(pilot);
      assert.equal((await complete(pilot, active)).statusCode, 200);
      return json(await call(pilot, 'GET', `/game/missions/cooldown?originId=${active.offer.origin_station_id}`)).remaining_ms;
    };
    const full = await remaining(without);
    const halved = await remaining(withDoc);
    assert.ok(full > MISSION_COOLDOWN_MS * 0.95 && full <= MISSION_COOLDOWN_MS, String(full));
    assert.ok(halved > MISSION_COOLDOWN_MS * 0.45 && halved <= MISSION_COOLDOWN_MS * 0.5, String(halved));
  });
});

describe('chart and cargo sales', () => {
  async function chart(pilot, planetId = 'planet-1') {
    await app.prisma.planetChart.create({
      data: { playerId: pilot.id, planetId, systemH3: '8828308283fffff', completedAtMs: BigInt(Date.now()), signature: 'x', surveyJson: {} }
    });
  }
  const sellChart = (pilot, body = {}) => call(pilot, 'POST', '/game/charts/sell', { planetId: 'planet-1', stationId: 'station-alpha', ...body });

  test('a chart sale lifts a Science officer and returns a token with the new morale', async () => {
    const pilot = await newPilot('ChartMorale');
    const crew = await addCrew(pilot, { crewClass: 'SCIENCE', quirkId: NEUTRAL, morale: 70, wageShareBp: 500 });
    await chart(pilot);
    const res = await sellChart(pilot);
    assert.equal(res.statusCode, 200, res.body);
    const body = json(res);
    assert.equal((await crewRow(crew.id)).morale, 74);
    assert.equal(body.crew_morale[0].morale, 74);
    assert.ok(app.jwt.verify(body.token).ship_attributes);
  });

  test('a deferred chart sale pays the pilot in full and the crew into arrears', async () => {
    const pilot = await newPilot('ChartDefer');
    const crew = await addCrew(pilot, { crewClass: 'SCIENCE', quirkId: NEUTRAL, morale: 70, wageShareBp: 500 });
    await chart(pilot);
    const body = json(await sellChart(pilot, { deferCrewPay: true }));
    assert.deepEqual([body.newBalance, body.crewShareCredits, body.deferredCrewShareCredits], [500, 0, 25]);
    const after = await crewRow(crew.id);
    assert.deepEqual([after.morale, after.unpaidArrearsCredits], [45, 25]);
  });

  test('a crew-less chart sale answers exactly as before', async () => {
    const pilot = await newPilot('ChartPlain');
    await chart(pilot);
    assert.deepEqual(json(await sellChart(pilot)), {
      sold: true, rewardCredits: 500, newBalance: 500, grossCredits: 500, crewShareCredits: 0, netCredits: 500, crewPayouts: []
    });
  });

  test('an ore sale lifts an Engineer once; a replay changes nothing', async () => {
    const pilot = await newPilot('OreMorale');
    const crew = await addCrew(pilot, { crewClass: 'ENGINEER', quirkId: NEUTRAL, morale: 70, wageShareBp: 500 });
    const { cargo } = json(await call(pilot, 'POST', '/game/cargo/lease'));
    const fields = {
      pilotId: pilot.id, stationId: randomUUID(), items: [{ resourceType: 'TITANIUM', unitsMilli: 12500, grade: 4, purityBp: 8000 }],
      totalCredits: 1000, soldAtMs: Date.now(), nonce: randomBytes(16).toString('base64'),
      leaseId: cargo.lease_id, sessionId: randomUUID(), seq: 1, remaining: []
    };
    const saleRecord = { ...fields, signature: sign(null, canonicalSaleRecordPayload(fields), rtseKey).toString('base64') };
    const res = await call(pilot, 'POST', '/game/cargo/sell', { saleRecord });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(json(res).crew_morale[0].morale, 74);
    assert.ok(json(res).token);
    assert.equal(json(res).ship, undefined);
    const replay = json(await call(pilot, 'POST', '/game/cargo/sell', { saleRecord }));
    assert.equal(replay.replayed, true);
    assert.equal(replay.crew_morale, undefined);
    assert.equal((await crewRow(crew.id)).morale, 74);
  });
});

describe('POST /game/crew/promote', () => {
  const promote = (pilot, crew, receipt = true) =>
    call(pilot, 'POST', '/game/crew/promote', {
      crewId: crew.id,
      ...(receipt && { dockedReceipt: receiptAtOrigin(pilot, { origin_station_id: randomUUID(), origin_system_h3: '8828308283fffff' }) })
    });

  test('ASSERT-3.2.4: a Novice Engineer with 1500 XP and 1,000 cr becomes an Adept for 800 cr at an 8% share', async () => {
    const pilot = await newPilot('Promote');
    const crew = await addCrew(pilot, { crewClass: 'ENGINEER', quirkId: NEUTRAL, seniorityXp: 1500 });
    await setCredits(pilot, 1000);
    const res = await promote(pilot, crew);
    assert.equal(res.statusCode, 200, res.body);
    const body = json(res);
    assert.deepEqual([body.credits, body.feeCredits, body.crew.rank, body.crew.baseWageShareBp], [200, 800, 'ADEPT', 800]);
    assert.equal(body.ship_attributes.ion_fog_shield_resist, 0.5);
    assert.equal(app.jwt.verify(body.token).ship_attributes.ion_fog_shield_resist, 0.5);
    const row = await crewRow(crew.id);
    assert.deepEqual([row.rank, row.wageShareBp, row.seniorityXp], ['ADEPT', 800, 1500]);
  });

  test('refusals: no receipt, too little XP, too few credits, Mutinous, Master, a stranger; nothing is charged', async () => {
    const pilot = await newPilot('PromoteNo');
    await setCredits(pilot, 1000);
    const ready = await addCrew(pilot, { crewClass: 'ENGINEER', quirkId: NEUTRAL, seniorityXp: 1500 });
    assert.equal((await promote(pilot, ready, false)).statusCode, 403);

    const green = await addCrew(pilot, { crewClass: 'PILOT', quirkId: NEUTRAL, seniorityXp: 1499 });
    const noXp = await promote(pilot, green);
    assert.deepEqual([noXp.statusCode, json(noXp).error, json(noXp).requiredXp], [409, 'insufficient_seniority_xp', 1500]);

    const grumpy = await addCrew(pilot, { crewClass: 'DOCTOR', quirkId: NEUTRAL, seniorityXp: 1500, morale: 24 });
    assert.deepEqual([(await promote(pilot, grumpy)).statusCode, json(await promote(pilot, grumpy)).error], [409, 'crew_refuses_promotion']);

    const master = await addCrew(pilot, { crewClass: 'GUNNER', quirkId: NEUTRAL, rank: 'MASTER', wageShareBp: 1200, seniorityXp: 9999 });
    assert.equal(json(await promote(pilot, master)).error, 'already_master');

    const stranger = await newPilot('Stranger');
    const foreign = await addCrew(stranger, { crewClass: 'ENGINEER', seniorityXp: 1500 });
    assert.equal((await promote(pilot, foreign)).statusCode, 404);

    await setCredits(pilot, 799);
    const poor = await promote(pilot, ready);
    assert.deepEqual([poor.statusCode, json(poor).error, json(poor).requiredCredits], [402, 'insufficient_credits', 800]);
    assert.equal(await credits(pilot), 799);
    assert.equal((await crewRow(ready.id)).rank, 'NOVICE');
  });

  test('an Adept needs 5000 XP and 2,500 cr for Master, and the quirk moves the fee', async () => {
    const pilot = await newPilot('PromoteMaster');
    await setCredits(pilot, 5000);
    const crew = await addCrew(pilot, { crewClass: 'NAVIGATOR', quirkId: 'Q03', rank: 'ADEPT', wageShareBp: 800, seniorityXp: 5000 });
    const body = json(await promote(pilot, crew));
    assert.deepEqual([body.crew.rank, body.feeCredits, body.credits, body.crew.baseWageShareBp], ['MASTER', 2125, 2875, 1200]);
  });
});

describe('POST /game/crew/pay-arrears', () => {
  const pay = (pilot, body = {}) => call(pilot, 'POST', '/game/crew/pay-arrears', body);

  test('pays what is owed, lifts morale 15 up to the rested cap, and clears the arrears', async () => {
    const pilot = await newPilot('Arrears');
    const crew = await addCrew(pilot, { crewClass: 'PILOT', quirkId: NEUTRAL, morale: 50, unpaidArrearsCredits: 125 });
    const high = await addCrew(pilot, { crewClass: 'DOCTOR', quirkId: NEUTRAL, morale: 70, unpaidArrearsCredits: 75 });
    await setCredits(pilot, 1000);
    const res = await pay(pilot);
    assert.equal(res.statusCode, 200, res.body);
    const body = json(res);
    assert.deepEqual([body.paidCredits, body.credits], [200, 800]);
    assert.deepEqual((await crewRow(crew.id)).morale, 65);
    assert.deepEqual([(await crewRow(high.id)).morale, (await crewRow(high.id)).unpaidArrearsCredits], [80, 0]);
    assert.equal(json(await pay(pilot)).error, 'no_arrears');
  });

  test('one member by id; a Master Chef lifts the cap to 90; too few credits pays nothing', async () => {
    const pilot = await newPilot('ArrearsOne');
    await addCrew(pilot, { crewClass: 'CHEF', rank: 'MASTER', wageShareBp: 1200, quirkId: NEUTRAL, morale: 75 });
    const a = await addCrew(pilot, { crewClass: 'PILOT', quirkId: NEUTRAL, morale: 70, unpaidArrearsCredits: 100 });
    const b = await addCrew(pilot, { crewClass: 'DOCTOR', quirkId: NEUTRAL, morale: 30, unpaidArrearsCredits: 100 });
    await app.prisma.shipComponentRecord.updateMany({ where: { spaceship: { playerId: pilot.id }, type: 'HULL' }, data: { tier: 5 } });
    await app.prisma.shipComponentRecord.updateMany({ where: { spaceship: { playerId: pilot.id }, type: 'LIFE_SUPPORT' }, data: { tier: 2 } });
    await setCredits(pilot, 99);
    const poor = await pay(pilot, { crewId: a.id });
    assert.deepEqual([poor.statusCode, json(poor).error, await credits(pilot)], [402, 'insufficient_credits', 99]);
    await setCredits(pilot, 500);
    assert.equal((await pay(pilot, { crewId: a.id })).statusCode, 200);
    assert.deepEqual([(await crewRow(a.id)).morale, (await crewRow(b.id)).unpaidArrearsCredits], [85, 100]);
    assert.equal((await pay(pilot, { crewId: randomUUID() })).statusCode, 404);
  });
});
