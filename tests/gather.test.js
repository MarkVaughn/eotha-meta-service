import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createPrivateKey, createPublicKey, randomUUID, sign } from 'node:crypto';
import { app, call, closeApp, credits, json, loginKey, newPilot, receiptAtOrigin, rtseKey, signedOffer } from './helpers.js';
import { canonicalClaimPayload } from '../src/lib/mission-claim.js';
import { canonicalMissionOfferPayload, verifyMissionOffer } from '../src/lib/mission-offer.js';

// The fixed gather vectors from eotha-contracts `scripts/check-mission-offer-vector.js` and
// `scripts/check-mission-claim-vector.js` (Ed25519 seed [7; 32]).
const OFFER_SIGNATURE =
  'KMm99/Mjtr4Y+qEpQcH5opDtHklAsNkdUCRoviYwAun2XDW649YauJVgz0yuD56XfsymYQeV1cyYHj9fJXDBCA==';
const CLAIM_VECTOR =
  '454f5448415f4d495353494f4e5f434c41494d5f5631020000006d310400000073686970020000007374a0eee6cf8b0100008082ebcf8b010000881300000000000005000000111111111111111111111111111111112222222222222222222222222222222209000000000000000100000008000000544954414e49554d9411000004000000401f0000';
const vectorKey = createPrivateKey({
  key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.alloc(32, 7)]),
  format: 'der',
  type: 'pkcs8'
});

const vectorOffer = () => ({
  pilot_id: 'pilot-1',
  offered_at_ms: 1791811000000,
  mission_id: '09090909-0909-4909-8909-090909090909',
  type: 'MISSION_TYPE_GATHER',
  title: 'Deliver 20 m3 of TITANIUM to SYS-3082A9 I Station',
  description: 'Deliver 20 m3 of grade 4+ TITANIUM to SYS-3082A9 I Station in SYS-3082A9 System.',
  origin_station_id: '2fe1f208-c003-44c5-929e-1b020d5a2e47',
  origin_system_h3: '8828308283fffff',
  destination_station_id: '3536a1db-5599-4b6f-bde9-d48524d31061',
  destination_system_h3: '88283082a9fffff',
  destination_node_h3: '8c283082a9001ff',
  destination_lat: 37.78125,
  destination_lng: -122.40625,
  distance_hexes: 2,
  required_berths: 0,
  duration_limit_ms: 1500000,
  reward_credits: 5000,
  reputation_change: 5,
  faction_id: 'faction-high',
  expires_at_ms: 1791812800000,
  resource_type: 'TITANIUM',
  min_grade: 4,
  quantity_m3: 20,
  source_body_id: '5a1b7c3e-8d2f-4e6a-9b04-c1d2e3f40516',
  source_system_h3: '8828308281fffff',
  source_node_h3: '8c28308281001ff',
  source_lat: 37.75,
  source_lng: -122.4375,
  signature: OFFER_SIGNATURE
});

function nextUp(x) {
  const buf = Buffer.alloc(8);
  buf.writeDoubleLE(x);
  buf.writeBigUInt64LE(buf.readBigUInt64LE() + 1n);
  return buf.readDoubleLE();
}

