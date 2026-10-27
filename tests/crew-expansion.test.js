import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID, sign } from 'node:crypto';
import { addCrew, app, call, closeApp, credits, dockedReceipt, json, newPilot, receiptAtOrigin, rtseKey, signedOffer } from './helpers.js';
import { canonicalClaimPayload } from '../src/lib/mission-claim.js';
import { canonicalSaleRecordPayload } from '../src/lib/cargo.js';
import { computeShipAttributes } from '../src/config/components.js';
import { MAX_REWARD_CREDITS } from '../src/config/missions.js';
import {
  CLANDESTINE_BASE_BONUS_RATE,
  CREW_CAPABILITY,
  CREW_CLASSES,
  CREW_CLASS_IDS,
  CREW_PERK,
  QUIRKS,
  classEffectsView,
  crewCapabilityFlags,
  crewPerk
} from '../src/config/crew.js';
import { SETTLEMENT, settleUtilization } from '../src/config/crew-morale.js';
import { boardingReasons, clandestineBonusCredits, oreSaleBonusCredits } from '../src/lib/crew.js';
import { generateCrewBoard } from '../src/lib/crew-generator.js';
import { withCrewReputationBonus, withCrewRivalHarmCut } from '../src/lib/reputation.js';

before(async () => { await app.ready(); });
after(closeApp);

// Q08 (Nervous Tell) moves no morale or class numbers, so a member's multiplier is its morale band's.
const NEUTRAL = 'Q08';
const member = (crewClass, rank = 'NOVICE', morale = 75) => ({ crewClass, rank, morale, quirkId: NEUTRAL, status: 'ACTIVE' });
const RANKS = ['NOVICE', 'ADEPT', 'MASTER'];
const NEW_CLASSES = ['QUARTERMASTER', 'COMMS_OFFICER', 'DIPLOMAT', 'SMUGGLER'];

describe('the expansion classes (classes.md 2.1)', () => {
  test('join the seven core classes, each with the design values by rank', () => {
    assert.deepEqual(CREW_CLASS_IDS.slice(7), NEW_CLASSES);
    assert.deepEqual(CREW_CLASSES.QUARTERMASTER.effects.map((e) => [e.attr, e.pct]), [['cargo_capacity_m3', [0.1, 0.17, 0.25]]]);
    assert.deepEqual(CREW_CLASSES.QUARTERMASTER.perks, { [CREW_PERK.ORE_SALE_BONUS]: [0.08, 0.14, 0.2] });
    assert.deepEqual(CREW_CLASSES.COMMS_OFFICER.effects.map((e) => [e.attr, e.pct]), [
      ['comms_range_m', [0.25, 0.4, 0.6]], ['covert_exposure_mult', [-0.12, -0.22, -0.35]]
    ]);
    assert.deepEqual(CREW_CLASSES.DIPLOMAT.perks, {
      [CREW_PERK.REPUTATION_GAIN_BONUS]: [0.15, 0.25, 0.35], [CREW_PERK.RIVAL_HARM_REDUCTION]: [0.15, 0.25, 0.4]
    });
    assert.deepEqual(CREW_CLASSES.SMUGGLER.perks, { [CREW_PERK.CLANDESTINE_BONUS_RATE]: [0.32, 0.4, 0.5] });
    assert.equal(CLANDESTINE_BASE_BONUS_RATE, 0.25);
    assert.deepEqual(NEW_CLASSES.map((id) => CREW_CLASSES[id].name), ['Quartermaster', 'Comms Officer', 'Diplomat', 'Smuggler']);
  });

  test('the board shows each class perk beside its ship effects', () => {
    assert.deepEqual(classEffectsView('QUARTERMASTER', 'ADEPT'), [
      { attribute: 'cargo_capacity_m3', kind: 'pct', value: 0.17 }, { attribute: 'ore_sale_bonus', kind: 'pct', value: 0.14 }
    ]);
    assert.deepEqual(classEffectsView('DIPLOMAT', 'MASTER').map((e) => [e.attribute, e.value]),
      [['reputation_gain_bonus', 0.35], ['rival_harm_reduction', 0.4]]);
    assert.deepEqual(classEffectsView('SMUGGLER', 'NOVICE'), [{ attribute: 'clandestine_bonus_rate', kind: 'pct', value: 0.32 }]);
    assert.deepEqual(classEffectsView('PILOT', 'NOVICE').map((e) => e.attribute), ['max_speed_mps', 'docking_time_mult']);
  });

  test('candidates of every class are generated', () => {
    const seen = new Set();
    for (let i = 0; i < 200; i++) {
      generateCrewBoard(`00000000-0000-4000-8000-${i.toString(16).padStart(12, '0')}`, 1_000_000).candidates.forEach((c) => seen.add(c.crewClass));
    }
    for (const id of NEW_CLASSES) assert.ok(seen.has(id), id);
  });
});

