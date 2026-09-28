import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createPrivateKey, sign } from 'node:crypto';
import app from '../src/app.js';
import { buildOffer, currentEpoch, parseMissionId } from '../src/config/missions.js';
import { mockAccount } from '../src/lib/mock-accounts.js';
import { canonicalClaimPayload } from '../src/lib/mission-claim.js';

const SYSTEM = '8828308281fffff';
const STATION = 'station-alpha';
const hasKey = existsSync('keys/private.pem');
const rtseKey = hasKey ? createPrivateKey(readFileSync('keys/private.pem', 'utf8')) : null;

const json = (res) => JSON.parse(res.body);

async function newPilot(callsign = 'MissionPilot') {
  const { token, player } = json(await app.inject({ method: 'GET', url: `/auth/dev-login?callsign=${callsign}` }));
  return { id: player.id, headers: { authorization: `Bearer ${token}` } };
}

const call = (pilot, method, url, payload) => app.inject({ method, url, headers: pilot.headers, payload });

async function firstOffer(pilot, station = STATION) {
  const res = json(await call(pilot, 'GET', `/game/missions/available?stationId=${station}&systemH3=${SYSTEM}`));
  return res.offers[0];
}

async function accept(pilot, offer) {
  return call(pilot, 'POST', '/game/missions/accept', { missionId: offer.mission_id, offer });
}

function signedClaim(pilot, active, overrides = {}) {
  const claim = {
    missionId: active.mission_id,
    playerShipId: pilot.id,
    destinationStationId: active.offer.destination_station_id,
    acceptedAtMs: active.accepted_at_ms,
    completedAtMs: active.accepted_at_ms + 60_000,
    rewardCredits: active.offer.reward_credits + 10,
    reputationChange: active.offer.reputation_change,
    ...overrides
  };
  claim.durationTakenMs = overrides.durationTakenMs ?? claim.completedAtMs - claim.acceptedAtMs;
  claim.signature = sign(null, canonicalClaimPayload(claim), rtseKey).toString('base64');
  return claim;
}

