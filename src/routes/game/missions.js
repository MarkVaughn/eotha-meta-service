import { isDeepStrictEqual } from 'node:util';
import { computeShipAttributes } from '../../config/components.js';
import {
  H3_PATTERN,
  STATION_PATTERN,
  MISSION_COOLDOWN_MS,
  MAX_REWARD_CREDITS,
  isSystemCell,
  parseMissionId,
  buildOffer,
  currentEpoch,
  generateOffers
} from '../../config/missions.js';
import { loadRtsePublicKey, verifyClaimSignature } from '../../lib/mission-claim.js';

const availableSchema = {
  querystring: {
    type: 'object',
    required: ['stationId', 'systemH3'],
    properties: {
      stationId: { type: 'string', pattern: STATION_PATTERN },
      systemH3: { type: 'string', pattern: H3_PATTERN }
    }
  }
};

const acceptSchema = {
  body: {
    type: 'object',
    required: ['missionId', 'offer'],
    properties: {
      missionId: { type: 'string', minLength: 1, maxLength: 256 },
      offer: { type: 'object' }
    }
  }
};

// Speed bonuses may raise a payout to at most 125% of the offered reward.
const MAX_BONUS_MULTIPLIER = 1.25;
// Tolerated RTSE/meta clock skew for completion timestamps.
const MAX_FUTURE_SKEW_MS = 60_000;
const OVERFLOW = Symbol('credit-overflow');

const uint = { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER };

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
          reputationChange: { type: 'integer', minimum: -2147483648, maximum: 2147483647 },
          signature: { type: 'string', minLength: 1, maxLength: 512 }
        }
      }
    }
  }
};

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

