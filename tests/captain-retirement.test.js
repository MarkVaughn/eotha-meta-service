import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import {
  PASSWORD, addCrew, app, attestationHeaders, call, closeApp, credits, dockedReceipt, json, newPilot, receiptAtOrigin,
  setCredits, signedOffer
} from './helpers.js';
import {
  ACADEMY_RECRUIT_NAME,
  EARLY_DISCHARGE_FEE_CREDITS,
  HONORS_RETIRE_MIN_LEVEL,
  LEGACY_DOCTRINES,
  LEGACY_DOCTRINE_IDS,
  LEVEL_XP,
  MAX_ACTIVE_LEGACY_DOCTRINES,
  PROMOTE_CREW_MIN_MORALE,
  RETAIN_ALL_RETIRED_CAPTAINS,
  doctrineTierLimit,
  doctrineXpMult,
  retirementFeeCredits,
  retirementTierForLevel
} from '../src/config/captain.js';
import { computeShipAttributes } from '../src/config/components.js';
import { innateEffectId, innateJuryRigTypes } from '../src/config/crew.js';
import { awardCaptainXp, effectIdsFor } from '../src/lib/captain.js';

before(async () => { await app.ready(); });
after(async () => { await closeApp(); });

const LV1 = 0;
const LV3 = LEVEL_XP[2];
const LV8 = LEVEL_XP[7];
const LV10 = LEVEL_XP[9];
const NEUTRAL_QUIRK = 'Q08'; // Nervous Tell: no morale, class or wage terms
const AMBITIOUS = 'Q11';
const COOL_HEADED = 'Q04';

const tokenClaims = (res) => app.jwt.verify(json(res).token);
const captainRow = (pilot) => app.prisma.captain.findUnique({ where: { playerId: pilot.id } });
const retiredRows = (pilot) => app.prisma.retiredCaptain.findMany({ where: { playerId: pilot.id }, orderBy: { retiredAt: 'asc' } });
const crewRows = (pilot) => app.prisma.crewMember.findMany({ where: { playerId: pilot.id } });

// A pilot whose Captain has `xp` (and the level it gives) and the unlocked `traits`.
async function pilotWith(xp, { traits = [], prefix = 'Retire' } = {}) {
  const pilot = await newPilot(prefix);
  await call(pilot, 'GET', '/game/captain'); // creates the Captain
  const level = LEVEL_XP.filter((needed) => xp >= needed).length;
  await app.prisma.captain.update({ where: { playerId: pilot.id }, data: { xp, level, unlockedTraits: traits, missionsCompleted: 7 } });
  return pilot;
}

const retire = (pilot, body = {}, receipt = dockedReceipt(pilot)) =>
  call(pilot, 'POST', '/game/captain/retire', { successorType: 'ACADEMY_RECRUIT', dockedReceipt: receipt, ...body });
const doctrine = (pilot, body, receipt = dockedReceipt(pilot)) =>
  call(pilot, 'POST', '/game/captain/doctrine', { dockedReceipt: receipt, ...body });

// Everything a refused request must leave alone.
async function snapshot(pilot) {
  return JSON.stringify({
    captain: await captainRow(pilot),
    retired: await retiredRows(pilot),
    crew: await crewRows(pilot),
    credits: await credits(pilot)
  });
}

describe('retirement config', () => {
  test('pins the plan constants', () => {
    assert.equal(HONORS_RETIRE_MIN_LEVEL, 8);
    assert.equal(EARLY_DISCHARGE_FEE_CREDITS, 1000);
    assert.equal(MAX_ACTIVE_LEGACY_DOCTRINES, 2);
    assert.equal(PROMOTE_CREW_MIN_MORALE, 80);
    assert.equal(RETAIN_ALL_RETIRED_CAPTAINS, true);
  });

  test('a level picks its tier, its fee and its doctrine tier', () => {
    assert.deepEqual([1, 7, 8, 9, 10].map(retirementTierForLevel), ['EARLY_DISCHARGE', 'EARLY_DISCHARGE', 'HONORS', 'HONORS', 'MASTER']);
    assert.deepEqual(['EARLY_DISCHARGE', 'HONORS', 'MASTER'].map(retirementFeeCredits), [1000, 0, 0]);
    assert.deepEqual(['EARLY_DISCHARGE', 'HONORS', 'MASTER'].map(doctrineTierLimit), [0, 1, 2]);
  });

  test('three perks, each in two tiers, the second twice as strong', () => {
    assert.equal(LEGACY_DOCTRINE_IDS.length, 6);
    assert.equal(LEGACY_DOCTRINES.LEGACY_XP_BOOST.xpMult, 1.1);
    assert.equal(LEGACY_DOCTRINES.LEGACY_XP_BOOST_II.xpMult, 1.2);
    assert.equal(LEGACY_DOCTRINES.LEGACY_DOCKING_SPEED.ship.docking_time_mult.mult, 0.9);
    assert.equal(LEGACY_DOCTRINES.LEGACY_WAGE_CUT.crew.wageMult, 0.9);
    assert.deepEqual(LEGACY_DOCTRINE_IDS.filter((id) => LEGACY_DOCTRINES[id].tier === 2), LEGACY_DOCTRINE_IDS.filter((id) => id.endsWith('_II')));
  });

  test('doctrine ids are Captain XP, wage and docking effects only while named among the effect ids', async () => {
    assert.equal(doctrineXpMult(['LEGACY_XP_BOOST', 'H1_TRIM_THRUSTERS']), 1.1);
    assert.equal(doctrineXpMult(['LEGACY_XP_BOOST', 'LEGACY_XP_BOOST_II']), 1.1 * 1.2);
    assert.equal(computeShipAttributes([], 0, ['LEGACY_DOCKING_SPEED']).docking_time_mult, 0.9);
    assert.equal(computeShipAttributes([], 0, ['LEGACY_DOCKING_SPEED', 'H2_HARBOR_PILOT']).docking_time_mult, 0.72);
    assert.equal(computeShipAttributes([], 0, []).docking_time_mult, 1);
  });

  test('a doctrine multiplies the XP an award adds, rounded down', async () => {
    const pilot = await pilotWith(LV1);
    const captain = await captainRow(pilot);
    assert.deepEqual(await awardCaptainXp(app.prisma, captain, 105, { traits: ['LEGACY_XP_BOOST'] }), {
      xpGained: 115, currentLevel: 1, traitPointsAvailable: 0
    });
    assert.equal((await captainRow(pilot)).xp, 115);
    assert.equal((await awardCaptainXp(app.prisma, await captainRow(pilot), 100, { traits: ['LEGACY_XP_BOOST_II'] })).xpGained, 120);
    assert.equal((await awardCaptainXp(app.prisma, await captainRow(pilot), 100)).xpGained, 100);
  });
});

