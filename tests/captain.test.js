import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, sign } from 'node:crypto';
import {
  PASSWORD, app, attestationHeaders, call, closeApp, dockedReceipt, json, loginKey, newPilot, receiptAtOrigin,
  rtseKey, setCredits, signedOffer
} from './helpers.js';
import { canonicalClaimPayload } from '../src/lib/mission-claim.js';
import { computeShipAttributes, defaultComponents, hullBudget } from '../src/config/components.js';
import {
  BRANCHES,
  EARLY_DISCHARGE_FEE_CREDITS,
  HONORS_RETIRE_MIN_LEVEL,
  LEVEL_XP,
  MAX_ACTIVE_LEGACY_DOCTRINES,
  MAX_CAPTAIN_LEVEL,
  PLANET_CHART_XP,
  SYSTEM_CHART_XP,
  TIER_2_BRANCH_PREREQ,
  TIER_3_BRANCH_PREREQ,
  TOTAL_TRAITS_DEFINED,
  TRAITS,
  TRAIT_IDS,
  knownTraits,
  levelForXp,
  missionXp,
  traitPointsForLevel,
  traitUnlockRefusal,
  xpRequiredForLevel
} from '../src/config/captain.js';

const HELMSMAN = ['H1_TRIM_THRUSTERS', 'H2_HARBOR_PILOT', 'H3_BULKHEAD_PACKING', 'H4_MODULAR_CABINS', 'H5_DEAD_RECKONING', 'H6_FLEET_CAPTAIN'];
const ASTROGATION = ['S1_LONG_BASELINE', 'S2_PULSE_CYCLING', 'S3_RESONANCE_EAR', 'S4_DEEP_SURVEYOR', 'S5_PROSPECTOR_EYE', 'S6_ASTROGATOR_PRIME'];
const COMMAND = ['C1_HARD_BARGAINER', 'C2_SHORE_CONTACTS', 'C3_COLD_RUNNING', 'C4_FACTION_ENVOY', 'C5_SMUGGLER_HOLD', 'C6_SHADOW_BROKER'];

