import {
  COMPONENT_TYPES,
  ESSENTIAL_COMPONENTS,
  MIN_TIER,
  MAX_TIER,
  clampPassengers,
  computeShipAttributes,
  upgradeCost,
  hullBudget,
  totalSubsystemPoints
} from '../../config/components.js';
import { devPassengersEnabled } from '../../config/dev.js';
import { dockedReceiptRefusal, dockedReceiptSchema } from '../../lib/docked-receipt.js';
import { lockActiveShip, reissueToken, toLoadout } from '../../lib/ship.js';

// `dockedReceipt` is optional here on purpose: the route answers its absence with the coded 403
// `docked_receipt_required` rather than a generic schema 400.
const upgradeSchema = {
  body: {
    type: 'object',
    required: ['componentType', 'targetTier'],
    properties: {
      componentType: { type: 'string', enum: COMPONENT_TYPES },
      targetTier: { type: 'integer', minimum: 0, maximum: MAX_TIER },
      dockedReceipt: dockedReceiptSchema
    }
  }
};

// Development-only: sets the passenger count directly, as a testing aid outside missions.
const devPassengersSchema = {
  body: {
    type: 'object',
    required: ['passengersAboard'],
    additionalProperties: false,
    properties: { passengersAboard: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER } }
  }
};

export default async function shipRoutes(fastify, opts) {
  const prisma = fastify.prisma;
  // In production the test-only passenger route is never registered.
  const devPassengers = opts.devPassengers ?? devPassengersEnabled();

  fastify.addHook('onRequest', fastify.authenticate);

  // Runs `fn(tx, ship)` inside one transaction holding the per-player lock (see lockActiveShip).
  function withActiveShip(request, fn) {
    return prisma.$transaction(async (tx) => fn(tx, await lockActiveShip(tx, request.user)));
  }

  const fail = (status, error, extra = {}) => ({ failure: { status, body: { error, ...extra } } });

  fastify.get('/loadout', async (request) => {
    const ship = await withActiveShip(request, async (tx, active) => active);
    return toLoadout(ship.id, ship.components, ship.passengersAboard, ship.traits, ship.crew);
  });

  if (devPassengers) {
    fastify.post('/dev/passengers', { schema: devPassengersSchema }, async (request, reply) => {
      const { passengersAboard } = request.body;
      const outcome = await withActiveShip(request, async (tx, ship) => {
        const capacity = computeShipAttributes(ship.components, 0, ship.traits, ship.crew).passenger_capacity;
        // Active crew take berths too, so the passengers fit what they leave.
        if (passengersAboard + ship.crew.length > capacity) {
          return fail(400, `Passengers aboard and crew cannot exceed the passenger capacity of ${capacity}.`, {
            code: 'passengers_exceed_capacity',
            passenger_capacity: capacity
          });
        }
        await tx.spaceship.update({ where: { id: ship.id }, data: { passengersAboard } });
        return { shipId: ship.id, components: ship.components, passengersAboard, traits: ship.traits, crew: ship.crew, factions: ship.factions };
      });
      if (outcome.failure) return reply.code(outcome.failure.status).send(outcome.failure.body);
      const loadout = toLoadout(outcome.shipId, outcome.components, outcome.passengersAboard, outcome.traits, outcome.crew);
      return { ...loadout, token: await reissueToken(fastify, request, loadout.ship_attributes, outcome.factions) };
    });
  }

  fastify.post('/upgrade', { schema: upgradeSchema, preHandler: fastify.requireClaimKey }, async (request, reply) => {
    const { componentType, targetTier, dockedReceipt } = request.body;
    const playerId = request.user.sub;

    // Upgrades are only offered while docked, and the engine alone knows that. These checks are
    // stateless and run before the transaction, so a refusal charges and changes nothing. They come
    // first, so an undocked guest is told to dock rather than that the hull is locked.
    if (!dockedReceipt) {
      return reply.code(403).send({
        error: 'Upgrades require a docked receipt from the engine.',
        code: 'docked_receipt_required'
      });
    }
    const refusal = dockedReceiptRefusal(dockedReceipt, {
      pilotId: playerId,
      publicKey: fastify.claimKey.key,
      nowMs: Date.now(),
      log: request.log
    });
    if (refusal) return reply.code(403).send(refusal);

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
        const budget = hullBudget(targetTier, ship.traits);
        if (currentPoints > budget) {
          return fail(400, `Upgrade exceeds Hull Tier ${targetTier} budget of ${budget} points (requested: ${currentPoints}).`);
        }
      } else {
        const projectedPoints = currentPoints - currentComponentTier + targetTier;
        const budget = hullBudget(currentHullTier, ship.traits);
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

      // A component change can lower the passenger capacity; persist the clamped count with it.
      const components = await tx.shipComponentRecord.findMany({ where: { spaceshipId: ship.id } });
      const capacity = computeShipAttributes(components, 0, ship.traits, ship.crew).passenger_capacity;
      const passengersAboard = clampPassengers(ship.passengersAboard, capacity - ship.crew.length);
      if (passengersAboard !== ship.passengersAboard) {
        await tx.spaceship.update({ where: { id: ship.id }, data: { passengersAboard } });
      }

      const player = await tx.player.findUnique({ where: { id: playerId }, select: { credits: true } });
      return { shipId: ship.id, components, passengersAboard, traits: ship.traits, crew: ship.crew, factions: ship.factions, cost, credits: player.credits };
    });

    if (outcome.failure) return reply.code(outcome.failure.status).send(outcome.failure.body);
    const loadout = toLoadout(outcome.shipId, outcome.components, outcome.passengersAboard, outcome.traits, outcome.crew);
    return { ...loadout, cost: outcome.cost, credits: outcome.credits, token: await reissueToken(fastify, request, loadout.ship_attributes, outcome.factions) };
  });
}
