import { computeShipAttributes } from '../../config/components.js';
import { MAX_OFFER_FUTURE_SKEW_MS, MAX_REWARD_CREDITS, MISSION_COOLDOWN_MS } from '../../config/missions.js';
import { H3_PATTERN, UUID_PATTERN } from '../../config/patterns.js';
import {
  DOCKED_ENTITY_ID_PATTERN,
  SIGNATURE_B64_PATTERN,
  dockedReceiptRefusal,
  dockedReceiptSchema
} from '../../lib/docked-receipt.js';
import { verifyClaimSignature } from '../../lib/mission-claim.js';
import { MISSION_TYPES, verifyMissionOffer } from '../../lib/mission-offer.js';
import { lockActiveShip, reissueToken, toLoadout } from '../../lib/ship.js';

const uint = { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
const uint32 = { type: 'integer', minimum: 0, maximum: 4_294_967_295 };
const int32 = { type: 'integer', minimum: -2147483648, maximum: 2147483647 };
const text = (maxLength) => ({ type: 'string', maxLength, default: '' });

const cooldownSchema = {
  querystring: {
    type: 'object',
    required: ['originId'],
    properties: { originId: { type: 'string', pattern: DOCKED_ENTITY_ID_PATTERN } }
  }
};

// A `MissionOffer` (eotha-contracts `rtse/v1/mission.proto`) as proto-JSON, signed by the engine.
// Proto-JSON may omit a field holding its zero value (a survey's `required_berths`, say), so those
// default to it; the fields no genuine offer leaves at zero are required. Unknown fields are
// dropped, so only what the engine signed is ever stored.
const offerSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['mission_id', 'type', 'origin_station_id', 'origin_system_h3', 'offered_at_ms', 'expires_at_ms', 'pilot_id', 'signature'],
  properties: {
    mission_id: { type: 'string', pattern: UUID_PATTERN.source },
    type: { type: 'string', enum: Object.keys(MISSION_TYPES) },
    title: text(512),
    description: text(4096),
    origin_station_id: { type: 'string', pattern: DOCKED_ENTITY_ID_PATTERN },
    origin_system_h3: { type: 'string', pattern: H3_PATTERN },
    destination_station_id: text(256),
    destination_system_h3: text(256),
    destination_node_h3: text(256),
    destination_lat: { type: 'number', default: 0 },
    destination_lng: { type: 'number', default: 0 },
    distance_hexes: { ...uint32, default: 0 },
    required_berths: { ...uint32, default: 0 },
    duration_limit_ms: { ...uint, default: 0 },
    reward_credits: { type: 'integer', minimum: 0, maximum: MAX_REWARD_CREDITS, default: 0 },
    reputation_change: { ...int32, default: 0 },
    faction_id: text(256),
    expires_at_ms: uint,
    offered_at_ms: uint,
    pilot_id: { type: 'string', minLength: 1, maxLength: 256 },
    signature: { type: 'string', pattern: SIGNATURE_B64_PATTERN }
  }
};

// `dockedReceipt` is optional here on purpose: the route answers its absence with the coded 403
// `docked_receipt_required` rather than a generic schema 400.
const acceptSchema = {
  body: {
    type: 'object',
    required: ['offer'],
    properties: { offer: offerSchema, dockedReceipt: dockedReceiptSchema }
  }
};

// Speed bonuses may raise a payout to at most 125% of the offered reward.
const MAX_BONUS_MULTIPLIER = 1.25;
// Tolerated RTSE/meta clock skew for completion timestamps.
const MAX_FUTURE_SKEW_MS = 60_000;
const OVERFLOW = Symbol('credit-overflow');

const completeSchema = {
  body: {
    type: 'object',
    required: ['claim'],
    properties: {
      claim: {
        type: 'object',
        required: [
          'missionId', 'playerShipId', 'destinationStationId', 'acceptedAtMs', 'completedAtMs',
          'durationTakenMs', 'rewardCredits', 'reputationChange', 'signature'
        ],
        properties: {
          missionId: { type: 'string', minLength: 1, maxLength: 256 },
          playerShipId: { type: 'string', minLength: 1, maxLength: 256 },
          destinationStationId: { type: 'string', minLength: 1, maxLength: 256 },
          acceptedAtMs: uint,
          completedAtMs: uint,
          durationTakenMs: uint,
          rewardCredits: { type: 'integer', minimum: 0, maximum: MAX_REWARD_CREDITS },
          reputationChange: int32,
          signature: { type: 'string', minLength: 1, maxLength: 512 }
        }
      }
    }
  }
};

