// Factions Stage F6, meta-service part: crew loyalty vectors, station seeding, berth tension, partisan
// morale and the Flying Colors morale shift.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID, sign } from 'node:crypto';
import { addCrew, app, call, closeApp, dockedReceipt, json, newPilot, receiptAtOrigin, rtseKey, setCredits, signedOffer } from './helpers.js';
import {
  BERTH_COHESION_CLANDESTINE_BONUS,
  BERTH_COHESION_MORALE_RECOVERY,
  BERTH_COHESION_THRESHOLD,
  BERTH_STATE,
  BERTH_TENSION_CHEF_DOCTOR_MITIGATION,
  BERTH_TENSION_FRICTION_THRESHOLD,
  BERTH_TENSION_MORALE_HIT,
  CREW_BOARD_OFFER_COUNT,
  CREW_LOYALTY_ALPHA_ORIGIN,
  CREW_LOYALTY_BETA_ORIGIN,
  CREW_LOYALTY_GAMMA_ORIGIN,
  CREW_LOYALTY_INDEPENDENT_ORIGIN,
  FLYING_COLORS_DISSENTER_MAX,
  FLYING_COLORS_DISSENTER_MORALE,
  FLYING_COLORS_LOYALIST_MIN,
  FLYING_COLORS_LOYALIST_MORALE,
  PARTISAN_GAIN_WEIGHT,
  PARTISAN_HARM_WEIGHT,
  PARTISAN_MORALE_MAX,
  PARTISAN_MORALE_MIN,
  berthTension,
  berthView,
  colorsMoraleShift,
  crewShipEffects,
  effectiveMorale,
  effectiveMoraleMult,
  pairTension,
  withFlyingColors
} from '../src/config/crew.js';
import { moraleBand, partisanMoraleDelta } from '../src/config/crew-morale.js';
import { candidateSeed, generateCandidate, generateCrewBoard, rollLoyalty } from '../src/lib/crew-generator.js';
import { clandestineBonusCredits, crewMemberView } from '../src/lib/crew.js';
import { canonicalClaimPayload } from '../src/lib/mission-claim.js';
import { missionOfferVersion } from '../src/lib/mission-offer.js';
import { canonicalCustomsSeizurePayload } from '../src/lib/customs-seizure.js';

before(async () => { await app.ready(); });
after(closeApp);

// A plain quirk (Q08 Nervous Tell moves no morale), so a morale change is the rule under test.
const PLAIN = 'Q08';
const lean = (alpha, beta, gamma = 50) => ({ loyaltyAlpha: alpha, loyaltyBeta: beta, loyaltyGamma: gamma });
const stationAt = (i) => `00000000-0000-4000-8000-${i.toString(16).padStart(12, '0')}`;
const member = (overrides = {}) => ({ crewClass: 'PILOT', rank: 'NOVICE', morale: 75, quirkId: PLAIN, ...lean(50, 50), ...overrides });

describe('F6 constants', () => {
  test('pin the plan values', () => {
    assert.deepEqual(
      [BERTH_TENSION_FRICTION_THRESHOLD, BERTH_TENSION_MORALE_HIT, BERTH_TENSION_CHEF_DOCTOR_MITIGATION,
        BERTH_COHESION_THRESHOLD, BERTH_COHESION_MORALE_RECOVERY, BERTH_COHESION_CLANDESTINE_BONUS],
      [55.0, -3, 0.5, 25.0, 2, 0.05]
    );
    assert.deepEqual([PARTISAN_GAIN_WEIGHT, PARTISAN_HARM_WEIGHT, PARTISAN_MORALE_MIN, PARTISAN_MORALE_MAX], [6.0, 9.0, -20, 15]);
    assert.deepEqual(
      [FLYING_COLORS_LOYALIST_MIN, FLYING_COLORS_DISSENTER_MAX, FLYING_COLORS_LOYALIST_MORALE, FLYING_COLORS_DISSENTER_MORALE],
      [65, 30, 10, -10]
    );
    assert.deepEqual(CREW_LOYALTY_ALPHA_ORIGIN.alpha, [50, 100]);
    assert.deepEqual(CREW_LOYALTY_BETA_ORIGIN.alpha, [0, 49]);
    assert.deepEqual(CREW_LOYALTY_GAMMA_ORIGIN.gamma, [55, 95]);
  });
});