describe('captain config', () => {
  test('pins the tunable constants', () => {
    assert.equal(MAX_CAPTAIN_LEVEL, 10);
    assert.equal(TOTAL_TRAITS_DEFINED, 18);
    assert.equal(TIER_2_BRANCH_PREREQ, 2);
    assert.equal(TIER_3_BRANCH_PREREQ, 4);
    assert.equal(HONORS_RETIRE_MIN_LEVEL, 8);
    assert.equal(EARLY_DISCHARGE_FEE_CREDITS, 1000);
    assert.equal(MAX_ACTIVE_LEGACY_DOCTRINES, 2);
    assert.equal(PLANET_CHART_XP, 35);
    assert.equal(SYSTEM_CHART_XP, 150);
  });

  test('cumulative XP per level is round_to_50(180 x (L - 1)^1.75)', () => {
    // Written out rather than derived, so a changed curve fails here.
    assert.deepEqual(LEVEL_XP, [0, 200, 600, 1250, 2050, 3000, 4150, 5400, 6850, 8400]);
    for (let level = 1; level <= MAX_CAPTAIN_LEVEL; level++) {
      assert.equal(xpRequiredForLevel(level), Math.round((180 * (level - 1) ** 1.75) / 50) * 50);
    }
  });

  test('levels follow cumulative XP and stop at the cap', () => {
    assert.equal(levelForXp(0), 1);
    assert.equal(levelForXp(199), 1);
    assert.equal(levelForXp(200), 2);
    assert.equal(levelForXp(599), 2);
    assert.equal(levelForXp(600), 3);
    assert.equal(levelForXp(8399), 9);
    assert.equal(levelForXp(8400), 10);
    assert.equal(levelForXp(2_147_483_647), 10);
  });

  test('levels 2 to 10 each grant one trait point, 9 in all', () => {
    assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(traitPointsForLevel), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    assert.equal(traitPointsForLevel(11), 9);
  });

  test('defines 18 traits: per branch three Tier I, two Tier II and one capstone', () => {
    assert.equal(TRAIT_IDS.length, TOTAL_TRAITS_DEFINED);
    assert.deepEqual(BRANCHES, ['HELMSMAN', 'ASTROGATION', 'COMMAND']);
    for (const [branch, ids] of [['HELMSMAN', HELMSMAN], ['ASTROGATION', ASTROGATION], ['COMMAND', COMMAND]]) {
      assert.deepEqual(ids.map((id) => [TRAITS[id].branch, TRAITS[id].tier]), [
        [branch, 1], [branch, 1], [branch, 1], [branch, 2], [branch, 2], [branch, 3]
      ]);
    }
  });

  test('stored trait lists keep only known ids, once each', () => {
    assert.deepEqual(knownTraits(['H1_TRIM_THRUSTERS', 'BOGUS', 'H1_TRIM_THRUSTERS']), ['H1_TRIM_THRUSTERS']);
    assert.deepEqual(knownTraits(null), []);
    assert.deepEqual(knownTraits({ H1_TRIM_THRUSTERS: true }), []);
  });

  test('mission XP comes from the signed offer, with +25% for a speed bonus', () => {
    const passage = { type: 'MISSION_TYPE_PASSAGE', distance_hexes: 2, required_berths: 2, reward_credits: 2500, duration_limit_ms: 600_000 };
    assert.equal(missionXp(passage, { rewardCredits: 2500 }), 200); // 100 + 40 x 2 + 10 x 2
    assert.equal(missionXp(passage, { rewardCredits: 2510 }), 250);
    assert.equal(missionXp(passage, { rewardCredits: 500 }), 200); // late: no bonus, full XP
    assert.equal(missionXp({ ...passage, distance_hexes: 1, required_berths: 1 }, { rewardCredits: 0 }), 150);
    const research = { type: 'MISSION_TYPE_RESEARCH', distance_hexes: 3, required_berths: 0, reward_credits: 2500 };
    assert.equal(missionXp(research, { rewardCredits: 2500 }), 270); // 120 + 50 x 3
    // A gather offer's route (origin to source to destination) is read from its signed time limit:
    // route x 5 min + 5 min mining. Route 4 here, though the destination is 2 systems out.
    const gather = { type: 'MISSION_TYPE_GATHER', distance_hexes: 2, required_berths: 0, reward_credits: 5000, duration_limit_ms: 1_500_000 };
    assert.equal(missionXp(gather, { rewardCredits: 5000 }), 390); // 150 + 60 x 4
    assert.equal(missionXp(gather, { rewardCredits: 6000 }), 487);
    assert.equal(missionXp({ type: 'MISSION_TYPE_UNKNOWN' }, { rewardCredits: 0 }), 0);
  });

  test('Tier II needs 2 points in its branch and a capstone 4; other branches do not count', () => {
    const at = (level, traitIds) => ({ level, traitIds });
    assert.equal(traitUnlockRefusal('H1_TRIM_THRUSTERS', at(2, [])), null);
    assert.deepEqual(traitUnlockRefusal('H4_MODULAR_CABINS', at(10, ['H1_TRIM_THRUSTERS', 'S1_LONG_BASELINE', 'C3_COLD_RUNNING'])), {
      code: 'prerequisite_not_met', requiredPointsInBranch: 2, currentPoints: 1
    });
    assert.equal(traitUnlockRefusal('H4_MODULAR_CABINS', at(4, ['H1_TRIM_THRUSTERS', 'H2_HARBOR_PILOT'])), null);
    assert.deepEqual(traitUnlockRefusal('H6_FLEET_CAPTAIN', at(10, HELMSMAN.slice(0, 3))), {
      code: 'prerequisite_not_met', requiredPointsInBranch: 4, currentPoints: 3
    });
    assert.equal(traitUnlockRefusal('H6_FLEET_CAPTAIN', at(6, HELMSMAN.slice(0, 4))), null);
    assert.deepEqual(traitUnlockRefusal('H2_HARBOR_PILOT', at(2, ['H1_TRIM_THRUSTERS'])), { code: 'no_trait_points', traitPointsAvailable: 0 });
    assert.deepEqual(traitUnlockRefusal('H1_TRIM_THRUSTERS', at(3, ['H1_TRIM_THRUSTERS'])), { code: 'trait_already_unlocked' });
    assert.deepEqual(traitUnlockRefusal('X', at(10, [])), { code: 'unknown_trait' });
  });

  test('computeShipAttributes folds in the ship traits', () => {
    const base = computeShipAttributes(defaultComponents());
    assert.equal(base.docking_time_mult, 1.0);
    assert.equal(base.extraction_rate_mult, 1.0);
    assert.equal(base.tuning_tolerance_hz, 100.0);
    const all = computeShipAttributes(defaultComponents(), 3, TRAIT_IDS);
    assert.equal(all.max_speed_mps, 21.6); // 20 x 1.08
    assert.equal(all.docking_time_mult, 0.8);
    assert.equal(all.cargo_capacity_m3, 23); // 20 x 1.15
    assert.equal(all.passenger_capacity, 5); // 3 + 2
    assert.equal(all.passengers_aboard, 3); // clamped to the raised capacity
    assert.equal(all.radar_range_m, 600);
    assert.equal(all.identification_range_m, 180);
    assert.equal(all.sensor_range_m, 1800);
    assert.equal(all.sensor_cooldown_mult, 0.85);
    assert.equal(all.tuning_tolerance_hz, 125);
    assert.equal(all.extraction_rate_mult, 1.1);
    assert.equal(all.stealth_rating, 0.15); // even with STEALTH unequipped
    // Traits with no ship effect change nothing else.
    for (const attr of ['max_hull_hp', 'max_shield_hp', 'weapon_dps', 'energy_capacity', 'comms_range_m', 'hull_tier']) {
      assert.equal(all[attr], base[attr], attr);
    }
    const top = computeShipAttributes(defaultComponents().map((c) => ({ ...c, tier: 5 })), 0, ['H1_TRIM_THRUSTERS', 'C3_COLD_RUNNING']);
    assert.equal(top.max_speed_mps, 343); // Mach 1 stays the ceiling
    assert.equal(top.stealth_rating, 0.95);
    assert.deepEqual(computeShipAttributes(defaultComponents(), 0, ['BOGUS']), base);
  });

  test('the Fleet Quartermaster capstone adds a hull budget point', () => {
    assert.equal(hullBudget(1, ['H6_FLEET_CAPTAIN']), 7);
    assert.equal(hullBudget(5, ['H6_FLEET_CAPTAIN']), 37);
    assert.equal(hullBudget(1, ['H1_TRIM_THRUSTERS']), 6);
  });
});

