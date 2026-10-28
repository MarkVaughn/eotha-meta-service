import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createPrivateKey, createPublicKey, randomBytes, randomUUID, sign } from 'node:crypto';
import {
  addCrew, app, call, closeApp, credits, dockedReceipt, json, newPilot, receiptAtOrigin, rtseKey, setCredits, signedOffer
} from './helpers.js';
import { canonicalClaimPayload } from '../src/lib/mission-claim.js';
import { missionOfferVersion } from '../src/lib/mission-offer.js';
import { canonicalCustomsSeizurePayload, verifyCustomsSeizure } from '../src/lib/customs-seizure.js';
import { CAPTURE_TIERS, crewCustomsMults, healthFactor, repairCost } from '../src/config/customs.js';
import { SUCCESSOR_TYPES } from '../src/config/captain.js';
import { computeShipAttributes } from '../src/config/components.js';

const MINUTE_MS = 60_000;

// --- Contract vectors (eotha-rtse customs_seizure.rs, signed by SigningKey::from_bytes(&[7; 32])) ---------
const vectorKey = createPublicKey(createPrivateKey({
  key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.alloc(32, 7)]), format: 'der', type: 'pkcs8'
}));
const VECTOR_BASE = { pilotId: 'pilot-1', stationEntityId: '07070707-0707-4707-8707-070707070707', systemH3: '8828308281fffff' };
const BOARDING_VECTOR = {
  ...VECTOR_BASE, controllingFactionId: 'beta', missionId: 'mission-1', inspectionOutcome: 4, captureTier: 3,
  exposureScoreMilli: 74500, seizedAtMs: 1_791_811_012_345, nonce: Buffer.alloc(16, 0xab).toString('base64'),
  signature: 'emqlOObg+4kQRP4PTd283+41UXkRMr3lSmHeh2ehhNJ8QHXWWVil6gdjv2kF0EQayJ2CUANF9pAOCb3W42EfCQ=='
};

describe('the customs seizure claim contract', () => {
  test('the engine\'s boarding vector has the contract length and verifies', () => {
    assert.equal(canonicalCustomsSeizurePayload(BOARDING_VECTOR).length, 127);
    assert.equal(verifyCustomsSeizure(BOARDING_VECTOR, vectorKey), true);
  });

  test('any changed field, a wrong key or a malformed claim fails to verify without throwing', () => {
    for (const change of [
      { captureTier: 4 }, { inspectionOutcome: 3 }, { exposureScoreMilli: 74501 }, { seizedAtMs: BOARDING_VECTOR.seizedAtMs + 1 },
      { missionId: 'mission-2' }, { controllingFactionId: 'alpha' }, { pilotId: 'pilot-2' }, { systemH3: '8828308283fffff' },
      { stationEntityId: '08080808-0808-4808-8808-080808080808' }, { nonce: Buffer.alloc(16, 0xac).toString('base64') },
      { captureTier: 0 }, { captureTier: 5 }, { inspectionOutcome: 2 }, { controllingFactionId: 'delta' },
      { nonce: Buffer.alloc(15).toString('base64') }, { signature: 'AAAA' }
    ]) assert.equal(verifyCustomsSeizure({ ...BOARDING_VECTOR, ...change }, vectorKey), false, JSON.stringify(change));
    assert.equal(verifyCustomsSeizure(BOARDING_VECTOR, createPublicKey(rtseKey)), false);
  });
});

