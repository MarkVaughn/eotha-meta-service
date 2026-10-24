import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, sign } from 'node:crypto';
import {
  PASSWORD, addCrew, app, attestationHeaders, call, closeApp, credits, json,
  newPilot, receiptAtOrigin, rtseKey, setCredits, signedOffer
} from './helpers.js';
import { canonicalClaimPayload } from '../src/lib/mission-claim.js';
import { canonicalMissionOfferPayload, missionOfferVersion } from '../src/lib/mission-offer.js';

const covert = (pilot, overrides = {}) => signedOffer(pilot, {
  visibility: 'MISSION_VISIBILITY_COVERT', archetype: 'MISSION_ARCHETYPE_SABOTEUR_INSERTION',
  faction_id: 'alpha', reputation_change: 25, opposed_faction_id: 'beta', opposed_reputation_change: -15,
  clandestine_bonus_credits: 625, carries_contraband_or_operative: true, ...overrides
});
const accept = (pilot, offer) => call(pilot, 'POST', '/game/missions/accept', { offer, dockedReceipt: receiptAtOrigin(pilot, offer) });
async function take(pilot, offer = covert(pilot)) {
  const response = await accept(pilot, offer);
  assert.equal(response.statusCode, 200, response.body);
  return json(response);
}
function claimFor(pilot, active, overrides = {}, version = missionOfferVersion(active.offer)) {
  const claim = {
    missionId: active.mission_id, playerShipId: pilot.id, destinationStationId: active.offer.destination_station_id,
    acceptedAtMs: active.accepted_at_ms, completedAtMs: active.accepted_at_ms + 1000, durationTakenMs: 1000,
    rewardCredits: active.offer.reward_credits, reputationChange: active.offer.reputation_change,
    wasDetected: false, exposureScoreMilli: 22000, opposedReputationChange: 0, bribePaidCredits: 0,
    ...overrides
  };
  claim.signature = sign(null, canonicalClaimPayload(claim, active.offer.type === 'MISSION_TYPE_GATHER', version), rtseKey).toString('base64');
  return claim;
}
const complete = (pilot, claim) => call(pilot, 'POST', '/game/missions/complete', { claim });
const jwt = (response) => app.jwt.verify(json(response).token);
const held = async (pilot) => json(await call(pilot, 'GET', '/game/missions/active')).missions;
const standing = (pilot, factionId, value) => app.prisma.playerReputation.upsert({
  where: { playerId_factionId: { playerId: pilot.id, factionId } }, update: { standing: value },
  create: { playerId: pilot.id, factionId, standing: value }
});
const login = (pilot) => app.inject({ method: 'POST', url: '/auth/login', headers: attestationHeaders,
  payload: { email: pilot.email, password: PASSWORD, deviceId: 'v2-login-test-device-id' } });
const research = (pilot, fields = {}) => signedOffer(pilot, { type: 'MISSION_TYPE_RESEARCH', required_berths: 0, ...fields });