describe('captain over HTTP', () => {
  before(async () => { await app.ready(); });
  after(async () => { await closeApp(); });

  const captainRow = (pilot) => app.prisma.captain.findUnique({ where: { playerId: pilot.id } });
  const setCaptain = (pilot, data) => app.prisma.captain.update({ where: { playerId: pilot.id }, data });
  const getCaptain = async (pilot) => json(await call(pilot, 'GET', '/game/captain')).captain;
  const unlock = (pilot, body) => call(pilot, 'POST', '/game/captain/trait', body);
  const unlockDocked = (pilot, traitId, receipt = dockedReceipt(pilot)) => unlock(pilot, { traitId, dockedReceipt: receipt });
  // A pilot whose captain has `xp` and `unlockedTraits`.
  async function captainWith(xp, unlockedTraits = []) {
    const pilot = await newPilot('Captain');
    await setCaptain(pilot, { xp, level: levelForXp(xp), unlockedTraits });
    return pilot;
  }

  function signedClaim(pilot, active, overrides = {}) {
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
  async function acceptPassage(pilot, overrides = {}) {
    const offer = signedOffer(pilot, overrides);
    const res = await call(pilot, 'POST', '/game/missions/accept', { offer, dockedReceipt: receiptAtOrigin(pilot, offer) });
    assert.equal(res.statusCode, 200, res.body);
    return json(res).active;
  }
  const complete = (pilot, claim) => call(pilot, 'POST', '/game/missions/complete', { claim });

  test('requires authentication', async () => {
    assert.equal((await app.inject({ method: 'GET', url: '/game/captain' })).statusCode, 401);
    assert.equal((await app.inject({ method: 'POST', url: '/game/captain/trait', payload: { traitId: 'H1_TRIM_THRUSTERS' } })).statusCode, 401);
  });

  test('every pilot gets a Level 1 starter captain at login', async () => {
    const pilot = await newPilot('Starter');
    const row = await captainRow(pilot);
    assert.equal(row.name, pilot.callsign);
    assert.deepEqual([row.level, row.xp, row.unlockedTraits, row.originType, row.missionsCompleted], [1, 0, [], 'STARTER', 0]);
    assert.deepEqual(await getCaptain(pilot), {
      name: pilot.callsign, level: 1, xp: 0, xpForLevel: 0, xpForNextLevel: 200,
      unlockedTraits: [], traitPoints: 0, traitPointsAvailable: 0, missionsCompleted: 0
    });
    assert.equal(await app.prisma.captain.count({ where: { playerId: pilot.id } }), 1);
  });

  test('a pilot from before captains gets one when its ship is next locked', async () => {
    const pilot = await newPilot('Veteran');
    await app.prisma.captain.delete({ where: { playerId: pilot.id } });
    const results = await Promise.all([0, 1, 2].map(() => call(pilot, 'GET', '/ship/loadout')));
    assert.deepEqual(results.map((r) => r.statusCode), [200, 200, 200]);
    assert.equal(await app.prisma.captain.count({ where: { playerId: pilot.id } }), 1);
    assert.equal((await captainRow(pilot)).level, 1);
  });

  test('ASSERT-1.2.1: completing a 2-hex, 2-passenger passage awards 200 XP and Level 2', async () => {
    const pilot = await newPilot('Ferry');
    const active = await acceptPassage(pilot);
    const res = await complete(pilot, signedClaim(pilot, active));
    assert.equal(res.statusCode, 200, res.body);
    const body = json(res);
    assert.equal(body.xpGained, 200);
    assert.equal(body.currentLevel, 2);
    assert.equal(body.traitPointsAvailable, 1);
    const row = await captainRow(pilot);
    assert.deepEqual([row.xp, row.level, row.missionsCompleted], [200, 2, 1]);
  });

  test('a replayed or concurrent completion claim awards its XP once', async () => {
    const pilot = await newPilot('Replay');
    const active = await acceptPassage(pilot);
    const claim = signedClaim(pilot, active);
    const results = await Promise.all([0, 1, 2].map(() => complete(pilot, claim)));
    assert.equal(results.filter((r) => r.statusCode === 200).length, 1);
    assert.equal((await complete(pilot, claim)).statusCode, 404);
    const row = await captainRow(pilot);
    assert.deepEqual([row.xp, row.missionsCompleted], [200, 1]);
  });

  test('refused claims award no XP', async () => {
    const pilot = await newPilot('Forger');
    const active = await acceptPassage(pilot);
    const forged = { ...signedClaim(pilot, active), rewardCredits: active.offer.reward_credits + 1 };
    assert.equal((await complete(pilot, forged)).statusCode, 403);
    const loginSigned = signedClaim(pilot, active);
    loginSigned.signature = sign(null, canonicalClaimPayload(loginSigned), loginKey).toString('base64');
    assert.equal((await complete(pilot, loginSigned)).statusCode, 403);
    // Abandoning pays nothing, XP included.
    assert.equal((await call(pilot, 'POST', '/game/missions/abandon', { missionId: active.mission_id })).statusCode, 200);
    assert.equal((await captainRow(pilot)).xp, 0);
  });

  test('ASSERT-1.2.2: a Level 2 captain docked at a station unlocks H1_TRIM_THRUSTERS', async () => {
    const pilot = await captainWith(200);
    const stationId = randomUUID();
    const res = await unlock(pilot, { traitId: 'H1_TRIM_THRUSTERS', stationId, dockedReceipt: dockedReceipt(pilot, { dockedEntityId: stationId }) });
    assert.equal(res.statusCode, 200, res.body);
    const body = json(res);
    assert.deepEqual(body.captain.unlockedTraits, ['H1_TRIM_THRUSTERS']);
    assert.equal(body.captain.traitPointsAvailable, 0);
    assert.equal(body.ship_attributes.max_speed_mps, 21.6);
    const claims = app.jwt.verify(body.token);
    assert.equal(claims.ship_attributes.max_speed_mps, 21.6);
    assert.equal(claims.sub, pilot.id);
    assert.deepEqual((await captainRow(pilot)).unlockedTraits, ['H1_TRIM_THRUSTERS']);
    // Every later token carries the trait: the loadout, mission tokens and a fresh login.
    assert.equal(json(await call(pilot, 'GET', '/ship/loadout')).ship_attributes.max_speed_mps, 21.6);
    const login = await app.inject({
      method: 'POST', url: '/auth/login', headers: attestationHeaders,
      payload: { email: pilot.email, password: PASSWORD, deviceId: 'login-test-device-id' }
    });
    assert.equal(app.jwt.verify(json(login).token).ship_attributes.max_speed_mps, 21.6);
  });

  test('S3 and H2 sign the docking, extraction and tuning attributes', async () => {
    const pilot = await captainWith(600);
    assert.equal((await unlockDocked(pilot, 'S3_RESONANCE_EAR')).statusCode, 200);
    const res = await unlockDocked(pilot, 'H2_HARBOR_PILOT');
    assert.equal(res.statusCode, 200, res.body);
    const { ship_attributes: attrs } = app.jwt.verify(json(res).token);
    assert.deepEqual([attrs.docking_time_mult, attrs.extraction_rate_mult, attrs.tuning_tolerance_hz], [0.8, 1.1, 125]);
  });

  test('ASSERT-1.2.3: a Tier II trait needs 2 points in its branch', async () => {
    const pilot = await captainWith(600, ['H1_TRIM_THRUSTERS']);
    const res = await unlockDocked(pilot, 'H4_MODULAR_CABINS');
    assert.equal(res.statusCode, 400);
    assert.deepEqual(json(res), {
      error: 'prerequisite_not_met',
      message: 'Not enough points are spent in this branch to unlock this trait.',
      requiredPointsInBranch: 2,
      currentPoints: 1
    });
    assert.deepEqual((await captainRow(pilot)).unlockedTraits, ['H1_TRIM_THRUSTERS']);
  });

  test('points in other branches never satisfy a prerequisite, and a capstone needs 4', async () => {
    const pilot = await captainWith(LEVEL_XP[9], ['S1_LONG_BASELINE', 'S2_PULSE_CYCLING', 'S3_RESONANCE_EAR', 'C3_COLD_RUNNING']);
    let res = await unlockDocked(pilot, 'H4_MODULAR_CABINS');
    assert.deepEqual([res.statusCode, json(res).requiredPointsInBranch, json(res).currentPoints], [400, 2, 0]);
    res = await unlockDocked(pilot, 'S6_ASTROGATOR_PRIME');
    assert.deepEqual([res.statusCode, json(res).requiredPointsInBranch, json(res).currentPoints], [400, 4, 3]);
    assert.equal((await unlockDocked(pilot, 'S4_DEEP_SURVEYOR')).statusCode, 200);
    assert.equal((await unlockDocked(pilot, 'S6_ASTROGATOR_PRIME')).statusCode, 200);
  });

  test('the Fleet Quartermaster capstone lets the hull budget take one more point', async () => {
    const pilot = await captainWith(LEVEL_XP[5], HELMSMAN.slice(0, 4));
    await setCredits(pilot, 10_000);
    const radar = () => call(pilot, 'POST', '/ship/upgrade', { componentType: 'RADAR', targetTier: 2, dockedReceipt: dockedReceipt(pilot) });
    assert.equal((await radar()).statusCode, 400); // 7 points over the Tier 1 budget of 6
    assert.equal((await unlockDocked(pilot, 'H6_FLEET_CAPTAIN')).statusCode, 200);
    assert.equal((await radar()).statusCode, 200);
  });

  test('Modular Cabins berths count when accepting a passage', async () => {
    const pilot = await captainWith(LEVEL_XP[3], ['H1_TRIM_THRUSTERS', 'H2_HARBOR_PILOT']);
    const offer = signedOffer(pilot, { required_berths: 5 });
    const accept = () => call(pilot, 'POST', '/game/missions/accept', { offer, dockedReceipt: receiptAtOrigin(pilot, offer) });
    assert.equal(json(await accept()).code, 'insufficient_berths');
    const res = await unlockDocked(pilot, 'H4_MODULAR_CABINS');
    assert.equal(json(res).ship_attributes.passenger_capacity, 5);
    const accepted = await accept();
    assert.equal(accepted.statusCode, 200, accepted.body);
    assert.equal(app.jwt.verify(json(accepted).token).ship_attributes.passengers_aboard, 5);
  });

  test('ASSERT-1.2.4: a missing or expired docked receipt is refused with docked_receipt_required', async () => {
    const pilot = await captainWith(200);
    const expired = dockedReceipt(pilot, { dockedAtMs: Date.now() - 60_000, issuedAtMs: Date.now() - 31_000 });
    for (const body of [{ traitId: 'H1_TRIM_THRUSTERS' }, { traitId: 'H1_TRIM_THRUSTERS', dockedReceipt: expired }]) {
      const res = await unlock(pilot, body);
      assert.equal(res.statusCode, 403);
      assert.equal(json(res).error, 'docked_receipt_required');
    }
    assert.deepEqual((await captainRow(pilot)).unlockedTraits, []);
  });

  test('receipts that do not prove this pilot docked here are refused and spend nothing', async () => {
    const pilot = await captainWith(200);
    const other = await newPilot('Other');
    const stationId = randomUUID();
    const cases = [
      [{ traitId: 'H1_TRIM_THRUSTERS', dockedReceipt: dockedReceipt(pilot, {}, loginKey) }, 'docked_receipt_invalid'],
      [{ traitId: 'H1_TRIM_THRUSTERS', dockedReceipt: dockedReceipt(other) }, 'docked_receipt_invalid'],
      [{ traitId: 'H1_TRIM_THRUSTERS', dockedReceipt: { ...dockedReceipt(pilot), dockedEntityId: stationId } }, 'docked_receipt_invalid'],
      [{ traitId: 'H1_TRIM_THRUSTERS', stationId, dockedReceipt: dockedReceipt(pilot) }, 'docked_receipt_wrong_station'],
      [{ traitId: 'H1_TRIM_THRUSTERS', dockedReceipt: dockedReceipt(pilot, { issuedAtMs: Date.now() + 60_000 }) }, 'docked_receipt_required']
    ];
    for (const [body, error] of cases) {
      const res = await unlock(pilot, body);
      assert.equal(res.statusCode, 403, error);
      assert.equal(json(res).error, error);
    }
    assert.deepEqual((await captainRow(pilot)).unlockedTraits, []);
  });

  test('an unknown trait is refused', async () => {
    const pilot = await captainWith(200);
    assert.equal((await unlockDocked(pilot, 'H9_WARP_DRIVE')).statusCode, 400);
  });

  test('a point is spent once: no second trait, no repeat of the same trait', async () => {
    const pilot = await captainWith(200);
    assert.equal((await unlockDocked(pilot, 'H1_TRIM_THRUSTERS')).statusCode, 200);
    let res = await unlockDocked(pilot, 'S1_LONG_BASELINE');
    assert.deepEqual([res.statusCode, json(res).error, json(res).traitPointsAvailable], [409, 'no_trait_points', 0]);
    await setCaptain(pilot, { xp: 600, level: 3 });
    res = await unlockDocked(pilot, 'H1_TRIM_THRUSTERS');
    assert.deepEqual([res.statusCode, json(res).error], [409, 'trait_already_unlocked']);
    assert.deepEqual((await captainRow(pilot)).unlockedTraits, ['H1_TRIM_THRUSTERS']);
  });

  test('a Level 1 captain has no point to spend', async () => {
    const pilot = await newPilot('Rookie');
    const res = await unlockDocked(pilot, 'H1_TRIM_THRUSTERS');
    assert.deepEqual([res.statusCode, json(res).error], [409, 'no_trait_points']);
  });

  test('concurrent unlocks spend the one point once', async () => {
    const pilot = await captainWith(200);
    const results = await Promise.all(['H1_TRIM_THRUSTERS', 'S1_LONG_BASELINE', 'C3_COLD_RUNNING', 'H1_TRIM_THRUSTERS']
      .map((traitId) => unlockDocked(pilot, traitId)));
    assert.deepEqual(results.map((r) => r.statusCode).sort(), [200, 409, 409, 409]);
    assert.equal((await captainRow(pilot)).unlockedTraits.length, 1);
  });

  test('a prerequisite cannot be bypassed by concurrent unlocks', async () => {
    const pilot = await captainWith(LEVEL_XP[9], ['H1_TRIM_THRUSTERS']);
    // H4 is only legal once H2 has landed; racing them must never leave H4 without 2 Helmsman points first.
    const [h2, h4] = await Promise.all([unlockDocked(pilot, 'H2_HARBOR_PILOT'), unlockDocked(pilot, 'H4_MODULAR_CABINS')]);
    assert.equal(h2.statusCode, 200);
    const traits = (await captainRow(pilot)).unlockedTraits;
    if (h4.statusCode === 200) assert.deepEqual(traits, ['H1_TRIM_THRUSTERS', 'H2_HARBOR_PILOT', 'H4_MODULAR_CABINS']);
    else assert.deepEqual([h4.statusCode, traits], [400, ['H1_TRIM_THRUSTERS', 'H2_HARBOR_PILOT']]);
  });

  test('trait points come from stored XP only, never from the request', async () => {
    const pilot = await newPilot('Claimer');
    const res = await unlock(pilot, { traitId: 'H1_TRIM_THRUSTERS', dockedReceipt: dockedReceipt(pilot), xp: 99_999, level: 10 });
    assert.notEqual(res.statusCode, 200);
    const row = await captainRow(pilot);
    assert.deepEqual([row.xp, row.level, row.unlockedTraits], [0, 1, []]);
  });
});