// TEST-6.1: candidate loyalty is seeded from the governing faction of the station.
describe('candidate loyalty seeding (TEST-6.1)', () => {
  const inRange = (value, [lo, hi]) => value >= lo && value <= hi;
  const ORIGINS = { alpha: CREW_LOYALTY_ALPHA_ORIGIN, beta: CREW_LOYALTY_BETA_ORIGIN, gamma: CREW_LOYALTY_GAMMA_ORIGIN };

  for (const faction of ['alpha', 'beta', 'gamma']) {
    test(`a ${faction} station's candidates are rolled in the ${faction} origin ranges`, () => {
      for (let i = 0; i < 300; i++) {
        for (const slot of [0, 1, 2, 3]) {
          const { loyalty } = generateCandidate(stationAt(i), 7, slot, faction);
          for (const facet of ['alpha', 'beta', 'gamma']) {
            assert.ok(inRange(loyalty[facet], ORIGINS[facet][faction]), `${faction} ${facet}=${loyalty[facet]}`);
          }
        }
      }
    });
  }

  test('a Free Port\'s candidates lean away from one of alpha and beta as they lean to the other', () => {
    const { alphaBeta, sumSlack, gamma } = CREW_LOYALTY_INDEPENDENT_ORIGIN;
    for (const faction of ['', 'independent', 'unknown']) {
      for (let i = 0; i < 400; i++) {
        const { loyalty } = generateCandidate(stationAt(i), 3, i % CREW_BOARD_OFFER_COUNT, faction);
        assert.ok(inRange(loyalty.alpha, alphaBeta) && inRange(loyalty.beta, alphaBeta), JSON.stringify(loyalty));
        assert.ok(Math.abs(loyalty.alpha + loyalty.beta - 100) <= sumSlack, JSON.stringify(loyalty));
        assert.ok(inRange(loyalty.gamma, gamma), JSON.stringify(loyalty));
      }
    }
  });

  test('the rolls fill their ranges and are integers', () => {
    const seen = { min: 100, max: 0 };
    for (let i = 0; i < 2000; i++) {
      const { alpha, beta, gamma } = rollLoyalty(candidateSeed(stationAt(i), 1, 0), 'gamma');
      for (const value of [alpha, beta, gamma]) assert.ok(Number.isInteger(value));
      seen.min = Math.min(seen.min, gamma);
      seen.max = Math.max(seen.max, gamma);
    }
    assert.deepEqual(seen, { min: 55, max: 95 });
  });

  test('the board is a pure function of station, window and governing faction', () => {
    const now = 1_800_000_000_000;
    const a = generateCrewBoard(stationAt(5), now, 'alpha');
    assert.deepEqual(generateCrewBoard(stationAt(5), now, 'alpha'), a);
    // The faction seeds the loyalty only: the person, and so the candidate id a hire names, is the same.
    const b = generateCrewBoard(stationAt(5), now, 'beta');
    assert.deepEqual(b.candidates.map((c) => c.candidateId), a.candidates.map((c) => c.candidateId));
    assert.deepEqual(b.candidates.map((c) => c.name), a.candidates.map((c) => c.name));
    assert.notDeepEqual(b.candidates.map((c) => c.loyalty), a.candidates.map((c) => c.loyalty));
  });

  test('the board shows the loyalty and a hire stores it, for each kind of station', async () => {
    for (const faction of ['alpha', 'beta', 'gamma', '']) {
      const pilot = await newPilot(`Seed-${faction || 'free'}`);
      await setCredits(pilot, 100_000);
      // A station whose board offers a Novice, who asks only the weakest standing.
      const stationId = Array.from({ length: 200 }, (_, i) => stationAt(1000 + i))
        .find((id) => generateCrewBoard(id, Date.now(), faction).candidates.some((c) => c.rank === 'NOVICE'));
      const boardRes = await call(pilot, 'POST', '/game/crew/board', { dockedReceipt: dockedReceipt(pilot, { dockedEntityId: stationId, controllingFactionId: faction }) });
      assert.equal(boardRes.statusCode, 200, boardRes.body);
      const expected = generateCrewBoard(stationId, Date.now(), faction).candidates;
      const shown = json(boardRes).candidates;
      assert.ok(shown.length > 0);
      for (const view of shown) {
        assert.deepEqual(view.loyalty, expected.find((c) => c.candidateId === view.candidateId).loyalty);
      }
      const novice = shown.find((view) => view.rank === 'NOVICE' && view.hireable);
      assert.ok(novice, 'a hireable novice');
      const hired = await call(pilot, 'POST', '/game/crew/hire', {
        candidateId: novice.candidateId,
        dockedReceipt: dockedReceipt(pilot, { dockedEntityId: stationId, controllingFactionId: faction })
      });
      assert.equal(hired.statusCode, 200, hired.body);
      assert.deepEqual(json(hired).crew.loyalty, novice.loyalty);
      const [stored] = await app.prisma.crewMember.findMany({ where: { playerId: pilot.id } });
      assert.deepEqual([stored.loyaltyAlpha, stored.loyaltyBeta, stored.loyaltyGamma], [novice.loyalty.alpha, novice.loyalty.beta, novice.loyalty.gamma]);
      const roster = json(await call(pilot, 'GET', '/game/crew'));
      assert.deepEqual(roster.active[0].loyalty, novice.loyalty);
    }
  });

  test('a member that predates loyalty holds neutral 50s', async () => {
    const pilot = await newPilot('Legacy');
    const crew = await addCrew(pilot, {});
    assert.deepEqual([crew.loyaltyAlpha, crew.loyaltyBeta, crew.loyaltyGamma], [50, 50, 50]);
    assert.deepEqual(json(await call(pilot, 'GET', '/game/crew')).active[0].loyalty, { alpha: 50, beta: 50, gamma: 50 });
  });
});