describe('ship attributes', () => {
  const attrs = (crew, components = []) => computeShipAttributes(components, 0, [], crew);

  test('a Quartermaster raises cargo_capacity_m3 by 10 / 17 / 25% of the installed CARGO', () => {
    const cargo = [{ type: 'CARGO', tier: 3 }]; // 80 m3
    assert.deepEqual(RANKS.map((rank) => attrs([member('QUARTERMASTER', rank)], cargo).cargo_capacity_m3), [88, 93.6, 100]);
    assert.equal(attrs([], cargo).cargo_capacity_m3, 80);
    assert.equal(attrs([member('QUARTERMASTER', 'MASTER')], [{ type: 'CARGO', tier: 0 }]).cargo_capacity_m3, 0);
  });

  test('a Comms Officer raises comms_range_m by 25 / 40 / 60% and cuts covert_exposure_mult by 12 / 22 / 35%', () => {
    const comms = [{ type: 'COMMS', tier: 2 }]; // 2500 m
    assert.deepEqual(RANKS.map((rank) => attrs([member('COMMS_OFFICER', rank)], comms).comms_range_m), [3125, 3500, 4000]);
    assert.deepEqual(RANKS.map((rank) => attrs([member('COMMS_OFFICER', rank)]).covert_exposure_mult), [0.88, 0.78, 0.65]);
    assert.equal(attrs([]).covert_exposure_mult, 1);
  });

  test('the Comms Officer effects scale with morale: Inspired x1.15, Disgruntled x0.6, Mutinous none', () => {
    const exposure = (morale) => attrs([member('COMMS_OFFICER', 'MASTER', morale)]).covert_exposure_mult;
    assert.equal(exposure(90), 0.5975); // 1 - 0.35 x 1.15
    assert.equal(exposure(40), 0.79); // 1 - 0.35 x 0.6
    assert.equal(exposure(10), 1);
  });

  test('the Diplomat and Smuggler change no ship attribute, and no expansion class signs a capability bit', () => {
    const base = attrs([]);
    for (const crewClass of ['DIPLOMAT', 'SMUGGLER']) {
      assert.deepEqual(attrs([member(crewClass, 'MASTER')]), { ...base, crew_aboard: 1, passengers_aboard: base.passengers_aboard });
    }
    const all = NEW_CLASSES.map((id) => member(id, 'MASTER'));
    assert.equal(crewCapabilityFlags(all), 0);
    assert.equal(attrs(all).crew_capability_flags & (CREW_CAPABILITY.HOT_CASTOFF | 0x08 | 0x10), 0);
  });

  test('a promoted Comms Officer captain signs the class effects at its rank, as every innate class does', () => {
    const effectId = `INNATE:COMMS_OFFICER:MASTER:${NEUTRAL}:`;
    assert.equal(computeShipAttributes([], 0, [effectId], []).covert_exposure_mult, 0.65);
  });

  test('the hull crew cap and one member per class still bind the new classes', () => {
    const hull = (tier) => [{ type: 'HULL', tier }, { type: 'LIFE_SUPPORT', tier }];
    const ship = (tier, crew) => ({ components: hull(tier), passengersAboard: 0, traits: [], crew });
    const codes = (s, crewClass) => boardingReasons(s, crewClass).map((r) => r.code);
    assert.deepEqual(codes(ship(1, []), 'DIPLOMAT'), []);
    assert.deepEqual(codes(ship(1, [member('PILOT')]), 'COMMS_OFFICER'), ['HULL_CREW_CAP_REACHED']);
    assert.deepEqual(codes(ship(3, [member('SMUGGLER')]), 'SMUGGLER'), ['CLASS_ALREADY_ACTIVE']);
    assert.deepEqual(codes(ship(3, [member('QUARTERMASTER'), member('DIPLOMAT')]), 'SMUGGLER'), []);
    assert.deepEqual(codes(ship(3, [member('QUARTERMASTER'), member('DIPLOMAT'), member('PILOT')]), 'SMUGGLER'), ['HULL_CREW_CAP_REACHED']);
  });
});