// --- Health and crew mitigation (unit) -------------------------------------------------------------------
describe('component health and crew customs mitigation', () => {
  test('healthPct scales the attributes of its own component only, linearly', () => {
    const whole = computeShipAttributes([{ type: 'HULL', tier: 3, healthPct: 100 }, { type: 'SHIELDS', tier: 3, healthPct: 100 }]);
    const worn = computeShipAttributes([{ type: 'HULL', tier: 3, healthPct: 60 }, { type: 'SHIELDS', tier: 3, healthPct: 100 }]);
    assert.equal(worn.max_hull_hp, whole.max_hull_hp * 0.6);
    assert.equal(worn.max_shield_hp, whole.max_shield_hp);
    assert.equal(worn.dry_mass_kg, whole.dry_mass_kg);
    assert.equal(worn.hull_tier, whole.hull_tier);
    assert.equal(computeShipAttributes([{ type: 'HULL', tier: 3 }]).max_hull_hp, whole.max_hull_hp); // missing healthPct is whole
    assert.equal(healthFactor(undefined), 1);
    assert.equal(healthFactor(150), 1);
    assert.equal(healthFactor(-5), 0);
  });

  test('repair costs 5 credits per missing point', () => {
    assert.equal(repairCost(100), 0);
    assert.equal(repairCost(80), 100);
    assert.equal(repairCost(10), 450);
  });

  test('a ship with no mitigating crew signs 1.0 for both customs multipliers', () => {
    const a = computeShipAttributes([], 0, [], []);
    assert.equal(a.customs_evasion_mult, 1);
    assert.equal(a.bribe_cost_mult, 1);
  });

  test('crew shield the ship by class and rank, and the bribe discount is capped', () => {
    const member = (crewClass, rank, morale = 75, quirkId = 'Q01') => ({ crewClass, rank, morale, quirkId });
    const evasion = (crew) => crewCustomsMults(crew).customs_evasion_mult;
    assert.ok(evasion([member('DOCTOR', 'NOVICE')]) < 1);
    assert.ok(evasion([member('DOCTOR', 'MASTER')]) < evasion([member('DOCTOR', 'NOVICE')]));
    assert.ok(evasion([member('DOCTOR', 'MASTER'), member('ENGINEER', 'MASTER'), member('DIPLOMAT', 'MASTER')]) >= 0.25);
    // Everyone who discounts bribes at once is held to the 25% cap.
    const bribers = [member('DOCTOR', 'MASTER'), member('DIPLOMAT', 'MASTER'), member('SMUGGLER', 'MASTER')];
    assert.equal(crewCustomsMults(bribers).bribe_cost_mult, 0.75);
    // A mutinous crew leaks, which raises the evasion multiplier; a detained member helps nobody.
    assert.ok(evasion([member('CHEF', 'NOVICE', 10)]) > 1);
    assert.equal(crewCustomsMults([{ ...member('DIPLOMAT', 'MASTER'), detained: true }]).bribe_cost_mult, 1);
    assert.equal(crewCustomsMults([member('DIPLOMAT', 'MASTER', 0)]).bribe_cost_mult, 1);
  });

  test('the capture tiers carry the design values', () => {
    assert.deepEqual([1, 2, 3, 4].map((t) => CAPTURE_TIERS[t].fineRate), [0.15, 0.25, 0.3, 0.35]);
    assert.deepEqual([1, 2, 3, 4].map((t) => CAPTURE_TIERS[t].lockoutMs / MINUTE_MS), [0, 15, 30, 30]);
    assert.deepEqual([1, 2, 3, 4].map((t) => CAPTURE_TIERS[t].moraleLoss), [4, 8, 12, 18]);
  });
});

// --- Routes ----------------------------------------------------------------------------------------------
const covert = (pilot, overrides = {}) => signedOffer(pilot, {
  visibility: 'MISSION_VISIBILITY_COVERT', archetype: 'MISSION_ARCHETYPE_SABOTEUR_INSERTION',
  faction_id: 'alpha', reputation_change: 25, opposed_faction_id: 'beta', opposed_reputation_change: -15,
  clandestine_bonus_credits: 625, carries_contraband_or_operative: true, ...overrides
});
const accept = (pilot, offer) => call(pilot, 'POST', '/game/missions/accept', { offer, dockedReceipt: receiptAtOrigin(pilot, offer) });
async function take(pilot, offer = covert(pilot)) {
  const response = await accept(pilot, offer);
  assert.equal(response.statusCode, 200, response.body);
  return json(response).active;
}
const seizureFor = (pilot, active, overrides = {}) => {
  const claim = {
    pilotId: pilot.id,
    stationEntityId: randomUUID(),
    systemH3: '8828308281fffff',
    controllingFactionId: 'beta',
    missionId: active?.mission_id ?? '',
    inspectionOutcome: 4,
    captureTier: 3,
    exposureScoreMilli: 74500,
    seizedAtMs: Date.now() - 1000,
    nonce: randomBytes(16).toString('base64'),
    ...overrides
  };
  claim.signature = sign(null, canonicalCustomsSeizurePayload(claim), rtseKey).toString('base64');
  return claim;
};
const seize = (pilot, claim) => call(pilot, 'POST', '/game/missions/seizure', { claim });
const held = async (pilot) => json(await call(pilot, 'GET', '/game/missions/active')).missions;
const standing = (pilot, factionId, value) => app.prisma.playerReputation.upsert({
  where: { playerId_factionId: { playerId: pilot.id, factionId } }, update: { standing: value },
  create: { playerId: pilot.id, factionId, standing: value }
});
const standingOf = async (pilot, factionId) =>
  (await app.prisma.playerReputation.findUnique({ where: { playerId_factionId: { playerId: pilot.id, factionId } } }))?.standing ?? 0;