describe('gather offer verifier', () => {
  test('canonical payload and signature match the eotha-contracts gather vector', () => {
    const payload = canonicalMissionOfferPayload(vectorOffer());
    assert.equal(payload.length, 541);
    assert.equal(sign(null, payload, vectorKey).toString('base64'), OFFER_SIGNATURE);
    assert.equal(verifyMissionOffer(vectorOffer(), createPublicKey(vectorKey)), true);
    assert.equal(verifyMissionOffer(JSON.parse(JSON.stringify(vectorOffer())), createPublicKey(vectorKey)), true);
  });

  test('every gather field is signed, the type and the source coordinates to the bit included', () => {
    const publicKey = createPublicKey(vectorKey);
    const changes = {
      resource_type: 'IRON',
      min_grade: 3,
      quantity_m3: 21,
      source_body_id: '5a1b7c3e-8d2f-4e6a-9b04-c1d2e3f40517',
      source_system_h3: '8828308283fffff',
      source_node_h3: '8c28308281002ff',
      source_lat: nextUp(37.75),
      source_lng: nextUp(-122.4375),
      type: 'MISSION_TYPE_PASSAGE'
    };
    for (const [field, value] of Object.entries(changes)) {
      assert.equal(verifyMissionOffer({ ...vectorOffer(), [field]: value }, publicKey), false, field);
    }
  });

  test('passage and research payloads ignore the gather fields', () => {
    const passage = { ...vectorOffer(), type: 'MISSION_TYPE_PASSAGE' };
    const bare = canonicalMissionOfferPayload(passage);
    assert.equal(canonicalMissionOfferPayload({ ...passage, quantity_m3: 99, resource_type: 'X' }).equals(bare), true);
    assert.equal(bare.length, 541 - 114);
  });

  test('the gather claim payload matches the eotha-contracts vector', () => {
    const claim = {
      missionId: 'm1',
      playerShipId: 'ship',
      destinationStationId: 'st',
      acceptedAtMs: 1700000100000,
      completedAtMs: 1700000400000,
      rewardCredits: 5000,
      reputationChange: 5,
      leaseId: '11111111-1111-1111-1111-111111111111',
      sessionId: '22222222-2222-2222-2222-222222222222',
      cargoSeq: 9,
      remaining: [{ resourceType: 'TITANIUM', unitsMilli: 4500, grade: 4, purityBp: 8000 }]
    };
    assert.equal(canonicalClaimPayload(claim, true).toString('hex'), CLAIM_VECTOR);
    // Without the flag the suffix is not signed.
    assert.equal(CLAIM_VECTOR.startsWith(canonicalClaimPayload(claim).toString('hex')), true);
  });
});

const GATHER = {
  type: 'MISSION_TYPE_GATHER',
  required_berths: 0,
  resource_type: 'TITANIUM',
  min_grade: 4,
  quantity_m3: 20,
  source_body_id: randomUUID(),
  source_system_h3: '8828308281fffff',
  source_node_h3: '8c28308281001ff',
  // Coordinates the JSON column does not keep exactly.
  source_lat: 37.716557269075864,
  source_lng: -122.41941550000001,
  reward_credits: 5000
};
const gatherOffer = (pilot, overrides = {}) => signedOffer(pilot, { ...GATHER, ...overrides });

const accept = (pilot, offer) => call(pilot, 'POST', '/game/missions/accept', { offer, dockedReceipt: receiptAtOrigin(pilot, offer) });
async function acceptOk(pilot, offer) {
  const res = await accept(pilot, offer);
  assert.equal(res.statusCode, 200, res.body);
  return json(res).active;
}

const u32 = (n) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
};
const u64 = (n) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
};
const i32 = (n) => {
  const b = Buffer.alloc(4);
  b.writeInt32LE(n);
  return b;
};
const str = (s) => Buffer.concat([u32(Buffer.byteLength(s)), Buffer.from(s, 'utf8')]);
const id = (uuid) => Buffer.from(uuid.replaceAll('-', ''), 'hex');

// A claim signed the way the engine signs it, assembled here rather than with src/lib/mission-claim.js.
function gatherClaim(pilot, active, cargo, overrides = {}, key = rtseKey) {
  const claim = {
    missionId: active.mission_id,
    playerShipId: pilot.id,
    destinationStationId: active.offer.destination_station_id,
    acceptedAtMs: active.accepted_at_ms,
    completedAtMs: active.accepted_at_ms + 60_000,
    rewardCredits: active.offer.reward_credits,
    reputationChange: active.offer.reputation_change,
    ...cargo,
    ...overrides
  };
  claim.durationTakenMs = claim.completedAtMs - claim.acceptedAtMs;
  const bytes = [
    Buffer.from('EOTHA_MISSION_CLAIM_V1', 'ascii'),
    str(claim.missionId), str(claim.playerShipId), str(claim.destinationStationId),
    u64(claim.acceptedAtMs), u64(claim.completedAtMs), u64(claim.rewardCredits), i32(claim.reputationChange),
    id(claim.leaseId), id(claim.sessionId), u64(claim.cargoSeq), u32(claim.remaining.length),
    ...claim.remaining.flatMap((lot) => [str(lot.resourceType), u32(lot.unitsMilli), u32(lot.grade), u32(lot.purityBp)])
  ];
  claim.signature = sign(null, Buffer.concat(bytes), key).toString('base64');
  return claim;
}

