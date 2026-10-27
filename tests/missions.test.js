import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createPrivateKey, createPublicKey, randomUUID, sign } from 'node:crypto';
import {
  addCrew,
  app,
  call,
  closeApp,
  credits,
  dockedReceipt,
  json,
  loginKey,
  newPilot,
  receiptAtOrigin,
  rtseKey,
  setCredits,
  signedOffer
} from './helpers.js';
import { canonicalClaimPayload } from '../src/lib/mission-claim.js';
import { canonicalMissionOfferPayload, verifyMissionOffer } from '../src/lib/mission-offer.js';
import { underMissionLimit } from '../src/config/missions.js';

// The fixed vector from eotha-contracts `scripts/check-mission-offer-vector.js`: Ed25519 seed [7; 32],
// the seed the RTSE verifier tests use.
const VECTOR_SIGNATURE =
  '2Zz1XMEu1YphTWnrV6Q8Q+T7vL/xK9svJUul8aedRqKQjUIk9/XYlvqUdeHfzhCZn7KO0vDjk6lbViu7WX7zAg==';
const VECTOR_PREFIX = '454f5448415f4d495353494f4e5f4f464645525f5631' + '07000000' + '70696c6f742d31' + 'c0164230a1010000';
const vectorOffer = () => ({
  pilot_id: 'pilot-1',
  offered_at_ms: 1791811000000,
  mission_id: '07070707-0707-4707-8707-070707070707',
  type: 'MISSION_TYPE_PASSAGE',
  title: 'Passage to SYS-3082A9 I Station in SYS-3082A9 System',
  description: 'Ferry 2 passengers.',
  origin_station_id: '2fe1f208-c003-44c5-929e-1b020d5a2e47',
  origin_system_h3: '8828308283fffff',
  destination_station_id: '3536a1db-5599-4b6f-bde9-d48524d31061',
  destination_system_h3: '88283082a9fffff',
  destination_node_h3: '8c283082a9001ff',
  destination_lat: 37.78125,
  destination_lng: -122.40625,
  distance_hexes: 2,
  required_berths: 2,
  duration_limit_ms: 600000,
  reward_credits: 2500,
  reputation_change: 5,
  faction_id: 'faction-high',
  expires_at_ms: 1791812800000,
  signature: VECTOR_SIGNATURE
});
const vectorKey = createPrivateKey({
  key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.alloc(32, 7)]),
  format: 'der',
  type: 'pkcs8'
});

// The next double above `x` (one ulp up).
function nextUp(x) {
  const buf = Buffer.alloc(8);
  buf.writeDoubleLE(x);
  buf.writeBigUInt64LE(buf.readBigUInt64LE() + 1n);
  return buf.readDoubleLE();
}

describe('mission offer verifier', () => {
  test('canonical payload and signature match the eotha-contracts vector', () => {
    const payload = canonicalMissionOfferPayload(vectorOffer());
    assert.equal(payload.length, 369);
    assert.equal(payload.subarray(0, VECTOR_PREFIX.length / 2).toString('hex'), VECTOR_PREFIX);
    assert.equal(sign(null, payload, vectorKey).toString('base64'), VECTOR_SIGNATURE);
    assert.equal(verifyMissionOffer(vectorOffer(), createPublicKey(vectorKey)), true);
    // The JSON a client relays carries the same bits.
    assert.equal(verifyMissionOffer(JSON.parse(JSON.stringify(vectorOffer())), createPublicKey(vectorKey)), true);
  });

  test('changing any signed field breaks verification, a coordinate by one ulp included', () => {
    const publicKey = createPublicKey(vectorKey);
    const changes = {
      pilot_id: 'pilot-2',
      offered_at_ms: 1791811000001,
      mission_id: '07070707-0707-4707-8707-070707070708',
      type: 'MISSION_TYPE_RESEARCH',
      title: 'Passage elsewhere',
      description: 'Ferry 3 passengers.',
      origin_station_id: '2fe1f208-c003-44c5-929e-1b020d5a2e48',
      origin_system_h3: '8828308285fffff',
      destination_station_id: '3536a1db-5599-4b6f-bde9-d48524d31062',
      destination_system_h3: '88283082abfffff',
      destination_node_h3: '8c283082a9003ff',
      destination_lat: nextUp(37.78125),
      destination_lng: nextUp(-122.40625),
      distance_hexes: 3,
      required_berths: 1,
      duration_limit_ms: 600001,
      reward_credits: 2501,
      reputation_change: 6,
      faction_id: 'faction-low',
      expires_at_ms: 1791812800001
    };
    assert.deepEqual(Object.keys(changes).sort(), Object.keys(vectorOffer()).filter((k) => k !== 'signature').sort());
    for (const [field, value] of Object.entries(changes)) {
      assert.equal(verifyMissionOffer({ ...vectorOffer(), [field]: value }, publicKey), false, field);
    }
  });

  test('never throws on malformed input', () => {
    const publicKey = createPublicKey(vectorKey);
    const good = vectorOffer();
    for (const bad of [
      undefined, null, {}, { ...good, signature: undefined }, { ...good, signature: 'AAAA' },
      { ...good, type: 'MISSION_TYPE_UNSPECIFIED' }, { ...good, type: 7 }, { ...good, title: undefined },
      { ...good, destination_lat: '37.78125' }, { ...good, distance_hexes: -1 }, { ...good, expires_at_ms: 'soon' },
      { ...good, reputation_change: 2 ** 31 }
    ]) {
      assert.equal(verifyMissionOffer(bad, publicKey), false);
    }
    assert.equal(verifyMissionOffer(good, null), false);
  });

  test('an offer signed by the login key never verifies against the claim key', () => {
    assert.equal(verifyMissionOffer(signedOffer('pilot-1', {}, loginKey), app.claimKey.key), false);
  });

  test('the test helper signs exactly what the verifier checks', () => {
    assert.equal(verifyMissionOffer(signedOffer('pilot-1'), app.claimKey.key), true);
    assert.equal(verifyMissionOffer(signedOffer('pilot-1', { type: 'MISSION_TYPE_RESEARCH', required_berths: 0 }), app.claimKey.key), true);
  });
});

// `offer` defaults to a fresh two-passenger passage for `pilot`, `receipt` to one at its origin.
const accept = (pilot, offer = signedOffer(pilot), receipt = receiptAtOrigin(pilot, offer)) =>
  call(pilot, 'POST', '/game/missions/accept', receipt === null ? { offer } : { offer, dockedReceipt: receipt });

async function acceptOk(pilot, offer = signedOffer(pilot)) {
  const res = await accept(pilot, offer);
  assert.equal(res.statusCode, 200, res.body);
  return json(res).active;
}

// Written out rather than imported, so a cap removed or changed in the table fails these tests.
const LIMITS = { MISSION_TYPE_PASSAGE: 1, MISSION_TYPE_RESEARCH: 3, MISSION_TYPE_GATHER: 1 };
const NO_MISSIONS = { missions: [], limits: LIMITS, active: null, standings: {} };

const activeMission = async (pilot) => json(await call(pilot, 'GET', '/game/missions/active')).active;
const activeIds = async (pilot) => json(await call(pilot, 'GET', '/game/missions/active')).missions.map((m) => m.mission_id);
const research = (pilot, overrides = {}) => signedOffer(pilot, { type: 'MISSION_TYPE_RESEARCH', required_berths: 0, ...overrides });
const abandon = (pilot, missionId) =>
  call(pilot, 'POST', '/game/missions/abandon', missionId === undefined ? undefined : { missionId });
// Abandons the pilot's one held mission while docked at its origin, where a passage's party steps off.
const abandonAtOrigin = (pilot, offer) =>
  call(pilot, 'POST', '/game/missions/abandon', { dockedReceipt: receiptAtOrigin(pilot, offer) });
const aboard = async (pilot) => json(await call(pilot, 'GET', '/ship/loadout')).ship_attributes.passengers_aboard;
const tokenAboard = (res) => app.jwt.verify(json(res).token).ship_attributes.passengers_aboard;
const cooldown = async (pilot, originId) => json(await call(pilot, 'GET', `/game/missions/cooldown?originId=${originId}`));
// The stored count, which the attributes would clamp into range on the way out.
const storedAboard = async (pilot) =>
  (await app.prisma.spaceship.findFirst({ where: { playerId: pilot.id } })).passengersAboard;
const setAboard = (pilot, passengersAboard) =>
  app.prisma.spaceship.updateMany({ where: { playerId: pilot.id }, data: { passengersAboard } });

function signedClaim(pilot, active, overrides = {}, key = rtseKey) {
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
  claim.signature = sign(null, canonicalClaimPayload(claim), key).toString('base64');
  return claim;
}

const complete = (pilot, claim) => call(pilot, 'POST', '/game/missions/complete', { claim });

