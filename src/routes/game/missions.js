import { computeShipAttributes } from '../../config/components.js';
import {
  MISSION_TYPES,
  missionCooldownMs,
  generateMissions,
  findMissionOffer,
  computePayout
} from '../../config/missions.js';
import { mockAccount } from '../../lib/mock-accounts.js';

const availableSchema = {
  querystring: {
    type: 'object',
    required: ['stationId', 'stationNode'],
    properties: {
      stationId: { type: 'string', minLength: 1 },
      stationNode: { type: 'string', minLength: 1 }
    }
  }
};

const acceptSchema = {
  body: {
    type: 'object',
    required: ['missionId'],
    properties: {
      missionId: { type: 'string', minLength: 1 }
    }
  }
};

const completeSchema = {
  body: {
    type: 'object',
    required: ['missionId', 'currentStationId', 'currentStationNode', 'elapsedSeconds'],
    properties: {
      missionId: { type: 'string', minLength: 1 },
      currentStationId: { type: 'string', minLength: 1 },
      currentStationNode: { type: 'string', minLength: 1 },
      elapsedSeconds: { type: 'number', minimum: 0 }
    }
  }
};

export default async function missionsRoutes(fastify, opts) {
  const prisma = fastify.prisma;

  // Dev-login pilots have no database row, so active missions and station
  // cooldowns live in memory for them.
  const mockActiveMissions = new Map(); // playerId -> mission
  const mockCooldowns = new Map(); // `${playerId}::${stationId}::${stationNode}` -> completedAt (ms)

  fastify.addHook('onRequest', fastify.authenticate);

  async function getPassengerCapacity(request) {
    if (request.user.mock) {
      return request.user.ship_attributes?.passenger_capacity ?? 0;
    }
    const ship = await prisma.spaceship.findFirst({
      where: { playerId: request.user.sub, active: true },
      orderBy: { createdAt: 'asc' },
      include: { components: true }
    });
    if (!ship) return 0;
    return computeShipAttributes(ship.components).passenger_capacity ?? 0;
  }

  async function cooldownRemainingMs(request, stationId, stationNode) {
    const cooldownMs = missionCooldownMs(stationId, stationNode);
    let completedAt = null;

    if (request.user.mock) {
      completedAt = mockCooldowns.get(`${request.user.sub}::${stationId}::${stationNode}`) ?? null;
    } else {
      const row = await prisma.missionCooldown.findUnique({
        where: { playerId_stationId_stationNode: { playerId: request.user.sub, stationId, stationNode } }
      });
      completedAt = row?.completedAt?.getTime() ?? null;
    }

    if (completedAt == null) return 0;
    return Math.max(0, completedAt + cooldownMs - Date.now());
  }

  async function activateCooldown(request, stationId, stationNode) {
    if (request.user.mock) {
      mockCooldowns.set(`${request.user.sub}::${stationId}::${stationNode}`, Date.now());
      return;
    }
    await prisma.missionCooldown.upsert({
      where: { playerId_stationId_stationNode: { playerId: request.user.sub, stationId, stationNode } },
      update: { completedAt: new Date() },
      create: { playerId: request.user.sub, stationId, stationNode }
    });
  }

  async function getActiveMission(request) {
    if (request.user.mock) return mockActiveMissions.get(request.user.sub) ?? null;
    const row = await prisma.playerMission.findUnique({ where: { playerId: request.user.sub } });
    if (!row) return null;
    const { id, playerId, acceptedAt, ...mission } = row;
    return { ...mission, acceptedAt: acceptedAt.toISOString() };
  }

  async function setActiveMission(request, mission) {
    if (request.user.mock) {
      const record = { ...mission, acceptedAt: new Date().toISOString() };
      mockActiveMissions.set(request.user.sub, record);
      return record;
    }
    const row = await prisma.playerMission.create({
      data: { playerId: request.user.sub, ...mission }
    });
    const { id, playerId, acceptedAt, ...rest } = row;
    return { ...rest, acceptedAt: acceptedAt.toISOString() };
  }

  async function clearActiveMission(request) {
    if (request.user.mock) {
      mockActiveMissions.delete(request.user.sub);
      return;
    }
    await prisma.playerMission.deleteMany({ where: { playerId: request.user.sub } });
  }

  async function creditPlayer(request, amount) {
    if (request.user.mock) {
      const account = mockAccount(request.user.sub);
      account.credits += amount;
      return account.credits;
    }
    const player = await prisma.player.update({
      where: { id: request.user.sub },
      data: { credits: { increment: amount } },
      select: { credits: true }
    });
    return player.credits;
  }

  fastify.get('/missions/available', { schema: availableSchema }, async (request) => {
    const { stationId, stationNode } = request.query;
    const passengerCapacity = await getPassengerCapacity(request);
    const remainingMs = await cooldownRemainingMs(request, stationId, stationNode);

    const cooldown = remainingMs > 0
      ? { active: true, remainingSeconds: Math.ceil(remainingMs / 1000), availableAt: new Date(Date.now() + remainingMs).toISOString() }
      : { active: false, remainingSeconds: 0, availableAt: null };

    const missions = cooldown.active ? [] : generateMissions({ stationId, stationNode, passengerCapacity });

    return { stationId, stationNode, passengerCapacity, cooldown, missions };
  });

  fastify.post('/missions/accept', { schema: acceptSchema }, async (request, reply) => {
    const { missionId } = request.body;

    const existing = await getActiveMission(request);
    if (existing) {
      return reply.code(409).send({ error: 'A mission is already active. Complete or abandon it first.' });
    }

    const passengerCapacity = await getPassengerCapacity(request);
    if (passengerCapacity <= 0) {
      return reply.code(400).send({ error: 'Ship has no passenger capacity available.' });
    }

    const offer = findMissionOffer(missionId, passengerCapacity);
    if (!offer) {
      return reply.code(404).send({ error: 'Mission offer not found or expired.' });
    }

    const remainingMs = await cooldownRemainingMs(request, offer.originStationId, offer.originStationNode);
    if (remainingMs > 0) {
      return reply.code(409).send({ error: 'Station is on cooldown; no passengers currently seeking passage.' });
    }

    const mission = await setActiveMission(request, offer);
    return mission;
  });

  fastify.get('/missions/active', async (request) => {
    return { mission: await getActiveMission(request) };
  });

  fastify.post('/missions/complete', { schema: completeSchema }, async (request, reply) => {
    const { missionId, currentStationId, currentStationNode, elapsedSeconds } = request.body;

    const mission = await getActiveMission(request);
    if (!mission || mission.missionId !== missionId) {
      return reply.code(404).send({ error: 'No matching active mission.' });
    }

    const destinationStationId = mission.roundTrip ? mission.originStationId : mission.destination.stationId;
    const destinationNode = mission.roundTrip ? mission.originStationNode : mission.destination.node;
    const arrived = currentStationId === destinationStationId && currentStationNode === destinationNode;

    if (!arrived) {
      return reply.code(400).send({
        error: mission.roundTrip
          ? 'Not back at the origin station; expedition is not complete.'
          : 'Not at the destination station; passage is not complete.'
      });
    }

    const { payout, bonus } = computePayout({
      basePayout: mission.basePayout,
      expectedSeconds: mission.expectedSeconds,
      elapsedSeconds
    });

    const credits = await creditPlayer(request, payout);
    await clearActiveMission(request);
    await activateCooldown(request, mission.originStationId, mission.originStationNode);

    return { mission, payout, bonus, credits };
  });

  fastify.post('/missions/abandon', async (request, reply) => {
    const mission = await getActiveMission(request);
    if (!mission) {
      return reply.code(404).send({ error: 'No active mission to abandon.' });
    }
    await clearActiveMission(request);
    return { abandoned: true, missionId: mission.missionId };
  });

  // Exposed for clients to build mission-type filters/UI without hardcoding values.
  fastify.get('/missions/types', async () => ({ types: MISSION_TYPES }));
}