// The JSON column does not keep every double exactly (it moved four in five destination
// coordinates by an ulp), and the offer's signature covers the coordinates' exact bits, so they
// are stored as text beside the offer and restored on the way out.
const toStoredOffer = (offer) => ({
  ...offer,
  exact_destination: [String(offer.destination_lat), String(offer.destination_lng)]
});

function fromStoredOffer(stored) {
  const { exact_destination: exact, ...offer } = stored;
  if (Array.isArray(exact)) {
    offer.destination_lat = Number(exact[0]);
    offer.destination_lng = Number(exact[1]);
  }
  return offer;
}

const LEGACY_MESSAGE = 'Your previous mission was cancelled because the mission format changed. Nothing was charged; accept a new mission.';

// A mission stored before offers were signed by the engine (legacy id, no exact coordinates, or no
// signature) can never be claimed: the engine would not recognise its offer. It is removed on first
// sight, so the pilot can take a fresh offer; accepting it charged nothing and boarded no one, so
// there is nothing to refund or unboard.
const isLegacyRow = (row) =>
  !UUID_PATTERN.test(row.missionId)
  || !Array.isArray(row.offer?.exact_destination)
  || row.offer.exact_destination.length !== 2
  || typeof row.offer.signature !== 'string';

// Proto-JSON ActiveMission for a stored row.
function toActiveMission(playerId, offer, acceptedAt) {
  const acceptedAtMs = acceptedAt.getTime();
  return {
    mission_id: offer.mission_id,
    player_ship_id: playerId,
    offer,
    accepted_at_ms: acceptedAtMs,
    deadline_ms: acceptedAtMs + offer.duration_limit_ms,
    is_completed: false
  };
}

// Passengers the ship carries once a mission's `berths` disembark (never below zero).
const unboarded = (ship, berths) => Math.max(0, ship.passengersAboard - berths);

