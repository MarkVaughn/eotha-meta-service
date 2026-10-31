import { createHash } from 'node:crypto';
import { MAX_SEIZURE_FUTURE_SKEW_MS } from '../../config/customs.js';
import { MINING_VIOLATION_MAX_FUTURE_SKEW_MS } from '../../config/regulation.js';
import { verifyCustomsSeizure } from '../../lib/customs-seizure.js';
import {
  EnforcementProjection,
  PenaltyAckStatus,
  PenaltyDelivery,
  PenaltyDeliveryAck,
  PenaltyKind,
  PenaltyRejectionReason
} from '../../lib/contracts/penalty.js';
import { buildEnforcementProjection } from '../../lib/enforcement-projection.js';
import { verifyMiningViolation } from '../../lib/mining-violation.js';
import { settleCustomsSeizure, settleMiningViolation } from '../../lib/penalty-settlement.js';

const PROTOBUF_CONTENT_TYPE = 'application/x-protobuf';
const asSafeUnixMs = (value) => {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
};

const uuidFromBytes = (value) => {
  if (!Buffer.isBuffer(value) || value.length !== 16) return null;
  const hex = value.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

// Hash the wire bytes received from the workload, rather than a decoded/re-encoded equivalent. That
// binds an ACK to this exact envelope even if a future producer adds an unknown protobuf field.
const deliveryHash = (wireBytes) => createHash('sha256').update(wireBytes).digest();

function reject(delivery, proofHash, rejectionReason) {
  return {
    deliveryId: delivery?.deliveryId ?? '',
    proofHash,
    status: PenaltyAckStatus.PENALTY_ACK_STATUS_REJECTED,
    authorityRevision: '0',
    rejectionReason,
    retryAfterMs: '0'
  };
}

function retry(delivery, proofHash, retryAfterMs = 1_000) {
  return {
    deliveryId: delivery?.deliveryId ?? '',
    proofHash,
    status: PenaltyAckStatus.PENALTY_ACK_STATUS_RETRYABLE,
    authorityRevision: '0',
    rejectionReason: PenaltyRejectionReason.PENALTY_REJECTION_REASON_UNSPECIFIED,
    retryAfterMs: String(retryAfterMs)
  };
}

function sendAck(reply, ack) {
  return reply.type(PROTOBUF_CONTENT_TYPE).send(Buffer.from(PenaltyDeliveryAck.encode(ack).finish()));
}

function deliveryId(kind, pilotId, nonce) {
  const name = kind === PenaltyKind.PENALTY_KIND_CUSTOMS_SEIZURE ? 'CUSTOMS_SEIZURE' : 'MINING_VIOLATION';
  return `${name}:${pilotId}:${nonce.toString('hex')}`;
}

function validateDelivery(delivery, claimKey, nowMs) {
  const proofCount = Number(Boolean(delivery.customsSeizure)) + Number(Boolean(delivery.miningViolation));
  if (proofCount !== 1) return { rejectionReason: PenaltyRejectionReason.PENALTY_REJECTION_REASON_MALFORMED_ENVELOPE };
  const customs = delivery.customsSeizure;
  const mining = delivery.miningViolation;
  if (![PenaltyKind.PENALTY_KIND_CUSTOMS_SEIZURE, PenaltyKind.PENALTY_KIND_MINING_VIOLATION].includes(delivery.kind)) {
    return { rejectionReason: PenaltyRejectionReason.PENALTY_REJECTION_REASON_UNSUPPORTED_KIND };
  }
  if ((delivery.kind === PenaltyKind.PENALTY_KIND_CUSTOMS_SEIZURE && !customs)
      || (delivery.kind === PenaltyKind.PENALTY_KIND_MINING_VIOLATION && !mining)) {
    return { rejectionReason: PenaltyRejectionReason.PENALTY_REJECTION_REASON_KIND_PROOF_MISMATCH };
  }

  const proof = customs ?? mining;
  const nonce = Buffer.from(proof.nonce);
  if (!proof.pilotId || nonce.length !== 16) {
    return { rejectionReason: PenaltyRejectionReason.PENALTY_REJECTION_REASON_INVALID_SOURCE_PROOF };
  }
  if (delivery.deliveryId !== deliveryId(delivery.kind, proof.pilotId, nonce)) {
    return { rejectionReason: PenaltyRejectionReason.PENALTY_REJECTION_REASON_DELIVERY_ID_MISMATCH };
  }

  if (customs) {
    const seizedAtMs = asSafeUnixMs(customs.seizedAtMs);
    const stationEntityId = uuidFromBytes(customs.stationEntityId);
    if (seizedAtMs === null || !stationEntityId) {
      return { rejectionReason: PenaltyRejectionReason.PENALTY_REJECTION_REASON_INVALID_SOURCE_PROOF };
    }
    const claim = {
      pilotId: customs.pilotId,
      stationEntityId,
      systemH3: customs.systemH3,
      controllingFactionId: customs.controllingFactionId,
      missionId: customs.missionId,
      inspectionOutcome: customs.inspectionOutcome,
      captureTier: customs.captureTier,
      exposureScoreMilli: customs.exposureScoreMilli,
      seizedAtMs,
      nonce: nonce.toString('base64'),
      signature: Buffer.from(customs.signature).toString('base64')
    };
    if (seizedAtMs > nowMs + MAX_SEIZURE_FUTURE_SKEW_MS || !verifyCustomsSeizure(claim, claimKey)) {
      return { rejectionReason: PenaltyRejectionReason.PENALTY_REJECTION_REASON_INVALID_SOURCE_PROOF };
    }
    return { kind: 'customs', playerId: claim.pilotId, claim };
  }

  const issuedAtMs = asSafeUnixMs(mining.issuedAtMs);
  if (issuedAtMs === null) return { rejectionReason: PenaltyRejectionReason.PENALTY_REJECTION_REASON_INVALID_SOURCE_PROOF };
  const notice = {
    pilotId: mining.pilotId,
    systemH3: mining.systemH3,
    controllingFactionId: mining.controllingFactionId,
    issuedAtMs,
    nonce: nonce.toString('base64'),
    signature: Buffer.from(mining.signature).toString('base64')
  };
  if (issuedAtMs > nowMs + MINING_VIOLATION_MAX_FUTURE_SKEW_MS || !verifyMiningViolation(notice, claimKey)) {
    return { rejectionReason: PenaltyRejectionReason.PENALTY_REJECTION_REASON_INVALID_SOURCE_PROOF };
  }
  return { kind: 'mining', playerId: notice.pilotId, notice };
}

export default async function rtseInternalRoutes(fastify) {
  // Workload identity deliberately runs before protobuf decoding or source-proof verification.
  fastify.addHook('onRequest', fastify.authenticateRtseWorkload);

  fastify.post('/penalty-events', async (request, reply) => {
    if (!Buffer.isBuffer(request.body)) {
      return sendAck(reply, reject(null, Buffer.alloc(0), PenaltyRejectionReason.PENALTY_REJECTION_REASON_MALFORMED_ENVELOPE));
    }
    let delivery;
    try {
      delivery = PenaltyDelivery.decode(request.body);
    } catch {
      return sendAck(reply, reject(null, createHash('sha256').update(request.body).digest(), PenaltyRejectionReason.PENALTY_REJECTION_REASON_MALFORMED_ENVELOPE));
    }
    const proofHash = deliveryHash(request.body);
    if (!fastify.claimKey) return sendAck(reply, retry(delivery, proofHash));

    const checked = validateDelivery(delivery, fastify.claimKey.key, Date.now());
    if (checked.rejectionReason) return sendAck(reply, reject(delivery, proofHash, checked.rejectionReason));

    try {
      const outcome = checked.kind === 'customs'
        ? await settleCustomsSeizure({ prisma: fastify.prisma, fastify, playerId: checked.playerId, claim: checked.claim })
        : await settleMiningViolation({ prisma: fastify.prisma, fastify, playerId: checked.playerId, notice: checked.notice });
      if (outcome.failure) {
        return sendAck(reply, reject(delivery, proofHash, PenaltyRejectionReason.PENALTY_REJECTION_REASON_INVALID_SOURCE_PROOF));
      }
      return sendAck(reply, {
        deliveryId: delivery.deliveryId,
        proofHash,
        status: outcome.replayed ? PenaltyAckStatus.PENALTY_ACK_STATUS_DUPLICATE : PenaltyAckStatus.PENALTY_ACK_STATUS_APPLIED,
        authorityRevision: outcome.authorityRevision.toString(),
        projection: outcome.projection,
        rejectionReason: PenaltyRejectionReason.PENALTY_REJECTION_REASON_UNSPECIFIED,
        retryAfterMs: '0'
      });
    } catch (err) {
      request.log.error(err, 'Penalty delivery settlement failed before commit.');
      return sendAck(reply, retry(delivery, proofHash));
    }
  });

  fastify.get('/players/:pilotId/authority', {
    schema: { params: { type: 'object', required: ['pilotId'], properties: { pilotId: { type: 'string', minLength: 1, maxLength: 256 } } } }
  }, async (request, reply) => {
    const projection = await buildEnforcementProjection(fastify.prisma, request.params.pilotId);
    if (!projection) return reply.code(404).send({ error: 'PILOT_NOT_FOUND' });
    const signedProjection = fastify.signEnforcementProjection(projection);
    return reply.type(PROTOBUF_CONTENT_TYPE).send(Buffer.from(
      // The endpoint returns the exact contract message rather than a JSON projection lookalike.
      EnforcementProjection.encode(signedProjection).finish()
    ));
  });
}