// TEST-6.2: berth tension, mess-hall friction and Chef/Doctor mitigation.
describe('berth tension (pure)', () => {
  test('T_ij is half the alpha and beta distance, gamma ignored', () => {
    assert.equal(pairTension(member(lean(100, 0, 0)), member(lean(0, 100, 100))), 100);
    assert.equal(pairTension(member(lean(80, 40)), member(lean(60, 50))), 15);
    assert.equal(pairTension(member(lean(50, 50, 0)), member(lean(50, 50, 100))), 0);
  });

  test('needs two crew aboard', () => {
    assert.deepEqual(berthTension([]).averageTension, null);
    const alone = berthTension([member()]);
    assert.deepEqual([alone.averageTension, alone.state, alone.moraleHit, alone.moraleRecovery], [null, BERTH_STATE.NEUTRAL, 0, 0]);
  });

  test('the tension is the mean over every pair', () => {
    const crew = [member(lean(100, 0)), member(lean(0, 100)), member(lean(50, 50))];
    // 100, 50 and 50.
    assert.equal(berthTension(crew).averageTension, 200 / 3);
  });

  test('friction at 55 or more, cohesion below 25, neutral between', () => {
    const at = (tension) => berthTension([member(lean(50 + tension, 50)), member(lean(50 - tension, 50))]);
    assert.equal(at(55).averageTension, 55);
    assert.equal(at(55).state, BERTH_STATE.FRICTION);
    assert.equal(at(54).state, BERTH_STATE.NEUTRAL);
    assert.equal(at(25).state, BERTH_STATE.NEUTRAL);
    assert.equal(at(24).state, BERTH_STATE.COHESION);
    assert.equal(at(0).state, BERTH_STATE.COHESION);
    assert.deepEqual([at(60).moraleHit, at(60).moraleRecovery, at(60).clandestineBonus], [3, 0, 0]);
    assert.deepEqual([at(10).moraleHit, at(10).moraleRecovery, at(10).clandestineBonus], [0, 2, 0.05]);
  });

  test('a working Chef or Doctor aboard halves the hit to 1; a mutinous or detained one does not', () => {
    const rivals = [member(lean(100, 0)), member(lean(0, 100))];
    assert.equal(berthTension(rivals).moraleHit, 3);
    // The Chef or Doctor's own loyalties join the average: neutral ones keep it above 55 here.
    for (const crewClass of ['CHEF', 'DOCTOR']) {
      const helped = berthTension([...rivals, member({ crewClass, ...lean(100, 0) })]);
      assert.equal(helped.state, BERTH_STATE.FRICTION);
      assert.equal(helped.chefOrDoctorAboard, true);
      assert.equal(helped.moraleHit, 1);
      assert.equal(berthTension([...rivals, member({ crewClass, ...lean(100, 0), morale: 20 })]).moraleHit, 3);
      assert.equal(berthTension([...rivals, member({ crewClass, ...lean(100, 0), detained: true })]).moraleHit, 3);
    }
    assert.equal(berthTension([...rivals, member({ crewClass: 'GUNNER', ...lean(100, 0) })]).moraleHit, 3);
  });

  test('a detained member is not aboard to be counted', () => {
    const crew = [member(lean(100, 0)), member(lean(0, 100)), member({ ...lean(0, 100), detained: true })];
    assert.equal(berthTension(crew).crewCount, 2);
    assert.equal(berthTension(crew).averageTension, 100);
  });

  test('the lounge view rounds the tension to a decimal', () => {
    const view = berthView([member(lean(100, 0)), member(lean(0, 100)), member(lean(50, 50))]);
    assert.equal(view.averageTension, 66.7);
    assert.equal(view.state, BERTH_STATE.FRICTION);
  });

  test('the cohesion bonus raises a clean covert bonus 5% over the Smuggler\'s', () => {
    const kin = [member(), member()];
    const rivals = [member(lean(100, 0)), member(lean(0, 100))];
    assert.equal(clandestineBonusCredits(rivals, 3125, 625), 0);
    assert.equal(clandestineBonusCredits(kin, 3125, 625), 31);
    const smuggler = (...rest) => [member({ crewClass: 'SMUGGLER', rank: 'ADEPT' }), ...rest];
    assert.equal(clandestineBonusCredits(smuggler(), 3125, 625), 375);
    // 625 * 1.6 * 1.05 = 1050, so 425 beyond the signed bonus.
    assert.equal(clandestineBonusCredits(smuggler(member()), 3125, 625), 425);
  });
});