const componentsOf = async (pilot) => {
  const ship = await app.prisma.spaceship.findFirst({ where: { playerId: pilot.id, active: true }, include: { components: true } });
  return Object.fromEntries(ship.components.map((c) => [c.type, c.healthPct]));
};
// Installs (at tier 1) the optional components the starting ship lacks, which captures can only damage if present.
const install = async (pilot, types) => {
  await call(pilot, 'GET', '/ship/loadout');
  const ship = await app.prisma.spaceship.findFirst({ where: { playerId: pilot.id, active: true } });
  await app.prisma.shipComponentRecord.updateMany({ where: { spaceshipId: ship.id, type: { in: types }, tier: 0 }, data: { tier: 1 } });
};
const wear = async (pilot, healthByType) => {
  await call(pilot, 'GET', '/ship/loadout');
  const ship = await app.prisma.spaceship.findFirst({ where: { playerId: pilot.id, active: true } });
  for (const [type, healthPct] of Object.entries(healthByType)) {
    await app.prisma.shipComponentRecord.updateMany({ where: { spaceshipId: ship.id, type }, data: { healthPct } });
  }
};

before(async () => { await app.ready(); });
after(closeApp);

describe('POST /game/missions/seizure', () => {
  test('a tier 3 boarding fails the mission, fines 30%, costs reputation, damages hull and shields and locks the station', async () => {
    const pilot = await newPilot();
    const active = await take(pilot);
    await install(pilot, ['SHIELDS']);
    await setCredits(pilot, 5000);
    await standing(pilot, 'alpha', 60);
    await standing(pilot, 'beta', 60);
    const crew = await addCrew(pilot, { morale: 75 });
    const claim = seizureFor(pilot, active);

    const response = await seize(pilot, claim);
    assert.equal(response.statusCode, 200, response.body);
    const body = json(response);
    assert.equal(body.success, true);
    assert.equal(body.replayed, false);
    assert.equal(body.mission_failed, true);
    assert.equal(body.fine_credits, 750); // 30% of the offered 2500
    assert.equal(body.credits, 4250);
    assert.equal(await credits(pilot), 4250);
    assert.equal(await standingOf(pilot, 'alpha'), 60 - 20); // sponsor: -0.8 x 25
    assert.equal(await standingOf(pilot, 'beta'), 60 - 30); // governing the station: -1.2 x 25
    assert.deepEqual(body.reputation_changes.map((c) => [c.faction_id, c.delta]), [['alpha', -20], ['beta', -30]]);
    assert.equal((await held(pilot)).length, 0);
    assert.equal(body.passengers_removed, 2);

    const health = await componentsOf(pilot);
    assert.deepEqual(body.component_damage.map((d) => d.type).sort(), ['HULL', 'SHIELDS']);
    for (const type of ['HULL', 'SHIELDS']) assert.ok(health[type] >= 75 && health[type] <= 85, `${type} ${health[type]}`);
    for (const type of Object.keys(health).filter((t) => t !== 'HULL' && t !== 'SHIELDS')) assert.equal(health[type], 100);

    const after = await app.prisma.crewMember.findUnique({ where: { id: crew.id } });
    assert.ok(after.morale < 75);
    assert.equal(after.detainedUntil, null);

    const lockout = await app.prisma.stationLockout.findUnique({
      where: { playerId_stationId: { playerId: pilot.id, stationId: claim.stationEntityId } }
    });
    assert.equal(lockout.until.getTime(), claim.seizedAtMs + 30 * MINUTE_MS);
    assert.equal(body.lockout.until_ms, claim.seizedAtMs + 30 * MINUTE_MS);

    const ledger = await app.prisma.reputationLedger.findMany({ where: { playerId: pilot.id, reason: 'CUSTOMS_CAUGHT' } });
    assert.equal(ledger.length, 1);
    assert.equal(ledger[0].missionId, active.mission_id);

    // The token carries the worn ship.
    const token = app.jwt.verify(body.token);
    assert.equal(token.ship_attributes.max_hull_hp, 100 * health.HULL / 100);
    assert.equal(token.active_mission ?? null, null);
  });

  test('a replayed claim answers with the first result and applies nothing twice', async () => {
    const pilot = await newPilot();
    const active = await take(pilot);
    await setCredits(pilot, 5000);
    await standing(pilot, 'alpha', 60);
    const claim = seizureFor(pilot, active, { captureTier: 4 });
    const first = json(await seize(pilot, claim));
    const health = await componentsOf(pilot);
    const balance = await credits(pilot);
    const ledger = await app.prisma.reputationLedger.count({ where: { playerId: pilot.id } });

    const replay = await seize(pilot, claim);
    assert.equal(replay.statusCode, 200, replay.body);
    const again = json(replay);
    assert.equal(again.replayed, true);
    const { token: _t1, replayed: _r1, ...firstBody } = first;
    const { token: _t2, replayed: _r2, ...againBody } = again;
    assert.deepEqual(againBody, firstBody);
    assert.deepEqual(await componentsOf(pilot), health);
    assert.equal(await credits(pilot), balance);
    assert.equal(await app.prisma.reputationLedger.count({ where: { playerId: pilot.id } }), ledger);
    assert.equal(await app.prisma.customsSeizure.count({ where: { playerId: pilot.id } }), 1);
  });

  test('concurrent copies of one claim apply it once', async () => {
    const pilot = await newPilot();
    const active = await take(pilot);
    await setCredits(pilot, 5000);
    const claim = seizureFor(pilot, active, { captureTier: 2 });
    const responses = await Promise.all([seize(pilot, claim), seize(pilot, claim), seize(pilot, claim)]);
    assert.deepEqual(responses.map((r) => r.statusCode), [200, 200, 200]);
    assert.equal(responses.filter((r) => json(r).replayed === false).length, 1);
    assert.equal(await credits(pilot), 5000 - 625); // 25% of 2500, once
  });

  test('a tier 4 firefight detains one crew member for 30 minutes and switches their effects off', async () => {
    const pilot = await newPilot();
    const active = await take(pilot);
    await install(pilot, ['SHIELDS', 'WEAPONS']);
    await setCredits(pilot, 5000);
    const crew = await addCrew(pilot, { crewClass: 'DIPLOMAT', rank: 'MASTER', morale: 75 });
    const before = computeShipAttributes([], 0, [], [{ ...crew, status: 'ACTIVE' }]);
    assert.ok(before.bribe_cost_mult < 1);
    const claim = seizureFor(pilot, active, { captureTier: 4 });
    const body = json(await seize(pilot, claim));
    assert.equal(body.detained_crew.crew_id, crew.id);
    assert.equal(body.detained_crew.until_ms, claim.seizedAtMs + 30 * MINUTE_MS);
    assert.equal(body.fine_credits, 875); // 35% of 2500
    assert.deepEqual(body.component_damage.map((d) => d.type).sort(), ['HULL', 'SHIELDS', 'WEAPONS']);
    const attributes = app.jwt.verify(body.token).ship_attributes;
    assert.equal(attributes.bribe_cost_mult, 1);
    assert.equal(attributes.crew_aboard, 1); // the detainee keeps their berth
    const loadout = json(await call(pilot, 'GET', '/ship/loadout'));
    assert.equal(loadout.ship_attributes.bribe_cost_mult, 1);
  });

  test('tier 1 only fines and costs reputation and morale: no damage, detention or lockout', async () => {
    const pilot = await newPilot();
    const active = await take(pilot);
    await setCredits(pilot, 5000);
    const body = json(await seize(pilot, seizureFor(pilot, active, { captureTier: 1, inspectionOutcome: 3 })));
    assert.equal(body.fine_credits, 375);
    assert.deepEqual(body.component_damage, []);
    assert.equal(body.lockout, null);
    assert.equal(body.detained_crew, null);
    assert.deepEqual(await componentsOf(pilot), Object.fromEntries(Object.keys(await componentsOf(pilot)).map((t) => [t, 100])));
    assert.equal(await app.prisma.stationLockout.count({ where: { playerId: pilot.id } }), 0);
  });

  test('a tier 2 capture clamps CARGO or COMMS by 5% and locks the station for 15 minutes', async () => {
    const pilot = await newPilot();
    const active = await take(pilot);
    await setCredits(pilot, 5000);
    const claim = seizureFor(pilot, active, { captureTier: 2 });
    const body = json(await seize(pilot, claim));
    assert.equal(body.component_damage.length, 1);
    assert.ok(['CARGO', 'COMMS'].includes(body.component_damage[0].type));
    assert.equal(body.component_damage[0].healthAfter, 95);
    assert.equal(body.lockout.until_ms, claim.seizedAtMs + 15 * MINUTE_MS);
  });

  test('a capture whose lockout has already run out records none, and damage stays deterministic per nonce', async () => {
    const pilot = await newPilot();
    const old = seizureFor(pilot, null, { captureTier: 2, seizedAtMs: Date.now() - 20 * MINUTE_MS });
    const body = json(await seize(pilot, old));
    assert.equal(body.lockout, null);
    assert.equal(body.mission_failed, false);
    assert.equal(body.fine_credits, 0);
  });

  test('the fine never takes the balance below zero', async () => {
    const pilot = await newPilot();
    const active = await take(pilot);
    await setCredits(pilot, 100);
    const body = json(await seize(pilot, seizureFor(pilot, active, { captureTier: 3 })));
    assert.equal(body.fine_credits, 100);
    assert.equal(body.fine_unpaid_credits, 650);
    assert.equal(await credits(pilot), 0);
  });

  test('a bad signature, a tampered field, another pilot\'s claim or a future claim changes nothing', async () => {
    const pilot = await newPilot();
    const other = await newPilot();
    const active = await take(pilot);
    await setCredits(pilot, 5000);
    const claim = seizureFor(pilot, active);
    for (const [who, change, status] of [
      [pilot, { captureTier: 1 }, 403],
      [pilot, { exposureScoreMilli: 1 }, 403],
      [pilot, { signature: Buffer.alloc(64).toString('base64') }, 403],
      [other, {}, 403],
      [pilot, { captureTier: 9 }, 403],
      [pilot, { inspectionOutcome: 1 }, 403]
    ]) {
      assert.equal((await seize(who, { ...claim, ...change })).statusCode, status, JSON.stringify(change));
    }
    const future = seizureFor(pilot, active, { seizedAtMs: Date.now() + 10 * MINUTE_MS });
    assert.equal((await seize(pilot, future)).statusCode, 400);
    assert.equal((await held(pilot)).length, 1);
    assert.equal(await credits(pilot), 5000);
    assert.equal(await app.prisma.customsSeizure.count({ where: { playerId: pilot.id } }), 0);
    // A claim signed by a key that is not the engine's is refused too.
    const forged = { ...claim };
    forged.signature = sign(null, canonicalCustomsSeizurePayload(forged), createPrivateKey(
      { key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.alloc(32, 9)]), format: 'der', type: 'pkcs8' }
    )).toString('base64');
    assert.equal((await seize(pilot, forged)).statusCode, 403);
  });

  test('a mission that carries nothing customs could seize is refused and left alone', async () => {
    const pilot = await newPilot();
    const active = await take(pilot, covert(pilot, { carries_contraband_or_operative: false }));
    const response = await seize(pilot, seizureFor(pilot, active));
    assert.equal(response.statusCode, 409);
    assert.equal(json(response).code, 'mission_not_inspectable');
    assert.equal((await held(pilot)).length, 1);
    assert.equal(await app.prisma.customsSeizure.count({ where: { playerId: pilot.id } }), 0);
  });

  test('a seized mission cannot be accepted again', async () => {
    const pilot = await newPilot();
    const offer = covert(pilot);
    const active = await take(pilot, offer);
    assert.equal((await seize(pilot, seizureFor(pilot, active, { captureTier: 1, inspectionOutcome: 3 }))).statusCode, 200);
    const response = await accept(pilot, offer);
    assert.equal(response.statusCode, 409, response.body);
    assert.equal(json(response).code, 'mission_failed_inspection');
  });

  test('the lockout refuses that station\'s mission board, upgrades and repairs for that pilot only', async () => {
    const pilot = await newPilot();
    const other = await newPilot();
    const stationId = randomUUID();
    const active = await take(pilot);
    await setCredits(pilot, 50_000);
    await setCredits(other, 50_000);
    await wear(pilot, { HULL: 60 });
    const claim = seizureFor(pilot, active, { captureTier: 3, stationEntityId: stationId });
    assert.equal((await seize(pilot, claim)).statusCode, 200);

    const listed = json(await call(pilot, 'GET', '/game/missions/lockouts')).lockouts;
    assert.equal(listed.length, 1);
    assert.equal(listed[0].station_id, stationId);
    assert.ok(listed[0].remaining_ms > 0);
    const cooldown = json(await call(pilot, 'GET', `/game/missions/cooldown?originId=${stationId}`));
    assert.equal(cooldown.active, true);
    assert.equal(cooldown.locked_out, true);

    const here = covert(pilot, { origin_station_id: stationId });
    const refused = await accept(pilot, here);
    assert.equal(refused.statusCode, 403, refused.body);
    assert.equal(json(refused).code, 'station_locked_out');
    assert.equal((await held(pilot)).length, 0);
    // Upper-case ids are the same station.
    const upper = await call(pilot, 'POST', '/ship/repair', { dockedReceipt: dockedReceipt(pilot, { dockedEntityId: stationId.toUpperCase() }) });
    assert.notEqual(upper.statusCode, 200);

    const receipt = () => dockedReceipt(pilot, { dockedEntityId: stationId });
    const upgrade = await call(pilot, 'POST', '/ship/upgrade', { componentType: 'HULL', targetTier: 2, dockedReceipt: receipt() });
    assert.equal(upgrade.statusCode, 403);
    assert.equal(json(upgrade).code, 'station_locked_out');
    const repair = await call(pilot, 'POST', '/ship/repair', { dockedReceipt: receipt() });
    assert.equal(repair.statusCode, 403);
    assert.equal(json(repair).code, 'station_locked_out');

    // Another station, and another pilot at this one, are unaffected.
    const elsewhere = await call(pilot, 'POST', '/ship/repair', { dockedReceipt: dockedReceipt(pilot, { dockedEntityId: randomUUID() }) });
    assert.equal(elsewhere.statusCode, 200, elsewhere.body);
    const otherPilot = await call(other, 'POST', '/ship/upgrade', { componentType: 'HULL', targetTier: 2, dockedReceipt: dockedReceipt(other, { dockedEntityId: stationId }) });
    assert.equal(otherPilot.statusCode, 200, otherPilot.body);
  });

  test('an expired lockout no longer refuses', async () => {
    const pilot = await newPilot();
    const stationId = randomUUID();
    await call(pilot, 'GET', '/ship/loadout');
    await app.prisma.stationLockout.create({ data: { playerId: pilot.id, stationId, tier: 2, until: new Date(Date.now() - 1000) } });
    assert.deepEqual(json(await call(pilot, 'GET', '/game/missions/lockouts')).lockouts, []);
    const offer = covert(pilot, { origin_station_id: stationId });
    assert.equal((await accept(pilot, offer)).statusCode, 200);
  });
});