describe('perks', () => {
  test('crewPerk sums the active members by rank and morale; a rate is counted over its base', () => {
    assert.deepEqual(RANKS.map((rank) => crewPerk([member('QUARTERMASTER', rank)], CREW_PERK.ORE_SALE_BONUS)), [0.08, 0.14, 0.2]);
    assert.equal(crewPerk([member('QUARTERMASTER', 'MASTER', 40)], CREW_PERK.ORE_SALE_BONUS), 0.12); // x0.6
    assert.equal(crewPerk([member('QUARTERMASTER', 'MASTER', 10)], CREW_PERK.ORE_SALE_BONUS), 0);
    assert.equal(crewPerk([member('PILOT', 'MASTER')], CREW_PERK.ORE_SALE_BONUS), 0);
    assert.equal(crewPerk([], CREW_PERK.ORE_SALE_BONUS), 0);
    const rate = (rank, morale) => crewPerk([member('SMUGGLER', rank, morale)], CREW_PERK.CLANDESTINE_BONUS_RATE, CLANDESTINE_BASE_BONUS_RATE);
    assert.deepEqual(RANKS.map((rank) => rate(rank)), [0.07, 0.15, 0.25]);
    assert.equal(rate('MASTER', 40), 0.15);
  });

  test('the Diplomat raises a reputation gain by 15 / 25 / 35% and never a loss', () => {
    const gain = (rank, delta) => withCrewReputationBonus(delta, [member('DIPLOMAT', rank)]);
    assert.deepEqual(RANKS.map((rank) => gain(rank, 20)), [23, 25, 27]);
    assert.equal(gain('MASTER', 5), 7); // 6.75
    assert.equal(gain('MASTER', -20), -20);
    assert.equal(gain('MASTER', 0), 0);
    assert.equal(withCrewReputationBonus(20, []), 20);
    assert.equal(withCrewReputationBonus(20, [member('PILOT', 'MASTER')]), 20);
  });

  test('the Diplomat takes 15 / 25 / 40% off the harm to the rival and never turns it into a gain', () => {
    const harm = (rank, delta) => withCrewRivalHarmCut(delta, [member('DIPLOMAT', rank)]);
    assert.deepEqual(RANKS.map((rank) => harm(rank, -20)), [-17, -15, -12]);
    assert.equal(harm('MASTER', 0), 0);
    assert.equal(withCrewRivalHarmCut(-20, []), -20);
    assert.equal(withCrewRivalHarmCut(-20, [member('DIPLOMAT', 'MASTER', 40)]), -15); // 40% x0.6 = 24%
  });

  test('the Quartermaster adds 8 / 14 / 20% to an ore sale, never past the credit ceiling', () => {
    assert.deepEqual(RANKS.map((rank) => oreSaleBonusCredits([member('QUARTERMASTER', rank)], 1000)), [80, 140, 200]);
    assert.equal(oreSaleBonusCredits([], 1000), 0);
    assert.equal(oreSaleBonusCredits([member('QUARTERMASTER', 'MASTER')], MAX_REWARD_CREDITS - 10), 10);
    assert.equal(oreSaleBonusCredits([member('QUARTERMASTER', 'MASTER')], MAX_REWARD_CREDITS), 0);
  });

  test('the Smuggler pays the clean covert bonus at 32 / 40 / 50% of the reward instead of 25%', () => {
    // An offer of 2500 cr signs a 625 cr bonus at the base 25%.
    assert.deepEqual(RANKS.map((rank) => clandestineBonusCredits([member('SMUGGLER', rank)], 3125, 625)), [175, 375, 625]);
    assert.equal(clandestineBonusCredits([], 3125, 625), 0);
    assert.equal(clandestineBonusCredits([member('SMUGGLER', 'MASTER')], 3125, 0), 0);
    assert.equal(clandestineBonusCredits([member('SMUGGLER', 'MASTER')], MAX_REWARD_CREDITS - 5, 625), 5);
  });
});