describe('partisan morale (pure)', () => {
  const gain = (factionId, delta = 10) => [{ factionId, delta }];
  test('a loyalist is glad of its faction\'s gain, a dissenter sorry; the reverse for harm', () => {
    const loyalist = member(lean(100, 0, 50));
    const dissenter = member(lean(0, 100, 50));
    assert.equal(partisanMoraleDelta(loyalist, gain('alpha')), 6);
    assert.equal(partisanMoraleDelta(dissenter, gain('alpha')), -6);
    assert.equal(partisanMoraleDelta(loyalist, gain('alpha', -10)), -9);
    assert.equal(partisanMoraleDelta(dissenter, gain('alpha', -10)), 9);
    assert.equal(partisanMoraleDelta(member(), gain('alpha')), 0);
    assert.equal(partisanMoraleDelta(member(lean(75, 50)), gain('alpha')), 3);
  });

  test('sums the factions changed and ignores any other', () => {
    const loyalist = member(lean(100, 0, 50));
    // Sponsor alpha gains (+6), rival beta harmed: sign -1 * 9 * (0 - 50) / 50 = +9.
    assert.equal(partisanMoraleDelta(loyalist, [{ factionId: 'alpha', delta: 10 }, { factionId: 'beta', delta: -10 }]), 15);
    assert.equal(partisanMoraleDelta(loyalist, [{ factionId: 'independent', delta: 10 }, { factionId: 'alpha', delta: 0 }]), 0);
  });

  test('is held to -20..15 and halved for a clean covert mission', () => {
    const loyalist = member(lean(100, 0));
    const deltas = [{ factionId: 'alpha', delta: 5 }, { factionId: 'beta', delta: -5 }, { factionId: 'gamma', delta: 5 }];
    assert.equal(partisanMoraleDelta(member(lean(100, 0, 100)), deltas), 15); // 6 + 9 + 6 = 21, held to 15
    assert.equal(partisanMoraleDelta(member(lean(0, 100, 0)), [
      { factionId: 'alpha', delta: -5 }, { factionId: 'beta', delta: -5 }
    ]), 0); // dissenter of alpha is glad (+9), loyalist of beta hurt (-9)
    assert.equal(partisanMoraleDelta(loyalist, gain('alpha'), { cleanCovert: true }), 3);
    assert.equal(partisanMoraleDelta(member(lean(100, 100)), [{ factionId: 'alpha', delta: -1 }, { factionId: 'beta', delta: -1 }, { factionId: 'gamma', delta: -1 }]), -9 * 2);
    assert.equal(partisanMoraleDelta(member(lean(100, 100, 100)), [{ factionId: 'alpha', delta: -1 }, { factionId: 'beta', delta: -1 }, { factionId: 'gamma', delta: -1 }]), -20);
  });
});

describe('Flying Colors morale (pure)', () => {
  test('a loyalist of the colors flown gains 10, a dissenter loses 10, the rest are unmoved', () => {
    assert.equal(colorsMoraleShift(member(lean(65, 50)), 'alpha'), 10);
    assert.equal(colorsMoraleShift(member(lean(64, 50)), 'alpha'), 0);
    assert.equal(colorsMoraleShift(member(lean(31, 50)), 'alpha'), 0);
    assert.equal(colorsMoraleShift(member(lean(30, 50)), 'alpha'), -10);
    assert.equal(colorsMoraleShift(member(lean(100, 0, 0)), 'beta'), -10);
    assert.equal(colorsMoraleShift(member(lean(100, 0, 0)), null), 0);
    assert.equal(colorsMoraleShift(member(lean(100, 0, 0)), 'independent'), 0);
  });

  test('is on read only: the stored morale stays, the effective morale moves and stays within 1..100', () => {
    const [loyal, dissent, neutral] = withFlyingColors([member({ ...lean(90, 50), morale: 95 }), member({ ...lean(5, 50), morale: 5 }), member()], 'alpha');
    assert.deepEqual([loyal.morale, dissent.morale, neutral.morale], [95, 5, 75]);
    assert.deepEqual([effectiveMorale(loyal), effectiveMorale(dissent), effectiveMorale(neutral)], [100, 1, 75]);
    // The shift never resigns a member nor revives one that has.
    const [resigned] = withFlyingColors([member({ ...lean(90, 50), morale: 0 })], 'alpha');
    assert.equal(effectiveMorale(resigned), 0);
    // Without colors there is nothing to read.
    const [plain] = withFlyingColors([member(lean(90, 50))], null);
    assert.equal(effectiveMorale(plain), 75);
  });

  test('moves the band and the class modifiers the member acts at', () => {
    const base = member({ crewClass: 'PILOT', morale: 80, ...lean(100, 0) });
    const [shifted] = withFlyingColors([base], 'alpha');
    assert.equal(effectiveMoraleMult(base), 1);
    assert.equal(effectiveMoraleMult(shifted), 1.15);
    const [penalised] = withFlyingColors([{ ...base, morale: 55, ...lean(10, 50) }], 'alpha');
    assert.equal(effectiveMoraleMult(penalised), 0.6);
    assert.ok(crewShipEffects([penalised])[0][1].mult < crewShipEffects([{ ...penalised, colorsMoraleShift: 0 }])[0][1].mult);
    const view = crewMemberView({ ...shifted, id: 'x', name: 'x', status: 'ACTIVE', hiredAt: new Date(), seniorityXp: 0, unutilizedStreak: 0, unpaidArrearsCredits: 0, pendingStipendCredits: 0, wageShareBp: 500, homeFactionId: 'alpha', hiredAtStationId: 's' });
    assert.deepEqual([view.morale, view.effectiveMorale, view.moraleBand], [80, 90, moraleBand(90, PLAIN)]);
    assert.deepEqual(view.colors, { factionId: 'alpha', moraleShift: 10 });
    assert.deepEqual(view.loyalty, { alpha: 100, beta: 0, gamma: 50 });
  });

  test('the engineer jury-rig flag follows the shifted morale across the Nominal threshold', () => {
    const engineer = { ...member({ crewClass: 'ENGINEER', rank: 'MASTER', morale: 45, ...lean(100, 0) }), id: 'e', name: 'e', status: 'ACTIVE', hiredAt: new Date(), seniorityXp: 0, unutilizedStreak: 0, unpaidArrearsCredits: 0, pendingStipendCredits: 0, wageShareBp: 500, homeFactionId: 'alpha', hiredAtStationId: 's' };
    const [shifted] = withFlyingColors([engineer], 'alpha');
    assert.equal(crewMemberView(engineer).juryRig.active, false);
    assert.equal(crewMemberView(shifted).juryRig.active, true);
  });
});