describe('factions phase 3 meta lifecycle', () => {
  before(async () => { await app.ready(); });
  after(async () => { await closeApp(); });

  test('V2 offer survives accept, JSONB, API and engine JWT round trip with exact signed coordinates', async () => {
    const pilot = await newPilot();
    const offer = covert(pilot);
    const response = await accept(pilot, offer);
    assert.equal(response.statusCode, 200, response.body);
    const active = json(response).active;
    assert.deepEqual(active.offer, offer);
    assert.deepEqual((await held(pilot))[0], active);
    const claim = jwt(response).active_mission;
    assert.equal(claim.offer.type, 1);
    assert.equal(claim.offer.visibility, 2);
    assert.equal(claim.offer.archetype, 2);
    assert.deepEqual(claim.offer.signature, [...Buffer.from(offer.signature, 'base64')]);
    assert.equal(claim.accepted_at_ms, active.accepted_at_ms);
    assert.equal(claim.deadline_ms, claim.accepted_at_ms + offer.duration_limit_ms);
    assert.equal(claim.player_ship_id, pilot.id);
    assert.equal(claim.is_completed, false);
    assert.ok(claim.accepted_at_ms >= offer.offered_at_ms && claim.accepted_at_ms <= offer.expires_at_ms);
    assert.deepEqual(canonicalMissionOfferPayload({ ...claim.offer, type: offer.type }), canonicalMissionOfferPayload(offer));
    assert.equal('exact_destination' in claim.offer, false);
  });

  test('one held covert mission across base types; concurrent accepts are serialized and refusal is side-effect free', async () => {
    const pilot = await newPilot();
    const offers = [covert(pilot), covert(pilot, {
      type: 'MISSION_TYPE_RESEARCH', required_berths: 0, archetype: 'MISSION_ARCHETYPE_STRATEGIC_RECON'
    })];
    const results = await Promise.all(offers.map((offer) => accept(pilot, offer)));
    assert.deepEqual(results.map((r) => r.statusCode).sort(), [200, 409]);
    assert.equal(json(results.find((r) => r.statusCode === 409)).code, 'covert_mission_limit_reached');
    assert.equal((await held(pilot)).length, 1);
    const third = await accept(pilot, covert(pilot, { type: 'MISSION_TYPE_RESEARCH', required_berths: 0 }));
    assert.equal(third.statusCode, 409);
    assert.equal(json(third).code, 'covert_mission_limit_reached');
    assert.equal(await app.prisma.completedMission.count({ where: { playerId: pilot.id } }), 0);
    assert.equal(await app.prisma.reputationLedger.count({ where: { playerId: pilot.id } }), 0);
  });

  test('V1/overt accepts and completions preserve covert tracking even with stale caller tokens', async () => {
    const pilot = await newPilot();
    const { active } = await take(pilot);
    const v1 = await accept(pilot, research(pilot));
    assert.equal(v1.statusCode, 200, v1.body);
    assert.equal(jwt(v1).active_mission.mission_id, active.mission_id);
    const overt = await accept(pilot, research(pilot, { visibility: 1, archetype: 0 }));
    assert.equal(overt.statusCode, 200, overt.body);
    assert.equal(jwt(overt).active_mission.mission_id, active.mission_id);
    for (const response of [v1, overt]) {
      const completed = await complete(pilot, claimFor(pilot, json(response).active, { exposureScoreMilli: 0 }));
      assert.equal(completed.statusCode, 200, completed.body);
      assert.equal(jwt(completed).active_mission.mission_id, active.mission_id);
    }
    const other = await take(pilot, research(pilot));
    const abandoned = await call(pilot, 'POST', '/game/missions/abandon', { missionId: other.active.mission_id });
    assert.equal(abandoned.statusCode, 200, abandoned.body);
    assert.equal(jwt(abandoned).active_mission.mission_id, active.mission_id);
    const loadout = await call(pilot, 'POST', '/game/cargo/lease');
    assert.equal(jwt(loadout).active_mission.mission_id, active.mission_id);
    assert.equal(jwt(loadout).exp, app.jwt.verify(pilot.token).exp);
  });

  test('overt/V1 missions alone never issue active_mission and overt V2 claims use V2 even with zero suffix', async () => {
    const pilot = await newPilot();
    const overt = await accept(pilot, research(pilot, { visibility: 'MISSION_VISIBILITY_OVERT' }));
    assert.equal(overt.statusCode, 200, overt.body);
    assert.equal(jwt(overt).active_mission, undefined);
    const active = json(overt).active;
    const downgrade = claimFor(pilot, active, { exposureScoreMilli: 0 }, 1);
    assert.equal((await complete(pilot, downgrade)).statusCode, 403);
    const zeroSuffix = claimFor(pilot, active, { exposureScoreMilli: 0 });
    for (const field of ['wasDetected', 'exposureScoreMilli', 'opposedReputationChange', 'bribePaidCredits']) delete zeroSuffix[field];
    const completed = await complete(pilot, zeroSuffix); // protobuf JSON may omit all four zeros
    assert.equal(completed.statusCode, 200, completed.body);
    assert.equal(jwt(completed).active_mission, undefined);
    const v1 = await accept(pilot, research(pilot));
    assert.equal(v1.statusCode, 200, v1.body);
    assert.equal(jwt(v1).active_mission, undefined);
  });

  test('login and refresh restore the DB-held covert mission, abandonment clears it and stale tokens cannot revive it', async () => {
    const pilot = await newPilot();
    const { active, token } = await take(pilot);
    const session = await login(pilot);
    assert.equal(session.statusCode, 200, session.body);
    assert.equal(jwt(session).active_mission.mission_id, active.mission_id);
    const refresh = await app.inject({ method: 'POST', url: '/auth/refresh', payload: { refreshToken: json(session).refreshToken } });
    assert.equal(refresh.statusCode, 200, refresh.body);
    assert.equal(jwt(refresh).active_mission.mission_id, active.mission_id);
    const stalePilot = { ...pilot, headers: { authorization: `Bearer ${token}` } };
    const abandoned = await call(stalePilot, 'POST', '/game/missions/abandon', { missionId: active.mission_id });
    assert.equal(abandoned.statusCode, 200, abandoned.body);
    assert.equal(jwt(abandoned).active_mission, undefined);
    assert.equal(jwt(await call(stalePilot, 'POST', '/game/cargo/lease')).active_mission, undefined);
    assert.equal(jwt(await login(pilot)).active_mission, undefined);
    assert.equal((await take(pilot, covert(pilot))).active.offer.visibility, 'MISSION_VISIBILITY_COVERT');
  });

  test('clean covert settlement pays signed bonus once including speed allowance and crew share, no rival loss', async () => {
    const pilot = await newPilot();
    await standing(pilot, 'alpha', 200); await standing(pilot, 'beta', 200);
    await addCrew(pilot, { wageShareBp: 500 });
    await setCredits(pilot, 100);
    const { active, token } = await take(pilot);
    const signed = claimFor(pilot, active, { rewardCredits: 3750 }); // 125% base + 625, beyond V1 cap
    const response = await complete(pilot, signed);
    assert.equal(response.statusCode, 200, response.body);
    const result = json(response);
    assert.deepEqual([result.payout, result.grossCredits, result.crewShareCredits, result.netCredits], [3750, 3750, 187, 3563]);
    assert.equal(result.credits, 3663);
    assert.deepEqual(result.standings, { alpha: 225, beta: 200 });
    assert.equal(jwt(response).active_mission, undefined);
    const rows = await app.prisma.reputationLedger.findMany({ where: { playerId: pilot.id } });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].reason, 'COMPLETE_COVERT_CLEAN');
    assert.equal(rows[0].alphaDelta, 25); assert.equal(rows[0].betaDelta, 0);
    assert.equal((await complete(pilot, signed)).statusCode, 404);
    assert.equal(await credits(pilot), 3663);
    const stale = { ...pilot, headers: { authorization: `Bearer ${token}` } };
    assert.equal(jwt(await call(stale, 'POST', '/game/cargo/lease')).active_mission, undefined);
  });

  test('detected settlement applies signed rival loss, ledger reason and fresh token standings', async () => {
    const pilot = await newPilot();
    await standing(pilot, 'alpha', 200); await standing(pilot, 'beta', 200);
    const { active } = await take(pilot, covert(pilot, { reputation_change: 12, opposed_reputation_change: -20 }));
    const response = await complete(pilot, claimFor(pilot, active, {
      wasDetected: true, exposureScoreMilli: 74500, opposedReputationChange: -20
    }));
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(json(response).standings, { alpha: 212, beta: 180 });
    const rows = await app.prisma.reputationLedger.findMany({ where: { playerId: pilot.id } });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].reason, 'COMPLETE_COVERT_DETECTED');
    assert.equal(rows[0].alphaDelta, 12);
    assert.equal(rows.reduce((n, row) => n + row.betaDelta, 0), -20);
    assert.equal(jwt(response).factions.beta, 180);
    assert.equal(jwt(response).active_mission, undefined);
  });

  test('traitor harm and sponsor gain are capped together, clear opposed colors and grant no clean bonus', async () => {
    const pilot = await newPilot();
    await standing(pilot, 'alpha', 500); await standing(pilot, 'beta', 440);
    await app.prisma.player.update({ where: { id: pilot.id }, data: { activeColorsFactionId: 'alpha' } });
    const { active } = await take(pilot, covert(pilot, {
      archetype: 'MISSION_ARCHETYPE_TRAITOR_DEFECTOR_OP', faction_id: 'beta', opposed_faction_id: 'alpha',
      opposed_reputation_change: -250, required_flying_colors_faction_id: 'alpha'
    }));
    const response = await complete(pilot, claimFor(pilot, active, {
      wasDetected: true, exposureScoreMilli: 100000, opposedReputationChange: -250
    }));
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(json(response).payout, active.offer.reward_credits);
    assert.equal(json(response).standings.alpha, 250);
    assert.equal(json(response).standings.beta, 465); // rival harm frees the cap in this event
    const rows = await app.prisma.reputationLedger.findMany({ where: { playerId: pilot.id } });
    assert.equal(rows.length, 1);
    assert.deepEqual([rows[0].alphaDelta, rows[0].betaDelta], [-250, 25]);
    assert.equal(jwt(response).factions.active_colors, null);
    assert.equal(jwt(response).active_mission, undefined);
  });

  test('overflow rolls back V2 mission, payout, reputation, ledger and tracking together', async () => {
    const pilot = await newPilot();
    const { active } = await take(pilot);
    await setCredits(pilot, 2147483647);
    const claim = claimFor(pilot, active, { rewardCredits: 3125 });
    const response = await complete(pilot, claim);
    assert.equal(response.statusCode, 409, response.body);
    assert.equal((await held(pilot)).length, 1);
    assert.equal(await app.prisma.reputationLedger.count({ where: { playerId: pilot.id } }), 0);
    assert.equal(await app.prisma.completedMission.count({ where: { playerId: pilot.id } }), 0);
    assert.equal(jwt(await login(pilot)).active_mission.mission_id, active.mission_id);
  });

  test('claim tampering, mismatched attribution, bribes and rewards over allowance cannot settle', async () => {
    const pilot = await newPilot();
    const { active } = await take(pilot);
    const valid = claimFor(pilot, active, { wasDetected: true, exposureScoreMilli: 74500, opposedReputationChange: -15 });
    for (const change of [
      { exposureScoreMilli: 74501 }, { wasDetected: false }, { opposedReputationChange: 0 }, { bribePaidCredits: 1 }
    ]) assert.ok([400, 403].includes((await complete(pilot, { ...valid, ...change })).statusCode));
    for (const override of [
      { wasDetected: false, opposedReputationChange: -15 },
      { wasDetected: true, opposedReputationChange: -14 }, { bribePaidCredits: 1 }, { rewardCredits: 3751 },
      { wasDetected: true, opposedReputationChange: -15, rewardCredits: 3126 }
    ]) assert.equal((await complete(pilot, claimFor(pilot, active, override))).statusCode, 400);
    assert.equal((await held(pilot)).length, 1);
    assert.equal(await app.prisma.completedMission.count({ where: { playerId: pilot.id } }), 0);
  });

  test('V1 held missions retain V1 rules; appended unsigned V2 claim fields or offer fields are rejected', async () => {
    const pilot = await newPilot();
    const offer = research(pilot);
    for (const changes of [{ opposed_faction_id: 'beta' }, { archetype: 2 }, { clandestine_bonus_credits: 1 }]) {
      assert.equal((await accept(pilot, { ...offer, ...changes })).statusCode, 403);
    }
    const { active } = await take(pilot, offer);
    const valid = claimFor(pilot, active, { exposureScoreMilli: 0 });
    for (const changes of [{ wasDetected: true }, { exposureScoreMilli: 1 }, { opposedReputationChange: -1 }, { bribePaidCredits: 1 }]) {
      assert.ok([400, 403].includes((await complete(pilot, { ...valid, ...changes })).statusCode));
    }
    assert.equal((await complete(pilot, valid)).statusCode, 200);
  });

  test('V2 gather settlement signs cargo then attribution, atomically stores remaining hold and pays bonus', async () => {
    const pilot = await newPilot();
    const { active } = await take(pilot, covert(pilot, {
      type: 'MISSION_TYPE_GATHER', archetype: 'MISSION_ARCHETYPE_ARMS_DELIVERY', required_berths: 0,
      resource_type: 'ORDNANCE', min_grade: 1, quantity_m3: 1, source_body_id: randomUUID(),
      source_system_h3: '8828308281fffff', source_node_h3: '8c28308281001ff',
      source_lat: 37.716557269075864, source_lng: -122.41941550000001
    }));
    const lease = await call(pilot, 'POST', '/game/cargo/lease');
    assert.equal(lease.statusCode, 200, lease.body);
    assert.equal(jwt(lease).active_mission.mission_id, active.mission_id);
    const claim = claimFor(pilot, active, { rewardCredits: 3125,
      leaseId: json(lease).cargo.lease_id, sessionId: randomUUID(), cargoSeq: 1, remaining: [] });
    const tampered = await complete(pilot, { ...claim, cargoSeq: 2 });
    assert.equal(tampered.statusCode, 403, tampered.body);
    const response = await complete(pilot, claim);
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(json(response).lots, []);
    assert.equal(json(response).payout, 3125);
    assert.equal(jwt(response).active_mission, undefined);
    assert.equal((await held(pilot)).length, 0);
  });
});