describe('utilization', () => {
  const used = (crewClass, settlement) =>
    settleUtilization({ ...member(crewClass), unutilizedStreak: 0 }, settlement, { weaponsTier: 0, subsystemUse: 0, activeCrew: 1 }, { deferred: false, traits: [] }).utilized;
  const mission = (over = {}) => ({
    kind: SETTLEMENT.MISSION, type: 'MISSION_TYPE_RESEARCH', distanceHexes: 1, requiredBerths: 0, covert: false, reputationChange: 0, factionId: 'alpha', ...over
  });

  test('Quartermaster: gather missions and ore sales', () => {
    assert.equal(used('QUARTERMASTER', { kind: SETTLEMENT.CARGO_SALE }), true);
    assert.equal(used('QUARTERMASTER', mission({ type: 'MISSION_TYPE_GATHER' })), true);
    assert.equal(used('QUARTERMASTER', mission({ type: 'MISSION_TYPE_PASSAGE', reputationChange: 5 })), false);
    assert.equal(used('QUARTERMASTER', { kind: SETTLEMENT.CHART_SALE, chart: 'SYSTEM' }), false);
  });

  test('Comms Officer: covert missions', () => {
    assert.equal(used('COMMS_OFFICER', mission({ covert: true })), true);
    assert.equal(used('COMMS_OFFICER', mission({ type: 'MISSION_TYPE_PASSAGE', reputationChange: 5 })), false);
    assert.equal(used('COMMS_OFFICER', { kind: SETTLEMENT.CARGO_SALE }), false);
  });

  test('Diplomat: passages and missions that move reputation', () => {
    assert.equal(used('DIPLOMAT', mission({ type: 'MISSION_TYPE_PASSAGE' })), true);
    assert.equal(used('DIPLOMAT', mission({ reputationChange: 5 })), true);
    assert.equal(used('DIPLOMAT', mission({ reputationChange: 0 })), false);
    assert.equal(used('DIPLOMAT', { kind: SETTLEMENT.CARGO_SALE }), false);
  });

  test('Smuggler: covert and gamma missions', () => {
    assert.equal(used('SMUGGLER', mission({ covert: true })), true);
    assert.equal(used('SMUGGLER', mission({ factionId: 'gamma' })), true);
    assert.equal(used('SMUGGLER', mission({ factionId: 'alpha' })), false);
    assert.equal(used('SMUGGLER', { kind: SETTLEMENT.CARGO_SALE }), false);
  });
});