describe('POST /ship/repair', () => {
  const repair = (pilot, extra = {}) => call(pilot, 'POST', '/ship/repair', { dockedReceipt: dockedReceipt(pilot), ...extra });

  test('restores damaged components to 100 for 5 credits per missing point', async () => {
    const pilot = await newPilot();
    await setCredits(pilot, 1000);
    await wear(pilot, { HULL: 60, SHIELDS: 90 });
    const response = await repair(pilot);
    assert.equal(response.statusCode, 200, response.body);
    const body = json(response);
    assert.equal(body.cost, 5 * 40 + 5 * 10);
    assert.equal(body.credits, 1000 - 250);
    assert.deepEqual(body.repaired.map((r) => [r.type, r.cost]).sort(), [['HULL', 200], ['SHIELDS', 50]]);
    assert.ok(Object.values(await componentsOf(pilot)).every((value) => value === 100));
    assert.ok(body.components.every((c) => c.healthPct === 100));
    assert.equal(app.jwt.verify(body.token).ship_attributes.max_hull_hp, body.ship_attributes.max_hull_hp);
    assert.equal((await repair(pilot)).statusCode, 409);
  });

  test('repairs only the components asked for', async () => {
    const pilot = await newPilot();
    await setCredits(pilot, 1000);
    await wear(pilot, { HULL: 60, SHIELDS: 90 });
    const body = json(await repair(pilot, { componentTypes: ['SHIELDS'] }));
    assert.equal(body.cost, 50);
    const health = await componentsOf(pilot);
    assert.equal(health.HULL, 60);
    assert.equal(health.SHIELDS, 100);
  });

  test('needs a valid docked receipt and enough credits, and charges nothing otherwise', async () => {
    const pilot = await newPilot();
    await setCredits(pilot, 100);
    await wear(pilot, { HULL: 60 });
    const bare = await call(pilot, 'POST', '/ship/repair', {});
    assert.equal(bare.statusCode, 403);
    assert.equal(json(bare).code, 'docked_receipt_required');
    const forged = await call(pilot, 'POST', '/ship/repair', { dockedReceipt: { ...dockedReceipt(pilot), systemH3: '8828308283fffff' } });
    assert.equal(forged.statusCode, 403);
    const poor = await repair(pilot);
    assert.equal(poor.statusCode, 402);
    assert.equal(json(poor).cost, 200);
    assert.equal(await credits(pilot), 100);
    assert.equal((await componentsOf(pilot)).HULL, 60);
  });
});