const complete = (pilot, claim) => call(pilot, 'POST', '/game/missions/complete', { claim });
const lease = async (pilot) => {
  const res = await call(pilot, 'POST', '/game/cargo/lease');
  assert.equal(res.statusCode, 200, res.body);
  return json(res).cargo.lease_id;
};
const held = async (pilot) => json(await call(pilot, 'GET', '/game/cargo'));
const stored = (lot) => ({ resource_type: lot.resourceType, units_milli: lot.unitsMilli, grade: lot.grade, purity_bp: lot.purityBp });
const LEFTOVER = { resourceType: 'TITANIUM', unitsMilli: 4500, grade: 4, purityBp: 8000 };

describe('gather missions', () => {
  before(async () => { await app.ready(); });
  after(async () => { await closeApp(); });

  test('a signed gather offer is accepted and handed back bit-exact', async () => {
    const pilot = await newPilot();
    const offer = gatherOffer(pilot);
    const active = await acceptOk(pilot, offer);
    assert.deepEqual(active.offer, offer);
    assert.equal(verifyMissionOffer(active.offer, app.claimKey.key), true);

    const listed = json(await call(pilot, 'GET', '/game/missions/active')).missions[0];
    assert.deepEqual(listed.offer, offer);
    const row = await app.prisma.playerMission.findFirst({ where: { playerId: pilot.id } });
    assert.deepEqual(row.offer.exact_source, [String(GATHER.source_lat), String(GATHER.source_lng)]);
    // A gather mission boards no one.
    assert.equal(json(await call(pilot, 'GET', '/ship/loadout')).ship_attributes.passengers_aboard, 0);
  });

  test('a tampered quantity, grade or type is refused as an invalid offer', async () => {
    const pilot = await newPilot();
    const offer = gatherOffer(pilot);
    for (const change of [{ quantity_m3: 1 }, { min_grade: 1 }, { resource_type: 'FERRITE' }, { source_lat: nextUp(offer.source_lat) }, { type: 'MISSION_TYPE_RESEARCH' }]) {
      const res = await accept(pilot, { ...offer, ...change });
      assert.equal(res.statusCode, 403, JSON.stringify(change));
      assert.equal(json(res).code, 'mission_offer_invalid');
    }
  });

  test('a pilot holds one gather mission, alongside passage and research', async () => {
    const pilot = await newPilot();
    await acceptOk(pilot, gatherOffer(pilot));
    const second = await accept(pilot, gatherOffer(pilot));
    assert.equal(second.statusCode, 409);
    assert.deepEqual(
      { code: json(second).code, type: json(second).type, limit: json(second).limit },
      { code: 'mission_limit_reached', type: 'MISSION_TYPE_GATHER', limit: 1 }
    );
    await acceptOk(pilot, signedOffer(pilot));
    await acceptOk(pilot, signedOffer(pilot, { type: 'MISSION_TYPE_RESEARCH', required_berths: 0 }));
    assert.equal(json(await call(pilot, 'GET', '/game/missions/active')).missions.length, 3);
  });

  describe('completion', () => {
    // A held gather mission, the pilot's lease and the cargo fields of a claim at `seq`.
    async function setup(overrides = {}) {
      const pilot = await newPilot();
      const active = await acceptOk(pilot, gatherOffer(pilot, overrides));
      const leaseId = await lease(pilot);
      const cargo = (seq, remaining = [LEFTOVER], extra = {}) => ({
        leaseId,
        sessionId: '22222222-2222-2222-2222-222222222222',
        cargoSeq: seq,
        remaining,
        ...extra
      });
      return { pilot, active, leaseId, cargo };
    }

    test('pays, stores the remaining hold and ends the mission in one step', async () => {
      const { pilot, active, cargo } = await setup();
      const before = await credits(pilot);
      const res = await complete(pilot, gatherClaim(pilot, active, cargo(5)));
      assert.equal(res.statusCode, 200, res.body);
      assert.equal(json(res).payout, 5000);
      assert.deepEqual(json(res).lots, [stored(LEFTOVER)]);
      assert.equal(await credits(pilot), before + 5000);
      assert.deepEqual((await held(pilot)).lots, [stored(LEFTOVER)]);
      assert.deepEqual(json(await call(pilot, 'GET', '/game/missions/active')).missions, []);
      assert.equal(await app.prisma.completedMission.count({ where: { playerId: pilot.id } }), 1);
    });

    test('an empty remaining hold is valid (proto-JSON omits an empty list)', async () => {
      const { pilot, active, cargo } = await setup();
      const claim = gatherClaim(pilot, active, cargo(5, []));
      delete claim.remaining;
      const res = await complete(pilot, claim);
      assert.equal(res.statusCode, 200, res.body);
      assert.deepEqual((await held(pilot)).lots, []);
    });

    test('a repeat is refused and stores nothing', async () => {
      const { pilot, active, cargo } = await setup();
      assert.equal((await complete(pilot, gatherClaim(pilot, active, cargo(5)))).statusCode, 200);
      const credited = await credits(pilot);
      const again = await complete(pilot, gatherClaim(pilot, active, cargo(6, [])));
      assert.equal(again.statusCode, 404);
      assert.equal(await credits(pilot), credited);
      assert.deepEqual((await held(pilot)).lots, [stored(LEFTOVER)]);
    });

    test('a claim without the cargo record is refused, and so is one on another type', async () => {
      const { pilot, active, cargo } = await setup();
      const bare = gatherClaim(pilot, active, cargo(5));
      for (const field of ['leaseId', 'sessionId', 'cargoSeq']) {
        const res = await complete(pilot, { ...bare, [field]: undefined });
        assert.equal(res.statusCode, 400, field);
      }

      const passage = await acceptOk(pilot, signedOffer(pilot));
      const claim = gatherClaim(pilot, passage, cargo(5));
      const res = await complete(pilot, claim);
      assert.equal(res.statusCode, 400);
      assert.equal(await app.prisma.completedMission.count({ where: { playerId: pilot.id } }), 0);
    });

    test('the cargo record is signed: a changed lease, session, seq or hold fails the signature', async () => {
      const { pilot, active, cargo } = await setup();
      const good = gatherClaim(pilot, active, cargo(5));
      const changes = [
        { leaseId: randomUUID() },
        { sessionId: '33333333-3333-3333-3333-333333333333' },
        { cargoSeq: 6 },
        { remaining: [] },
        { remaining: [{ ...LEFTOVER, unitsMilli: 9000 }] }
      ];
      for (const change of changes) {
        const res = await complete(pilot, { ...good, ...change });
        assert.equal(res.statusCode, 403, JSON.stringify(change));
      }
      assert.equal((await complete(pilot, gatherClaim(pilot, active, cargo(5), {}, loginKey))).statusCode, 403);
      assert.equal(await app.prisma.completedMission.count({ where: { playerId: pilot.id } }), 0);
    });

    test('a lease of no pilot of ours is refused cargo_lease_unknown with nothing changed', async () => {
      const { pilot, active, cargo } = await setup();
      const before = await credits(pilot);
      const res = await complete(pilot, gatherClaim(pilot, active, cargo(5, [LEFTOVER], { leaseId: randomUUID() })));
      assert.equal(res.statusCode, 409);
      assert.equal(json(res).code, 'cargo_lease_unknown');
      assert.equal(await credits(pilot), before);
      assert.equal((await json(await call(pilot, 'GET', '/game/missions/active')).missions).length, 1);
    });

    test('a claim from a fenced lease is superseded: no payout, the mission stays, the hold is unchanged', async () => {
      const { pilot, active, cargo } = await setup();
      await lease(pilot); // a newer lease fences the one the claim names
      const before = await credits(pilot);
      const res = await complete(pilot, gatherClaim(pilot, active, cargo(5)));
      assert.equal(res.statusCode, 409);
      assert.equal(json(res).code, 'cargo_superseded');
      assert.equal(await credits(pilot), before);
      assert.deepEqual((await held(pilot)).lots, []);
      assert.equal(json(await call(pilot, 'GET', '/game/missions/active')).missions.length, 1);
      assert.equal(await app.prisma.completedMission.count({ where: { playerId: pilot.id } }), 0);
    });

    test('a claim a later snapshot of its session already covers still pays, storing nothing', async () => {
      const { pilot, active, cargo } = await setup();
      // The same session relays a newer manifest first, which binds the lease and stores the hold.
      const lots = [stored({ ...LEFTOVER, unitsMilli: 1000 })];
      await app.prisma.cargoLease.updateMany({
        where: { playerId: pilot.id },
        data: { sessionId: id('22222222-2222-2222-2222-222222222222'), lastSeq: 9n, lots }
      });
      const before = await credits(pilot);
      const res = await complete(pilot, gatherClaim(pilot, active, cargo(5)));
      assert.equal(res.statusCode, 200, res.body);
      assert.equal(await credits(pilot), before + 5000);
      assert.deepEqual((await held(pilot)).lots, lots);
    });

    test('a payout that would overflow the balance rolls the cargo write back too', async () => {
      const { pilot, active, cargo } = await setup();
      await app.prisma.player.update({ where: { id: pilot.id }, data: { credits: 2_147_483_000 } });
      const res = await complete(pilot, gatherClaim(pilot, active, cargo(5)));
      assert.equal(res.statusCode, 409);
      assert.deepEqual((await held(pilot)).lots, []);
      assert.equal(json(await call(pilot, 'GET', '/game/missions/active')).missions.length, 1);
    });

    test('another pilot cannot redeem it', async () => {
      const { pilot, active, cargo } = await setup();
      const other = await newPilot('Other');
      const res = await complete(other, gatherClaim(pilot, active, cargo(5)));
      assert.equal(res.statusCode, 403);
    });
  });

  test('abandoning costs 10 reputation and a 20-minute cooldown at the origin, and the ore stays in the hold', async () => {
    const pilot = await newPilot();
    await lease(pilot);
    const lots = [stored(LEFTOVER)];
    await app.prisma.cargoLease.updateMany({ where: { playerId: pilot.id }, data: { lots } });
    const offer = gatherOffer(pilot);
    const active = await acceptOk(pilot, offer);

    const res = await call(pilot, 'POST', '/game/missions/abandon', { missionId: active.mission_id });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(json(res).reputation_change, -10);
    assert.deepEqual(json(res).standings, { 'faction-high': -10 });
    assert.deepEqual((await held(pilot)).lots, lots);
    assert.equal(await credits(pilot), 0);
    const wait = json(await call(pilot, 'GET', `/game/missions/cooldown?originId=${offer.origin_station_id}`));
    assert.ok(wait.remaining_ms > 19 * 60_000 && wait.remaining_ms <= 20 * 60_000, JSON.stringify(wait));
    const row = await app.prisma.abandonedMission.findFirst({ where: { playerId: pilot.id } });
    assert.equal(row.missionType, 'GATHER');
    assert.equal(row.reputationLoss, -10);
  });
});