describe('hiring', () => {
  const stationAt = (i) => `00000000-0000-4000-8000-${i.toString(16).padStart(12, '0')}`;
  const plainQuirk = (id) => !QUIRKS[id].stat;
  // The first station whose board offers a Novice of `crewClass` whose quirk adds nothing to its class numbers.
  function findNovice(crewClass) {
    for (let i = 0; i < 20_000; i++) {
      const candidate = generateCrewBoard(stationAt(i), Date.now()).candidates.find((c) => c.crewClass === crewClass && c.rank === 'NOVICE' && plainQuirk(c.quirkId));
      if (candidate) return { stationId: stationAt(i), candidate };
    }
    throw new Error(`no station offers a Novice ${crewClass}`);
  }

  for (const crewClass of NEW_CLASSES) {
    test(`a ${CREW_CLASSES[crewClass].name} hired from the board is aboard and signed into the token`, async () => {
      const { stationId, candidate } = findNovice(crewClass);
      const pilot = await newPilot('Expansion');
      await app.prisma.player.update({ where: { id: pilot.id }, data: { credits: 5_000 } });
      const res = await call(pilot, 'POST', '/game/crew/hire', { candidateId: candidate.candidateId, dockedReceipt: dockedReceipt(pilot, { dockedEntityId: stationId }) });
      assert.equal(res.statusCode, 200, res.body);
      const body = json(res);
      assert.equal(body.crew.crewClass, crewClass);
      assert.equal(body.crew.className, CREW_CLASSES[crewClass].name);
      assert.deepEqual(body.crew.effects, classEffectsView(crewClass, 'NOVICE'));
      const attributes = app.jwt.verify(body.token).ship_attributes;
      assert.equal(attributes.crew_aboard, 1);
      assert.equal(attributes.covert_exposure_mult, crewClass === 'COMMS_OFFICER' ? 0.88 : 1);
      assert.equal(attributes.crew_capability_flags, 0);
    });
  }

  test('a second member of a class is refused on the board and at the hull cap', async () => {
    const { stationId, candidate } = findNovice('DIPLOMAT');
    const pilot = await newPilot('Second');
    await addCrew(pilot, { crewClass: 'DIPLOMAT', rank: 'NOVICE' });
    const res = await call(pilot, 'POST', '/game/crew/board', { dockedReceipt: dockedReceipt(pilot, { dockedEntityId: stationId }) });
    const view = json(res).candidates.find((c) => c.candidateId === candidate.candidateId);
    assert.equal(view.hireable, false);
    const codes = view.unavailableReasons.map((r) => r.code);
    assert.ok(codes.includes('CLASS_ALREADY_ACTIVE'));
    assert.ok(codes.includes('HULL_CREW_CAP_REACHED'));
  });
});

// Hold-and-complete helpers for the mission routes (see missions-v2.test.js).
const standing = (pilot, factionId, value) => app.prisma.playerReputation.upsert({
  where: { playerId_factionId: { playerId: pilot.id, factionId } }, update: { standing: value },
  create: { playerId: pilot.id, factionId, standing: value }
});
async function take(pilot, offer) {
  const res = await call(pilot, 'POST', '/game/missions/accept', { offer, dockedReceipt: receiptAtOrigin(pilot, offer) });
  assert.equal(res.statusCode, 200, res.body);
  return json(res).active;
}
function claimFor(pilot, active, overrides = {}) {
  const claim = {
    missionId: active.mission_id, playerShipId: pilot.id, destinationStationId: active.offer.destination_station_id,
    acceptedAtMs: active.accepted_at_ms, completedAtMs: active.accepted_at_ms + 1000, durationTakenMs: 1000,
    rewardCredits: active.offer.reward_credits, reputationChange: active.offer.reputation_change,
    wasDetected: false, exposureScoreMilli: 0, opposedReputationChange: 0, bribePaidCredits: 0, ...overrides
  };
  claim.signature = sign(null, canonicalClaimPayload(claim, false, active.offer.visibility ? 2 : 1), rtseKey).toString('base64');
  return claim;
}
const complete = (pilot, claim) => call(pilot, 'POST', '/game/missions/complete', { claim });
const covert = (pilot, overrides = {}) => signedOffer(pilot, {
  visibility: 'MISSION_VISIBILITY_COVERT', archetype: 'MISSION_ARCHETYPE_SABOTEUR_INSERTION',
  faction_id: 'alpha', reputation_change: 12, opposed_faction_id: 'beta', opposed_reputation_change: -20,
  clandestine_bonus_credits: 625, carries_contraband_or_operative: true, ...overrides
});