describe('bribed mission completion', () => {
  const claimFor = (pilot, active, overrides = {}) => {
    const claim = {
      missionId: active.mission_id, playerShipId: pilot.id, destinationStationId: active.offer.destination_station_id,
      acceptedAtMs: active.accepted_at_ms, completedAtMs: active.accepted_at_ms + 1000, durationTakenMs: 1000,
      rewardCredits: active.offer.reward_credits, reputationChange: active.offer.reputation_change,
      wasDetected: false, exposureScoreMilli: 22000, opposedReputationChange: 0, bribePaidCredits: 0, ...overrides
    };
    claim.signature = sign(null, canonicalClaimPayload(claim, false, missionOfferVersion(active.offer)), rtseKey).toString('base64');
    return claim;
  };
  const complete = (pilot, claim) => call(pilot, 'POST', '/game/missions/complete', { claim });

  test('settles with the bribe deducted, 75% sponsor reputation, no rival harm, no clandestine bonus and a ledger record', async () => {
    const pilot = await newPilot();
    const active = await take(pilot);
    await setCredits(pilot, 1000);
    const response = await complete(pilot, claimFor(pilot, active, { bribePaidCredits: 400 }));
    assert.equal(response.statusCode, 200, response.body);
    const body = json(response);
    assert.equal(body.bribe_paid_credits, 400);
    assert.equal(body.clandestineBonusCredits, undefined);
    assert.equal(body.credits, 1000 + 2500 - 400);
    assert.equal(await credits(pilot), 3100);
    assert.equal(await standingOf(pilot, 'alpha'), 19); // round(0.75 x 25)
    assert.equal(body.reputation_change, 19);
    assert.equal(await standingOf(pilot, 'beta'), 0);
    assert.ok(Object.keys(body).some((k) => /xp/i.test(k)), 'the Captain still earns XP');
    const ledger = await app.prisma.reputationLedger.findMany({ where: { playerId: pilot.id } });
    assert.equal(ledger.length, 1);
    assert.equal(ledger[0].reason, 'COMPLETE_BRIBED');
    assert.equal(ledger[0].bribePaidCredits, 400);
    assert.equal(ledger[0].missionId, active.mission_id);
    assert.equal(ledger[0].betaDelta, 0);
    assert.equal((await held(pilot)).length, 0);
  });

  test('a replayed bribed claim settles nothing twice', async () => {
    const pilot = await newPilot();
    const active = await take(pilot);
    await setCredits(pilot, 1000);
    const claim = claimFor(pilot, active, { bribePaidCredits: 400 });
    assert.equal((await complete(pilot, claim)).statusCode, 200);
    assert.equal((await complete(pilot, claim)).statusCode, 404); // the mission is no longer held
    assert.equal(await credits(pilot), 3100);
    assert.equal(await app.prisma.reputationLedger.count({ where: { playerId: pilot.id } }), 1);
  });

  test('a Smuggler\'s clandestine bonus is paid on a clean run and not on a bribed one', async () => {
    const [clean, bribed] = [await newPilot(), await newPilot()];
    for (const pilot of [clean, bribed]) await addCrew(pilot, { crewClass: 'SMUGGLER', rank: 'MASTER', wageShareBp: 0 });
    const cleanActive = await take(clean);
    const bribedActive = await take(bribed);
    await setCredits(bribed, 1000);
    const paid = json(await complete(clean, claimFor(clean, cleanActive)));
    assert.ok(paid.clandestineBonusCredits > 0);
    const spared = json(await complete(bribed, claimFor(bribed, bribedActive, { bribePaidCredits: 400 })));
    assert.equal(spared.clandestineBonusCredits, undefined);
    assert.equal(spared.bribe_paid_credits, 400);
  });

  test('a detected run that bribed signs no rival harm, and any harm is refused', async () => {
    const pilot = await newPilot();
    const active = await take(pilot);
    await setCredits(pilot, 1000);
    await standing(pilot, 'beta', 40);
    const harmed = claimFor(pilot, active, { bribePaidCredits: 400, wasDetected: true, opposedReputationChange: -15 });
    assert.equal((await complete(pilot, harmed)).statusCode, 400);
    const claim = claimFor(pilot, active, { bribePaidCredits: 400, wasDetected: true });
    assert.equal((await complete(pilot, claim)).statusCode, 200);
    assert.equal(await standingOf(pilot, 'beta'), 40);
  });

  test('a bribe the pilot cannot pay leaves the mission active and changes nothing', async () => {
    const pilot = await newPilot();
    const active = await take(pilot);
    await setCredits(pilot, 0);
    const response = await complete(pilot, claimFor(pilot, active, { bribePaidCredits: 2501 }));
    assert.equal(response.statusCode, 402, response.body);
    assert.equal(json(response).code, 'bribe_unaffordable');
    assert.equal((await held(pilot)).length, 1);
    assert.equal(await credits(pilot), 0);
    assert.equal(await app.prisma.completedMission.count({ where: { playerId: pilot.id } }), 0);
    assert.equal(await app.prisma.reputationLedger.count({ where: { playerId: pilot.id } }), 0);
    assert.equal(await standingOf(pilot, 'alpha'), 0);
    // The same mission settles once the bribe is one the balance and payout cover.
    assert.equal((await complete(pilot, claimFor(pilot, active, { bribePaidCredits: 2500 }))).statusCode, 200);
    assert.equal(await credits(pilot), 0);
  });

  test('only a covert mission carrying contraband can have paid a bribe', async () => {
    const pilot = await newPilot();
    const active = await take(pilot, covert(pilot, { carries_contraband_or_operative: false }));
    await setCredits(pilot, 1000);
    assert.equal((await complete(pilot, claimFor(pilot, active, { bribePaidCredits: 100 }))).statusCode, 400);
    assert.equal((await held(pilot)).length, 1);
  });
});

