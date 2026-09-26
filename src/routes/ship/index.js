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

    let ship = await prisma.spaceship.findFirst({
      where: { playerId, active: true },
      include: { components: true }
    });
    if (!ship) {
      ship = await prisma.spaceship.create({
        data: {
          playerId,
          callsign: request.user.callsign,
          components: { create: defaultComponents().map(({ type, tier, healthPct }) => ({ type, tier, healthPct })) }
        },
        include: { components: true }
      });
    }
    return ship;
  }

  fastify.get('/loadout', async (request) => {
    const ship = await getActiveShip(request);
    return toLoadout(ship.id, ship.components);
  });

  fastify.post('/upgrade', { schema: upgradeSchema }, async (request, reply) => {
    const { componentType, targetTier } = request.body;
    const ship = await getActiveShip(request);

    const current = ship.components.find((c) => c.type === componentType);
    if (current && targetTier <= current.tier) {
      return reply.code(400).send({ error: `${componentType} is already at tier ${current.tier}.` });
    }

    if (ship.mock) {
      const components = ship.components.map((c) =>
        c.type === componentType ? { ...c, tier: targetTier, healthPct: 100 } : c
      );
      mockLoadouts.set(ship.playerId, components);
      return toLoadout(ship.id, components);
    }

    await prisma.shipComponentRecord.upsert({
      where: { spaceshipId_type: { spaceshipId: ship.id, type: componentType } },
      update: { tier: targetTier, healthPct: 100 },
      create: { spaceshipId: ship.id, type: componentType, tier: targetTier }
    });
    const updated = await prisma.shipComponentRecord.findMany({ where: { spaceshipId: ship.id } });
    return toLoadout(ship.id, updated);
  });
}