describe('Smuggler on a covert settlement', () => {
  test('a clean completion pays the Smuggler rate, and the crew share the bonus', async () => {
    const pilot = await newPilot('Smuggler');
    await standing(pilot, 'alpha', 200); await standing(pilot, 'beta', 200);
    await addCrew(pilot, { crewClass: 'SMUGGLER', rank: 'ADEPT', quirkId: NEUTRAL, morale: 75, wageShareBp: 800 });
    const active = await take(pilot, covert(pilot));
    // The claim signs 2500 cr and the 625 cr bonus at the base 25%; the Adept Smuggler's 40% pays 1000.
    const res = await complete(pilot, claimFor(pilot, active, { rewardCredits: 3125 }));
    assert.equal(res.statusCode, 200, res.body);
    const body = json(res);
    assert.deepEqual([body.payout, body.grossCredits, body.clandestineBonusCredits], [3500, 3500, 375]);
    assert.deepEqual([body.crewShareCredits, body.netCredits], [280, 3220]);
    assert.equal(body.credits, 3220);
    assert.equal(await credits(pilot), 3220);
    const [paid] = await app.prisma.completedMission.findMany({ where: { playerId: pilot.id } });
    assert.equal(paid.rewardCredits, 3500);
  });

  test('a detected completion, an overt mission and a ship without a Smuggler pay the signed reward only', async () => {
    const detected = await newPilot('Detected');
    await standing(detected, 'alpha', 200); await standing(detected, 'beta', 200);
    await addCrew(detected, { crewClass: 'SMUGGLER', rank: 'MASTER', quirkId: NEUTRAL, morale: 75, wageShareBp: 1200 });
    const d = await take(detected, covert(detected));
    const detectedRes = json(await complete(detected, claimFor(detected, d, { rewardCredits: 2500, wasDetected: true, exposureScoreMilli: 74500, opposedReputationChange: -20 })));
    assert.deepEqual([detectedRes.payout, detectedRes.clandestineBonusCredits], [2500, undefined]);

    const overt = await newPilot('Overt');
    await addCrew(overt, { crewClass: 'SMUGGLER', rank: 'MASTER', quirkId: NEUTRAL, morale: 75, wageShareBp: 1200 });
    const o = await take(overt, signedOffer(overt, {}));
    const overtRes = json(await complete(overt, claimFor(overt, o)));
    assert.deepEqual([overtRes.payout, overtRes.clandestineBonusCredits], [2500, undefined]);

    const plain = await newPilot('Plain');
    await standing(plain, 'alpha', 200); await standing(plain, 'beta', 200);
    const p = await take(plain, covert(plain));
    const plainRes = json(await complete(plain, claimFor(plain, p, { rewardCredits: 3125 })));
    assert.deepEqual([plainRes.payout, plainRes.clandestineBonusCredits], [3125, undefined]);
  });

  test('a Smuggler in Mutinous morale adds nothing', async () => {
    const pilot = await newPilot('Mutinous');
    await standing(pilot, 'alpha', 200); await standing(pilot, 'beta', 200);
    const crew = await addCrew(pilot, { crewClass: 'SMUGGLER', rank: 'MASTER', quirkId: NEUTRAL, morale: 75, wageShareBp: 1200 });
    const active = await take(pilot, covert(pilot));
    // Accepting consumes the dock's shore leave; the morale under test is set after it.
    await app.prisma.crewMember.update({ where: { id: crew.id }, data: { morale: 10 } });
    assert.equal(json(await complete(pilot, claimFor(pilot, active, { rewardCredits: 3125 }))).payout, 3125);
  });
});

