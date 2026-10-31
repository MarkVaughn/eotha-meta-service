import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID, sign } from 'node:crypto';
import { app, call, closeApp, internalRtseHeaders, json, newPilot, receiptAtOrigin, rtseKey, signedOffer } from './helpers.js';
import {
  EnforcementProjection,
  PenaltyAckStatus,
  PenaltyDelivery,
  PenaltyDeliveryAck,
  PenaltyKind,
  PenaltyRejectionReason
} from '../src/lib/contracts/penalty.js';
import { CUSTOMS_FLAG_MS } from '../src/config/regulation.js';

before(async () => { await app.ready(); });
after(closeApp);

const str = (value) => {
  const bytes = Buffer.from(value, 'utf8');
  const length = Buffer.alloc(4);
  length.writeUInt32LE(bytes.length);
  return Buffer.concat([length, bytes]);
};
const u32 = (value) => {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32LE(value);
  return bytes;
};
const u64 = (value) => {
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64LE(BigInt(value));
  return bytes;
};
const uuidBytes = (value) => Buffer.from(value.replaceAll('-', ''), 'hex');
const idFor = (kind, pilotId, nonce) => `${kind}:${pilotId}:${nonce.toString('hex')}`;
const hash = (delivery) => createHash('sha256').update(Buffer.from(PenaltyDelivery.encode(delivery).finish())).digest();
const raw = (response) => Buffer.isBuffer(response.rawPayload) ? response.rawPayload : Buffer.from(response.body, 'binary');

function customsPenalty(pilot, overrides = {}) {
  const source = {
    pilotId: pilot.id,
    stationEntityId: randomUUID(),
    systemH3: '8828308281fffff',
    controllingFactionId: 'alpha',
    missionId: '',
    inspectionOutcome: 3,
    captureTier: 2,
    exposureScoreMilli: 0,
    seizedAtMs: Date.now(),
    nonce: randomBytes(16),
    ...overrides
  };
  const signingBytes = Buffer.concat([
    Buffer.from('EOTHA_CUSTOMS_SEIZURE_V1', 'ascii'), str(source.pilotId), uuidBytes(source.stationEntityId),
    str(source.systemH3), str(source.controllingFactionId), str(source.missionId), u32(source.inspectionOutcome),
    u32(source.captureTier), u32(source.exposureScoreMilli), u64(source.seizedAtMs), source.nonce
  ]);
  const signature = sign(null, signingBytes, rtseKey);
  const claim = {
    pilotId: source.pilotId,
    stationEntityId: source.stationEntityId,
    systemH3: source.systemH3,
    controllingFactionId: source.controllingFactionId,
    missionId: source.missionId,
    inspectionOutcome: source.inspectionOutcome,
    captureTier: source.captureTier,
    exposureScoreMilli: source.exposureScoreMilli,
    seizedAtMs: source.seizedAtMs,
    nonce: source.nonce.toString('base64'),
    signature: signature.toString('base64')
  };
  const delivery = PenaltyDelivery.create({
    deliveryId: idFor('CUSTOMS_SEIZURE', source.pilotId, source.nonce),
    kind: PenaltyKind.PENALTY_KIND_CUSTOMS_SEIZURE,
    emittedAtMs: String(source.seizedAtMs),
    customsSeizure: {
      ...claim,
      stationEntityId: uuidBytes(source.stationEntityId),
      seizedAtMs: String(source.seizedAtMs),
      nonce: source.nonce,
      signature
    }
  });
  return { claim, delivery, stationId: source.stationEntityId.toLowerCase() };
}