describe('POST /game/captain/retire', () => {
  test('requires a login and a valid body', async () => {
    assert.equal((await app.inject({ method: 'POST', url: '/game/captain/retire', payload: { successorType: 'ACADEMY_RECRUIT' } })).statusCode, 401);
    const pilot = await pilotWith(LV8);
    for (const body of [{ successorType: 'BOSS' }, { retirementTier: 'RETIRED' }, { legacyDoctrineId: 'LEGACY_MAGIC' }, { successorCrewId: 'nope' }, { successorName: '   ' }]) {
      const res = await call(pilot, 'POST', '/game/captain/retire', { successorType: 'ACADEMY_RECRUIT', dockedReceipt: dockedReceipt(pilot), ...body });
      assert.equal(res.statusCode, 400, JSON.stringify(body));
    }
    assert.equal((await call(pilot, 'POST', '/game/captain/retire', { dockedReceipt: dockedReceipt(pilot) })).statusCode, 400);
    assert.equal((await retiredRows(pilot)).length, 0);
  });

  test('ASSERT-4.1.1: an honors retirement archives the captain, starts a Level 1 successor and activates the doctrine', async () => {
    const pilot = await pilotWith(LV8, { traits: ['H1_TRIM_THRUSTERS', 'H2_HARBOR_PILOT'] });
    const receipt = dockedReceipt(pilot);
    const res = await retire(pilot, { retirementTier: 'HONORS', legacyDoctrineId: 'LEGACY_XP_BOOST', successorType: 'ACADEMY_RECRUIT' }, receipt);
    assert.equal(res.statusCode, 200, res.body);
    const body = json(res);
    assert.equal(body.retirementTier, 'HONORS');
    assert.equal(body.feeCredits, 0);
    assert.equal(body.doctrine.id, 'LEGACY_XP_BOOST');
    assert.equal(body.doctrine.active, true);
    assert.deepEqual(body.resigned, []);
    assert.equal(body.captain.level, 1);
    assert.equal(body.captain.xp, 0);
    assert.equal(body.captain.name, ACADEMY_RECRUIT_NAME);
    assert.equal(body.captain.originType, 'ACADEMY_RECRUIT');
    assert.deepEqual(body.captain.unlockedTraits, []);
    assert.equal(body.captain.missionsCompleted, 0);

    const [row, ...others] = await retiredRows(pilot);
    assert.equal(others.length, 0);
    assert.equal(row.finalLevel, 8);
    assert.equal(row.finalXp, LV8);
    assert.equal(row.retirementTier, 'HONORS');
    assert.equal(row.legacyDoctrineId, 'LEGACY_XP_BOOST');
    assert.equal(row.activeDoctrine, true);
    assert.equal(row.missionsCompleted, 7);
    assert.deepEqual(row.unlockedTraits, ['H1_TRIM_THRUSTERS', 'H2_HARBOR_PILOT']);
    assert.equal(row.capstoneTraitId, null);
    assert.equal(row.assignmentStatus, 'RETIRED_IDLE');
    assert.equal(row.assignedSpaceshipId, null);
    assert.equal(row.retiredAtStationId, receipt.dockedEntityId);
    assert.equal(row.retiredAtSystemH3, receipt.systemH3);
    assert.equal(body.retiredCaptain.id, row.id);

    const stored = await captainRow(pilot);
    assert.equal(stored.xp, 0);
    assert.equal(stored.level, 1);
    assert.deepEqual(stored.unlockedTraits, []);
    assert.equal(stored.originType, 'ACADEMY_RECRUIT');
    // The old captain's traits left with it; the token the engine adopts says so.
    assert.equal(tokenClaims(res).ship_attributes.max_speed_mps, 20);
    assert.equal(tokenClaims(res).ship_attributes.docking_time_mult, 1);
    assert.deepEqual(tokenClaims(res).ship_attributes, body.ship_attributes);
  });

  test('a retired captain\'s doctrine speeds docking, signed into the token and into a fresh login', async () => {
    const pilot = await pilotWith(LV8);
    const res = await retire(pilot, { legacyDoctrineId: 'LEGACY_DOCKING_SPEED' });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(tokenClaims(res).ship_attributes.docking_time_mult, 0.9);
    const login = await app.inject({
      method: 'POST', url: '/auth/login', headers: attestationHeaders,
      payload: { email: pilot.email, password: PASSWORD, deviceId: 'retire-login-device' }
    });
    assert.equal(login.statusCode, 200, login.body);
    assert.equal(tokenClaims(login).ship_attributes.docking_time_mult, 0.9);
    assert.equal(json(await call(pilot, 'GET', '/ship/loadout')).ship_attributes.docking_time_mult, 0.9);
  });

  test('the wage doctrine lowers crew wage shares for the successor too', async () => {
    const pilot = await pilotWith(LV8);
    await addCrew(pilot, { quirkId: NEUTRAL_QUIRK });
    assert.equal(json(await call(pilot, 'GET', '/game/crew')).active[0].effectiveWageShareBp, 500);
    assert.equal((await retire(pilot, { legacyDoctrineId: 'LEGACY_WAGE_CUT' })).statusCode, 200);
    assert.equal(json(await call(pilot, 'GET', '/game/crew')).active[0].effectiveWageShareBp, 450);
  });

  test('ASSERT-4.1.2: promoting a Master Engineer removes it from the crew and carries its class and quirk into the token', async () => {
    const pilot = await pilotWith(LV10);
    const engineer = await addCrew(pilot, { name: 'Mara Vell', crewClass: 'ENGINEER', rank: 'MASTER', morale: 85, quirkId: COOL_HEADED, wageShareBp: 1200 });
    const res = await retire(pilot, { successorType: 'PROMOTED_CREW', successorCrewId: engineer.id });
    assert.equal(res.statusCode, 200, res.body);
    const body = json(res);
    assert.equal(body.retirementTier, 'MASTER');
    assert.equal(body.captain.name, 'Mara Vell');
    assert.equal(body.captain.originType, 'PROMOTED_CREW');
    assert.deepEqual(body.captain.innate, {
      crewClass: 'ENGINEER', rank: 'MASTER', quirkId: COOL_HEADED, juryRig: { slots: 2, selectedComponentTypes: [] }
    });
    assert.equal(body.promoted.crewId, engineer.id);

    assert.equal((await retiredRows(pilot)).length, 1);
    assert.deepEqual(await crewRows(pilot), []);
    assert.deepEqual(json(await call(pilot, 'GET', '/game/crew')).active, []);
    const stored = await captainRow(pilot);
    assert.deepEqual(
      [stored.originType, stored.promotedFromCrewId, stored.innateClass, stored.innateRank, stored.quirkId, stored.level, stored.xp],
      ['PROMOTED_CREW', engineer.id, 'ENGINEER', 'MASTER', COOL_HEADED, 1, 0]
    );

    // Master Engineer terms at the Nominal band, plus COOL_HEADED's +3%: +50 x 1.03 Hz, energy regen x (1 + 0.65 x 1.03).
    const attributes = tokenClaims(res).ship_attributes;
    assert.equal(attributes.tuning_tolerance_hz, 151.5);
    assert.equal(attributes.energy_regen_rate, 16.695);
    assert.equal(attributes.extraction_rate_mult, 1.3605);
    // The seat is not a berth, and the member's bunk is free again.
    assert.equal(attributes.crew_aboard, 0);
    assert.equal(attributes.crew_capability_flags, 0);
    assert.equal(attributes.ion_fog_shield_resist, 0);
    assert.deepEqual(attributes, computeShipAttributes(
      (await call(pilot, 'GET', '/ship/loadout').then(json)).components, 0,
      effectIdsFor(stored), []
    ));
    assert.equal(json(await call(pilot, 'GET', '/game/crew')).limits.freeBerths, 3);
  });

  test('the innate class keeps working through later token reissues: trait unlocks and a fresh login', async () => {
    const pilot = await pilotWith(LV10);
    const pilotMember = await addCrew(pilot, { name: 'Ro Tane', crewClass: 'PILOT', rank: 'MASTER', morale: 90, quirkId: 'Q01' });
    const res = await retire(pilot, { successorType: 'PROMOTED_CREW', successorCrewId: pilotMember.id, legacyDoctrineId: 'LEGACY_DOCKING_SPEED_II' });
    assert.equal(res.statusCode, 200, res.body);
    // Master Pilot: +25% speed (Mach 1 stays the ceiling), -40% docking time; the doctrine takes 20% more off (floor 0.5).
    assert.equal(tokenClaims(res).ship_attributes.max_speed_mps, 25);
    assert.equal(tokenClaims(res).ship_attributes.docking_time_mult, 0.5);

    await app.prisma.captain.update({ where: { playerId: pilot.id }, data: { xp: LEVEL_XP[1], level: 2 } });
    const unlock = await call(pilot, 'POST', '/game/captain/trait', { traitId: 'H1_TRIM_THRUSTERS', dockedReceipt: dockedReceipt(pilot) });
    assert.equal(unlock.statusCode, 200, unlock.body);
    assert.equal(tokenClaims(unlock).ship_attributes.max_speed_mps, 27);
    assert.equal(tokenClaims(unlock).ship_attributes.docking_time_mult, 0.5);
    assert.deepEqual((await captainRow(pilot)).unlockedTraits, ['H1_TRIM_THRUSTERS']);

    const login = await app.inject({
      method: 'POST', url: '/auth/login', headers: attestationHeaders,
      payload: { email: pilot.email, password: PASSWORD, deviceId: 'innate-login-device' }
    });
    assert.equal(tokenClaims(login).ship_attributes.max_speed_mps, 27);
    assert.equal(json(await call(pilot, 'GET', '/game/captain')).captain.innate.crewClass, 'PILOT');
  });

  test('standby crew can succeed too, freeing the standby slot', async () => {
    const pilot = await pilotWith(LV8);
    const navigator = await addCrew(pilot, { crewClass: 'NAVIGATOR', rank: 'ADEPT', morale: 80, status: 'STANDBY', spaceshipId: null });
    const res = await retire(pilot, { successorType: 'PROMOTED_CREW', successorCrewId: navigator.id });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(json(res).captain.innate.rank, 'ADEPT');
    assert.deepEqual(await crewRows(pilot), []);
  });

  test('ASSERT-4.1.3: a passed-over AMBITIOUS Master resigns, on the ship or on standby; an Adept or the chosen one stays', async () => {
    const pilot = await pilotWith(LV10);
    const ambitiousPilot = await addCrew(pilot, { crewClass: 'PILOT', rank: 'MASTER', quirkId: AMBITIOUS, morale: 90 });
    const chef = await addCrew(pilot, { name: 'Good Chef', crewClass: 'CHEF', rank: 'MASTER', quirkId: 'Q01', morale: 90 });
    const standbyNavigator = await addCrew(pilot, { crewClass: 'NAVIGATOR', rank: 'MASTER', quirkId: AMBITIOUS, morale: 10, status: 'STANDBY', spaceshipId: null });
    const adept = await addCrew(pilot, { crewClass: 'GUNNER', rank: 'ADEPT', quirkId: AMBITIOUS, morale: 90 });
    const res = await retire(pilot, { successorType: 'PROMOTED_CREW', successorCrewId: chef.id });
    assert.equal(res.statusCode, 200, res.body);
    assert.deepEqual(json(res).resigned.map((r) => r.crewId).sort(), [ambitiousPilot.id, standbyNavigator.id].sort());
    assert.deepEqual((await crewRows(pilot)).map((m) => m.id), [adept.id]);
    assert.equal(json(res).captain.name, 'Good Chef');
    assert.equal(tokenClaims(res).ship_attributes.crew_aboard, 1);
  });

  test('an AMBITIOUS Master who is chosen stays captain material, and an Academy successor passes every one over', async () => {
    const chosen = await pilotWith(LV8);
    const master = await addCrew(chosen, { crewClass: 'SCIENCE', rank: 'MASTER', quirkId: AMBITIOUS, morale: 95 });
    const res = await retire(chosen, { successorType: 'PROMOTED_CREW', successorCrewId: master.id });
    assert.equal(res.statusCode, 200, res.body);
    assert.deepEqual(json(res).resigned, []);
    assert.equal((await captainRow(chosen)).quirkId, AMBITIOUS);

    const academy = await pilotWith(LV8);
    await addCrew(academy, { crewClass: 'SCIENCE', rank: 'MASTER', quirkId: AMBITIOUS });
    assert.equal(json(await retire(academy)).resigned.length, 1);
    assert.deepEqual(await crewRows(academy), []);
  });

  test('ASSERT-4.1.4: a successor below 80 morale is refused and nothing changes', async () => {
    const pilot = await pilotWith(LV8);
    const navigator = await addCrew(pilot, { crewClass: 'NAVIGATOR', rank: 'ADEPT', morale: 74 });
    const before = await snapshot(pilot);
    const res = await retire(pilot, { successorType: 'PROMOTED_CREW', successorCrewId: navigator.id, legacyDoctrineId: 'LEGACY_XP_BOOST' });
    assert.equal(res.statusCode, 400);
    assert.deepEqual(
      { error: json(res).error, minMorale: json(res).minMorale, currentMorale: json(res).currentMorale },
      { error: 'insufficient_morale_for_promotion', minMorale: 80, currentMorale: 74 }
    );
    assert.equal(await snapshot(pilot), before);

    await app.prisma.crewMember.update({ where: { id: navigator.id }, data: { morale: 80 } });
    assert.equal((await retire(pilot, { successorType: 'PROMOTED_CREW', successorCrewId: navigator.id })).statusCode, 200);
  });

  test('successors must be the pilot\'s own Adepts or Masters, named exactly when promoting', async () => {
    const pilot = await pilotWith(LV8);
    const novice = await addCrew(pilot, { crewClass: 'CHEF', rank: 'NOVICE', morale: 100 });
    const stranger = await pilotWith(LV1, { prefix: 'Stranger' });
    const strangerMaster = await addCrew(stranger, { crewClass: 'PILOT', rank: 'MASTER', morale: 100 });
    const before = [await snapshot(pilot), await snapshot(stranger)];

    const cases = [
      [{ successorType: 'PROMOTED_CREW' }, 400, 'successor_crew_required'],
      [{ successorType: 'ACADEMY_RECRUIT', successorCrewId: novice.id }, 400, 'successor_crew_not_allowed'],
      [{ successorType: 'PROMOTED_CREW', successorCrewId: novice.id, successorName: 'Alias' }, 400, 'successor_name_not_allowed'],
      [{ successorType: 'PROMOTED_CREW', successorCrewId: randomUUID() }, 404, 'crew_not_found'],
      [{ successorType: 'PROMOTED_CREW', successorCrewId: strangerMaster.id }, 404, 'crew_not_found'],
      [{ successorType: 'PROMOTED_CREW', successorCrewId: novice.id }, 400, 'insufficient_rank_for_promotion']
    ];
    for (const [body, status, error] of cases) {
      const res = await retire(pilot, body);
      assert.equal(res.statusCode, status, JSON.stringify(body));
      assert.equal(json(res).error, error);
    }
    assert.deepEqual([await snapshot(pilot), await snapshot(stranger)], before);
  });

  test('ASSERT-4.1.5: the archive keeps the capstone, the standings and the primary faction', async () => {
    const pilot = await pilotWith(LV10, { traits: ['S1_LONG_BASELINE', 'S2_PULSE_CYCLING', 'S3_RESONANCE_EAR', 'S4_DEEP_SURVEYOR', 'S6_ASTROGATOR_PRIME'] });
    for (const [factionId, standing] of [['alpha', 480], ['beta', -210], ['gamma', 120]]) {
      await app.prisma.playerReputation.create({ data: { playerId: pilot.id, factionId, standing } });
    }
    const res = await retire(pilot, { legacyDoctrineId: 'LEGACY_XP_BOOST_II' });
    assert.equal(res.statusCode, 200, res.body);
    const [row] = await retiredRows(pilot);
    assert.equal(row.capstoneTraitId, 'S6_ASTROGATOR_PRIME');
    assert.deepEqual(row.factionStandingsSnapshot, { alpha: 480, beta: -210, gamma: 120 });
    assert.equal(row.primaryFactionId, 'alpha');
    assert.equal(row.retirementTier, 'MASTER');
    assert.equal(row.legacyDoctrineId, 'LEGACY_XP_BOOST_II');
    // Standings belong to the pilot, not the captain.
    assert.equal((await app.prisma.playerReputation.findUnique({ where: { playerId_factionId: { playerId: pilot.id, factionId: 'alpha' } } })).standing, 480);
  });

  test('no standing above neutral means no primary faction', async () => {
    const pilot = await pilotWith(LV8);
    await app.prisma.playerReputation.create({ data: { playerId: pilot.id, factionId: 'beta', standing: -50 } });
    assert.equal((await retire(pilot)).statusCode, 200);
    const [row] = await retiredRows(pilot);
    assert.deepEqual(row.factionStandingsSnapshot, { alpha: 0, beta: -50, gamma: 0 });
    assert.equal(row.primaryFactionId, null);
  });

  test('an early discharge costs 1,000 credits, must be named and unlocks no doctrine', async () => {
    const pilot = await pilotWith(LV3);
    await setCredits(pilot, 5000);
    const before = await snapshot(pilot);

    let res = await retire(pilot);
    assert.equal(res.statusCode, 400);
    assert.equal(json(res).error, 'retirement_tier_required');
    assert.equal(json(res).feeCredits, 1000);
    res = await retire(pilot, { retirementTier: 'EARLY_DISCHARGE', legacyDoctrineId: 'LEGACY_XP_BOOST' });
    assert.equal(res.statusCode, 400);
    assert.equal(json(res).error, 'doctrine_not_available');
    assert.equal(await snapshot(pilot), before);

    res = await retire(pilot, { retirementTier: 'EARLY_DISCHARGE' });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(json(res).feeCredits, 1000);
    assert.equal(json(res).credits, 4000);
    assert.equal(await credits(pilot), 4000);
    const [row] = await retiredRows(pilot);
    assert.deepEqual(
      [row.retirementTier, row.finalLevel, row.legacyDoctrineId, row.activeDoctrine],
      ['EARLY_DISCHARGE', 3, null, false]
    );
    assert.equal(json(res).doctrine, undefined);
  });

  test('an early discharge the pilot cannot pay for is refused whole', async () => {
    const pilot = await pilotWith(LV3);
    const engineer = await addCrew(pilot, { crewClass: 'ENGINEER', rank: 'ADEPT', morale: 90 });
    await setCredits(pilot, 999);
    const before = await snapshot(pilot);
    const res = await retire(pilot, { retirementTier: 'EARLY_DISCHARGE', successorType: 'PROMOTED_CREW', successorCrewId: engineer.id });
    assert.equal(res.statusCode, 402);
    assert.equal(json(res).error, 'insufficient_credits');
    assert.equal(json(res).requiredCredits, 1000);
    assert.equal(await snapshot(pilot), before);
  });

  test('the tier must be the one the level qualifies for', async () => {
    for (const [xp, tier, eligible] of [
      [LEVEL_XP[6], 'HONORS', 'EARLY_DISCHARGE'], [LV8, 'EARLY_DISCHARGE', 'HONORS'], [LV8, 'MASTER', 'HONORS'],
      [LEVEL_XP[8], 'MASTER', 'HONORS'], [LV10, 'HONORS', 'MASTER']
    ]) {
      const pilot = await pilotWith(xp);
      await setCredits(pilot, 5000);
      const before = await snapshot(pilot);
      const res = await retire(pilot, { retirementTier: tier });
      assert.equal(res.statusCode, 400, `${xp} ${tier}`);
      assert.equal(json(res).error, 'retirement_tier_mismatch');
      assert.equal(json(res).eligibleTier, eligible);
      assert.equal(await snapshot(pilot), before);
    }
  });

  test('Tier II doctrines need a master retirement', async () => {
    const honors = await pilotWith(LV8);
    const before = await snapshot(honors);
    const res = await retire(honors, { legacyDoctrineId: 'LEGACY_XP_BOOST_II' });
    assert.equal(res.statusCode, 400);
    assert.equal(json(res).error, 'doctrine_tier_locked');
    assert.equal(await snapshot(honors), before);

    const master = await pilotWith(LV10);
    assert.equal((await retire(master, { legacyDoctrineId: 'LEGACY_XP_BOOST_II' })).statusCode, 200);
    const tierOne = await pilotWith(LV10);
    assert.equal((await retire(tierOne, { legacyDoctrineId: 'LEGACY_XP_BOOST' })).statusCode, 200);
  });

  test('a honors retirement may leave its doctrine slot empty to fill later', async () => {
    const pilot = await pilotWith(LV8);
    const res = await retire(pilot);
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(json(res).doctrine, undefined);
    const [row] = await retiredRows(pilot);
    assert.deepEqual([row.legacyDoctrineId, row.activeDoctrine], [null, false]);
  });

  test('refuses while a mission is held', async () => {
    const pilot = await pilotWith(LV8);
    const offer = signedOffer(pilot, { type: 'MISSION_TYPE_RESEARCH', required_berths: 0 });
    assert.equal((await call(pilot, 'POST', '/game/missions/accept', { offer, dockedReceipt: receiptAtOrigin(pilot, offer) })).statusCode, 200);
    const before = await snapshot(pilot);
    const res = await retire(pilot);
    assert.equal(res.statusCode, 409);
    assert.equal(json(res).error, 'captain_locked_by_active_mission');
    assert.equal(await snapshot(pilot), before);
  });

  describe('docked trust', () => {
    test('a receipt is required, and must be genuine, fresh, the pilot\'s and for the station named', async () => {
      const pilot = await pilotWith(LV8);
      const other = await newPilot('Other');
      const forged = generateKeyPairSync('ed25519').privateKey;
      const before = await snapshot(pilot);
      const now = Date.now();
      const cases = [
        [undefined, 'docked_receipt_required', {}],
        [dockedReceipt(pilot, {}, forged), 'docked_receipt_invalid', {}],
        [dockedReceipt(other), 'docked_receipt_invalid', {}],
        [dockedReceipt(pilot, { issuedAtMs: now - 60_000, dockedAtMs: now - 62_000 }), 'docked_receipt_required', {}],
        [dockedReceipt(pilot, { issuedAtMs: now + 60_000 }), 'docked_receipt_required', {}],
        [dockedReceipt(pilot), 'docked_receipt_wrong_station', { stationId: randomUUID() }]
      ];
      for (const [receipt, code, extra] of cases) {
        const res = await call(pilot, 'POST', '/game/captain/retire', { successorType: 'ACADEMY_RECRUIT', ...extra, ...(receipt && { dockedReceipt: receipt }) });
        assert.equal(res.statusCode, 403, code);
        assert.equal(json(res).error, code);
      }
      // A receipt whose signature was tampered with, or issued for another station, no longer verifies.
      const tampered = { ...dockedReceipt(pilot), dockedEntityId: randomUUID() };
      assert.equal(json(await retire(pilot, {}, tampered)).error, 'docked_receipt_invalid');
      assert.equal(await snapshot(pilot), before);
    });

    test('a matching stationId passes; a receipt older than the last dock the ship settled is stale', async () => {
      const pilot = await pilotWith(LV8);
      await call(pilot, 'GET', '/ship/loadout');
      const receipt = dockedReceipt(pilot);
      await app.prisma.spaceship.updateMany({ where: { playerId: pilot.id }, data: { lastCrewDockedAtMs: BigInt(receipt.dockedAtMs) + 1n } });
      const before = await snapshot(pilot);
      const stale = await retire(pilot, { stationId: receipt.dockedEntityId }, receipt);
      assert.equal(stale.statusCode, 403);
      assert.equal(json(stale).error, 'docked_receipt_stale');
      assert.equal(await snapshot(pilot), before);

      await app.prisma.spaceship.updateMany({ where: { playerId: pilot.id }, data: { lastCrewDockedAtMs: BigInt(receipt.dockedAtMs) } });
      assert.equal((await retire(pilot, { stationId: receipt.dockedEntityId }, receipt)).statusCode, 200);
    });
  });

  describe('retries and replays', () => {
    test('the same receipt twice retires once and answers the second with the first', async () => {
      const pilot = await pilotWith(LV8);
      const receipt = dockedReceipt(pilot);
      const body = { retirementTier: 'HONORS', legacyDoctrineId: 'LEGACY_XP_BOOST' };
      const first = await retire(pilot, body, receipt);
      assert.equal(first.statusCode, 200, first.body);
      const again = await retire(pilot, body, receipt);
      assert.equal(again.statusCode, 200, again.body);
      assert.equal(json(again).replayed, true);
      assert.equal(json(again).retiredCaptain.id, json(first).retiredCaptain.id);
      assert.equal(json(again).captain.level, 1);
      assert.ok(tokenClaims(again).ship_attributes);
      assert.equal((await retiredRows(pilot)).length, 1);
      assert.equal((await captainRow(pilot)).originType, 'ACADEMY_RECRUIT');
    });

    test('an early discharge retried with its receipt is charged once and never discharges the successor', async () => {
      const pilot = await pilotWith(LV3);
      await setCredits(pilot, 3000);
      const receipt = dockedReceipt(pilot);
      assert.equal((await retire(pilot, { retirementTier: 'EARLY_DISCHARGE' }, receipt)).statusCode, 200);
      const again = await retire(pilot, { retirementTier: 'EARLY_DISCHARGE' }, receipt);
      assert.equal(again.statusCode, 200);
      assert.equal(json(again).replayed, true);
      assert.equal(await credits(pilot), 2000);
      assert.equal((await retiredRows(pilot)).length, 1);
    });

    test('a replayed promotion does not look for the successor again', async () => {
      const pilot = await pilotWith(LV8);
      const member = await addCrew(pilot, { crewClass: 'GUNNER', rank: 'MASTER', morale: 99, quirkId: 'Q01' });
      const receipt = dockedReceipt(pilot);
      const body = { successorType: 'PROMOTED_CREW', successorCrewId: member.id };
      assert.equal((await retire(pilot, body, receipt)).statusCode, 200);
      const again = await retire(pilot, body, receipt);
      assert.equal(again.statusCode, 200);
      assert.equal(json(again).replayed, true);
      assert.equal((await captainRow(pilot)).innateClass, 'GUNNER');
    });

    test('a fresh request after a retirement retires the successor only when it asks for the fee tier', async () => {
      const pilot = await pilotWith(LV8);
      assert.equal((await retire(pilot)).statusCode, 200);
      const ambiguous = await retire(pilot);
      assert.equal(ambiguous.statusCode, 400);
      assert.equal(json(ambiguous).error, 'retirement_tier_required');
      const honors = await retire(pilot, { retirementTier: 'HONORS' });
      assert.equal(honors.statusCode, 400);
      assert.equal(json(honors).error, 'retirement_tier_mismatch');
      assert.equal((await retiredRows(pilot)).length, 1);
    });

    test('simultaneous duplicates retire once', async () => {
      const pilot = await pilotWith(LV8);
      const receipt = dockedReceipt(pilot);
      const results = await Promise.all(Array.from({ length: 4 }, () => retire(pilot, { retirementTier: 'HONORS', legacyDoctrineId: 'LEGACY_XP_BOOST' }, receipt)));
      assert.deepEqual(results.map((res) => res.statusCode), [200, 200, 200, 200]);
      assert.equal(results.filter((res) => !json(res).replayed).length, 1);
      assert.equal((await retiredRows(pilot)).length, 1);
    });

    test('another pilot\'s receipt nonce is its own: nonces are keyed per pilot', async () => {
      const first = await pilotWith(LV8);
      const second = await pilotWith(LV8);
      const nonce = Buffer.alloc(16, 7).toString('base64');
      assert.equal((await retire(first, {}, dockedReceipt(first, { nonce }))).statusCode, 200);
      const res = await retire(second, {}, dockedReceipt(second, { nonce }));
      assert.equal(res.statusCode, 200);
      assert.equal(json(res).replayed, undefined);
    });
  });

  test('a failure part-way rolls back the fee, the archive, the crew and the captain', async () => {
    const pilot = await pilotWith(LV3);
    await setCredits(pilot, 5000);
    const chosen = await addCrew(pilot, { crewClass: 'ENGINEER', rank: 'MASTER', morale: 90, quirkId: 'Q01' });
    await addCrew(pilot, { crewClass: 'PILOT', rank: 'MASTER', morale: 90, quirkId: AMBITIOUS });
    const before = await snapshot(pilot);
    const name = `fail_retire_${pilot.id.replaceAll('-', '')}`;
    // The captain's update is the last write of the transaction; make it fail after everything else was written.
    await app.prisma.$executeRawUnsafe(`CREATE FUNCTION "${name}"() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'injected failure'; END $$ LANGUAGE plpgsql`);
    await app.prisma.$executeRawUnsafe(`CREATE TRIGGER "${name}" BEFORE UPDATE ON "Captain" FOR EACH ROW WHEN (OLD."playerId" = '${pilot.id}') EXECUTE FUNCTION "${name}"()`);
    try {
      const body = { retirementTier: 'EARLY_DISCHARGE', successorType: 'PROMOTED_CREW', successorCrewId: chosen.id };
      const receipt = dockedReceipt(pilot);
      const res = await retire(pilot, body, receipt);
      assert.equal(res.statusCode, 500);
      assert.equal(await snapshot(pilot), before);
      assert.equal(await credits(pilot), 5000);
    } finally {
      await app.prisma.$executeRawUnsafe(`DROP TRIGGER "${name}" ON "Captain"`);
      await app.prisma.$executeRawUnsafe(`DROP FUNCTION "${name}"()`);
    }
    // Nothing was kept, so the same request now goes through.
    const retry = await retire(pilot, { retirementTier: 'EARLY_DISCHARGE', successorType: 'PROMOTED_CREW', successorCrewId: chosen.id });
    assert.equal(retry.statusCode, 200, retry.body);
    assert.equal(await credits(pilot), 4000);
    assert.equal((await retiredRows(pilot)).length, 1);
    assert.deepEqual(await crewRows(pilot), []);
  });

  test('retirements are kept: the history lists every captain, oldest first, for its own pilot only', async () => {
    const pilot = await pilotWith(LV8);
    await setCredits(pilot, 5000);
    assert.equal((await retire(pilot, { legacyDoctrineId: 'LEGACY_XP_BOOST' })).statusCode, 200);
    await app.prisma.captain.update({ where: { playerId: pilot.id }, data: { xp: LV3, level: 3, name: 'Second' } });
    assert.equal((await retire(pilot, { retirementTier: 'EARLY_DISCHARGE' })).statusCode, 200);

    const res = await call(pilot, 'GET', '/game/captain/retired');
    assert.equal(res.statusCode, 200);
    const body = json(res);
    assert.deepEqual(body.retiredCaptains.map((c) => [c.finalLevel, c.retirementTier]), [[8, 'HONORS'], [3, 'EARLY_DISCHARGE']]);
    assert.equal(body.retiredCaptains[1].name, 'Second');
    assert.equal(body.retiredCaptains[0].legacyDoctrine.id, 'LEGACY_XP_BOOST');
    assert.equal(body.retiredCaptains[1].legacyDoctrine, null);
    assert.deepEqual(body.activeDoctrineIds, ['LEGACY_XP_BOOST']);
    assert.equal(body.maxActiveDoctrines, 2);
    assert.equal(body.doctrines.length, 6);
    assert.equal(body.retiredCaptains[0].assignmentStatus, 'RETIRED_IDLE');

    const stranger = await newPilot('Stranger');
    assert.deepEqual(json(await call(stranger, 'GET', '/game/captain/retired')).retiredCaptains, []);
    assert.equal((await app.inject({ method: 'GET', url: '/game/captain/retired' })).statusCode, 401);
  });
});