// --- Routes: settlements -----------------------------------------------------------------------------------
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
  claim.signature = sign(null, canonicalClaimPayload(claim, false, missionOfferVersion(active.offer)), rtseKey).toString('base64');
  return claim;
}
const complete = (pilot, active, overrides) => call(pilot, 'POST', '/game/missions/complete', { claim: claimFor(pilot, active, overrides) });
const research = (pilot, overrides = {}) => signedOffer(pilot, {
  type: 'MISSION_TYPE_RESEARCH', required_berths: 0, faction_id: 'alpha', reputation_change: 0, ...overrides
});
const covertOffer = (pilot, overrides = {}) => signedOffer(pilot, {
  type: 'MISSION_TYPE_RESEARCH', required_berths: 0, visibility: 'MISSION_VISIBILITY_COVERT',
  archetype: 'MISSION_ARCHETYPE_SABOTEUR_INSERTION', faction_id: 'alpha', reputation_change: 12,
  opposed_faction_id: 'beta', opposed_reputation_change: -20, clandestine_bonus_credits: 625,
  carries_contraband_or_operative: true, ...overrides
});
// Accepting docks the ship, which restores morale: set the crew's morale after it.
const setMorale = (crew, morale) => app.prisma.crewMember.update({ where: { id: crew.id }, data: { morale } });
const moraleOf = async (crew) => (await app.prisma.crewMember.findUnique({ where: { id: crew.id } })).morale;
const effectOf = (body, crew) => body.crew_morale?.find((e) => e.crewId === crew.id);