describe('Diplomat on a settlement', () => {
  test('raises the sponsor reputation of an overt mission', async () => {
    const pilot = await newPilot('Envoy');
    await addCrew(pilot, { crewClass: 'DIPLOMAT', rank: 'MASTER', quirkId: NEUTRAL, morale: 75, wageShareBp: 1200 });
    const active = await take(pilot, signedOffer(pilot, { faction_id: 'alpha', reputation_change: 20 }));
    const body = json(await complete(pilot, claimFor(pilot, active)));
    assert.equal(body.reputation_change, 27);
    assert.equal(body.standings.alpha, 27);
  });

  test('raises a clean covert gain and softens the rival harm of a detected one', async () => {
    const clean = await newPilot('Clean');
    await standing(clean, 'alpha', 200); await standing(clean, 'beta', 200);
    await addCrew(clean, { crewClass: 'DIPLOMAT', rank: 'ADEPT', quirkId: NEUTRAL, morale: 75, wageShareBp: 800 });
    const c = await take(clean, covert(clean));
    assert.deepEqual(json(await complete(clean, claimFor(clean, c, { rewardCredits: 3125 }))).standings, { alpha: 215, beta: 200 });

    const caught = await newPilot('Caught');
    await standing(caught, 'alpha', 200); await standing(caught, 'beta', 200);
    await addCrew(caught, { crewClass: 'DIPLOMAT', rank: 'ADEPT', quirkId: NEUTRAL, morale: 75, wageShareBp: 800 });
    const d = await take(caught, covert(caught));
    const res = await complete(caught, claimFor(caught, d, { rewardCredits: 2500, wasDetected: true, exposureScoreMilli: 74500, opposedReputationChange: -20 }));
    assert.equal(res.statusCode, 200, res.body);
    assert.deepEqual(json(res).standings, { alpha: 215, beta: 185 }); // +12 x1.25 and -20 x0.75
    const rows = await app.prisma.reputationLedger.findMany({ where: { playerId: caught.id } });
    assert.equal(rows.length, 1);
    assert.deepEqual([rows[0].alphaDelta, rows[0].betaDelta], [15, -15]);
  });

  test('leaves a late completion\'s lost reputation as signed', async () => {
    const pilot = await newPilot('Late');
    await addCrew(pilot, { crewClass: 'DIPLOMAT', rank: 'MASTER', quirkId: NEUTRAL, morale: 75, wageShareBp: 1200 });
    const active = await take(pilot, signedOffer(pilot, { faction_id: 'alpha', reputation_change: 20 }));
    const body = json(await complete(pilot, claimFor(pilot, active, { reputationChange: -6 })));
    assert.equal(body.reputation_change, -6);
    assert.equal(body.standings.alpha, -6);
  });

  test('a ship without one is unchanged', async () => {
    const pilot = await newPilot('NoEnvoy');
    const active = await take(pilot, signedOffer(pilot, { faction_id: 'alpha', reputation_change: 20 }));
    assert.equal(json(await complete(pilot, claimFor(pilot, active))).standings.alpha, 20);
  });
});

// The engine's sale-record encoder, written out as in cargo.test.js.
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const str = (s) => Buffer.concat([u32(Buffer.byteLength(s)), Buffer.from(s, 'utf8')]);
const uuidBytes = (uuid) => Buffer.from(uuid.replaceAll('-', ''), 'hex');
const lotBytes = (lots) => [u32(lots.length), ...lots.flatMap((l) => [str(l.resourceType), u32(l.unitsMilli), u32(l.grade), u32(l.purityBp)])];
const ORE = { resourceType: 'TITANIUM', unitsMilli: 12500, grade: 4, purityBp: 8000 };

function saleFor(pilot, leaseId, totalCredits) {
  const fields = {
    pilotId: pilot.id, stationId: randomUUID(), items: [ORE], totalCredits, soldAtMs: Date.now(),
    nonce: randomBytes(16).toString('base64'), leaseId, sessionId: randomUUID(), seq: 1, remaining: []
  };
  const bytes = Buffer.concat([
    Buffer.from('EOTHA_SALE_RECORD_V2', 'ascii'), str(fields.pilotId), str(fields.stationId), ...lotBytes(fields.items),
    u64(fields.totalCredits), u64(fields.soldAtMs), Buffer.from(fields.nonce, 'base64'), uuidBytes(fields.leaseId),
    uuidBytes(fields.sessionId), u64(fields.seq), ...lotBytes(fields.remaining)
  ]);
  return { ...fields, signature: sign(null, bytes, rtseKey).toString('base64') };
}
const leaseOf = async (pilot) => json(await call(pilot, 'POST', '/game/cargo/lease')).cargo.lease_id;
const sell = (pilot, saleRecord, body = {}) => call(pilot, 'POST', '/game/cargo/sell', { saleRecord, ...body });