describe('Legacy Doctrines', () => {
  // Retires a Level 8 captain of `pilot` with `doctrineId` (none when omitted); returns the response.
  async function retireEighth(pilot, doctrineId) {
    await app.prisma.captain.update({ where: { playerId: pilot.id }, data: { xp: LV8, level: 8 } });
    return retire(pilot, doctrineId ? { legacyDoctrineId: doctrineId } : {});
  }

  test('at most two are in force: a third retirement naming one is refused until another is switched off', async () => {
    const pilot = await pilotWith(LV8);
    assert.equal((await retireEighth(pilot, 'LEGACY_XP_BOOST')).statusCode, 200);
    assert.equal((await retireEighth(pilot, 'LEGACY_DOCKING_SPEED')).statusCode, 200);
    const before = await snapshot(pilot);

    const full = await retireEighth(pilot, 'LEGACY_WAGE_CUT');
    assert.equal(full.statusCode, 409);
    assert.equal(json(full).error, 'doctrine_limit_reached');
    assert.deepEqual(json(full).activeDoctrineIds.sort(), ['LEGACY_DOCKING_SPEED', 'LEGACY_XP_BOOST']);
    // The refused retirement left the Level 8 captain in command.
    const captain = await captainRow(pilot);
    assert.equal(captain.xp, LV8);
    assert.equal((await retiredRows(pilot)).length, 2);
    assert.equal(JSON.stringify((await retiredRows(pilot))), JSON.stringify(JSON.parse(before).retired));

    const [first] = await retiredRows(pilot);
    const off = await doctrine(pilot, { retiredCaptainId: first.id, active: false });
    assert.equal(off.statusCode, 200, off.body);
    assert.deepEqual(json(off).activeDoctrineIds, ['LEGACY_DOCKING_SPEED']);
    assert.equal((await retire(pilot, { legacyDoctrineId: 'LEGACY_WAGE_CUT' })).statusCode, 200);
  });

  test('the same doctrine held by several retired captains counts once for its effect and for the limit', async () => {
    const pilot = await pilotWith(LV8);
    assert.equal((await retireEighth(pilot, 'LEGACY_DOCKING_SPEED')).statusCode, 200);
    const same = await retireEighth(pilot, 'LEGACY_DOCKING_SPEED');
    assert.equal(same.statusCode, 200, same.body);
    assert.deepEqual(json(same).activeDoctrineIds, ['LEGACY_DOCKING_SPEED']);
    assert.equal(tokenClaims(same).ship_attributes.docking_time_mult, 0.9);

    const other = await retireEighth(pilot, 'LEGACY_XP_BOOST');
    assert.equal(other.statusCode, 200, other.body);
    assert.deepEqual(json(other).activeDoctrineIds.sort(), ['LEGACY_DOCKING_SPEED', 'LEGACY_XP_BOOST']);

    const atCap = await retireEighth(pilot, 'LEGACY_DOCKING_SPEED');
    assert.equal(atCap.statusCode, 200, atCap.body);
    assert.equal(tokenClaims(atCap).ship_attributes.docking_time_mult, 0.9);
    const third = await retireEighth(pilot, 'LEGACY_WAGE_CUT');
    assert.equal(third.statusCode, 409);
    assert.equal(json(third).error, 'doctrine_limit_reached');
  });

  test('POST /game/captain/doctrine switches a doctrine on and off and re-signs the token', async () => {
    const pilot = await pilotWith(LV8);
    assert.equal((await retireEighth(pilot, 'LEGACY_DOCKING_SPEED')).statusCode, 200);
    const [row] = await retiredRows(pilot);
    const off = await doctrine(pilot, { retiredCaptainId: row.id, active: false });
    assert.equal(off.statusCode, 200, off.body);
    assert.equal(json(off).retiredCaptain.legacyDoctrine.active, false);
    assert.equal(tokenClaims(off).ship_attributes.docking_time_mult, 1);
    assert.equal((await retiredRows(pilot))[0].activeDoctrine, false);

    const on = await doctrine(pilot, { retiredCaptainId: row.id, active: true });
    assert.equal(on.statusCode, 200, on.body);
    assert.equal(tokenClaims(on).ship_attributes.docking_time_mult, 0.9);
    const again = await doctrine(pilot, { retiredCaptainId: row.id, active: true });
    assert.equal(again.statusCode, 200);
    assert.deepEqual(json(again).activeDoctrineIds, ['LEGACY_DOCKING_SPEED']);
    assert.equal(tokenClaims(again).ship_attributes.docking_time_mult, 0.9);
  });

  test('a third cannot be switched on while two are', async () => {
    const pilot = await pilotWith(LV8);
    for (const id of ['LEGACY_XP_BOOST', 'LEGACY_DOCKING_SPEED']) assert.equal((await retireEighth(pilot, id)).statusCode, 200);
    assert.equal((await retireEighth(pilot)).statusCode, 200);
    const [, , third] = await retiredRows(pilot);
    const before = await snapshot(pilot);

    const unlocked = await doctrine(pilot, { retiredCaptainId: third.id, active: true, legacyDoctrineId: 'LEGACY_WAGE_CUT' });
    assert.equal(unlocked.statusCode, 409);
    assert.equal(json(unlocked).error, 'doctrine_limit_reached');
    assert.equal(await snapshot(pilot), before);

    // Unlocked but off is allowed; switching it on afterwards is the refused step.
    const stored = await doctrine(pilot, { retiredCaptainId: third.id, active: false, legacyDoctrineId: 'LEGACY_WAGE_CUT' });
    assert.equal(stored.statusCode, 200, stored.body);
    assert.equal((await retiredRows(pilot))[2].legacyDoctrineId, 'LEGACY_WAGE_CUT');
    const on = await doctrine(pilot, { retiredCaptainId: third.id, active: true });
    assert.equal(on.statusCode, 409);
    assert.equal(json(on).error, 'doctrine_limit_reached');
  });

  test('a slot left empty is filled once, within its tier', async () => {
    const pilot = await pilotWith(LV8);
    assert.equal((await retireEighth(pilot)).statusCode, 200);
    const [row] = await retiredRows(pilot);

    let res = await doctrine(pilot, { retiredCaptainId: row.id, active: true });
    assert.equal(res.statusCode, 409);
    assert.equal(json(res).error, 'no_doctrine_unlocked');
    res = await doctrine(pilot, { retiredCaptainId: row.id, active: true, legacyDoctrineId: 'LEGACY_XP_BOOST_II' });
    assert.equal(res.statusCode, 400);
    assert.equal(json(res).error, 'doctrine_tier_locked');

    res = await doctrine(pilot, { retiredCaptainId: row.id, active: true, legacyDoctrineId: 'LEGACY_WAGE_CUT' });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(json(res).retiredCaptain.legacyDoctrine.id, 'LEGACY_WAGE_CUT');
    res = await doctrine(pilot, { retiredCaptainId: row.id, active: true, legacyDoctrineId: 'LEGACY_XP_BOOST' });
    assert.equal(res.statusCode, 409);
    assert.equal(json(res).error, 'doctrine_already_chosen');
    assert.equal((await retiredRows(pilot))[0].legacyDoctrineId, 'LEGACY_WAGE_CUT');
  });

  test('an early discharge left no slot, and another pilot\'s captain is not found', async () => {
    const pilot = await pilotWith(LV3);
    await setCredits(pilot, 2000);
    assert.equal((await retire(pilot, { retirementTier: 'EARLY_DISCHARGE' })).statusCode, 200);
    const [row] = await retiredRows(pilot);
    for (const body of [{ active: true }, { active: true, legacyDoctrineId: 'LEGACY_XP_BOOST' }]) {
      const res = await doctrine(pilot, { retiredCaptainId: row.id, ...body });
      assert.equal(res.statusCode, 409);
      assert.equal(json(res).error, 'no_doctrine_slot');
    }

    const owner = await pilotWith(LV8);
    assert.equal((await retireEighth(owner, 'LEGACY_XP_BOOST')).statusCode, 200);
    const [theirs] = await retiredRows(owner);
    const stranger = await newPilot('Stranger');
    for (const id of [theirs.id, randomUUID()]) {
      const res = await doctrine(stranger, { retiredCaptainId: id, active: false });
      assert.equal(res.statusCode, 404);
      assert.equal(json(res).error, 'retired_captain_not_found');
    }
    assert.equal((await retiredRows(owner))[0].activeDoctrine, true);
  });

  test('needs a login, a valid body and a docked receipt as fresh as a trait unlock\'s', async () => {
    const pilot = await pilotWith(LV8);
    assert.equal((await retireEighth(pilot, 'LEGACY_XP_BOOST')).statusCode, 200);
    const [row] = await retiredRows(pilot);
    assert.equal((await app.inject({ method: 'POST', url: '/game/captain/doctrine', payload: { retiredCaptainId: row.id, active: false } })).statusCode, 401);
    for (const body of [{ active: false }, { retiredCaptainId: row.id }, { retiredCaptainId: 'x', active: false }, { retiredCaptainId: row.id, active: 'no' }]) {
      assert.equal((await doctrine(pilot, body)).statusCode, 400, JSON.stringify(body));
    }
    const before = await snapshot(pilot);
    const now = Date.now();
    for (const [receipt, code] of [
      [dockedReceipt(pilot, {}, generateKeyPairSync('ed25519').privateKey), 'docked_receipt_invalid'],
      [dockedReceipt(pilot, { issuedAtMs: now - 60_000, dockedAtMs: now - 62_000 }), 'docked_receipt_required']
    ]) {
      const res = await doctrine(pilot, { retiredCaptainId: row.id, active: false }, receipt);
      assert.equal(res.statusCode, 403);
      assert.equal(json(res).error, code);
    }
    const missing = await call(pilot, 'POST', '/game/captain/doctrine', { retiredCaptainId: row.id, active: false });
    assert.equal(json(missing).error, 'docked_receipt_required');
    const wrong = await doctrine(pilot, { retiredCaptainId: row.id, active: false, stationId: randomUUID() });
    assert.equal(json(wrong).error, 'docked_receipt_wrong_station');
    assert.equal(await snapshot(pilot), before);
  });
});