describe('customs lockout scope', () => {
  const lockOut = async (pilot, stationId) => {
    await call(pilot, 'GET', '/ship/loadout');
    await app.prisma.stationLockout.create({ data: { playerId: pilot.id, stationId, tier: 3, until: new Date(Date.now() + 30 * MINUTE_MS) } });
  };
  const sale = (pilot) => ({
    pilotId: pilot.id, stationId: randomUUID(), totalCredits: 1, soldAtMs: Date.now(), nonce: randomBytes(16).toString('base64'),
    signature: randomBytes(64).toString('base64'), leaseId: randomUUID(), sessionId: randomUUID(), seq: 1
  });
  const uuid = () => randomUUID();
  const routes = (pilot, receipt) => ({
    'crew/board': ['/game/crew/board', {}],
    'crew/hire': ['/game/crew/hire', { candidateId: 'cand-0-0123abcd' }],
    'crew/dismiss': ['/game/crew/dismiss', { crewId: uuid() }],
    'crew/standby': ['/game/crew/standby', { crewId: uuid() }],
    'crew/activate': ['/game/crew/activate', { crewId: uuid() }],
    'crew/jury-rig': ['/game/crew/jury-rig', { crewId: uuid(), componentTypes: [] }],
    'crew/promote': ['/game/crew/promote', { crewId: uuid() }],
    'crew/shore-leave': ['/game/crew/shore-leave', {}],
    'crew/pay-arrears': ['/game/crew/pay-arrears', {}],
    'cargo/sell': ['/game/cargo/sell', { saleRecord: sale(pilot) }],
    'captain/trait': ['/game/captain/trait', { traitId: 'H1_TRIM_THRUSTERS' }],
    'captain/retire': ['/game/captain/retire', { successorType: Object.values(SUCCESSOR_TYPES)[0] }],
    'captain/doctrine': ['/game/captain/doctrine', { retiredCaptainId: uuid(), active: true }],
    'captain/jury-rig': ['/game/captain/jury-rig', { componentTypes: [] }],
    'factions/colors': ['/game/factions/colors', { factionId: null }],
    'factions/renounce-paragon': ['/game/factions/renounce-paragon', { currentParagonFactionId: 'alpha' }],
    'charts/sell': ['/game/charts/sell', { planetId: 'no-such-chart', stationId: 'station-alpha' }]
  });
  const post = (pilot, [url, body], stationId) =>
    call(pilot, 'POST', url, { ...body, dockedReceipt: dockedReceipt(pilot, { dockedEntityId: stationId }) });

  test('every docked-receipt service refuses a locked-out pilot at that station only', async () => {
    const pilot = await newPilot();
    const other = await newPilot();
    const stationId = randomUUID();
    await lockOut(pilot, stationId);
    await call(other, 'GET', '/ship/loadout');

    for (const [name, route] of Object.entries(routes(pilot))) {
      const refused = await post(pilot, route, stationId);
      assert.equal(refused.statusCode, 403, `${name}: ${refused.body}`);
      assert.equal(json(refused).code, 'station_locked_out', name);
      assert.ok(json(refused).remaining_ms > 0, name);

      const elsewhere = await post(pilot, route, randomUUID());
      assert.notEqual(json(elsewhere).code, 'station_locked_out', `${name} at another station`);
      const otherPilot = await post(other, routes(other)[name], stationId);
      assert.notEqual(json(otherPilot).code, 'station_locked_out', `${name} for another pilot`);
    }
  });

  test('mission complete, abandon and disembark still work while locked out', async () => {
    const pilot = await newPilot();
    const stationId = randomUUID();
    const offer = covert(pilot);
    const active = await take(pilot, offer);
    await lockOut(pilot, stationId);
    const receipt = () => dockedReceipt(pilot, { dockedEntityId: stationId });

    const disembark = await call(pilot, 'POST', '/game/missions/disembark', { missionId: active.mission_id, dockedReceipt: receipt() });
    assert.notEqual(json(disembark).code, 'station_locked_out', disembark.body);
    const complete = await call(pilot, 'POST', '/game/missions/complete', {
      dockedReceipt: receipt(),
      claim: {
        missionId: active.mission_id, playerShipId: pilot.id, destinationStationId: stationId, acceptedAtMs: 1, completedAtMs: 2,
        durationTakenMs: 1, rewardCredits: 1, reputationChange: 0, signature: randomBytes(64).toString('base64')
      }
    });
    assert.notEqual(json(complete).code, 'station_locked_out', complete.body);
    const abandon = await call(pilot, 'POST', '/game/missions/abandon', { missionId: active.mission_id, dockedReceipt: receipt() });
    assert.equal(abandon.statusCode, 200, abandon.body);
  });
});
