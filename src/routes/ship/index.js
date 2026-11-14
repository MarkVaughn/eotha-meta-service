import {
  COMPONENT_TYPES,
  ESSENTIAL_COMPONENTS,
  MIN_TIER,
  MAX_TIER,
  maxTierOf,
  clampPassengers,
  computeShipAttributes,
  upgradeCost,
  hullBudget,
  totalSubsystemPoints
} from '../../config/components.js';
import { repairCost } from '../../config/customs.js';
import {
  DEFAULT_QUALITY,
  QUALITY_GRADES,
  STANDING_BANDS,
  STANDING_DISCOUNT,
  blackMarketMultiplier,
  normalizeQuality,
  qualityRank,
  quoteOutfit,
  standingBand
} from '../../config/outfitting.js';
import { devPassengersEnabled } from '../../config/dev.js';
import { stationLockoutRefusal } from '../../lib/customs.js';
import { dockedReceiptRefusal, dockedReceiptSchema } from '../../lib/docked-receipt.js';
import { stationServices } from '../../lib/outfitting-station.js';
import { standingsOf } from '../../lib/reputation.js';
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
      qualityGrade: { type: 'string', enum: QUALITY_GRADES },
      dockedReceipt: dockedReceiptSchema
    }
  }
};

// `componentTypes` limits the repair to those components (all damaged ones by default).
const repairSchema = {
  body: {
    type: 'object',
    properties: {
      componentTypes: { type: 'array', items: { type: 'string', enum: COMPONENT_TYPES }, minItems: 1, uniqueItems: true },
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
    const qualityGrade = request.body.qualityGrade ?? DEFAULT_QUALITY;
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
    // A station that locked the pilot out after a customs capture does no business with them.
    const lockout = await stationLockoutRefusal(prisma, playerId, dockedReceipt.dockedEntityId, Date.now());
    if (lockout) return reply.code(403).send(lockout);

    if (ESSENTIAL_COMPONENTS.includes(componentType) && targetTier === 0) {
      return reply.code(400).send({
        error: `${componentType} is an essential component and cannot be unequipped (minimum tier is 1).`
      });
    }

    if (targetTier > maxTierOf(componentType)) {
      return reply.code(400).send({
        error: `${componentType} has no tier ${targetTier} (maximum tier is ${maxTierOf(componentType)}).`,
        code: 'tier_above_component_max',
        maxTier: maxTierOf(componentType)
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

      // The faction governing the dock decides the pilot's price (standing) and whether they are served at all.
      const stationFactionId = dockedReceipt.controllingFactionId || '';
      let band = null;
      let discount = 0;
      let hostileMult = 1;
      if (stationFactionId) {
        const standing = (await standingsOf(tx, playerId))[stationFactionId] ?? 0;
        const colors = standing > 0
          ? (await tx.player.findUnique({ where: { id: playerId }, select: { activeColorsFactionId: true } }))?.activeColorsFactionId
          : null;
        band = standingBand(standing, { flyingColors: colors === stationFactionId });
        discount = STANDING_DISCOUNT[band];
        if (band === STANDING_BANDS.HOSTILE) {
          // Civilian terminals refuse a Hostile pilot; only a low-sec dock refits them, on the black market.
          if (!stationServices.isLowSecDock(dockedReceipt)) {
            return fail(403, 'This terminal refuses Hostile pilots.', { code: 'terminal_barred_hostile' });
          }
          hostileMult = blackMarketMultiplier(dockedReceipt.dockedEntityId);
        }
      }

      const currentHullTier = ship.components.find((c) => c.type === 'HULL')?.tier ?? MIN_TIER;
      const currentComponentTier = ship.components.find((c) => c.type === componentType)?.tier ?? (ESSENTIAL_COMPONENTS.includes(componentType) ? MIN_TIER : 0);
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
      if (targetTier < fromTier || (fromTier === 0 && targetTier === 0)) return fail(400, `${componentType} is already at tier ${fromTier}.`);
      // A fitted part can be replaced by a better grade (a regrade, at its own tier or on the way up) but never
      // by a worse one: there is no buy-back, so a cheaper grade would only be a discount on the tier. The one
      // exception is an essential component's starter part (its free tier-1 Basic part), which may become a
      // Cheap part as its tier rises.
      const fitted = fromTier > 0;
      const fromQuality = fitted ? normalizeQuality(row?.quality) : DEFAULT_QUALITY;
      const starter = ESSENTIAL_COMPONENTS.includes(componentType) && fromTier === MIN_TIER && fromQuality === DEFAULT_QUALITY;
      if (fitted && qualityRank(qualityGrade) < qualityRank(fromQuality) && !(starter && targetTier > fromTier)) {
        return fail(400, `${componentType} is ${fromQuality} grade and cannot be replaced by a lower grade (${qualityGrade}).`, {
          code: 'quality_downgrade_refused',
          currentQualityGrade: fromQuality
        });
      }
      if (targetTier === fromTier && qualityGrade === fromQuality) {
        return fail(400, `${componentType} is already at tier ${fromTier}${fitted ? ` (${fromQuality})` : ''}.`);
      }

      // Guarded deduction: only succeeds while the balance still covers the cost.
      const cost = quoteOutfit({
        from: { tier: fromTier, quality: fromQuality },
        to: { tier: targetTier, quality: qualityGrade },
        tierCost: (from, to) => upgradeCost(from, to, componentType),
        starter,
        discount,
        hostileMult
      }).price;
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
        await tx.shipComponentRecord.update({ where: { id: row.id }, data: { tier: targetTier, quality: qualityGrade, healthPct: 100 } });
      } else {
        await tx.shipComponentRecord.create({ data: { spaceshipId: ship.id, type: componentType, tier: targetTier, quality: qualityGrade } });
      }

      // A component change can lower the passenger capacity; persist the clamped count with it.
      const components = await tx.shipComponentRecord.findMany({ where: { spaceshipId: ship.id } });
      const capacity = computeShipAttributes(components, 0, ship.traits, ship.crew).passenger_capacity;
      const passengersAboard = clampPassengers(ship.passengersAboard, capacity - ship.crew.length);
      if (passengersAboard !== ship.passengersAboard) {
        await tx.spaceship.update({ where: { id: ship.id }, data: { passengersAboard } });
      }

      const player = await tx.player.findUnique({ where: { id: playerId }, select: { credits: true } });
      return { shipId: ship.id, components, passengersAboard, traits: ship.traits, crew: ship.crew, factions: ship.factions, cost, credits: player.credits, qualityGrade, standingBand: band, blackMarket: hostileMult > 1 };
    });

    if (outcome.failure) return reply.code(outcome.failure.status).send(outcome.failure.body);
    const loadout = toLoadout(outcome.shipId, outcome.components, outcome.passengersAboard, outcome.traits, outcome.crew);
    return { ...loadout, cost: outcome.cost, credits: outcome.credits, qualityGrade: outcome.qualityGrade, standingBand: outcome.standingBand, blackMarket: outcome.blackMarket, token: await reissueToken(fastify, request, loadout.ship_attributes, outcome.factions) };
  });
  // Restores damaged components (customs captures wear them, see config/customs.js) to 100% for
  // REPAIR_CREDITS_PER_PCT credits per missing point, while docked.
  fastify.post('/repair', { schema: repairSchema, preHandler: fastify.requireClaimKey }, async (request, reply) => {
    const { componentTypes, dockedReceipt } = request.body;
    const playerId = request.user.sub;

    if (!dockedReceipt) {
      return reply.code(403).send({ error: 'Repairs require a docked receipt from the engine.', code: 'docked_receipt_required' });
    }
    const refusal = dockedReceiptRefusal(dockedReceipt, {
      pilotId: playerId,
      publicKey: fastify.claimKey.key,
      nowMs: Date.now(),
      log: request.log
    });
    if (refusal) return reply.code(403).send(refusal);
    const lockout = await stationLockoutRefusal(prisma, playerId, dockedReceipt.dockedEntityId, Date.now());
    if (lockout) return reply.code(403).send(lockout);

    const outcome = await withActiveShip(request, async (tx, ship) => {
      const damaged = ship.components.filter((c) => c.tier > 0 && c.healthPct < 100 && (!componentTypes || componentTypes.includes(c.type)));
      if (damaged.length === 0) return fail(409, 'Nothing needs repair.', { code: 'nothing_to_repair' });
      const repaired = damaged.map((c) => ({ type: c.type, healthBefore: c.healthPct, cost: repairCost(c.healthPct) }));
      const cost = repaired.reduce((sum, r) => sum + r.cost, 0);

      const { count } = await tx.player.updateMany({
        where: { id: playerId, credits: { gte: cost } },
        data: { credits: { decrement: cost } }
      });
      if (count !== 1) {
        const player = await tx.player.findUnique({ where: { id: playerId }, select: { credits: true } });
        if (!player) return fail(404, 'Player not found.');
        return fail(402, `Insufficient credits: repairs cost ${cost}, balance is ${player.credits}.`, { cost, credits: player.credits });
      }
      await tx.shipComponentRecord.updateMany({ where: { id: { in: damaged.map((c) => c.id) } }, data: { healthPct: 100 } });

      const components = await tx.shipComponentRecord.findMany({ where: { spaceshipId: ship.id } });
      const player = await tx.player.findUnique({ where: { id: playerId }, select: { credits: true } });
      return { shipId: ship.id, components, passengersAboard: ship.passengersAboard, traits: ship.traits, crew: ship.crew, factions: ship.factions, cost, credits: player.credits, repaired };
    });

    if (outcome.failure) return reply.code(outcome.failure.status).send(outcome.failure.body);
    const loadout = toLoadout(outcome.shipId, outcome.components, outcome.passengersAboard, outcome.traits, outcome.crew);
    return {
      ...loadout,
      cost: outcome.cost,
      credits: outcome.credits,
      repaired: outcome.repaired,
      token: await reissueToken(fastify, request, loadout.ship_attributes, outcome.factions)
    };
  });
}