describe('an innate Master Engineer overdrives two components', () => {
  const shipOf = (pilot) => app.prisma.spaceship.findFirst({ where: { playerId: pilot.id, active: true } });
  const setTier = async (pilot, type, tier) => app.prisma.shipComponentRecord.update({
    where: { spaceshipId_type: { spaceshipId: (await shipOf(pilot)).id, type } }, data: { tier }
  });
  const loadout = async (pilot) => json(await call(pilot, 'GET', '/ship/loadout')).components;
  const rig = (pilot, componentTypes, body = {}, receipt = dockedReceipt(pilot)) =>
    call(pilot, 'POST', '/game/captain/jury-rig', { componentTypes, dockedReceipt: receipt, ...body });

  // A pilot whose captain was promoted from a crew Engineer of `rank`.
  async function engineerCaptain(rank = 'MASTER') {
    const pilot = await pilotWith(LV10);
    const engineer = await addCrew(pilot, { crewClass: 'ENGINEER', rank, morale: 90, quirkId: NEUTRAL_QUIRK });
    const res = await retire(pilot, { successorType: 'PROMOTED_CREW', successorCrewId: engineer.id });
    assert.equal(res.statusCode, 200, res.body);
    return pilot;
  }

  test('the innate id carries the selection, cut to the rank\'s slots, and only for an Engineer', () => {
    const innate = { innateClass: 'ENGINEER', innateRank: 'MASTER', quirkId: NEUTRAL_QUIRK };
    const id = innateEffectId({ ...innate, juryRigComponentTypes: ['ENGINES', 'RADAR'] });
    assert.deepEqual([...innateJuryRigTypes([id])], ['ENGINES', 'RADAR']);
    assert.deepEqual([...innateJuryRigTypes([innateEffectId({ ...innate, juryRigComponentTypes: ['ENGINES', 'RADAR', 'ENERGY'] })])], ['ENGINES', 'RADAR']);
    assert.deepEqual([...innateJuryRigTypes([innateEffectId({ ...innate, innateRank: 'ADEPT', juryRigComponentTypes: ['ENGINES', 'RADAR'] })])], ['ENGINES']);
    assert.equal(innateJuryRigTypes([innateEffectId({ ...innate, innateRank: 'NOVICE', juryRigComponentTypes: ['ENGINES'] })]).size, 0);
    assert.equal(innateJuryRigTypes([innateEffectId({ ...innate, innateClass: 'PILOT', juryRigComponentTypes: ['ENGINES'] })]).size, 0);
    assert.equal(innateJuryRigTypes([innateEffectId({ ...innate, juryRigComponentTypes: ['HULL'] })]).size, 0);
    assert.equal(innateJuryRigTypes(['H1_TRIM_THRUSTERS']).size, 0);
  });

  test('selecting two installed components signs each one tier higher; the stored tiers and hull budget stay', async () => {
    const pilot = await engineerCaptain();
    const base = computeShipAttributes(await loadout(pilot), 0, effectIdsFor(await captainRow(pilot)), []);
    const res = await rig(pilot, ['ENGINES', 'RADAR']);
    assert.equal(res.statusCode, 200, res.body);
    assert.deepEqual(json(res).captain.innate.juryRig, { slots: 2, selectedComponentTypes: ['ENGINES', 'RADAR'] });
    assert.deepEqual((await captainRow(pilot)).juryRigComponentTypes, ['ENGINES', 'RADAR']);

    const components = await loadout(pilot);
    const higher = components.map((c) => (['ENGINES', 'RADAR'].includes(c.type) ? { ...c, tier: c.tier + 1 } : c));
    const signed = tokenClaims(res).ship_attributes;
    // The same ship as one whose ENGINES and RADAR were stored a tier higher, under the same captain.
    const noRig = effectIdsFor({ ...(await captainRow(pilot)), juryRigComponentTypes: [] });
    assert.deepEqual(signed, computeShipAttributes(higher, 0, noRig, []));
    assert.ok(signed.max_speed_mps > base.max_speed_mps || signed.radar_range_m > base.radar_range_m);
    assert.deepEqual(await loadout(pilot), components); // stored tiers unchanged
    assert.equal(signed.crew_aboard, 0);

    // Clearing the selection puts it back; a fresh login signs the selection again.
    assert.deepEqual(tokenClaims(await rig(pilot, [])).ship_attributes, base);
    await rig(pilot, ['RADAR']);
    const login = await app.inject({
      method: 'POST', url: '/auth/login', headers: attestationHeaders,
      payload: { email: pilot.email, password: PASSWORD, deviceId: 'innate-rig-login-device' }
    });
    assert.ok(tokenClaims(login).ship_attributes.radar_range_m > base.radar_range_m);
    assert.equal(tokenClaims(login).ship_attributes.max_speed_mps, base.max_speed_mps);
    assert.equal(json(await call(pilot, 'GET', '/game/captain')).captain.innate.juryRig.selectedComponentTypes[0], 'RADAR');
  });

  test('matches the Phase 3 crew Engineer rule for the same selection, and joining it never stacks a second tier', async () => {
    const pilot = await engineerCaptain();
    await rig(pilot, ['ENGINES', 'RADAR']);
    const crewEngineer = await addCrew(pilot, { crewClass: 'ENGINEER', rank: 'MASTER', morale: 90, quirkId: NEUTRAL_QUIRK, juryRigComponentTypes: ['RADAR', 'ENERGY'] });
    assert.ok(crewEngineer);
    const components = await loadout(pilot);
    const withCrew = computeShipAttributes(components, 0, effectIdsFor(await captainRow(pilot)), await app.prisma.crewMember.findMany({ where: { playerId: pilot.id } }));
    const tiersUp = (types) => computeShipAttributes(
      components.map((c) => (types.includes(c.type) ? { ...c, tier: Math.min(c.tier + 1, 5) } : c)), 0, [], []);
    const plain = tiersUp([]);
    const up = tiersUp(['ENGINES', 'RADAR', 'ENERGY']);
    assert.equal(withCrew.radar_range_m, up.radar_range_m); // RADAR from both sources: one tier up
    assert.ok(withCrew.radar_range_m > plain.radar_range_m);
    assert.equal(withCrew.energy_capacity, up.energy_capacity);
  });

  test('refuses what the Phase 3 rule refuses: slots, uninstalled and Tier 5 components, other captains', async () => {
    const pilot = await engineerCaptain();
    const before = await snapshot(pilot);
    assert.equal((await rig(pilot, ['ENGINES', 'RADAR', 'ENERGY'])).statusCode, 400); // schema: at most 2
    assert.equal((await rig(pilot, ['RADAR', 'RADAR'])).statusCode, 400);
    assert.equal((await rig(pilot, ['HULL'])).statusCode, 400);
    const zero = await rig(pilot, ['SHIELDS']);
    assert.equal(zero.statusCode, 409, zero.body);
    assert.equal(json(zero).error, 'COMPONENT_NOT_INSTALLED');
    await setTier(pilot, 'RADAR', 5);
    const maximum = await rig(pilot, ['ENGINES', 'RADAR']);
    assert.equal(maximum.statusCode, 409);
    assert.equal(json(maximum).error, 'jury_rig_already_max_tier');
    assert.equal(await snapshot(pilot), before);

    const adept = await engineerCaptain('ADEPT');
    const tooMany = await rig(adept, ['ENGINES', 'RADAR']);
    assert.equal(tooMany.statusCode, 409);
    assert.deepEqual([json(tooMany).error, json(tooMany).slots], ['jury_rig_slots_exceeded', 1]);
    assert.equal((await rig(adept, ['RADAR'])).statusCode, 200);

    const starter = await pilotWith(LV1);
    assert.equal(json(await rig(starter, ['RADAR'])).error, 'captain_not_engineer');
    const pilotCaptain = await pilotWith(LV10);
    const pilotCrew = await addCrew(pilotCaptain, { crewClass: 'PILOT', rank: 'MASTER', morale: 90 });
    await retire(pilotCaptain, { successorType: 'PROMOTED_CREW', successorCrewId: pilotCrew.id });
    assert.equal(json(await rig(pilotCaptain, ['RADAR'])).error, 'captain_not_engineer');
  });

  test('needs a login and a fresh docked receipt for this pilot', async () => {
    const pilot = await engineerCaptain();
    assert.equal((await app.inject({ method: 'POST', url: '/game/captain/jury-rig', payload: { componentTypes: [] } })).statusCode, 401);
    const before = await snapshot(pilot);
    assert.equal(json(await call(pilot, 'POST', '/game/captain/jury-rig', { componentTypes: ['RADAR'] })).error, 'docked_receipt_required');
    assert.equal(json(await rig(pilot, ['RADAR'], {}, dockedReceipt('someone-else'))).error, 'docked_receipt_invalid');
    assert.equal(json(await rig(pilot, ['RADAR'], { stationId: randomUUID() })).error, 'docked_receipt_wrong_station');
    assert.equal(await snapshot(pilot), before);
  });

  test('a successor starts with no overdrive selection, and the retired Engineer\'s is not kept', async () => {
    const pilot = await engineerCaptain();
    await rig(pilot, ['ENGINES', 'RADAR']);
    await app.prisma.captain.update({ where: { playerId: pilot.id }, data: { xp: LV10, level: 10 } });
    const res = await retire(pilot);
    assert.equal(res.statusCode, 200, res.body);
    assert.deepEqual((await captainRow(pilot)).juryRigComponentTypes, []);
    const base = computeShipAttributes(await loadout(pilot), 0, [], []);
    assert.deepEqual(tokenClaims(res).ship_attributes, base);
    assert.equal(json(res).captain.innate, undefined);
  });
});