function miningPenalty(pilot, overrides = {}) {
  const source = {
    pilotId: pilot.id,
    systemH3: '8828308281fffff',
    controllingFactionId: 'alpha',
    issuedAtMs: Date.now(),
    nonce: randomBytes(16),
    ...overrides
  };
  const signingBytes = Buffer.concat([
    Buffer.from('EOTHA_MINING_VIOLATION_V1', 'ascii'), str(source.pilotId), str(source.systemH3),
    str(source.controllingFactionId), u64(source.issuedAtMs), source.nonce
  ]);
  const signature = sign(null, signingBytes, rtseKey);
  const notice = {
    pilotId: source.pilotId,
    systemH3: source.systemH3,
    controllingFactionId: source.controllingFactionId,
    issuedAtMs: source.issuedAtMs,
    nonce: source.nonce.toString('base64'),
    signature: signature.toString('base64')
  };
  const delivery = PenaltyDelivery.create({
    deliveryId: idFor('MINING_VIOLATION', source.pilotId, source.nonce),
    kind: PenaltyKind.PENALTY_KIND_MINING_VIOLATION,
    emittedAtMs: String(source.issuedAtMs),
    miningViolation: { ...notice, issuedAtMs: String(source.issuedAtMs), nonce: source.nonce, signature }
  });
  return { notice, delivery };
}

async function deliver(delivery, headers = internalRtseHeaders) {
  const response = await app.inject({
    method: 'POST',
    url: '/internal/v1/rtse/penalty-events',
    headers: { ...headers, 'content-type': 'application/x-protobuf' },
    payload: Buffer.from(PenaltyDelivery.encode(delivery).finish())
  });
  return { response, ack: response.statusCode === 200 ? PenaltyDeliveryAck.decode(raw(response)) : null };
}