export default async function missionsRoutes(fastify, opts) {
  const prisma = fastify.prisma;
  const rtsePublicKey = opts.rtsePublicKey ?? loadRtsePublicKey();
  if (!rtsePublicKey) {
    fastify.log.warn('⚠️ keys/public.pem not found; mission completion claims will be rejected.');
  }

  fastify.addHook('onRequest', fastify.authenticate);

  async function getPassengerCapacity(request) {
    const ship = await prisma.spaceship.findFirst({
      where: { playerId: request.user.sub, active: true },
      orderBy: { createdAt: 'asc' },
      include: { components: true }
    });
    // A pilot with no ship row yet flies the Tier 1 default ship, as in the login token.
    return computeShipAttributes(ship?.components ?? []).passenger_capacity ?? 0;
  }

  async function cooldownRemainingMs(request, stationId) {
    const playerId = request.user.sub;
    const row = await prisma.missionCooldown.findUnique({
      where: { playerId_originStationId: { playerId, originStationId: stationId } }
    });
    const completedAt = row?.completedAt.getTime();
    if (completedAt == null) return 0;
    return Math.max(0, completedAt + MISSION_COOLDOWN_MS - Date.now());
  }

  async function getActive(request) {
    const playerId = request.user.sub;
    const row = await prisma.playerMission.findUnique({ where: { playerId } });
    return row ? toActiveMission(playerId, row.offer, row.acceptedAt) : null;
  }

  async function alreadyCompleted(request, missionId) {
    const playerId = request.user.sub;
    return (await prisma.completedMission.findUnique({
      where: { playerId_missionId: { playerId, missionId } }
    })) !== null;
  }

  const conflict = (reply, error) => reply.code(409).send({ error });

  fastify.get('/missions/available', { schema: availableSchema }, async (request, reply) => {
    const { stationId, systemH3 } = request.query;
    if (!isSystemCell(systemH3)) {
      return reply.code(400).send({ error: 'systemH3 must be a valid H3 resolution 8 cell.' });
    }

    const passengerCapacity = await getPassengerCapacity(request);
    const remainingMs = await cooldownRemainingMs(request, stationId);
    const cooldown = remainingMs > 0
      ? { active: true, remaining_ms: remainingMs, available_at_ms: Date.now() + remainingMs }
      : { active: false, remaining_ms: 0, available_at_ms: 0 };

    const offers = cooldown.active ? [] : generateOffers({ stationId, systemH3, passengerCapacity });
    return { offers, cooldown, passenger_capacity: passengerCapacity };
  });

  fastify.post('/missions/accept', { schema: acceptSchema }, async (request, reply) => {
    const playerId = request.user.sub;
    const { missionId, offer } = request.body;

    if (await getActive(request)) {
      return conflict(reply, 'A mission is already active. Complete or abandon it first.');
    }

    // Offers are client-presented but never trusted: the id must decode to a
    // current-epoch slot, and the presented offer must equal what we derive from it.
    const parsed = parseMissionId(missionId);
    if (!parsed || parsed.epoch > currentEpoch()) {
      return reply.code(400).send({ error: 'Invalid missionId.' });
    }
    const authoritative = buildOffer(parsed);
    if (!isDeepStrictEqual(JSON.parse(JSON.stringify(offer)), authoritative)) {
      return reply.code(400).send({ error: 'Offer does not match the authoritative mission.' });
    }
    if (Date.now() > authoritative.expires_at_ms) {
      return reply.code(410).send({ error: 'Offer has expired.' });
    }

    const capacity = Math.floor(await getPassengerCapacity(request));
    if (authoritative.required_berths > capacity) {
      return reply.code(400).send({ error: 'Ship has insufficient passenger berths for this mission.' });
    }
    if (await cooldownRemainingMs(request, authoritative.origin_station_id) > 0) {
      return conflict(reply, 'Station is on cooldown.');
    }
    if (await alreadyCompleted(request, authoritative.mission_id)) {
      return conflict(reply, 'Mission has already been completed.');
    }

    const acceptedAt = new Date();
    try {
      await prisma.playerMission.create({
        data: {
          playerId,
          missionId: authoritative.mission_id,
          originStationId: authoritative.origin_station_id,
          offer: authoritative,
          acceptedAt
        }
      });
    } catch (err) {
      // Lost a race with a concurrent accept (unique(playerId)).
      if (err?.code === 'P2002') return conflict(reply, 'A mission is already active. Complete or abandon it first.');
      throw err;
    }
    return toActiveMission(playerId, authoritative, acceptedAt);
  });

  fastify.get('/missions/active', async (request) => ({ active: await getActive(request) }));

  fastify.post('/missions/abandon', async (request, reply) => {
    const playerId = request.user.sub;
    const active = await getActive(request);
    if (!active) return reply.code(404).send({ error: 'No active mission to abandon.' });
    // No payout and no cooldown.
    await prisma.playerMission.deleteMany({ where: { playerId } });
    return { abandoned: true, mission_id: active.mission_id };
  });

  // Returns the new credit balance, null if the mission was already settled, or
  // OVERFLOW (mission left active, nothing changed) if the payout would overflow credits.
  async function settle(request, active, claim) {
    const playerId = request.user.sub;
    const stationId = active.offer.origin_station_id;
    const missionId = active.mission_id;

    try {
      return await prisma.$transaction(async (tx) => {
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
        return player.credits;
      });
    } catch (err) {
      if (err === OVERFLOW) return OVERFLOW;
      if (err?.code === 'P2002') return null; // payout for this (player, mission) already recorded
      throw err;
    }
  }

  fastify.post('/missions/complete', { schema: completeSchema }, async (request, reply) => {
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

    // 4. Canonical Ed25519 signature by the RTSE.
    if (!verifyClaimSignature(claim, rtsePublicKey)) {
      return reply.code(403).send({ error: 'Invalid claim signature.' });
    }

    // 5. Atomic settlement.
    const credits = await settle(request, active, claim);
    if (credits === OVERFLOW) return conflict(reply, 'Payout would overflow the credit balance.');
    if (credits === null) return conflict(reply, 'Mission has already been completed.');
    return { success: true, credits, payout: claim.rewardCredits };
  });
}