export default async function missionsRoutes(fastify) {
  const prisma = fastify.prisma;
  fastify.addHook('onRequest', fastify.authenticate);

  // `db` is the Prisma client or an open transaction.
  async function cooldownRemainingMs(db, playerId, stationId, nowMs) {
    const row = await db.missionCooldown.findUnique({
      where: { playerId_originStationId: { playerId, originStationId: stationId } }
    });
    const completedAt = row?.completedAt.getTime();
    if (completedAt == null) return 0;
    return Math.max(0, completedAt + MISSION_COOLDOWN_MS - nowMs);
  }

  async function loadActive(request) {
    const playerId = request.user.sub;
    const row = await prisma.playerMission.findUnique({ where: { playerId } });
    if (!row) return { active: null };
    if (isLegacyRow(row)) {
      await prisma.playerMission.deleteMany({ where: { id: row.id } });
      return { active: null, cancelled: { mission_id: row.missionId, reason: 'format_changed', message: LEGACY_MESSAGE } };
    }
    return { active: toActiveMission(playerId, fromStoredOffer(row.offer), row.acceptedAt) };
  }

  const getActive = async (request) => (await loadActive(request)).active;

  const fail = (status, error, extra = {}) => ({ failure: { status, body: { error, ...extra } } });
  const conflict = (reply, error) => reply.code(409).send({ error });

  // The reissued token carrying the ship's new passenger count.
  const tokenFor = (request, ship, passengersAboard) =>
    reissueToken(fastify, request, toLoadout(ship.id, ship.components, passengersAboard).ship_attributes);

  fastify.get('/missions/cooldown', { schema: cooldownSchema }, async (request) => {
    const nowMs = Date.now();
    const remainingMs = await cooldownRemainingMs(prisma, request.user.sub, request.query.originId, nowMs);
    return remainingMs > 0
      ? { active: true, remaining_ms: remainingMs, available_at_ms: nowMs + remainingMs }
      : { active: false, remaining_ms: 0, available_at_ms: 0 };
  });

  fastify.post('/missions/accept', { schema: acceptSchema, preHandler: fastify.requireClaimKey }, async (request, reply) => {
    const playerId = request.user.sub;
    const { offer, dockedReceipt } = request.body;
    const nowMs = Date.now();

    // Stateless checks first, so a refusal changes nothing.
    // 1. The engine made this offer, to this pilot. Every field is signed, so nothing in it is the client's.
    if (offer.pilot_id !== playerId || !verifyMissionOffer(offer, fastify.claimKey.key)) {
      return reply.code(403).send({ error: 'The mission offer is not valid for this pilot.', code: 'mission_offer_invalid' });
    }
    // 2. The offer is current.
    if (offer.offered_at_ms > nowMs + MAX_OFFER_FUTURE_SKEW_MS || nowMs > offer.expires_at_ms) {
      return reply.code(410).send({ error: 'The mission offer has expired.', code: 'mission_offer_expired' });
    }
    // 3. The pilot is docked at the offer's origin right now, as the engine vouches.
    if (!dockedReceipt) {
      return reply.code(403).send({
        error: 'Accepting a mission requires a docked receipt from the engine.',
        code: 'docked_receipt_required'
      });
    }
    const refusal = dockedReceiptRefusal(dockedReceipt, {
      pilotId: playerId,
      publicKey: fastify.claimKey.key,
      nowMs,
      log: request.log
    });
    if (refusal) return reply.code(403).send(refusal);
    if (dockedReceipt.dockedEntityId !== offer.origin_station_id || dockedReceipt.systemH3 !== offer.origin_system_h3) {
      return reply.code(403).send({ error: 'Missions can only be accepted while docked where they are offered.', code: 'not_docked_at_origin' });
    }

    // Never earlier than the offer was made: the engine refuses the claim otherwise.
    const acceptedAt = new Date(Math.max(nowMs, offer.offered_at_ms));

    // The player rules, the mission and the boarding commit or roll back together.
    const outcome = await prisma.$transaction(async (tx) => {
      const ship = await lockActiveShip(tx, request.user);
      const current = await tx.playerMission.findUnique({ where: { playerId } });
      if (current && !isLegacyRow(current)) {
        return fail(409, 'A mission is already active. Complete or abandon it first.', { code: 'mission_active' });
      }
      const remainingMs = await cooldownRemainingMs(tx, playerId, offer.origin_station_id, nowMs);
      if (remainingMs > 0) return fail(409, 'Station is on cooldown.', { code: 'origin_on_cooldown', remaining_ms: remainingMs });
      const completed = await tx.completedMission.findUnique({
        where: { playerId_missionId: { playerId, missionId: offer.mission_id } }
      });
      if (completed) return fail(409, 'Mission has already been completed.', { code: 'mission_already_completed' });

      const { passenger_capacity: capacity, passengers_aboard: aboard } = computeShipAttributes(ship.components, ship.passengersAboard);
      const freeBerths = Math.max(0, Math.floor(capacity) - aboard);
      if (offer.required_berths > freeBerths) {
        return fail(400, 'Ship has insufficient free passenger berths for this mission.', {
          code: 'insufficient_berths',
          available_berths: freeBerths
        });
      }

      if (current) await tx.playerMission.delete({ where: { id: current.id } });
      await tx.playerMission.create({
        data: {
          playerId,
          missionId: offer.mission_id,
          originStationId: offer.origin_station_id,
          offer: toStoredOffer(offer),
          acceptedAt
        }
      });
      const passengersAboard = aboard + offer.required_berths;
      await tx.spaceship.update({ where: { id: ship.id }, data: { passengersAboard } });
      return { ship, passengersAboard };
    });

    if (outcome.failure) return reply.code(outcome.failure.status).send(outcome.failure.body);
    return { active: toActiveMission(playerId, offer, acceptedAt), token: tokenFor(request, outcome.ship, outcome.passengersAboard) };
  });

  fastify.get('/missions/active', async (request) => {
    const { active, cancelled } = await loadActive(request);
    return cancelled ? { active, cancelled_mission: cancelled } : { active };
  });

  fastify.post('/missions/abandon', async (request, reply) => {
    const playerId = request.user.sub;
    // No payout and no cooldown; the mission's passengers disembark wherever the ship is.
    const outcome = await prisma.$transaction(async (tx) => {
      const ship = await lockActiveShip(tx, request.user);
      const row = await tx.playerMission.findUnique({ where: { playerId } });
      if (!row) return null;
      await tx.playerMission.delete({ where: { id: row.id } });
      if (isLegacyRow(row)) return null;
      const passengersAboard = unboarded(ship, row.offer.required_berths);
      await tx.spaceship.update({ where: { id: ship.id }, data: { passengersAboard } });
      return { ship, passengersAboard, missionId: row.missionId };
    });
    if (!outcome) return reply.code(404).send({ error: 'No active mission to abandon.' });
    return { abandoned: true, mission_id: outcome.missionId, token: tokenFor(request, outcome.ship, outcome.passengersAboard) };
  });

  // Returns `{ credits, ship, passengersAboard }`, null if the mission was already settled, or
  // OVERFLOW (mission left active, nothing changed) if the payout would overflow credits.
  async function settle(request, active, claim) {
    const playerId = request.user.sub;
    const stationId = active.offer.origin_station_id;
    const missionId = active.mission_id;

    try {
      return await prisma.$transaction(async (tx) => {
        const ship = await lockActiveShip(tx, request.user);
        const { count } = await tx.playerMission.deleteMany({ where: { playerId, missionId } });
        if (count !== 1) return null;
        await tx.completedMission.create({ data: { playerId, missionId, rewardCredits: claim.rewardCredits } });
        // Guarded increment; throwing rolls back the mission delete and payout record.
        const { count: credited } = await tx.player.updateMany({
          where: { id: playerId, credits: { lte: MAX_REWARD_CREDITS - claim.rewardCredits } },
          data: { credits: { increment: claim.rewardCredits } }
        });
        if (credited !== 1) throw OVERFLOW;
        const player = await tx.player.findUnique({ where: { id: playerId }, select: { credits: true } });
        await tx.missionCooldown.upsert({
          where: { playerId_originStationId: { playerId, originStationId: stationId } },
          update: { completedAt: new Date() },
          create: { playerId, originStationId: stationId }
        });
        const passengersAboard = unboarded(ship, active.offer.required_berths);
        await tx.spaceship.update({ where: { id: ship.id }, data: { passengersAboard } });
        return { credits: player.credits, ship, passengersAboard };
      });
    } catch (err) {
      if (err === OVERFLOW) return OVERFLOW;
      if (err?.code === 'P2002') return null; // payout for this (player, mission) already recorded
      throw err;
    }
  }

  fastify.post('/missions/complete', { schema: completeSchema, preHandler: fastify.requireClaimKey }, async (request, reply) => {
    const { claim } = request.body;

    // 1. The claim must be for the authenticated pilot's ship.
    if (request.user.sub !== claim.playerShipId) {
      return reply.code(403).send({ error: 'Claim does not belong to the authenticated pilot.' });
    }

    // 2. The pilot must hold exactly this mission, accepted at the time the RTSE saw.
    const active = await getActive(request);
    if (!active || active.mission_id !== claim.missionId) {
      return reply.code(404).send({ error: 'No matching active mission.' });
    }
    if (claim.acceptedAtMs !== active.accepted_at_ms
        || claim.destinationStationId !== active.offer.destination_station_id
        || claim.durationTakenMs !== claim.completedAtMs - claim.acceptedAtMs) {
      return reply.code(400).send({ error: 'Claim does not match the active mission.' });
    }

    // 3. Deadline.
    if (claim.completedAtMs < claim.acceptedAtMs || claim.completedAtMs > active.deadline_ms) {
      return reply.code(400).send({ error: 'Claim completed outside the mission window.' });
    }

    if (claim.completedAtMs > Date.now() + MAX_FUTURE_SKEW_MS) {
      return reply.code(400).send({ error: 'Claim completion time is in the future.' });
    }
    if (claim.rewardCredits > Math.floor(active.offer.reward_credits * MAX_BONUS_MULTIPLIER)) {
      return reply.code(400).send({ error: 'Claim reward exceeds the maximum speed bonus.' });
    }

    // 4. Canonical Ed25519 signature by the engine's claim key.
    if (!verifyClaimSignature(claim, fastify.claimKey.key)) {
      return reply.code(403).send({ error: 'Invalid claim signature.' });
    }

    // 5. Atomic settlement: payout, cooldown, and the passengers disembark.
    const settled = await settle(request, active, claim);
    if (settled === OVERFLOW) return conflict(reply, 'Payout would overflow the credit balance.');
    if (settled === null) return conflict(reply, 'Mission has already been completed.');
    return {
      success: true,
      credits: settled.credits,
      payout: claim.rewardCredits,
      token: tokenFor(request, settled.ship, settled.passengersAboard)
    };
  });
}
