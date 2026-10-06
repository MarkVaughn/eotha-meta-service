import { computeShipAttributes } from '../../config/components.js';
import {
  H3_PATTERN,
  STATION_PATTERN,
  MISSION_COOLDOWN_MS,
  MAX_REWARD_CREDITS,
  isStationOf,
  isSystemCell,
  authenticateOffer,
  UUID_PATTERN,
  generateOffers
} from '../../config/missions.js';
import { verifyClaimSignature } from '../../lib/mission-claim.js';

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

// The JSON column does not keep every double exactly (it moved four in five destination
// coordinates by an ulp), and the RTSE compares the coordinates of an offer for exact equality,
// so they are stored as text beside the offer and restored on the way out.
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

export default async function missionsRoutes(fastify) {
  const prisma = fastify.prisma;
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

  // A mission stored before offers followed the engine (legacy id, no exact coordinates) can never
  // be claimed: the engine would reject its offer as tampered. It is removed on first sight, so
  // the pilot can take a fresh offer; accepting charged nothing, so there is nothing to refund.
  const isLegacyRow = (row) =>
    !UUID_PATTERN.test(row.missionId) || !Array.isArray(row.offer?.exact_destination) || row.offer.exact_destination.length !== 2;

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
    // Offers are the engine's, and it knows stations only by their id in the system they sit in.
    if (!isStationOf(systemH3, stationId)) {
      return reply.code(400).send({ error: 'stationId must be the id of a station in systemH3.' });
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

    // Offers are client-presented but never trusted: the presented offer must equal what this
    // service derives for the window it names, for a ship with this many berths.
    const capacity = Math.floor(await getPassengerCapacity(request));
    if (offer.required_berths > capacity) {
      return reply.code(400).send({ error: 'Ship has insufficient passenger berths for this mission.' });
    }
    const verdict = missionId === offer.mission_id ? authenticateOffer(offer, { availableBerths: capacity }) : null;
    if (!verdict) {
      return reply.code(400).send({ error: 'Offer does not match the authoritative mission.' });
    }
    const authoritative = verdict.offer;
    if (verdict.expired) {
      return reply.code(410).send({ error: 'Offer has expired.' });
    }
    if (await cooldownRemainingMs(request, authoritative.origin_station_id) > 0) {
      return conflict(reply, 'Station is on cooldown.');
    }
    if (await alreadyCompleted(request, authoritative.mission_id)) {
      return conflict(reply, 'Mission has already been completed.');
    }

    // Never earlier than the offer was made (see authenticateOffer): the engine refuses the claim otherwise.
    const acceptedAt = new Date(Math.max(Date.now(), verdict.offeredAtMs));
    try {
      await prisma.playerMission.create({
        data: {
          playerId,
          missionId: authoritative.mission_id,
          originStationId: authoritative.origin_station_id,
          offer: toStoredOffer(authoritative),
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

  fastify.get('/missions/active', async (request) => {
    const { active, cancelled } = await loadActive(request);
    return cancelled ? { active, cancelled_mission: cancelled } : { active };
  });

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

    // 5. Atomic settlement.
    const credits = await settle(request, active, claim);
    if (credits === OVERFLOW) return conflict(reply, 'Payout would overflow the credit balance.');
    if (credits === null) return conflict(reply, 'Mission has already been completed.');
    return { success: true, credits, payout: claim.rewardCredits };
  });
}