describe('mess-hall friction and cohesion on a settled mission (TEST-6.2)', () => {
  test('rivals aboard each lose 3 morale per mission completed', async () => {
    const pilot = await newPilot('Rivals');
    const science = await addCrew(pilot, { crewClass: 'SCIENCE', quirkId: PLAIN, ...lean(100, 0) });
    const gunner = await addCrew(pilot, { crewClass: 'GUNNER', quirkId: PLAIN, ...lean(0, 100) });
    const active = await take(pilot, research(pilot));
    await setMorale(science, 75); await setMorale(gunner, 75);
    const res = await complete(pilot, active);
    assert.equal(res.statusCode, 200, res.body);
    const body = json(res);
    // The Science officer is used by research (+4) and the Gunner is not (nothing).
    assert.equal(await moraleOf(science), 75 + 4 - 3);
    assert.equal(await moraleOf(gunner), 75 - 3);
    assert.deepEqual(effectOf(body, gunner).berthFriction, { averageTension: 100, moraleLoss: 3, mitigated: false });
    assert.equal(effectOf(body, science).berthCohesion, undefined);
  });

  test('a Chef or Doctor aboard cuts it to 1', async () => {
    for (const crewClass of ['CHEF', 'DOCTOR']) {
      const pilot = await newPilot(`Mediator-${crewClass}`);
      const a = await addCrew(pilot, { crewClass: 'SCIENCE', quirkId: PLAIN, ...lean(100, 0) });
      const b = await addCrew(pilot, { crewClass: 'GUNNER', quirkId: PLAIN, ...lean(0, 100) });
      const c = await addCrew(pilot, { crewClass, quirkId: PLAIN, ...lean(50, 50) });
      const active = await take(pilot, research(pilot));
      for (const m of [a, b, c]) await setMorale(m, 75);
      const body = json(await complete(pilot, active));
      assert.equal(await moraleOf(b), 75 - 1);
      assert.deepEqual(effectOf(body, b).berthFriction, { averageTension: 66.7, moraleLoss: 1, mitigated: true });
    }
  });

  test('crew on Harbor Standby are not aboard: they neither cause friction nor suffer it', async () => {
    const pilot = await newPilot('Ashore');
    const aboard = await addCrew(pilot, { crewClass: 'GUNNER', quirkId: PLAIN, ...lean(100, 0) });
    const ashore = await addCrew(pilot, { crewClass: 'GUNNER', quirkId: PLAIN, status: 'STANDBY', spaceshipId: null, ...lean(0, 100) });
    const active = await take(pilot, research(pilot));
    await setMorale(aboard, 75); await setMorale(ashore, 75);
    const body = json(await complete(pilot, active));
    assert.equal(await moraleOf(aboard), 75);
    assert.equal(await moraleOf(ashore), 75);
    assert.ok(!body.crew_morale?.some((e) => e.berthFriction));
  });

  test('a cohesive crew recovers 2 morale per mission', async () => {
    const pilot = await newPilot('Kin');
    const a = await addCrew(pilot, { crewClass: 'GUNNER', quirkId: PLAIN, ...lean(80, 20) });
    const b = await addCrew(pilot, { crewClass: 'PILOT', quirkId: PLAIN, ...lean(70, 30) });
    const active = await take(pilot, research(pilot));
    await setMorale(a, 60); await setMorale(b, 60);
    const body = json(await complete(pilot, active));
    // The Pilot is used by the mission too (+4); the Gunner is not.
    assert.equal(await moraleOf(a), 60 + 2);
    assert.equal(await moraleOf(b), 60 + 4 + 2);
    assert.deepEqual(effectOf(body, a).berthCohesion, { averageTension: 10, moraleGain: 2 });
  });

  test('a lone crew member feels no berth, and an ore sale is not a mission completed', async () => {
    const pilot = await newPilot('Alone');
    const only = await addCrew(pilot, { crewClass: 'GUNNER', quirkId: PLAIN });
    const active = await take(pilot, research(pilot));
    await setMorale(only, 60);
    await complete(pilot, active);
    assert.equal(await moraleOf(only), 60);
  });

  test('the lounge shows the berth, and a hire or standby move re-reads it', async () => {
    const pilot = await newPilot('Lounge');
    await setCredits(pilot, 10_000);
    await addCrew(pilot, { crewClass: 'GUNNER', quirkId: PLAIN, ...lean(100, 0) });
    await addCrew(pilot, { crewClass: 'PILOT', quirkId: PLAIN, ...lean(0, 100) });
    const roster = json(await call(pilot, 'GET', '/game/crew'));
    assert.deepEqual(
      [roster.berth.state, roster.berth.averageTension, roster.berth.moraleHit, roster.berth.crewCount],
      [BERTH_STATE.FRICTION, 100, 3, 2]
    );
    const moved = json(await call(pilot, 'POST', '/game/crew/standby', { crewId: roster.active[0].id, dockedReceipt: dockedReceipt(pilot) }));
    assert.equal(moved.berth.state, BERTH_STATE.NEUTRAL);
    assert.equal(moved.berth.averageTension, null);
  });

  test('a clean covert completion by a cohesive crew pays 5% more clandestine bonus', async () => {
    const pilot = await newPilot('Clean');
    await standing(pilot, 'alpha', 200); await standing(pilot, 'beta', 200);
    await addCrew(pilot, { crewClass: 'GUNNER', quirkId: PLAIN });
    await addCrew(pilot, { crewClass: 'PILOT', quirkId: PLAIN });
    const active = await take(pilot, covertOffer(pilot));
    const body = json(await complete(pilot, active, { rewardCredits: 3125 }));
    // The claim signs 2500 and the 625 bonus; cohesion adds 5% of the bonus.
    assert.deepEqual([body.clandestineBonusCredits, body.payout], [31, 3156]);

    const rivals = await newPilot('Rivals');
    await standing(rivals, 'alpha', 200); await standing(rivals, 'beta', 200);
    await addCrew(rivals, { crewClass: 'GUNNER', quirkId: PLAIN, ...lean(100, 0) });
    await addCrew(rivals, { crewClass: 'PILOT', quirkId: PLAIN, ...lean(0, 100) });
    const other = await take(rivals, covertOffer(rivals));
    const plain = json(await complete(rivals, other, { rewardCredits: 3125 }));
    assert.deepEqual([plain.clandestineBonusCredits, plain.payout], [undefined, 3125]);
  });
});

