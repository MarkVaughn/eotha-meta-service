import {
  COMPONENT_TYPES,
  MIN_TIER,
  MAX_TIER,
  computeShipAttributes,
  defaultComponents
} from '../../config/components.js';

const upgradeSchema = {
  body: {
    type: 'object',
    required: ['componentType', 'targetTier'],
    properties: {
      componentType: { type: 'string', enum: COMPONENT_TYPES },
      targetTier: { type: 'integer', minimum: MIN_TIER, maximum: MAX_TIER }
    }
  }
};

function toLoadout(shipId, components) {
  const list = COMPONENT_TYPES.map((type) => {
    const found = components.find((c) => c.type === type);
    return { type, tier: found?.tier ?? MIN_TIER, healthPct: found?.healthPct ?? 100 };
  });
  return { ship_id: shipId, components: list, ship_attributes: computeShipAttributes(list) };
}

export default async function shipRoutes(fastify, opts) {
  const prisma = fastify.prisma;

  // Dev-login pilots have no database row, so their loadouts live in memory.
  const mockLoadouts = new Map();

  fastify.addHook('onRequest', fastify.authenticate);

  async function getActiveShip(request) {
    const playerId = request.user.sub;
    if (request.user.mock) {
      if (!mockLoadouts.has(playerId)) mockLoadouts.set(playerId, defaultComponents());
      return { id: `dev-${playerId}`, components: mockLoadouts.get(playerId), mock: true, playerId };
    }

    // Serialize first-time creation per player with a transaction-scoped advisory lock,
    // so concurrent requests cannot create duplicate active ships.
    return prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${playerId}))`;
      const existing = await tx.spaceship.findFirst({
        where: { playerId, active: true },
        orderBy: { createdAt: 'asc' },
        include: { components: true }
      });
      if (existing) return existing;
      return tx.spaceship.create({
        data: {
          playerId,
          callsign: request.user.callsign,
          components: { create: defaultComponents().map(({ type, tier, healthPct }) => ({ type, tier, healthPct })) }
        },
        include: { components: true }
      });
    });
  }

  // Re-sign the caller's claims with fresh ship attributes so the token RTSE verifies is current.
  function reissueToken(request, loadout) {
    const { iat, exp, iss, ...claims } = request.user;
    return fastify.jwt.sign({ ...claims, ship_attributes: loadout.ship_attributes });
  }

  const alreadyAtTier = (reply, componentType, tier) =>
    reply.code(400).send({ error: `${componentType} is already at tier ${tier}.` });

  fastify.get('/loadout', async (request) => {
    const ship = await getActiveShip(request);
    return toLoadout(ship.id, ship.components);
  });

  fastify.post('/upgrade', { schema: upgradeSchema }, async (request, reply) => {
    const { componentType, targetTier } = request.body;
    const ship = await getActiveShip(request);

    if (ship.mock) {
      const current = ship.components.find((c) => c.type === componentType);
      if (current && targetTier <= current.tier) return alreadyAtTier(reply, componentType, current.tier);
      const components = ship.components.map((c) =>
        c.type === componentType ? { ...c, tier: targetTier, healthPct: 100 } : c
      );
      mockLoadouts.set(ship.playerId, components);
      const loadout = toLoadout(ship.id, components);
      return { ...loadout, token: reissueToken(request, loadout) };
    }

    // Atomic guard: only raise the tier if the stored tier is still lower than the target.
    const { count } = await prisma.shipComponentRecord.updateMany({
      where: { spaceshipId: ship.id, type: componentType, tier: { lt: targetTier } },
      data: { tier: targetTier, healthPct: 100 }
    });
    if (count === 0) {
      const row = await prisma.shipComponentRecord.findUnique({
        where: { spaceshipId_type: { spaceshipId: ship.id, type: componentType } }
      });
      if (row) return alreadyAtTier(reply, componentType, row.tier);
      try {
        await prisma.shipComponentRecord.create({
          data: { spaceshipId: ship.id, type: componentType, tier: targetTier }
        });
      } catch (err) {
        if (err.code !== 'P2002') throw err;
        // Lost a creation race; retry the guarded update against the winner's row.
        const retry = await prisma.shipComponentRecord.updateMany({
          where: { spaceshipId: ship.id, type: componentType, tier: { lt: targetTier } },
          data: { tier: targetTier, healthPct: 100 }
        });
        if (retry.count === 0) return alreadyAtTier(reply, componentType, targetTier);
      }
    }
    const updated = await prisma.shipComponentRecord.findMany({ where: { spaceshipId: ship.id } });
    const loadout = toLoadout(ship.id, updated);
    return { ...loadout, token: reissueToken(request, loadout) };
  });
}
