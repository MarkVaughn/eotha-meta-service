import {
  COMPONENT_TYPES,
  ESSENTIAL_COMPONENTS,
  MIN_TIER,
  MAX_TIER,
  computeShipAttributes,
  defaultComponents,
  upgradeCost,
  hullBudget,
  totalSubsystemPoints
} from '../../config/components.js';

const upgradeSchema = {
  body: {
    type: 'object',
    required: ['componentType', 'targetTier'],
    properties: {
      componentType: { type: 'string', enum: COMPONENT_TYPES },
      targetTier: { type: 'integer', minimum: 0, maximum: MAX_TIER }
    }
  }
};

function toLoadout(shipId, components) {
  const list = COMPONENT_TYPES.map((type) => {
    const found = components.find((c) => c.type === type);
    const fallbackTier = ESSENTIAL_COMPONENTS.includes(type) ? MIN_TIER : 0;
    return { type, tier: found?.tier ?? fallbackTier, healthPct: found?.healthPct ?? 100 };
  });
  return { ship_id: shipId, components: list, ship_attributes: computeShipAttributes(list) };
}

export default async function shipRoutes(fastify, opts) {
  const prisma = fastify.prisma;

  fastify.addHook('onRequest', fastify.authenticate);

  // Runs `fn(tx, ship)` inside one transaction holding a per-player advisory lock, so concurrent
  // requests cannot create duplicate active ships or interleave a check with its write.
  function withActiveShip(request, fn) {
    const playerId = request.user.sub;
    return prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${playerId}))`;
      const existing = await tx.spaceship.findFirst({
        where: { playerId, active: true },
        orderBy: { createdAt: 'asc' },
        include: { components: true }
      });
      const ship = existing ?? await tx.spaceship.create({
        data: {
          playerId,
          callsign: request.user.callsign,
          components: { create: defaultComponents().map(({ type, tier, healthPct }) => ({ type, tier, healthPct })) }
        },
        include: { components: true }
      });
      return fn(tx, ship);
    });
  }

  // Re-sign the caller's claims with fresh ship attributes so the token RTSE verifies is current.
  // The expiry is carried over: only a refresh token may extend a login.
  function reissueToken(request, loadout) {
    const { iat, iss, ...claims } = request.user;
    return fastify.signWithExpiry({ ...claims, ship_attributes: loadout.ship_attributes });
  }

  const fail = (status, error, extra = {}) => ({ failure: { status, body: { error, ...extra } } });

  fastify.get('/loadout', async (request) => {
    const ship = await withActiveShip(request, async (tx, active) => active);
    return toLoadout(ship.id, ship.components);
  });

  fastify.post('/upgrade', { schema: upgradeSchema }, async (request, reply) => {
    const { componentType, targetTier } = request.body;
    const playerId = request.user.sub;

    if (ESSENTIAL_COMPONENTS.includes(componentType) && targetTier === 0) {
      return reply.code(400).send({
        error: `${componentType} is an essential component and cannot be unequipped (minimum tier is 1).`
      });
    }

    // Every check, the credit deduction and the tier change commit or roll back together.
    const outcome = await withActiveShip(request, async (tx, ship) => {
      // Guests cannot upgrade the hull until they link an account. Decided from the identity
      // record, never from the token or the request.
      if (componentType === 'HULL') {
        const player = await tx.player.findUnique({ where: { id: playerId }, select: { isAnonymous: true } });
        if (player?.isAnonymous) {
          return fail(403, 'Hull upgrades are locked until you link an account.', { code: 'guest_hull_locked' });
        }
      }

      const currentHullTier = ship.components.find((c) => c.type === 'HULL')?.tier ?? MIN_TIER;
      const currentComponentTier = ship.components.find((c) => c.type === componentType)?.tier ?? MIN_TIER;
      const currentPoints = totalSubsystemPoints(ship.components);

      if (componentType === 'HULL') {
        const budget = hullBudget(targetTier);
        if (currentPoints > budget) {
          return fail(400, `Upgrade exceeds Hull Tier ${targetTier} budget of ${budget} points (requested: ${currentPoints}).`);
        }
      } else {
        const projectedPoints = currentPoints - currentComponentTier + targetTier;
        const budget = hullBudget(currentHullTier);
        if (projectedPoints > budget) {
          return fail(400, `Upgrade exceeds Hull Tier ${currentHullTier} budget of ${budget} points (requested: ${projectedPoints}).`);
        }
      }

      const row = ship.components.find((c) => c.type === componentType);
      const fromTier = row?.tier ?? (ESSENTIAL_COMPONENTS.includes(componentType) ? MIN_TIER : 0);
      if (targetTier <= fromTier) return fail(400, `${componentType} is already at tier ${fromTier}.`);

      // Guarded deduction: only succeeds while the balance still covers the cost.
      const cost = upgradeCost(fromTier, targetTier);
      const { count } = await tx.player.updateMany({
        where: { id: playerId, credits: { gte: cost } },
        data: { credits: { decrement: cost } }
      });
      if (count !== 1) {
        const player = await tx.player.findUnique({ where: { id: playerId }, select: { credits: true } });
        if (!player) return fail(404, 'Player not found.');
        return fail(402, `Insufficient credits: upgrade costs ${cost}, balance is ${player.credits}.`, {
          cost,
          credits: player.credits
        });
      }

      if (row) {
        await tx.shipComponentRecord.update({ where: { id: row.id }, data: { tier: targetTier, healthPct: 100 } });
      } else {
        await tx.shipComponentRecord.create({ data: { spaceshipId: ship.id, type: componentType, tier: targetTier } });
      }

      const [components, player] = await Promise.all([
        tx.shipComponentRecord.findMany({ where: { spaceshipId: ship.id } }),
        tx.player.findUnique({ where: { id: playerId }, select: { credits: true } })
      ]);
      return { shipId: ship.id, components, cost, credits: player.credits };
    });

    if (outcome.failure) return reply.code(outcome.failure.status).send(outcome.failure.body);
    const loadout = toLoadout(outcome.shipId, outcome.components);
    return { ...loadout, cost: outcome.cost, credits: outcome.credits, token: reissueToken(request, loadout) };
  });
}