describe('partisan morale on a settled mission and a seizure (TEST-6.3)', () => {
  // Loyalties chosen so the berth is neither sour nor cohesive for these pairs.
  const LOYAL_ALPHA = lean(100, 50);
  const LOYAL_BETA = lean(50, 100);

  test('a mission for alpha cheers its loyalists and sours its dissenters, scaled by loyalty', async () => {
    const pilot = await newPilot('Partisan');
    const fan = await addCrew(pilot, { crewClass: 'GUNNER', quirkId: PLAIN, ...lean(100, 25) });
    const sour = await addCrew(pilot, { crewClass: 'PILOT', quirkId: PLAIN, ...lean(25, 100) });
    // Their berth: (75 + 75) / 2 / 1 pair is 75, friction. Compare against the friction-free part.
    const active = await take(pilot, research(pilot, { faction_id: 'alpha', reputation_change: 20 }));
    await setMorale(fan, 60); await setMorale(sour, 60);
    const body = json(await complete(pilot, active));
    // fan: +6 * 1.0 = +6; friction -3. sour: 6 * (25-50)/50 = -3; friction -3.
    assert.equal(effectOf(body, fan).partisanMoraleDelta, 6);
    assert.equal(effectOf(body, sour).partisanMoraleDelta, -3);
    assert.equal(await moraleOf(fan), 60 + 6 - 3);
    // The Pilot is used by the mission too (+4).
    assert.equal(await moraleOf(sour), 60 + 4 - 3 - 3);
  });

  test('a mission for a faction the crew are neutral to moves nobody', async () => {
    const pilot = await newPilot('Neutral');
    const a = await addCrew(pilot, { crewClass: 'GUNNER', quirkId: PLAIN, ...LOYAL_ALPHA });
    const b = await addCrew(pilot, { crewClass: 'PILOT', quirkId: PLAIN, ...LOYAL_BETA });
    const active = await take(pilot, research(pilot, { faction_id: 'gamma', reputation_change: 20 }));
    await setMorale(a, 60); await setMorale(b, 60);
    const body = json(await complete(pilot, active));
    assert.equal(effectOf(body, a)?.partisanMoraleDelta, undefined);
    assert.equal(effectOf(body, b)?.partisanMoraleDelta, undefined);
  });

  test('a detected covert run harms the rival: its loyalists lose 9 and its dissenters gain', async () => {
    const pilot = await newPilot('Detected');
    await standing(pilot, 'alpha', 200); await standing(pilot, 'beta', 200);
    const beta = await addCrew(pilot, { crewClass: 'GUNNER', quirkId: PLAIN, ...lean(50, 100) });
    const anti = await addCrew(pilot, { crewClass: 'PILOT', quirkId: PLAIN, ...lean(50, 0) });
    const active = await take(pilot, covertOffer(pilot));
    await setMorale(beta, 60); await setMorale(anti, 60);
    const body = json(await complete(pilot, active, {
      rewardCredits: 2500, wasDetected: true, exposureScoreMilli: 74500, opposedReputationChange: -20
    }));
    // Beta takes the harm (sign -1 * 9 * +1 = -9 for its loyalist, +9 for its dissenter); alpha's gain is neutral to both.
    assert.equal(effectOf(body, beta).partisanMoraleDelta, -9);
    assert.equal(effectOf(body, anti).partisanMoraleDelta, 9);
  });

  test('a covert run completed undetected moves the crew half as much', async () => {
    const pilot = await newPilot('Quiet');
    await standing(pilot, 'alpha', 200); await standing(pilot, 'beta', 200);
    const fan = await addCrew(pilot, { crewClass: 'GUNNER', quirkId: PLAIN, ...lean(100, 50) });
    const neutral = await addCrew(pilot, { crewClass: 'PILOT', quirkId: PLAIN, ...lean(50, 100) });
    const active = await take(pilot, covertOffer(pilot));
    await setMorale(fan, 60); await setMorale(neutral, 60);
    const body = json(await complete(pilot, active, { rewardCredits: 3125 }));
    assert.equal(effectOf(body, fan).partisanMoraleDelta, 3);
  });

  test('a customs seizure hurts the crew loyal to the factions that lost standing', async () => {
    const pilot = await newPilot('Seized');
    await standing(pilot, 'alpha', 300); await standing(pilot, 'beta', 300);
    const fan = await addCrew(pilot, { crewClass: 'GUNNER', quirkId: PLAIN, ...lean(100, 50) });
    const bystander = await addCrew(pilot, { crewClass: 'PILOT', quirkId: PLAIN, ...lean(50, 100) });
    const active = await take(pilot, covertOffer(pilot));
    await setMorale(fan, 80); await setMorale(bystander, 80);
    const claim = {
      pilotId: pilot.id, stationEntityId: randomUUID(), systemH3: '8828308281fffff', controllingFactionId: 'alpha',
      missionId: active.mission_id, inspectionOutcome: 4, captureTier: 2, exposureScoreMilli: 74500,
      seizedAtMs: Date.now() - 1000, nonce: randomBytes(16).toString('base64')
    };
    claim.signature = sign(null, canonicalCustomsSeizurePayload(claim), rtseKey).toString('base64');
    const res = await call(pilot, 'POST', '/game/missions/seizure', { claim });
    assert.equal(res.statusCode, 200, res.body);
    const body = json(res);
    const lost = body.reputation_changes.filter((c) => c.delta < 0).map((c) => c.faction_id);
    assert.deepEqual(lost, ['alpha']); // the sponsor and the governing faction are one, so one loss
    const effect = body.crew_morale.find((e) => e.crewId === fan.id);
    assert.equal(effect.partisanMoraleDelta, -9);
    assert.equal(effect.moraleLoss, 8); // the tier's own loss
    assert.equal(await moraleOf(fan), 80 - 8 - 9);
    assert.equal(await moraleOf(bystander), 80 - 8);
  });
});