describe('Quartermaster on an ore sale', () => {
  test('pays 14% on top of the signed total, the crew share it, and a replay answers the same', async () => {
    const pilot = await newPilot('Purser');
    await addCrew(pilot, { crewClass: 'QUARTERMASTER', rank: 'ADEPT', quirkId: NEUTRAL, morale: 75, wageShareBp: 800 });
    const sale = saleFor(pilot, await leaseOf(pilot), 1000);
    const res = await sell(pilot, sale);
    assert.equal(res.statusCode, 200, res.body);
    const body = json(res);
    assert.deepEqual([body.total_credits, body.grossCredits, body.oreSaleBonusCredits], [1140, 1140, 140]);
    assert.deepEqual([body.crewShareCredits, body.netCredits, body.credits], [91, 1049, 1049]);
    assert.equal(await credits(pilot), 1049);
    const [stored] = await app.prisma.cargoSale.findMany({ where: { playerId: pilot.id } });
    assert.deepEqual([stored.totalCredits, stored.crewShareCredits], [1140, 91]);

    await app.prisma.crewMember.deleteMany({ where: { playerId: pilot.id } });
    const replay = json(await sell(pilot, sale));
    assert.equal(replay.replayed, true);
    assert.deepEqual([replay.grossCredits, replay.oreSaleBonusCredits, replay.crewShareCredits, replay.netCredits], [1140, 140, 91, 1049]);
    assert.equal(await credits(pilot), 1049);
  });

  test('a deferred sale still pays the bonus to the pilot and owes the crew their share of it', async () => {
    const pilot = await newPilot('Deferred');
    await addCrew(pilot, { crewClass: 'QUARTERMASTER', rank: 'MASTER', quirkId: NEUTRAL, morale: 75, wageShareBp: 1200 });
    const body = json(await sell(pilot, saleFor(pilot, await leaseOf(pilot), 1000), { deferCrewPay: true }));
    assert.deepEqual([body.grossCredits, body.oreSaleBonusCredits, body.netCredits, body.deferredCrewShareCredits], [1200, 200, 1200, 144]);
  });

  test('a ship without one is paid the signed total and the answer carries no bonus', async () => {
    const pilot = await newPilot('NoPurser');
    const body = json(await sell(pilot, saleFor(pilot, await leaseOf(pilot), 1000)));
    assert.deepEqual([body.total_credits, body.grossCredits, body.netCredits], [1000, 1000, 1000]);
    assert.equal(body.oreSaleBonusCredits, undefined);
  });

  test('the bonus stops at the credit ceiling', async () => {
    const pilot = await newPilot('Ceiling');
    await addCrew(pilot, { crewClass: 'QUARTERMASTER', rank: 'MASTER', quirkId: NEUTRAL, morale: 75, wageShareBp: 1200 });
    const body = json(await sell(pilot, saleFor(pilot, await leaseOf(pilot), MAX_REWARD_CREDITS - 10)));
    assert.deepEqual([body.grossCredits, body.oreSaleBonusCredits], [MAX_REWARD_CREDITS, 10]);
  });

  test('a standby Quartermaster adds nothing', async () => {
    const pilot = await newPilot('Standby');
    await addCrew(pilot, { crewClass: 'QUARTERMASTER', rank: 'MASTER', quirkId: NEUTRAL, morale: 75, wageShareBp: 1200, status: 'STANDBY', spaceshipId: null });
    const body = json(await sell(pilot, saleFor(pilot, await leaseOf(pilot), 1000)));
    assert.equal(body.grossCredits, 1000);
    assert.equal(body.oreSaleBonusCredits, undefined);
  });
});

describe('the token and loadout', () => {
  test('carry covert_exposure_mult, 1 without a Comms Officer', async () => {
    const pilot = await newPilot('Signals');
    assert.equal(json(await call(pilot, 'GET', '/ship/loadout')).ship_attributes.covert_exposure_mult, 1);
    await addCrew(pilot, { crewClass: 'COMMS_OFFICER', rank: 'MASTER', quirkId: NEUTRAL, morale: 75, wageShareBp: 1200 });
    const loadout = json(await call(pilot, 'GET', '/ship/loadout'));
    assert.equal(loadout.ship_attributes.covert_exposure_mult, 0.65);
    assert.equal(loadout.ship_attributes.crew_capability_flags, 0);
  });
});