describe('trusted RTSE penalty delivery', () => {
  test('settles once, returns a semantic duplicate after commit, and exposes the newer authority projection', async () => {
    const pilot = await newPilot('Delivery');
    const oldRevision = app.jwt.verify(pilot.token).authority_revision;
    assert.equal(oldRevision, 0);
    const { delivery, stationId } = customsPenalty(pilot);

    const first = await deliver(delivery);
    assert.equal(first.response.statusCode, 200, first.response.body);
    assert.equal(first.ack.status, PenaltyAckStatus.PENALTY_ACK_STATUS_APPLIED);
    assert.deepEqual(first.ack.proofHash, hash(delivery));
    assert.equal(first.ack.authorityRevision, '1');

    // This models a consumer crash after the settlement commit but before it consumes the HTTP ACK.
    const replay = await deliver(delivery);
    assert.equal(replay.ack.status, PenaltyAckStatus.PENALTY_ACK_STATUS_DUPLICATE);
    assert.equal(replay.ack.authorityRevision, '1');
    assert.equal(await app.prisma.customsSeizure.count({ where: { playerId: pilot.id } }), 1);
    assert.equal(await app.prisma.stationLockout.count({ where: { playerId: pilot.id } }), 1);
    assert.equal((await app.prisma.player.findUnique({ where: { id: pilot.id } })).authorityRevision, 1n);

    const authority = await app.inject({ method: 'GET', url: `/internal/v1/rtse/players/${pilot.id}/authority`, headers: internalRtseHeaders });
    assert.equal(authority.statusCode, 200, authority.body);
    const projection = EnforcementProjection.decode(raw(authority));
    assert.equal(projection.authorityRevision, '1');
    assert.equal(projection.lockouts[0].factionId, stationId);
    assert.ok(Number(projection.authorityRevision) > oldRevision, 'a token at the old revision is stale');

    const forbidden = await deliver(delivery, { authorization: `Bearer ${pilot.token}` });
    assert.equal(forbidden.response.statusCode, 401);
  });

  test('keeps the player relay compatible while sharing authority settlement and rejects forged private deliveries', async () => {
    const pilot = await newPilot('Relay');
    const { notice, delivery } = miningPenalty(pilot);

    const relay = await call(pilot, 'POST', '/game/factions/mining-violation', { notice });
    assert.equal(relay.statusCode, 200, relay.body);
    assert.equal(app.jwt.verify(json(relay).token).authority_revision, 1);
    assert.equal((await app.prisma.player.findUnique({ where: { id: pilot.id } })).authorityRevision, 1n);

    const duplicate = await deliver(delivery);
    assert.equal(duplicate.ack.status, PenaltyAckStatus.PENALTY_ACK_STATUS_DUPLICATE);
    assert.equal(await app.prisma.miningViolation.count({ where: { playerId: pilot.id } }), 1);

    const forged = PenaltyDelivery.create({ ...delivery, deliveryId: `${delivery.deliveryId}-forged` });
    const rejected = await deliver(forged);
    assert.equal(rejected.ack.status, PenaltyAckStatus.PENALTY_ACK_STATUS_REJECTED);
    assert.equal(await app.prisma.miningViolation.count({ where: { playerId: pilot.id } }), 1);
  });

  test('reports readiness only when database, claim key, and internal workload auth are available', async () => {
    const response = await app.inject({ method: 'GET', url: '/ready' });
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(json(response).checks, { database: true, claim_key: true, internal_workload_credential: true });
  });

  test('derives mining citation expiry from the signed issue time and never revives an expired violation', async () => {
    const pilot = await newPilot('DelayedCitation');
    const issuedAtMs = Date.now() - Math.floor(CUSTOMS_FLAG_MS / 3);
    const { delivery } = miningPenalty(pilot, { issuedAtMs });
    const settled = await deliver(delivery);
    assert.equal(settled.ack.status, PenaltyAckStatus.PENALTY_ACK_STATUS_APPLIED);

    const row = await app.prisma.miningViolation.findFirstOrThrow({ where: { playerId: pilot.id } });
    const player = await app.prisma.player.findUniqueOrThrow({ where: { id: pilot.id } });
    assert.equal(row.flaggedUntil.getTime(), issuedAtMs + CUSTOMS_FLAG_MS);
    assert.equal(player.customsFlaggedUntil.getTime(), issuedAtMs + CUSTOMS_FLAG_MS);

    const expiredPilot = await newPilot('ExpiredCitation');
    const expiredAtMs = Date.now() - CUSTOMS_FLAG_MS - 1_000;
    const expired = await deliver(miningPenalty(expiredPilot, { issuedAtMs: expiredAtMs }).delivery);
    assert.equal(expired.ack.status, PenaltyAckStatus.PENALTY_ACK_STATUS_APPLIED);
    const expiredPlayer = await app.prisma.player.findUniqueOrThrow({ where: { id: expiredPilot.id } });
    assert.equal(expiredPlayer.customsFlaggedUntil, null);
    assert.equal(expiredPlayer.customsFlaggedFactionId, null);
  });

  test('uses a permanent contract rejection reason when a valid seizure cannot be settled', async () => {
    const pilot = await newPilot('Uninspectable');
    const offer = signedOffer(pilot);
    const accepted = await call(pilot, 'POST', '/game/missions/accept', { offer, dockedReceipt: receiptAtOrigin(pilot, offer) });
    assert.equal(accepted.statusCode, 200, accepted.body);

    const rejected = await deliver(customsPenalty(pilot, { missionId: offer.mission_id }).delivery);
    assert.equal(rejected.ack.status, PenaltyAckStatus.PENALTY_ACK_STATUS_REJECTED);
    assert.equal(rejected.ack.rejectionReason, PenaltyRejectionReason.PENALTY_REJECTION_REASON_KIND_PROOF_MISMATCH);
  });

  test('permanently rejects a signed penalty with a non-UUID pilot id before database settlement', async () => {
    const rejected = await deliver(miningPenalty({ id: 'not-a-uuid' }).delivery);
    assert.equal(rejected.ack.status, PenaltyAckStatus.PENALTY_ACK_STATUS_REJECTED);
    assert.equal(rejected.ack.rejectionReason, PenaltyRejectionReason.PENALTY_REJECTION_REASON_INVALID_SOURCE_PROOF);
  });

  test('returns not found rather than a server error for a non-UUID authority lookup', async () => {
    const response = await app.inject({
      method: 'GET', url: '/internal/v1/rtse/players/not-a-uuid/authority', headers: internalRtseHeaders
    });
    assert.equal(response.statusCode, 404, response.body);
    assert.equal(json(response).error, 'PILOT_NOT_FOUND');
  });
});