describe('Flying Colors on the crew (route)', () => {
  const colors = (pilot, factionId) => call(pilot, 'POST', '/game/factions/colors', { factionId, dockedReceipt: dockedReceipt(pilot) });

  test('shifts the effective morale of loyalists and dissenters while flown, and never the stored one', async () => {
    const pilot = await newPilot('Colors');
    await standing(pilot, 'alpha', 600);
    const loyal = await addCrew(pilot, { crewClass: 'GUNNER', quirkId: PLAIN, morale: 70, ...lean(90, 50) });
    const dissent = await addCrew(pilot, { crewClass: 'PILOT', quirkId: PLAIN, morale: 70, ...lean(10, 50) });
    const neutral = await addCrew(pilot, { crewClass: 'SCIENCE', quirkId: PLAIN, morale: 70, ...lean(50, 50) });
    const idOf = (view, crew) => view.find((m) => m.id === crew.id);

    const before = json(await call(pilot, 'GET', '/game/crew')).active;
    assert.equal(idOf(before, loyal).effectiveMorale, undefined);

    const res = await colors(pilot, 'alpha');
    assert.equal(res.statusCode, 200, res.body);
    const flown = json(res);
    assert.deepEqual(flown.crew_morale.map((e) => [e.crewId, e.morale, e.effectiveMorale, e.moraleShift]).sort(),
      [[loyal.id, 70, 80, 10], [dissent.id, 70, 60, -10]].sort());

    const active = json(await call(pilot, 'GET', '/game/crew')).active;
    assert.deepEqual([idOf(active, loyal).morale, idOf(active, loyal).effectiveMorale], [70, 80]);
    assert.deepEqual([idOf(active, dissent).morale, idOf(active, dissent).effectiveMorale], [70, 60]);
    assert.deepEqual(idOf(active, loyal).colors, { factionId: 'alpha', moraleShift: 10 });
    assert.equal(idOf(active, neutral).effectiveMorale, undefined);
    for (const crew of [loyal, dissent, neutral]) assert.equal(await moraleOf(crew), 70);

    // Stopping the colors lifts it, nothing having been written.
    assert.equal((await colors(pilot, null)).statusCode, 200);
    const lifted = json(await call(pilot, 'GET', '/game/crew')).active;
    assert.equal(idOf(lifted, loyal).effectiveMorale, undefined);
    assert.equal(idOf(lifted, loyal).morale, 70);
  });

  test('the shifted morale crosses the class modifier bands in the token\'s ship attributes', async () => {
    const pilot = await newPilot('Bands');
    await standing(pilot, 'alpha', 600);
    // Pilot at 82 is Nominal (+8% speed). Loyal to alpha, the colors lift it to 92, Inspired (x1.15: +9.2%).
    await addCrew(pilot, { crewClass: 'PILOT', quirkId: PLAIN, morale: 82, ...lean(90, 50) });
    const flown = app.jwt.verify(json(await colors(pilot, 'alpha')).token).ship_attributes.max_speed_mps;
    const stopped = app.jwt.verify(json(await colors(pilot, null)).token).ship_attributes.max_speed_mps;
    assert.ok(flown > stopped, `${flown} vs ${stopped}`);
    assert.ok(Math.abs(flown / stopped - 1.092 / 1.08) < 1e-6, `${flown / stopped}`);
  });

  test('a dissenter at 55 falls to Disgruntled while the colors fly', async () => {
    const pilot = await newPilot('Disgruntled');
    await standing(pilot, 'alpha', 600);
    const dissent = await addCrew(pilot, { crewClass: 'PILOT', quirkId: PLAIN, morale: 55, ...lean(10, 50) });
    await colors(pilot, 'alpha');
    const view = json(await call(pilot, 'GET', '/game/crew')).active.find((m) => m.id === dissent.id);
    assert.equal(view.moraleBand, 'DISGRUNTLED');
    assert.equal(view.moraleMult, 0.6);
    assert.equal(view.morale, 55);
  });

  test('no colors, no shift, whatever the loyalties', async () => {
    const pilot = await newPilot('Plain');
    await addCrew(pilot, { crewClass: 'PILOT', quirkId: PLAIN, morale: 70, ...lean(100, 0) });
    const [view] = json(await call(pilot, 'GET', '/game/crew')).active;
    assert.equal(view.effectiveMorale, undefined);
    assert.equal(view.colors, undefined);
  });
});