describe('authoritative missions', () => {
  before(async () => { await app.ready(); });
  after(async () => { await app.close(); });

  test('requires authentication', async () => {
    const res = await app.inject({ method: 'GET', url: `/game/missions/available?stationId=${STATION}&systemH3=${SYSTEM}` });
    assert.equal(res.statusCode, 401);
  });

  test('lists proto-shaped offers limited by passenger berths', async () => {
    const pilot = await newPilot();
    const res = json(await call(pilot, 'GET', `/game/missions/available?stationId=${STATION}&systemH3=${SYSTEM}`));
    assert.equal(res.passenger_capacity, 2); // Tier 1 life support
    assert.ok(res.offers.length > 0);
    assert.equal(res.cooldown.active, false);
    for (const o of res.offers) {
      assert.ok(o.required_berths <= 2);
      assert.match(o.destination_system_h3, /^[0-9a-f]{15}$/);
      assert.match(o.destination_node_h3, /^[0-9a-f]{15}$/);
      assert.ok(o.distance_hexes >= 1 && o.distance_hexes <= 3);
      assert.equal(o.origin_station_id, STATION);
      assert.ok(o.expires_at_ms > Date.now());
      assert.ok(['MISSION_TYPE_PASSAGE', 'MISSION_TYPE_RESEARCH'].includes(o.type));
    }
    // Deterministic within an epoch.
    const again = json(await call(pilot, 'GET', `/game/missions/available?stationId=${STATION}&systemH3=${SYSTEM}`));
    assert.deepEqual(again.offers, res.offers);
  });

  test('rejects malformed query parameters', async () => {
    const pilot = await newPilot();
    for (const q of ['systemH3=nothex', `stationId=${STATION}`, `stationId=${STATION}&systemH3=8c283082e1801ff`, `stationId=bad%20id&systemH3=${SYSTEM}`]) {
      assert.equal((await call(pilot, 'GET', `/game/missions/available?${q}`)).statusCode, 400);
    }
  });

  test('accepts a mission once, rejects duplicates, serves and abandons it', async () => {
    const pilot = await newPilot();
    assert.deepEqual(json(await call(pilot, 'GET', '/game/missions/active')), { active: null });
    assert.equal((await call(pilot, 'POST', '/game/missions/abandon')).statusCode, 404);

    const offers = json(await call(pilot, 'GET', `/game/missions/available?stationId=${STATION}&systemH3=${SYSTEM}`)).offers;
    const res = await accept(pilot, offers[0]);
    assert.equal(res.statusCode, 200);
    const active = json(res);
    assert.equal(active.mission_id, offers[0].mission_id);
    assert.equal(active.player_ship_id, pilot.id);
    assert.equal(active.deadline_ms, active.accepted_at_ms + offers[0].duration_limit_ms);

    assert.deepEqual(json(await call(pilot, 'GET', '/game/missions/active')).active, active);

    const other = offers[1] ?? offers[0];
    assert.equal((await accept(pilot, other)).statusCode, 409);

    const abandon = await call(pilot, 'POST', '/game/missions/abandon');
    assert.equal(abandon.statusCode, 200);
    assert.deepEqual(json(await call(pilot, 'GET', '/game/missions/active')), { active: null });
    // Abandoning grants no payout and starts no cooldown.
    assert.equal(json(await call(pilot, 'GET', '/game/credits')).credits, 0);
    assert.equal(json(await call(pilot, 'GET', `/game/missions/available?stationId=${STATION}&systemH3=${SYSTEM}`)).cooldown.active, false);
  });

  test('rejects forged, oversized, and expired offers', async () => {
    const pilot = await newPilot();
    const offer = await firstOffer(pilot);

    const forged = { ...offer, reward_credits: 1_000_000 };
    assert.equal((await accept(pilot, forged)).statusCode, 400);
    assert.equal((await call(pilot, 'POST', '/game/missions/accept', { missionId: 'garbage', offer })).statusCode, 400);

    // A berth count above capacity is rejected even though the offer is authentic.
    let big;
    for (let index = 0; index < 6 && !big; index++) {
      const o = buildOffer({ stationId: STATION, systemH3: SYSTEM, epoch: currentEpoch(), index });
      if (o.required_berths > 2) big = o;
    }
    assert.ok(big, 'expected at least one high-berth offer');
    assert.equal((await accept(pilot, big)).statusCode, 400);

    const stale = buildOffer({ ...parseMissionId(offer.mission_id), epoch: currentEpoch() - 1 });
    assert.equal((await accept(pilot, stale)).statusCode, 410);

    assert.deepEqual(json(await call(pilot, 'GET', '/game/missions/active')), { active: null });
  });

  describe('completion', { skip: !hasKey && 'keys/private.pem not present' }, () => {
    test('valid signed claim pays out, sets cooldown, clears mission, and cannot be replayed', async () => {
      const pilot = await newPilot();
      const offer = await firstOffer(pilot);
      const active = json(await accept(pilot, offer));
      const claim = signedClaim(pilot, active);

      const res = await call(pilot, 'POST', '/game/missions/complete', { claim });
      assert.equal(res.statusCode, 200);
      assert.deepEqual(json(res), { success: true, credits: claim.rewardCredits, payout: claim.rewardCredits });

      assert.equal(json(await call(pilot, 'GET', '/game/credits')).credits, claim.rewardCredits);
      assert.deepEqual(json(await call(pilot, 'GET', '/game/missions/active')), { active: null });

      const after = json(await call(pilot, 'GET', `/game/missions/available?stationId=${STATION}&systemH3=${SYSTEM}`));
      assert.equal(after.cooldown.active, true);
      assert.deepEqual(after.offers, []);
      assert.equal((await accept(pilot, offer)).statusCode, 409); // cooldown

      // Replayed claim: no active mission, so no second payout.
      const replay = await call(pilot, 'POST', '/game/missions/complete', { claim });
      assert.equal(replay.statusCode, 404);
      assert.equal(json(await call(pilot, 'GET', '/game/credits')).credits, claim.rewardCredits);

      // Cooldown is per station: another station is unaffected.
      const elsewhere = json(await call(pilot, 'GET', `/game/missions/available?stationId=station-beta&systemH3=${SYSTEM}`));
      assert.equal(elsewhere.cooldown.active, false);
      assert.ok(elsewhere.offers.length > 0);
    });

    test('invalid signature is rejected and grants nothing', async () => {
      const pilot = await newPilot();
      const active = json(await accept(pilot, await firstOffer(pilot)));
      const claim = signedClaim(pilot, active);

      const tampered = { ...claim, rewardCredits: claim.rewardCredits + 1 }; // signature no longer covers this
      assert.equal((await call(pilot, 'POST', '/game/missions/complete', { claim: tampered })).statusCode, 403);
      const garbage = { ...claim, signature: Buffer.alloc(64, 7).toString('base64') };
      assert.equal((await call(pilot, 'POST', '/game/missions/complete', { claim: garbage })).statusCode, 403);
      const short = { ...claim, signature: 'AAAA' };
      assert.equal((await call(pilot, 'POST', '/game/missions/complete', { claim: short })).statusCode, 403);

      assert.equal(json(await call(pilot, 'GET', '/game/credits')).credits, 0);
      assert.ok(json(await call(pilot, 'GET', '/game/missions/active')).active);
      // The genuine claim still works afterwards.
      assert.equal((await call(pilot, 'POST', '/game/missions/complete', { claim })).statusCode, 200);
    });

    test('claim past the deadline is rejected even with a valid signature', async () => {
      const pilot = await newPilot();
      const active = json(await accept(pilot, await firstOffer(pilot)));
      const claim = signedClaim(pilot, active, { completedAtMs: active.deadline_ms + 1 });
      const res = await call(pilot, 'POST', '/game/missions/complete', { claim });
      assert.equal(res.statusCode, 400);
      assert.equal(json(await call(pilot, 'GET', '/game/credits')).credits, 0);
      assert.ok(json(await call(pilot, 'GET', '/game/missions/active')).active);
    });

    test('reward above the 125% bonus cap is rejected; the cap itself is paid', async () => {
      const pilot = await newPilot();
      const active = json(await accept(pilot, await firstOffer(pilot)));
      const cap = Math.floor(active.offer.reward_credits * 1.25);

      const over = signedClaim(pilot, active, { rewardCredits: cap + 1 });
      assert.equal((await call(pilot, 'POST', '/game/missions/complete', { claim: over })).statusCode, 400);
      assert.equal(json(await call(pilot, 'GET', '/game/credits')).credits, 0);
      assert.ok(json(await call(pilot, 'GET', '/game/missions/active')).active);

      const atCap = signedClaim(pilot, active, { rewardCredits: cap });
      const res = await call(pilot, 'POST', '/game/missions/complete', { claim: atCap });
      assert.equal(res.statusCode, 200);
      assert.equal(json(res).payout, cap);
    });

    test('future completedAtMs is rejected; small clock skew is tolerated', async () => {
      const pilot = await newPilot();
      const active = json(await accept(pilot, await firstOffer(pilot)));

      const future = signedClaim(pilot, active, { completedAtMs: Date.now() + 120_000 });
      assert.equal((await call(pilot, 'POST', '/game/missions/complete', { claim: future })).statusCode, 400);
      assert.equal(json(await call(pilot, 'GET', '/game/credits')).credits, 0);
      assert.ok(json(await call(pilot, 'GET', '/game/missions/active')).active);

      const skewed = signedClaim(pilot, active, { completedAtMs: Date.now() + 30_000 });
      assert.equal((await call(pilot, 'POST', '/game/missions/complete', { claim: skewed })).statusCode, 200);
    });

    test('payout that would overflow the credit balance is rejected and the mission stays active', async () => {
      const pilot = await newPilot();
      const active = json(await accept(pilot, await firstOffer(pilot)));
      const claim = signedClaim(pilot, active);

      mockAccount(pilot.id).credits = 2_147_483_647 - claim.rewardCredits + 1;
      const res = await call(pilot, 'POST', '/game/missions/complete', { claim });
      assert.equal(res.statusCode, 409);
      assert.equal(mockAccount(pilot.id).credits, 2_147_483_647 - claim.rewardCredits + 1);
      assert.ok(json(await call(pilot, 'GET', '/game/missions/active')).active);

      // Exactly reaching the maximum is allowed.
      mockAccount(pilot.id).credits = 2_147_483_647 - claim.rewardCredits;
      assert.equal((await call(pilot, 'POST', '/game/missions/complete', { claim })).statusCode, 200);
      assert.equal(mockAccount(pilot.id).credits, 2_147_483_647);
    });

    test('a claim for another pilot is rejected', async () => {
      const pilot = await newPilot('Owner');
      const thief = await newPilot('Thief');
      const active = json(await accept(pilot, await firstOffer(pilot)));
      const claim = signedClaim(pilot, active);

      assert.equal((await call(thief, 'POST', '/game/missions/complete', { claim })).statusCode, 403);
      // Thief re-labels the claim as their own: valid shape, but signature covers the owner's id.
      const relabelled = { ...claim, playerShipId: thief.id };
      assert.equal((await call(thief, 'POST', '/game/missions/complete', { claim: relabelled })).statusCode, 404);

      assert.equal(json(await call(thief, 'GET', '/game/credits')).credits, 0);
      assert.equal(json(await call(pilot, 'GET', '/game/credits')).credits, 0);
    });

    test('claims must match the active mission', async () => {
      const pilot = await newPilot();
      const active = json(await accept(pilot, await firstOffer(pilot)));
      const nothing = await call(pilot, 'POST', '/game/missions/complete', { claim: signedClaim(pilot, { ...active, mission_id: 'm1:other:x:1:0' }) });
      assert.equal(nothing.statusCode, 404);
      const wrongAccepted = signedClaim(pilot, active, { acceptedAtMs: active.accepted_at_ms - 1 });
      assert.equal((await call(pilot, 'POST', '/game/missions/complete', { claim: wrongAccepted })).statusCode, 400);
      const wrongDest = signedClaim(pilot, active, { destinationStationId: 'station-elsewhere' });
      assert.equal((await call(pilot, 'POST', '/game/missions/complete', { claim: wrongDest })).statusCode, 400);
    });

    test('concurrent completions pay out once', async () => {
      const pilot = await newPilot();
      const active = json(await accept(pilot, await firstOffer(pilot)));
      const claim = signedClaim(pilot, active);
      const results = await Promise.all([1, 2, 3].map(() => call(pilot, 'POST', '/game/missions/complete', { claim })));
      assert.equal(results.filter((r) => r.statusCode === 200).length, 1);
      assert.equal(json(await call(pilot, 'GET', '/game/credits')).credits, claim.rewardCredits);
    });
  });
});