const standings = async (pilot) => json(await call(pilot, 'GET', '/game/missions/active')).standings;
const setStanding = (pilot, factionId, standing) =>
  app.prisma.playerReputation.upsert({
    where: { playerId_factionId: { playerId: pilot.id, factionId } },
    update: { standing },
    create: { playerId: pilot.id, factionId, standing }
  });
const abandonRows = (pilot) => app.prisma.abandonedMission.findMany({ where: { playerId: pilot.id } });
// Moves a held mission's acceptance `agoMs` into the past, so a claim completed by now can be late.
async function acceptedAgo(pilot, active, agoMs) {
  const acceptedAt = new Date(Date.now() - agoMs);
  await app.prisma.playerMission.updateMany({ where: { playerId: pilot.id, missionId: active.mission_id }, data: { acceptedAt } });
  return { ...active, accepted_at_ms: acceptedAt.getTime(), deadline_ms: acceptedAt.getTime() + active.offer.duration_limit_ms };
}

describe('engine-signed missions', () => {
  before(async () => { await app.ready(); });
  after(async () => { await closeApp(); });

  test('requires authentication', async () => {
    const offer = signedOffer(randomUUID());
    assert.equal((await app.inject({ method: 'GET', url: `/game/missions/cooldown?originId=${offer.origin_station_id}` })).statusCode, 401);
    assert.equal((await app.inject({ method: 'POST', url: '/game/missions/accept', payload: { offer } })).statusCode, 401);
  });

  test('the service no longer builds boards: GET /game/missions/available is gone', async () => {
    const pilot = await newPilot();
    const res = await call(pilot, 'GET', '/game/missions/available?stationId=2fe1f208-c003-44c5-929e-1b020d5a2e47&systemH3=8828308283fffff');
    assert.equal(res.statusCode, 404);
  });

  describe('accept', () => {
    test('stores the engine offer, boards its passengers and reissues the token', async () => {
      const pilot = await newPilot();
      assert.deepEqual(json(await call(pilot, 'GET', '/game/missions/active')), NO_MISSIONS);
      const offer = signedOffer(pilot);

      const res = await accept(pilot, offer);
      assert.equal(res.statusCode, 200, res.body);
      const { active } = json(res);
      assert.equal(active.mission_id, offer.mission_id);
      assert.equal(active.player_ship_id, pilot.id);
      assert.deepEqual(active.offer, offer);
      assert.ok(active.accepted_at_ms >= offer.offered_at_ms && active.accepted_at_ms <= Date.now());
      assert.equal(active.deadline_ms, active.accepted_at_ms + offer.duration_limit_ms);
      assert.equal(active.is_completed, false);

      // Boarded in the database and in the token the engine reads.
      assert.equal(tokenAboard(res), 2);
      assert.equal(await aboard(pilot), 2);

      // The stored offer comes back bit for bit, coordinates and signature included: the engine
      // verifies its own signature over it when the pilot claims the mission.
      const stored = await activeMission(pilot);
      assert.deepEqual(stored, active);
      assert.equal(verifyMissionOffer(stored.offer, app.claimKey.key), true);
      assert.deepEqual(json(await call(pilot, 'GET', '/game/missions/active')), { missions: [active], limits: LIMITS, active, standings: {} });
    });

    test('the stored coordinates are exact where the JSON column alone would move them', async () => {
      const pilot = await newPilot();
      const offer = signedOffer(pilot);
      await acceptOk(pilot, offer);
      const row = await app.prisma.playerMission.findFirst({ where: { playerId: pilot.id } });
      // The precondition: the column moved these coordinates.
      assert.notEqual(row.offer.destination_lat, offer.destination_lat);
      assert.notEqual(row.offer.destination_lng, offer.destination_lng);
      assert.deepEqual(row.offer.exact_destination, [String(offer.destination_lat), String(offer.destination_lng)]);
      assert.equal((await activeMission(pilot)).offer.destination_lat, offer.destination_lat);
      assert.equal((await activeMission(pilot)).offer.destination_lng, offer.destination_lng);
    });

    test('proto-JSON offers are accepted: zero fields omitted, 64-bit integers as strings', async () => {
      const pilot = await newPilot();
      const offer = signedOffer(pilot, { type: 'MISSION_TYPE_RESEARCH', required_berths: 0, reputation_change: 0 });
      const { required_berths, reputation_change, ...wire } = offer;
      for (const field of ['offered_at_ms', 'expires_at_ms', 'duration_limit_ms', 'reward_credits']) wire[field] = String(offer[field]);

      const active = await acceptOk(pilot, wire);
      assert.deepEqual(active.offer, offer);
      assert.equal(await aboard(pilot), 0); // a survey boards no one
    });

    test('fields the engine did not sign are dropped, not stored', async () => {
      const pilot = await newPilot();
      const offer = signedOffer(pilot);
      const active = await acceptOk(pilot, { ...offer, bonus_credits: 1_000_000 });
      assert.equal('bonus_credits' in active.offer, false);
      assert.equal('bonus_credits' in (await activeMission(pilot)).offer, false);
    });

    test('a tampered offer is refused with mission_offer_invalid and changes nothing', async () => {
      const pilot = await newPilot();
      for (const change of [{ reward_credits: 1_000_000 }, { required_berths: 1 }, { duration_limit_ms: 6_000_000 }, { destination_lat: 'next ulp' }]) {
        const offer = signedOffer(pilot);
        if (change.destination_lat) change.destination_lat = nextUp(offer.destination_lat);
        const res = await accept(pilot, { ...offer, ...change });
        assert.equal(res.statusCode, 403, JSON.stringify(change));
        assert.equal(json(res).code, 'mission_offer_invalid');
      }
      const garbage = await accept(pilot, { ...signedOffer(pilot), signature: Buffer.alloc(64, 7).toString('base64') });
      assert.equal(json(garbage).code, 'mission_offer_invalid');
      assert.equal(await activeMission(pilot), null);
      assert.equal(await aboard(pilot), 0);
    });

    test("another pilot's genuine offer is refused with mission_offer_invalid", async () => {
      const pilot = await newPilot('Taker');
      const other = await newPilot('Owner');
      const offer = signedOffer(other);
      const res = await accept(pilot, offer, receiptAtOrigin(pilot, offer));
      assert.equal(res.statusCode, 403);
      assert.equal(json(res).code, 'mission_offer_invalid');
      // Relabelling it breaks the signature instead.
      const relabelled = await accept(pilot, { ...offer, pilot_id: pilot.id }, receiptAtOrigin(pilot, offer));
      assert.equal(json(relabelled).code, 'mission_offer_invalid');
      assert.equal(await activeMission(pilot), null);
    });

    test('an offer signed by the login key is refused; only the claim key signs offers', async () => {
      const pilot = await newPilot();
      const res = await accept(pilot, signedOffer(pilot, {}, loginKey));
      assert.equal(res.statusCode, 403);
      assert.equal(json(res).code, 'mission_offer_invalid');
    });

    test('an expired offer is refused with 410 mission_offer_expired', async () => {
      const pilot = await newPilot();
      const stale = signedOffer(pilot, { offered_at_ms: Date.now() - 31 * 60_000 });
      const res = await accept(pilot, stale);
      assert.equal(res.statusCode, 410);
      assert.equal(json(res).code, 'mission_offer_expired');
      assert.equal(await activeMission(pilot), null);
    });

    test('an offer from up to 5 s in the future is accepted, no earlier than it was made; beyond that it is refused', async () => {
      const pilot = await newPilot();
      const tooFar = signedOffer(pilot, { offered_at_ms: Date.now() + 10_000 });
      const refused = await accept(pilot, tooFar);
      assert.equal(refused.statusCode, 410);
      assert.equal(json(refused).code, 'mission_offer_expired');

      const ahead = signedOffer(pilot, { offered_at_ms: Date.now() + 3_000 });
      const active = await acceptOk(pilot, ahead);
      // The engine refuses a claim for a mission accepted before its offer was made.
      assert.equal(active.accepted_at_ms, ahead.offered_at_ms);
    });

    test('a missing receipt is refused with docked_receipt_required', async () => {
      const pilot = await newPilot();
      const res = await accept(pilot, signedOffer(pilot), null);
      assert.equal(res.statusCode, 403);
      assert.equal(json(res).code, 'docked_receipt_required');
    });

    test('a receipt at a different dock is refused with not_docked_at_origin', async () => {
      const pilot = await newPilot();
      const offer = signedOffer(pilot);
      const elsewhere = await accept(pilot, offer, receiptAtOrigin(pilot, offer, { dockedEntityId: randomUUID() }));
      assert.equal(elsewhere.statusCode, 403);
      assert.equal(json(elsewhere).code, 'not_docked_at_origin');
      // The same dock id named in another system is another dock.
      const otherSystem = await accept(pilot, offer, receiptAtOrigin(pilot, offer, { systemH3: '8828308285fffff' }));
      assert.equal(json(otherSystem).code, 'not_docked_at_origin');
      assert.equal(await activeMission(pilot), null);
      // Docked at the origin, the same offer goes through.
      await acceptOk(pilot, offer);
    });

    test('a stale receipt is refused with docked_receipt_expired', async () => {
      const pilot = await newPilot();
      const offer = signedOffer(pilot);
      const issuedAtMs = Date.now() - 31_000;
      const res = await accept(pilot, offer, receiptAtOrigin(pilot, offer, { issuedAtMs, dockedAtMs: issuedAtMs - 1_000 }));
      assert.equal(res.statusCode, 403);
      assert.equal(json(res).code, 'docked_receipt_expired');
      assert.equal(await activeMission(pilot), null);
    });

    test("a receipt for another pilot, or a tampered one, is refused with docked_receipt_invalid", async () => {
      const pilot = await newPilot();
      const other = await newPilot('Other');
      const offer = signedOffer(pilot);
      const theirs = await accept(pilot, offer, receiptAtOrigin(other, offer));
      assert.equal(theirs.statusCode, 403);
      assert.equal(json(theirs).code, 'docked_receipt_invalid');
      const tampered = { ...receiptAtOrigin(pilot, offer, { dockedEntityId: randomUUID() }), dockedEntityId: offer.origin_station_id };
      assert.equal(json(await accept(pilot, offer, tampered)).code, 'docked_receipt_invalid');
    });

    test('the offer is judged before the receipt, and its signature before its expiry', async () => {
      const pilot = await newPilot();
      const forgedAndStale = { ...signedOffer(pilot, { offered_at_ms: Date.now() - 31 * 60_000 }), reward_credits: 9 };
      assert.equal(json(await accept(pilot, forgedAndStale, null)).code, 'mission_offer_invalid');
      const stale = signedOffer(pilot, { offered_at_ms: Date.now() - 31 * 60_000 });
      assert.equal(json(await accept(pilot, stale, dockedReceipt(pilot))).code, 'mission_offer_expired');
    });

    test('too few free berths is refused with insufficient_berths; passengers already aboard count', async () => {
      const pilot = await newPilot();
      // Tier 1 life support has 3 berths.
      const big = await accept(pilot, signedOffer(pilot, { required_berths: 4 }));
      assert.equal(big.statusCode, 400);
      assert.equal(json(big).code, 'insufficient_berths');
      assert.equal(json(big).available_berths, 3);

      await call(pilot, 'GET', '/ship/loadout'); // creates the ship row
      await setAboard(pilot, 2);
      const full = await accept(pilot, signedOffer(pilot, { required_berths: 2 }));
      assert.equal(full.statusCode, 400);
      assert.equal(json(full).code, 'insufficient_berths');
      assert.equal(json(full).available_berths, 1);
      assert.equal(await activeMission(pilot), null);
      assert.equal(await aboard(pilot), 2);

      // One free berth still takes a one-passenger passage, and boards on top of who is aboard.
      const res = await accept(pilot, signedOffer(pilot, { required_berths: 1 }));
      assert.equal(res.statusCode, 200, res.body);
      assert.equal(tokenAboard(res), 3);
      assert.equal(await aboard(pilot), 3);
    });

    test('the origin is on cooldown after a completion there; other docks are not', async () => {
      const pilot = await newPilot();
      const offer = signedOffer(pilot);
      const active = await acceptOk(pilot, offer);
      assert.equal((await complete(pilot, signedClaim(pilot, active))).statusCode, 200);

      const again = await accept(pilot, signedOffer(pilot, { origin_station_id: offer.origin_station_id }));
      assert.equal(again.statusCode, 409);
      assert.equal(json(again).code, 'origin_on_cooldown');
      assert.ok(json(again).remaining_ms > 9 * 60_000 && json(again).remaining_ms <= 10 * 60_000);

      await acceptOk(pilot, signedOffer(pilot));
    });

    test('a mission already completed cannot be accepted again, even offered at another dock', async () => {
      const pilot = await newPilot();
      const active = await acceptOk(pilot);
      assert.equal((await complete(pilot, signedClaim(pilot, active))).statusCode, 200);

      const res = await accept(pilot, signedOffer(pilot, { mission_id: active.mission_id }));
      assert.equal(res.statusCode, 409);
      assert.equal(json(res).code, 'mission_already_completed');
      assert.equal(await activeMission(pilot), null);
    });

    test('malformed offers are schema errors', async () => {
      const pilot = await newPilot();
      const offer = signedOffer(pilot);
      for (const bad of [
        { ...offer, type: 'MISSION_TYPE_UNSPECIFIED' },
        { ...offer, mission_id: 'm1:legacy' },
        { ...offer, origin_station_id: 'station-alpha' },
        { ...offer, signature: 'AAAA' },
        (({ signature, ...rest }) => rest)(offer),
        (({ pilot_id, ...rest }) => rest)(offer)
      ]) {
        assert.equal((await accept(pilot, bad, receiptAtOrigin(pilot, offer))).statusCode, 400);
      }
      assert.equal((await call(pilot, 'POST', '/game/missions/accept', {})).statusCode, 400);
    });

    test('without a claim key the route refuses with 503 CLAIM_KEY_NOT_CONFIGURED', async () => {
      const pilot = await newPilot();
      const configured = app.claimKey;
      app.claimKey = null;
      try {
        const res = await accept(pilot);
        assert.equal(res.statusCode, 503);
        assert.equal(json(res).error, 'CLAIM_KEY_NOT_CONFIGURED');
      } finally {
        app.claimKey = configured;
      }
      assert.equal(await activeMission(pilot), null);
    });

    test('concurrent accepts take one mission and board once', async () => {
      const pilot = await newPilot();
      const offers = [1, 2, 3].map(() => signedOffer(pilot, { required_berths: 1 }));
      const results = await Promise.all(offers.map((offer) => accept(pilot, offer)));
      assert.equal(results.filter((r) => r.statusCode === 200).length, 1);
      assert.equal(await aboard(pilot), 1);
    });
  });

  describe('limits per mission type', () => {
    test('research: three are held at once and a fourth is refused with mission_limit_reached', async () => {
      const pilot = await newPilot();
      const held = [];
      for (let i = 0; i < 3; i++) held.push(await acceptOk(pilot, research(pilot)));

      const fourth = await accept(pilot, research(pilot));
      assert.equal(fourth.statusCode, 409);
      assert.deepEqual(
        (({ error, ...rest }) => rest)(json(fourth)),
        { code: 'mission_limit_reached', type: 'MISSION_TYPE_RESEARCH', limit: 3 }
      );
      // Listed oldest first; `active` is the oldest.
      const res = json(await call(pilot, 'GET', '/game/missions/active'));
      assert.deepEqual(res.missions, held);
      assert.deepEqual(res.active, held[0]);
      assert.deepEqual(res.limits, LIMITS);

      // Abandoning one frees its place.
      assert.equal((await abandon(pilot, held[1].mission_id)).statusCode, 200);
      await acceptOk(pilot, research(pilot));
    });

    test('passage: a second is refused with mission_limit_reached even when it boards no one', async () => {
      const pilot = await newPilot();
      await acceptOk(pilot, signedOffer(pilot, { required_berths: 1 }));
      const second = await accept(pilot, signedOffer(pilot, { required_berths: 0 }));
      assert.equal(second.statusCode, 409);
      assert.equal(json(second).code, 'mission_limit_reached');
      assert.equal(json(second).type, 'MISSION_TYPE_PASSAGE');
      assert.equal(json(second).limit, 1);
      assert.equal(await aboard(pilot), 1);
      assert.equal((await activeIds(pilot)).length, 1);
    });

    test('the types are independent: a passage and three research are held together', async () => {
      const pilot = await newPilot();
      const passage = await acceptOk(pilot, signedOffer(pilot));
      const surveys = [];
      for (let i = 0; i < 3; i++) surveys.push(await acceptOk(pilot, research(pilot)));
      assert.deepEqual(await activeIds(pilot), [passage, ...surveys].map((m) => m.mission_id));
      assert.equal(await aboard(pilot), 2);
      assert.equal(json(await accept(pilot, research(pilot))).code, 'mission_limit_reached');
      assert.equal(json(await accept(pilot, signedOffer(pilot, { required_berths: 0 }))).code, 'mission_limit_reached');
    });

    test('gather: one is held at once, independent of the other types', () => {
      const gather = { type: 'MISSION_TYPE_GATHER' };
      const others = [{ type: 'MISSION_TYPE_PASSAGE' }, { type: 'MISSION_TYPE_RESEARCH' }, { type: 'MISSION_TYPE_RESEARCH' }];
      assert.equal(underMissionLimit(others, 'MISSION_TYPE_GATHER'), true);
      assert.equal(underMissionLimit([...others, gather], 'MISSION_TYPE_GATHER'), false);
      assert.equal(underMissionLimit([gather], 'MISSION_TYPE_RESEARCH'), true);
      assert.equal(underMissionLimit([gather], 'MISSION_TYPE_PASSAGE'), true);
      // A type the table does not list is never taken.
      assert.equal(underMissionLimit([], 'MISSION_TYPE_UNSPECIFIED'), false);
    });

    test('the same mission cannot be held twice', async () => {
      const pilot = await newPilot();
      const offer = research(pilot);
      await acceptOk(pilot, offer);
      const again = await accept(pilot, research(pilot, { mission_id: offer.mission_id }));
      assert.equal(again.statusCode, 409);
      assert.equal(json(again).code, 'mission_already_active');
      assert.equal((await activeIds(pilot)).length, 1);
    });

    test('concurrent accepts of one type stop at its cap', async () => {
      const pilot = await newPilot();
      await acceptOk(pilot, research(pilot));
      await acceptOk(pilot, research(pilot));
      const results = await Promise.all([1, 2, 3].map(() => accept(pilot, research(pilot))));
      assert.equal(results.filter((r) => r.statusCode === 200).length, 1, results.map((r) => r.body).join('\n'));
      assert.deepEqual(results.filter((r) => r.statusCode !== 200).map((r) => json(r).code), ['mission_limit_reached', 'mission_limit_reached']);
      assert.equal((await activeIds(pilot)).length, 3);
    });
  });

  describe('cooldown', () => {
    test('reports the per-origin cooldown after a completion', async () => {
      const pilot = await newPilot();
      const offer = signedOffer(pilot);
      assert.deepEqual(await cooldown(pilot, offer.origin_station_id), { active: false, remaining_ms: 0, available_at_ms: 0 });

      const active = await acceptOk(pilot, offer);
      assert.equal((await complete(pilot, signedClaim(pilot, active))).statusCode, 200);
      const after = await cooldown(pilot, offer.origin_station_id);
      assert.equal(after.active, true);
      assert.ok(after.remaining_ms > 9 * 60_000 && after.remaining_ms <= 10 * 60_000);
      assert.ok(Math.abs(after.available_at_ms - (Date.now() + after.remaining_ms)) < 5_000);

      assert.equal((await cooldown(pilot, randomUUID())).active, false);
    });

    test('takes a dock id only', async () => {
      const pilot = await newPilot();
      for (const q of ['', '?originId=station-alpha', '?originId=2FE1F208-C003-44C5-929E-1B020D5A2E47']) {
        assert.equal((await call(pilot, 'GET', `/game/missions/cooldown${q}`)).statusCode, 400, q);
      }
    });
  });

  describe('abandon', () => {
    test('unboards the passengers at the origin, reissues the token and pays nothing', async () => {
      const pilot = await newPilot();
      assert.equal((await call(pilot, 'POST', '/game/missions/abandon')).statusCode, 404);
      const offer = signedOffer(pilot);
      await acceptOk(pilot, offer);
      assert.equal(await aboard(pilot), 2);

      const res = await abandonAtOrigin(pilot, offer);
      assert.equal(res.statusCode, 200);
      assert.equal(json(res).abandoned, true);
      assert.equal(json(res).mission_id, offer.mission_id);
      assert.equal(tokenAboard(res), 0);
      assert.equal(await aboard(pilot), 0);
      assert.equal(await activeMission(pilot), null);
      assert.equal(await credits(pilot), 0);
      assert.equal((await call(pilot, 'POST', '/game/missions/abandon')).statusCode, 404);
    });

    test('unboards only that mission\'s passengers, and never below zero', async () => {
      const pilot = await newPilot();
      await call(pilot, 'GET', '/ship/loadout');
      await setAboard(pilot, 1);
      const first = signedOffer(pilot, { required_berths: 1 });
      await acceptOk(pilot, first);
      assert.equal(await aboard(pilot), 2);
      assert.equal(tokenAboard(await abandonAtOrigin(pilot, first)), 1);

      await setAboard(pilot, 0);
      const second = signedOffer(pilot, { required_berths: 2 });
      await acceptOk(pilot, second);
      await setAboard(pilot, 1);
      assert.equal(tokenAboard(await abandonAtOrigin(pilot, second)), 0);
      assert.equal(await storedAboard(pilot), 0);
    });

    test('by id while others are held; only the passage unboards anyone', async () => {
      const pilot = await newPilot();
      const passageOffer = signedOffer(pilot);
      const passage = await acceptOk(pilot, passageOffer);
      const survey = await acceptOk(pilot, research(pilot));
      const other = await acceptOk(pilot, research(pilot));

      const unnamed = await abandon(pilot);
      assert.equal(unnamed.statusCode, 400);
      assert.equal(json(unnamed).code, 'mission_id_required');
      assert.equal((await abandon(pilot, randomUUID())).statusCode, 404);
      assert.equal((await abandon(pilot, 'not-a-mission-id')).statusCode, 400);
      assert.equal((await activeIds(pilot)).length, 3);

      const res = await abandon(pilot, survey.mission_id);
      assert.equal(res.statusCode, 200);
      assert.equal(json(res).mission_id, survey.mission_id);
      assert.equal(tokenAboard(res), 2);
      assert.deepEqual(await activeIds(pilot), [passage.mission_id, other.mission_id]);

      const off = await call(pilot, 'POST', '/game/missions/abandon', { missionId: passage.mission_id, dockedReceipt: receiptAtOrigin(pilot, passageOffer) });
      assert.equal(json(off).mission_id, passage.mission_id);
      assert.equal(tokenAboard(off), 0);
      assert.equal(await aboard(pilot), 0);

      // With one left, the id may be left out again.
      assert.equal(json(await abandon(pilot)).mission_id, other.mission_id);
      assert.deepEqual(await activeIds(pilot), []);
    });
  });

  describe('missions stored before offers were signed', () => {
    const legacyOffer = (extra = {}) => ({
      mission_id: 'm1:station-alpha:8828308281fffff:497562:0',
      type: 'MISSION_TYPE_PASSAGE',
      origin_station_id: 'station-alpha',
      origin_system_h3: '8828308281fffff',
      destination_station_id: 'station-8828308285fffff',
      destination_lat: 37.77,
      destination_lng: -122.41,
      required_berths: 1,
      duration_limit_ms: 600_000,
      reward_credits: 150,
      reputation_change: 1,
      expires_at_ms: Date.now() + 60_000,
      ...extra
    });
    const seed = (pilot, missionId, offer) =>
      app.prisma.playerMission.create({ data: { playerId: pilot.id, missionId, originStationId: offer.origin_station_id, offer } });
    const rows = (pilot) => app.prisma.playerMission.count({ where: { playerId: pilot.id } });

    test('are removed, reported as cancelled, and leave the pilot free to accept a fresh offer', async () => {
      const pilot = await newPilot();
      const offer = legacyOffer();
      await seed(pilot, offer.mission_id, offer);

      const res = json(await call(pilot, 'GET', '/game/missions/active'));
      assert.equal(res.active, null);
      assert.deepEqual(res.missions, []);
      assert.deepEqual(res.cancelled_missions, [res.cancelled_mission]);
      assert.equal(res.cancelled_mission.mission_id, offer.mission_id);
      assert.equal(res.cancelled_mission.reason, 'format_changed');
      assert.match(res.cancelled_mission.message, /format changed/);
      assert.equal(await rows(pilot), 0);
      assert.equal(await credits(pilot), 0); // nothing was charged at accept, so nothing is refunded

      // Reported once; afterwards there is simply no mission.
      assert.deepEqual(json(await call(pilot, 'GET', '/game/missions/active')), NO_MISSIONS);
      await acceptOk(pilot);
    });

    test('are recognised by a missing signature alone, a missing exact destination alone, or a legacy id alone', async () => {
      // The last format: engine-derived UUID and exact coordinates, but unsigned.
      const unsigned = await newPilot();
      const uuid = '4a5d3a52-6f0c-4b0e-8a64-0c9a3a0f1b11';
      await seed(unsigned, uuid, legacyOffer({ mission_id: uuid, exact_destination: ['37.77', '-122.41'] }));
      assert.equal(json(await call(unsigned, 'GET', '/game/missions/active')).cancelled_mission.mission_id, uuid);

      const signature = Buffer.alloc(64, 7).toString('base64');
      const noExact = await newPilot();
      await seed(noExact, uuid, legacyOffer({ mission_id: uuid, signature }));
      assert.equal(json(await call(noExact, 'GET', '/game/missions/active')).cancelled_mission.mission_id, uuid);

      const legacyId = await newPilot();
      const offer = legacyOffer({ exact_destination: ['37.77', '-122.41'], signature });
      await seed(legacyId, offer.mission_id, offer);
      assert.equal(json(await call(legacyId, 'GET', '/game/missions/active')).cancelled_mission.mission_id, offer.mission_id);
    });

    test('block neither accepting nor abandoning, unboard no one, and cannot be completed', async () => {
      const pilot = await newPilot();
      const offer = legacyOffer();
      await seed(pilot, offer.mission_id, offer);
      // Accepting sweeps the stale row away instead of answering "already active".
      await acceptOk(pilot);
      assert.equal(await rows(pilot), 1);
      assert.equal(await aboard(pilot), 2);

      const other = await newPilot();
      await call(other, 'GET', '/ship/loadout');
      await setAboard(other, 1);
      await seed(other, offer.mission_id, offer);
      assert.equal((await call(other, 'POST', '/game/missions/abandon')).statusCode, 404);
      assert.equal(await rows(other), 0);
      assert.equal(await aboard(other), 1); // the legacy accept never boarded anyone

      const stale = await newPilot();
      await seed(stale, offer.mission_id, offer);
      const claim = signedClaim(stale, { mission_id: offer.mission_id, accepted_at_ms: Date.now() - 60_000, offer: { ...offer, reward_credits: 150 } });
      assert.equal((await complete(stale, claim)).statusCode, 404);
      assert.equal(await credits(stale), 0);
    });

    test('a current mission is left alone', async () => {
      const pilot = await newPilot();
      const active = await acceptOk(pilot);
      assert.deepEqual(json(await call(pilot, 'GET', '/game/missions/active')), { missions: [active], limits: LIMITS, active, standings: {} });
    });

    test('a refused accept leaves them in place, to be reported', async () => {
      const pilot = await newPilot();
      const offer = legacyOffer();
      await seed(pilot, offer.mission_id, offer);
      assert.equal(json(await accept(pilot, signedOffer(pilot, { required_berths: 4 }))).code, 'insufficient_berths');
      assert.equal(json(await call(pilot, 'GET', '/game/missions/active')).cancelled_mission.mission_id, offer.mission_id);
    });
  });

  describe('completion', () => {
    test('valid signed claim pays out, sets cooldown, unboards, reissues the token, and cannot be replayed', async () => {
      const pilot = await newPilot();
      const offer = signedOffer(pilot);
      const active = await acceptOk(pilot, offer);
      assert.equal(await aboard(pilot), 2);
      const claim = signedClaim(pilot, active);

      const res = await complete(pilot, claim);
      assert.equal(res.statusCode, 200);
      const { token, ...body } = json(res);
      assert.deepEqual(body, {
        success: true,
        credits: claim.rewardCredits,
        payout: claim.rewardCredits,
        grossCredits: claim.rewardCredits,
        crewShareCredits: 0,
        netCredits: claim.rewardCredits,
        crewPayouts: [],
        reputation_change: 5,
        standings: { 'faction-high': 5 },
        // The claim earned the speed bonus (paid above the offer): (100 + 40 x 2 + 10 x 2) x 1.25.
        xpGained: 250,
        currentLevel: 2,
        traitPointsAvailable: 1
      });
      assert.equal(app.jwt.verify(token).ship_attributes.passengers_aboard, 0);
      assert.equal(await aboard(pilot), 0);

      assert.equal(await credits(pilot), claim.rewardCredits);
      assert.equal(await activeMission(pilot), null);
      assert.equal((await cooldown(pilot, offer.origin_station_id)).active, true);

      // Replayed claim: no active mission, so no second payout.
      const replay = await complete(pilot, claim);
      assert.equal(replay.statusCode, 404);
      assert.equal(await credits(pilot), claim.rewardCredits);
    });

    test('crew on standby still take their wage share of the payout', async () => {
      const pilot = await newPilot();
      await addCrew(pilot, { crewClass: 'CHEF', rank: 'NOVICE', wageShareBp: 500, status: 'STANDBY', spaceshipId: null });
      const active = await acceptOk(pilot, research(pilot));
      const claim = signedClaim(pilot, active, { rewardCredits: 1000 });
      const res = await complete(pilot, claim);
      assert.equal(res.statusCode, 200, res.body);
      const body = json(res);
      assert.deepEqual([body.grossCredits, body.crewShareCredits, body.netCredits], [1000, 50, 950]);
      assert.equal(body.credits, 950);
    });

    test('ASSERT-2.2.3: the active crew take their wage share of the payout and the pilot is paid the rest', async () => {
      const pilot = await newPilot();
      const chef = await addCrew(pilot, { crewClass: 'CHEF', rank: 'NOVICE', wageShareBp: 500 });
      const doctor = await addCrew(pilot, { crewClass: 'DOCTOR', rank: 'ADEPT', wageShareBp: 800, quirkId: 'Q13' }); // CHARMING: +1.5%
      await app.prisma.shipComponentRecord.updateMany({ where: { spaceship: { playerId: pilot.id }, type: 'HULL' }, data: { tier: 2 } });
      const active = await acceptOk(pilot, research(pilot));
      const claim = signedClaim(pilot, active, { rewardCredits: 1000 });

      const res = await complete(pilot, claim);
      assert.equal(res.statusCode, 200, res.body);
      const body = json(res);
      // 5.0% and 9.5% of 1000, rounded down.
      assert.deepEqual([body.grossCredits, body.crewShareCredits, body.netCredits], [1000, 145, 855]);
      assert.deepEqual(body.crewPayouts.map((p) => [p.crewId, p.shareCredits]), [[chef.id, 50], [doctor.id, 95]]);
      assert.equal(body.payout, 1000);
      assert.equal(body.credits, 855);
      assert.equal(await credits(pilot), 855);
    });

    test('a crew share rounds down, so a tiny payout can leave the pilot everything', async () => {
      const pilot = await newPilot();
      await addCrew(pilot, { crewClass: 'CHEF', rank: 'NOVICE', wageShareBp: 500 });
      const active = await acceptOk(pilot, research(pilot));
      const res = await complete(pilot, signedClaim(pilot, active, { rewardCredits: 19 }));
      assert.equal(res.statusCode, 200, res.body);
      assert.deepEqual([json(res).crewShareCredits, json(res).netCredits], [0, 19]);
      assert.equal(await credits(pilot), 19);
    });

    test('unboards only the mission\'s passengers, and never below zero', async () => {
      const pilot = await newPilot();
      await call(pilot, 'GET', '/ship/loadout');
      await setAboard(pilot, 1);
      const one = await acceptOk(pilot, signedOffer(pilot, { required_berths: 1 }));
      assert.equal(tokenAboard(await complete(pilot, signedClaim(pilot, one))), 1);

      const two = await acceptOk(pilot, signedOffer(pilot, { required_berths: 1 }));
      await setAboard(pilot, 0);
      assert.equal(tokenAboard(await complete(pilot, signedClaim(pilot, two))), 0);
      assert.equal(await storedAboard(pilot), 0);
    });

    test('invalid signature is rejected and grants nothing', async () => {
      const pilot = await newPilot();
      const active = await acceptOk(pilot);
      const claim = signedClaim(pilot, active);

      const tampered = { ...claim, rewardCredits: claim.rewardCredits + 1 }; // signature no longer covers this
      assert.equal((await complete(pilot, tampered)).statusCode, 403);
      const garbage = { ...claim, signature: Buffer.alloc(64, 7).toString('base64') };
      assert.equal((await complete(pilot, garbage)).statusCode, 403);
      const short = { ...claim, signature: 'AAAA' };
      assert.equal((await complete(pilot, short)).statusCode, 403);

      assert.equal(await credits(pilot), 0);
      assert.ok(await activeMission(pilot));
      assert.equal(await aboard(pilot), 2);
      // The genuine claim still works afterwards.
      assert.equal((await complete(pilot, claim)).statusCode, 200);
    });

    test('a claim signed with the login key is rejected; only the claim key verifies engine claims', async () => {
      const pilot = await newPilot();
      const active = await acceptOk(pilot);

      const forged = signedClaim(pilot, active, {}, loginKey);
      assert.equal((await complete(pilot, forged)).statusCode, 403);
      assert.equal(await credits(pilot), 0);
      assert.ok(await activeMission(pilot));

      assert.equal((await complete(pilot, signedClaim(pilot, active))).statusCode, 200);
    });

    test('refuses with a stable error when no claim key is configured', async () => {
      const pilot = await newPilot();
      const active = await acceptOk(pilot);
      const claim = signedClaim(pilot, active);

      const configured = app.claimKey;
      app.claimKey = null;
      try {
        const res = await complete(pilot, claim);
        assert.equal(res.statusCode, 503);
        assert.equal(json(res).error, 'CLAIM_KEY_NOT_CONFIGURED');
      } finally {
        app.claimKey = configured;
      }
      assert.equal(await credits(pilot), 0);
      assert.equal((await complete(pilot, claim)).statusCode, 200);
    });

    test('a claim completed before it was accepted is rejected', async () => {
      const pilot = await newPilot();
      const active = await acceptOk(pilot);
      const claim = signedClaim(pilot, active, { completedAtMs: active.accepted_at_ms - 1, durationTakenMs: 0 });
      assert.equal((await complete(pilot, claim)).statusCode, 400);
      assert.equal(await credits(pilot), 0);
      assert.ok(await activeMission(pilot));
    });

    test('reward above the 125% bonus cap is rejected; the cap itself is paid', async () => {
      const pilot = await newPilot();
      const active = await acceptOk(pilot);
      const cap = Math.floor(active.offer.reward_credits * 1.25);

      const over = signedClaim(pilot, active, { rewardCredits: cap + 1 });
      assert.equal((await complete(pilot, over)).statusCode, 400);
      assert.equal(await credits(pilot), 0);
      assert.ok(await activeMission(pilot));

      const res = await complete(pilot, signedClaim(pilot, active, { rewardCredits: cap }));
      assert.equal(res.statusCode, 200);
      assert.equal(json(res).payout, cap);
    });

    test('future completedAtMs is rejected; small clock skew is tolerated', async () => {
      const pilot = await newPilot();
      const active = await acceptOk(pilot);

      const future = signedClaim(pilot, active, { completedAtMs: Date.now() + 120_000 });
      assert.equal((await complete(pilot, future)).statusCode, 400);
      assert.equal(await credits(pilot), 0);
      assert.ok(await activeMission(pilot));

      const skewed = signedClaim(pilot, active, { completedAtMs: Date.now() + 30_000 });
      assert.equal((await complete(pilot, skewed)).statusCode, 200);
    });

    test('payout that would overflow the credit balance is rejected and the mission stays active', async () => {
      const pilot = await newPilot();
      const active = await acceptOk(pilot);
      const claim = signedClaim(pilot, active);

      await setCredits(pilot, 2_147_483_647 - claim.rewardCredits + 1);
      assert.equal((await complete(pilot, claim)).statusCode, 409);
      assert.equal(await credits(pilot), 2_147_483_647 - claim.rewardCredits + 1);
      assert.ok(await activeMission(pilot));
      assert.equal(await aboard(pilot), 2); // rolled back with the rest
      assert.deepEqual(await standings(pilot), {});
      assert.equal(await app.prisma.completedMission.count({ where: { playerId: pilot.id } }), 0);

      // Exactly reaching the maximum is allowed.
      await setCredits(pilot, 2_147_483_647 - claim.rewardCredits);
      assert.equal((await complete(pilot, claim)).statusCode, 200);
      assert.equal(await credits(pilot), 2_147_483_647);
    });

    test('a claim for another pilot is rejected', async () => {
      const pilot = await newPilot('Owner');
      const thief = await newPilot('Thief');
      const active = await acceptOk(pilot);
      const claim = signedClaim(pilot, active);

      assert.equal((await complete(thief, claim)).statusCode, 403);
      // Thief re-labels the claim as their own: valid shape, but signature covers the owner's id.
      const relabelled = { ...claim, playerShipId: thief.id };
      assert.equal((await complete(thief, relabelled)).statusCode, 404);

      assert.equal(await credits(thief), 0);
      assert.equal(await credits(pilot), 0);
    });

    test('claims must match the active mission', async () => {
      const pilot = await newPilot();
      const active = await acceptOk(pilot);
      const nothing = await complete(pilot, signedClaim(pilot, { ...active, mission_id: randomUUID() }));
      assert.equal(nothing.statusCode, 404);
      const wrongAccepted = signedClaim(pilot, active, { acceptedAtMs: active.accepted_at_ms - 1 });
      assert.equal((await complete(pilot, wrongAccepted)).statusCode, 400);
      const wrongDest = signedClaim(pilot, active, { destinationStationId: randomUUID() });
      assert.equal((await complete(pilot, wrongDest)).statusCode, 400);
    });

    test('settles the mission the claim names while others are held', async () => {
      const pilot = await newPilot();
      const passage = await acceptOk(pilot, signedOffer(pilot));
      const first = await acceptOk(pilot, research(pilot));
      const second = await acceptOk(pilot, research(pilot));

      const claim = signedClaim(pilot, second);
      const res = await complete(pilot, claim);
      assert.equal(res.statusCode, 200, res.body);
      assert.equal(json(res).payout, claim.rewardCredits);
      assert.equal(tokenAboard(res), 2); // a survey boarded no one, so the passage's passengers stay
      assert.deepEqual(await activeIds(pilot), [passage.mission_id, first.mission_id]);
      assert.equal((await complete(pilot, claim)).statusCode, 404);

      const landed = await complete(pilot, signedClaim(pilot, passage));
      assert.equal(landed.statusCode, 200, landed.body);
      assert.equal(tokenAboard(landed), 0);
      assert.deepEqual(await activeIds(pilot), [first.mission_id]);
      assert.equal(await credits(pilot), claim.rewardCredits + passage.offer.reward_credits + 10);
    });

    test('concurrent completions pay out and unboard once', async () => {
      const pilot = await newPilot();
      await call(pilot, 'GET', '/ship/loadout');
      await setAboard(pilot, 1);
      const active = await acceptOk(pilot, signedOffer(pilot, { required_berths: 1 }));
      const claim = signedClaim(pilot, active);
      const results = await Promise.all([1, 2, 3].map(() => complete(pilot, claim)));
      assert.equal(results.filter((r) => r.statusCode === 200).length, 1);
      assert.equal(await credits(pilot), claim.rewardCredits);
      assert.equal(await aboard(pilot), 1);
      assert.deepEqual(await standings(pilot), { 'faction-high': 5 });
    });
  });
  describe('late completion', () => {
    const MIN = 60_000;
    const HOUR = 60 * MIN;

    test('a late claim pays the signed decayed reward, applies its negative reputation and settles as usual', async () => {
      const pilot = await newPilot();
      const offer = signedOffer(pilot); // a 10-minute passage
      const late = await acceptedAgo(pilot, await acceptOk(pilot, offer), 25 * MIN);
      // Completed 15 minutes after the deadline (lateness 1.5): the engine signed the passage floors.
      const claim = signedClaim(pilot, late, { completedAtMs: late.deadline_ms + 15 * MIN, rewardCredits: 500, reputationChange: -10 });

      const res = await complete(pilot, claim);
      assert.equal(res.statusCode, 200, res.body);
      const { token, ...body } = json(res);
      assert.deepEqual(body, {
        success: true, credits: 500, payout: 500, grossCredits: 500, crewShareCredits: 0, netCredits: 500, crewPayouts: [], reputation_change: -10, standings: { 'faction-high': -10 },
        xpGained: 200, currentLevel: 2, traitPointsAvailable: 1
      });
      assert.equal(app.jwt.verify(token).ship_attributes.passengers_aboard, 0);
      assert.equal(await credits(pilot), 500);
      assert.equal(await activeMission(pilot), null);
      assert.equal((await cooldown(pilot, offer.origin_station_id)).active, true);

      const row = await app.prisma.completedMission.findFirst({ where: { playerId: pilot.id } });
      assert.equal(row.missionId, offer.mission_id);
      assert.equal(row.factionId, 'faction-high');
      assert.equal(row.rewardCredits, 500);
      assert.equal(row.reputationChange, -10);
      const rep = await app.prisma.playerReputation.findMany({ where: { playerId: pilot.id } });
      assert.deepEqual(rep.map((r) => [r.factionId, r.standing]), [['faction-high', -10]]);
      assert.equal((await complete(pilot, claim)).statusCode, 404);
      assert.deepEqual(await standings(pilot), { 'faction-high': -10 });
    });

    test('the cutoff is the deadline plus three duration limits: at it the claim pays, a millisecond beyond it is refused', async () => {
      const pilot = await newPilot();
      const onTime = await acceptedAgo(pilot, await acceptOk(pilot, research(pilot)), 45 * MIN);
      const beyond = await acceptedAgo(pilot, await acceptOk(pilot, research(pilot)), 45 * MIN);
      // 10-minute limit: the cutoff is 30 minutes after the deadline.
      const refused = await complete(pilot, signedClaim(pilot, beyond, { completedAtMs: beyond.deadline_ms + 30 * MIN + 1, rewardCredits: 1000, reputationChange: 0 }));
      assert.equal(refused.statusCode, 400);
      assert.equal(json(refused).code, 'mission_expired');
      assert.equal(await credits(pilot), 0);
      assert.deepEqual(await standings(pilot), {});
      assert.equal(await app.prisma.completedMission.count({ where: { playerId: pilot.id } }), 0);
      assert.equal((await activeIds(pilot)).length, 2);

      const paid = await complete(pilot, signedClaim(pilot, onTime, { completedAtMs: onTime.deadline_ms + 30 * MIN, rewardCredits: 1000, reputationChange: 0 }));
      assert.equal(paid.statusCode, 200, paid.body);
      assert.equal(json(paid).payout, 1000);
      // A zero reputation change leaves the standing neutral and stores no row.
      assert.deepEqual(json(paid).standings, {});
      assert.deepEqual(await activeIds(pilot), [beyond.mission_id]);
    });

    test('the late window is capped at 24 hours for long missions', async () => {
      const pilot = await newPilot();
      const limit = 36 * HOUR; // three limits would be 108 hours
      const offerFor = () => research(pilot, { duration_limit_ms: limit });
      const atCap = await acceptedAgo(pilot, await acceptOk(pilot, offerFor()), limit + 25 * HOUR);
      const pastCap = await acceptedAgo(pilot, await acceptOk(pilot, offerFor()), limit + 25 * HOUR);

      const refused = await complete(pilot, signedClaim(pilot, pastCap, { completedAtMs: pastCap.deadline_ms + 24 * HOUR + 1, rewardCredits: 1000, reputationChange: 0 }));
      assert.equal(refused.statusCode, 400);
      assert.equal(json(refused).code, 'mission_expired');
      const paid = await complete(pilot, signedClaim(pilot, atCap, { completedAtMs: atCap.deadline_ms + 24 * HOUR, rewardCredits: 1000, reputationChange: 0 }));
      assert.equal(paid.statusCode, 200, paid.body);
    });

    test('a claim gaining more reputation than the offer is rejected and changes nothing', async () => {
      const pilot = await newPilot();
      const active = await acceptOk(pilot);
      const res = await complete(pilot, signedClaim(pilot, active, { reputationChange: 6 }));
      assert.equal(res.statusCode, 400);
      assert.equal(await credits(pilot), 0);
      assert.deepEqual(await standings(pilot), {});
      assert.ok(await activeMission(pilot));
    });

    test('standing is clamped to [-1000, 1000]', async () => {
      const pilot = await newPilot();
      await setStanding(pilot, 'faction-high', -995);
      const late = await acceptedAgo(pilot, await acceptOk(pilot), 25 * MIN);
      const sunk = await complete(pilot, signedClaim(pilot, late, { completedAtMs: late.deadline_ms + 15 * MIN, rewardCredits: 500, reputationChange: -10 }));
      assert.deepEqual(json(sunk).standings, { 'faction-high': -1000 });
      // The ledger keeps the signed change, not the clamped one.
      assert.equal((await app.prisma.completedMission.findFirst({ where: { playerId: pilot.id } })).reputationChange, -10);

      await setStanding(pilot, 'faction-high', 998);
      const active = await acceptOk(pilot);
      const raised = await complete(pilot, signedClaim(pilot, active));
      assert.deepEqual(json(raised).standings, { 'faction-high': 1000 });
    });

    test('an offer without a faction credits the independent standing', async () => {
      const pilot = await newPilot();
      const active = await acceptOk(pilot, signedOffer(pilot, { faction_id: '' }));
      const res = await complete(pilot, signedClaim(pilot, active));
      assert.deepEqual(json(res).standings, { independent: 5 });
      assert.equal((await app.prisma.completedMission.findFirst({ where: { playerId: pilot.id } })).factionId, 'independent');
    });

    test('concurrent late completions pay and apply reputation once', async () => {
      const pilot = await newPilot();
      const late = await acceptedAgo(pilot, await acceptOk(pilot), 25 * MIN);
      const claim = signedClaim(pilot, late, { completedAtMs: late.deadline_ms + 4 * MIN, rewardCredits: 1700, reputationChange: -1 });
      const results = await Promise.all([1, 2, 3, 4].map(() => complete(pilot, claim)));
      assert.equal(results.filter((r) => r.statusCode === 200).length, 1);
      assert.equal(await credits(pilot), 1700);
      assert.deepEqual(await standings(pilot), { 'faction-high': -1 });
      assert.equal(await app.prisma.completedMission.count({ where: { playerId: pilot.id } }), 1);
    });
  });

  describe('abandon penalties', () => {
    const abandonAt = (pilot, missionId, dockedReceipt) => call(pilot, 'POST', '/game/missions/abandon', { missionId, dockedReceipt });
    const MIN = 60_000;

    test('research costs 8 reputation and starts a 15-minute cooldown at its origin, docked or in flight', async () => {
      const pilot = await newPilot();
      const offer = research(pilot);
      const active = await acceptOk(pilot, offer);

      const res = await abandon(pilot, active.mission_id);
      assert.equal(res.statusCode, 200, res.body);
      const { token, ...body } = json(res);
      assert.deepEqual(body, {
        abandoned: true,
        mission_id: offer.mission_id,
        outcome: 'MISSION_ABANDON_OUTCOME_CANCELLED',
        reputation_change: -8,
        standings: { 'faction-high': -8 }
      });
      assert.ok(app.jwt.verify(token));
      assert.equal(await credits(pilot), 0);
      const wait = await cooldown(pilot, offer.origin_station_id);
      assert.ok(wait.remaining_ms > 14 * MIN && wait.remaining_ms <= 15 * MIN, JSON.stringify(wait));
      const [row] = await abandonRows(pilot);
      assert.equal(row.missionId, offer.mission_id);
      assert.equal(row.originStationId, offer.origin_station_id);
      assert.equal(row.factionId, 'faction-high');
      assert.equal(row.missionType, 'RESEARCH');
      assert.equal(row.reputationLoss, -8);
      assert.equal(row.hostageMinutes, 0);
      assert.equal(row.reason, 'in_flight');

      // Docked anywhere, the terms are the same.
      const docked = await acceptOk(pilot, research(pilot));
      const there = await abandonAt(pilot, docked.mission_id, dockedReceipt(pilot));
      assert.equal(there.statusCode, 200, there.body);
      assert.equal(json(there).reputation_change, -8);
      assert.deepEqual(json(there).standings, { 'faction-high': -16 });
      assert.equal((await abandonRows(pilot)).find((r) => r.missionId === docked.mission_id).reason, 'in_port_dock');
    });

    test('a passage cancelled while docked at its origin costs 2 reputation and a 5-minute cooldown, and the passengers step off', async () => {
      const pilot = await newPilot();
      const offer = signedOffer(pilot);
      const active = await acceptOk(pilot, offer);
      assert.equal(await aboard(pilot), 2);

      const res = await abandonAt(pilot, active.mission_id, receiptAtOrigin(pilot, offer));
      assert.equal(res.statusCode, 200, res.body);
      assert.equal(json(res).outcome, 'MISSION_ABANDON_OUTCOME_CANCELLED');
      assert.equal(json(res).reputation_change, -2);
      assert.deepEqual(json(res).standings, { 'faction-high': -2 });
      assert.equal(tokenAboard(res), 0);
      assert.equal(await aboard(pilot), 0);
      const wait = await cooldown(pilot, offer.origin_station_id);
      assert.ok(wait.remaining_ms > 4 * MIN && wait.remaining_ms <= 5 * MIN, JSON.stringify(wait));
      const [row] = await abandonRows(pilot);
      assert.equal(row.missionType, 'PASSAGE');
      assert.equal(row.reason, 'in_port_origin');
      assert.equal(row.reputationLoss, -2);
    });

    test('a passage abandoned in flight or at another dock costs nothing yet, starts no cooldown and keeps its passengers aboard', async () => {
      const pilot = await newPilot();
      const offer = signedOffer(pilot);
      await acceptOk(pilot, offer);
      const flight = await abandon(pilot);
      assert.equal(flight.statusCode, 200);
      assert.equal(json(flight).outcome, 'MISSION_ABANDON_OUTCOME_HOSTAGE');
      assert.equal(json(flight).reputation_change, 0);
      assert.deepEqual(json(flight).standings, {});
      assert.equal(tokenAboard(flight), 2);
      assert.equal(await aboard(pilot), 2);
      assert.equal((await cooldown(pilot, offer.origin_station_id)).active, false);

      // Hold the second party with the first still aboard, in a ship with room for both.
      const elsewhere = signedOffer(pilot, { required_berths: 1 });
      await acceptOk(pilot, elsewhere);
      // Docked at the same station id but in another system is another dock.
      const res = await abandonAt(pilot, elsewhere.mission_id, receiptAtOrigin(pilot, elsewhere, { systemH3: '8828308285fffff' }));
      assert.equal(res.statusCode, 200, res.body);
      assert.equal(json(res).outcome, 'MISSION_ABANDON_OUTCOME_HOSTAGE');
      assert.equal(json(res).reputation_change, 0);
      assert.equal(await aboard(pilot), 3);
      assert.equal((await cooldown(pilot, elsewhere.origin_station_id)).active, false);
      const rows = await abandonRows(pilot);
      assert.deepEqual(rows.map((r) => [r.missionId, r.reason, r.reputationLoss, r.hostageBerths]).sort(), [
        [offer.mission_id, 'in_flight', 0, 2],
        [elsewhere.mission_id, 'in_port_dock', 0, 1]
      ].sort());
      assert.deepEqual(await standings(pilot), {});
    });

    test('a refused receipt changes nothing', async () => {
      const pilot = await newPilot();
      const offer = research(pilot);
      const active = await acceptOk(pilot, offer);
      const other = await newPilot('Other');
      for (const [receipt, code] of [
        [receiptAtOrigin(other, offer), 'docked_receipt_invalid'],
        [receiptAtOrigin(pilot, offer, { signature: Buffer.alloc(64, 7).toString('base64') }), 'docked_receipt_invalid'],
        [receiptAtOrigin(pilot, offer, { issuedAtMs: Date.now() - 10 * MIN, dockedAtMs: Date.now() - 11 * MIN }), 'docked_receipt_expired']
      ]) {
        const res = await abandonAt(pilot, active.mission_id, receipt);
        assert.equal(res.statusCode, 403, res.body);
        assert.equal(json(res).code, code);
      }
      assert.equal((await abandonAt(pilot, active.mission_id, { dockedEntityId: 'nope' })).statusCode, 400);

      const configured = app.claimKey;
      app.claimKey = null;
      try {
        const res = await abandonAt(pilot, active.mission_id, receiptAtOrigin(pilot, offer));
        assert.equal(res.statusCode, 503);
        assert.equal(json(res).error, 'CLAIM_KEY_NOT_CONFIGURED');
      } finally {
        app.claimKey = configured;
      }
      assert.deepEqual(await activeIds(pilot), [active.mission_id]);
      assert.deepEqual(await abandonRows(pilot), []);
      assert.deepEqual(await standings(pilot), {});
      assert.equal((await cooldown(pilot, offer.origin_station_id)).active, false);
    });

    test('accept-abandon churn: each abandon costs reputation, the origin cools down, and an abandoned mission is never taken again', async () => {
      const pilot = await newPilot();
      const offer = research(pilot);
      const active = await acceptOk(pilot, offer);
      assert.equal((await abandon(pilot, active.mission_id)).statusCode, 200);

      const again = await accept(pilot, research(pilot, { origin_station_id: offer.origin_station_id }));
      assert.equal(again.statusCode, 409);
      assert.equal(json(again).code, 'origin_on_cooldown');
      // Even once the cooldown has passed, the same offer is refused.
      await app.prisma.missionCooldown.deleteMany({ where: { playerId: pilot.id } });
      const same = await accept(pilot, offer);
      assert.equal(same.statusCode, 409);
      assert.equal(json(same).code, 'mission_abandoned');
      assert.deepEqual(await activeIds(pilot), []);

      // Elsewhere, each churned mission costs again.
      for (let i = 0; i < 3; i += 1) {
        const churn = await acceptOk(pilot, research(pilot));
        assert.equal((await abandon(pilot, churn.mission_id)).statusCode, 200);
      }
      assert.deepEqual(await standings(pilot), { 'faction-high': -32 });
      assert.equal((await abandonRows(pilot)).length, 4);
    });

    test('an abandon cooldown never shortens one already running at the origin', async () => {
      const pilot = await newPilot();
      const passage = signedOffer(pilot);
      const survey = research(pilot, { origin_station_id: passage.origin_station_id, origin_system_h3: passage.origin_system_h3 });
      const held = await acceptOk(pilot, passage);
      const done = await acceptOk(pilot, survey);
      assert.equal((await complete(pilot, signedClaim(pilot, done))).statusCode, 200); // 10 minutes
      assert.equal((await abandonAt(pilot, held.mission_id, receiptAtOrigin(pilot, passage))).statusCode, 200); // 5 minutes
      const wait = await cooldown(pilot, passage.origin_station_id);
      assert.ok(wait.remaining_ms > 9 * MIN, JSON.stringify(wait));
    });

    test('a cooldown stored before abandons had their own still runs 10 minutes from completion', async () => {
      const pilot = await newPilot();
      const stationId = randomUUID();
      await app.prisma.missionCooldown.create({
        data: { playerId: pilot.id, originStationId: stationId, completedAt: new Date(Date.now() - 4 * MIN) }
      });
      const wait = await cooldown(pilot, stationId);
      assert.ok(wait.remaining_ms > 5 * MIN && wait.remaining_ms <= 6 * MIN, JSON.stringify(wait));
    });

    test('the standing floor is -1000', async () => {
      const pilot = await newPilot();
      await setStanding(pilot, 'faction-high', -995);
      const active = await acceptOk(pilot, research(pilot));
      const res = await abandon(pilot, active.mission_id);
      assert.equal(json(res).reputation_change, -8);
      assert.deepEqual(json(res).standings, { 'faction-high': -1000 });
    });

    test('concurrent abandons of one mission penalise once', async () => {
      const pilot = await newPilot();
      const active = await acceptOk(pilot, research(pilot));
      const results = await Promise.all([1, 2, 3, 4].map(() => abandon(pilot, active.mission_id)));
      assert.deepEqual(results.map((r) => r.statusCode).sort(), [200, 404, 404, 404]);
      assert.deepEqual(await standings(pilot), { 'faction-high': -8 });
      assert.equal((await abandonRows(pilot)).length, 1);
    });

    test('a concurrent abandon and completion settle the mission one way only', async () => {
      for (let i = 0; i < 3; i += 1) {
        const pilot = await newPilot();
        const active = await acceptOk(pilot, research(pilot));
        const claim = signedClaim(pilot, active);
        const [quit, done] = await Promise.all([abandon(pilot, active.mission_id), complete(pilot, claim)]);
        const abandoned = quit.statusCode === 200;
        assert.notEqual(abandoned, done.statusCode === 200, `${quit.statusCode} ${done.statusCode}`);
        assert.equal(await credits(pilot), abandoned ? 0 : claim.rewardCredits);
        assert.deepEqual(await standings(pilot), { 'faction-high': abandoned ? -8 : 5 });
        assert.equal((await abandonRows(pilot)).length, abandoned ? 1 : 0);
        assert.equal(await app.prisma.completedMission.count({ where: { playerId: pilot.id } }), abandoned ? 0 : 1);
        assert.deepEqual(await activeIds(pilot), []);
      }
    });
  });

  describe('survey surveyor', () => {
    const survey = (pilot, overrides = {}) => research(pilot, { required_berths: 1, ...overrides });

    test('with one free berth a survey boards its surveyor; with none it is refused', async () => {
      const pilot = await newPilot();
      await call(pilot, 'GET', '/ship/loadout'); // creates the ship row; Tier 1 has 3 berths
      await setAboard(pilot, 2);
      const res = await accept(pilot, survey(pilot));
      assert.equal(res.statusCode, 200, res.body);
      assert.equal(tokenAboard(res), 3);
      assert.equal(await aboard(pilot), 3);

      const full = await accept(pilot, survey(pilot));
      assert.equal(full.statusCode, 400);
      assert.equal(json(full).code, 'insufficient_berths');
      assert.equal(json(full).available_berths, 0);
      assert.equal((await activeIds(pilot)).length, 1);
      assert.equal(await aboard(pilot), 3);
    });

    test('a hold full of passage passengers blocks a survey, and a survey blocks a passage', async () => {
      const pilot = await newPilot();
      await acceptOk(pilot, signedOffer(pilot, { required_berths: 3 }));
      assert.equal(await aboard(pilot), 3);
      const blocked = await accept(pilot, survey(pilot));
      assert.equal(blocked.statusCode, 400);
      assert.equal(json(blocked).code, 'insufficient_berths');
      assert.equal(json(blocked).available_berths, 0);

      const other = await newPilot();
      await acceptOk(other, survey(other));
      const passage = await accept(other, signedOffer(other, { required_berths: 3 }));
      assert.equal(json(passage).code, 'insufficient_berths');
      assert.equal(json(passage).available_berths, 2);
    });

    test('the surveyor steps off at completion', async () => {
      const pilot = await newPilot();
      await call(pilot, 'GET', '/ship/loadout');
      await setAboard(pilot, 1);
      const active = await acceptOk(pilot, survey(pilot));
      assert.equal(await aboard(pilot), 2);
      const res = await complete(pilot, signedClaim(pilot, active));
      assert.equal(res.statusCode, 200, res.body);
      assert.equal(tokenAboard(res), 1);
      assert.equal(await aboard(pilot), 1);
      assert.equal(json(await accept(pilot, survey(pilot))).active.offer.required_berths, 1);
    });

    test('the surveyor steps off at abandon, in flight and in port, with the research terms', async () => {
      const pilot = await newPilot();
      const flying = await acceptOk(pilot, survey(pilot));
      assert.equal(await aboard(pilot), 1);
      const res = await abandon(pilot, flying.mission_id);
      assert.equal(json(res).reputation_change, -8);
      assert.equal(tokenAboard(res), 0);
      assert.equal(await aboard(pilot), 0);

      const offer = survey(pilot, { origin_station_id: randomUUID() });
      const docked = await acceptOk(pilot, offer);
      assert.equal(await aboard(pilot), 1);
      const inPort = await call(pilot, 'POST', '/game/missions/abandon', {
        missionId: docked.mission_id,
        dockedReceipt: receiptAtOrigin(pilot, offer)
      });
      assert.equal(inPort.statusCode, 200, inPort.body);
      assert.equal(json(inPort).reputation_change, -8);
      assert.equal(tokenAboard(inPort), 0);
      assert.equal(await aboard(pilot), 0);
      assert.equal((await abandonRows(pilot)).filter((r) => r.reason === 'in_port_origin').length, 1);
    });
  });
});
