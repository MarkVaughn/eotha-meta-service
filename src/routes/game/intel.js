import {
  CLEARANCES,
  DOSSIER_LIFETIME_MS,
  VOUCHER_CATEGORIES,
  hourEpochOf
} from '../../config/intel.js';
import { DOCKED_ENTITY_ID_PATTERN, dockedReceiptRefusal, dockedReceiptSchema } from '../../lib/docked-receipt.js';
import { stationLockoutRefusal } from '../../lib/customs.js';
import { activeCrewOf } from '../../lib/crew.js';
import { stationServices } from '../../lib/outfitting-station.js';
import { standingsOf } from '../../lib/reputation.js';
import { lockActiveShip } from '../../lib/ship.js';
import { IntelEngineUnavailable } from '../../lib/intel-engine.js';
import { IntelPoolError, validatePool } from '../../lib/intel-offer.js';
import { issueVoucher, newVoucherNonce, unlockExpiryOf } from '../../lib/intel-voucher.js';
import { sightingsForPool } from '../../lib/sightings.js';
import {
  budgetCostOf,
  budgetOf,
  budgetTotalFor,
  clearanceFor,
  costOf,
  isAccessRefused,
  itemView,
  meetsRequirement,
  nextRefreshAtMs,
  spendBudget,
  visibleAt
} from '../../lib/intel.js';

const uint = { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER };

// The pool is a GET, so the docked receipt travels in the query as the JSON of the same object every other route takes
// in its body (`receipt`). It is optional in the schema so that its absence is answered with the coded 403, as elsewhere.
const poolSchema = {
  querystring: {
    type: 'object',
    additionalProperties: false,
    properties: {
      receipt: { type: 'string', minLength: 2, maxLength: 4096 },
      stationId: { type: 'string', pattern: DOCKED_ENTITY_ID_PATTERN }
    }
  }
};

const gatherSchema = {
  body: {
    type: 'object',
    additionalProperties: false,
    required: ['intelId', 'hourEpoch', 'expectedCostCredits'],
    properties: {
      intelId: { type: 'string', minLength: 1, maxLength: 256 },
      hourEpoch: uint,
      expectedCostCredits: uint,
      stationId: { type: 'string', pattern: DOCKED_ENTITY_ID_PATTERN },
      dockedReceipt: dockedReceiptSchema
    }
  }
};

const ACCESS_REFUSED_BODY = (clearance) => ({
  error: 'The station terminal refuses you access.',
  code: 'intel_access_refused',
  clearance,
  banner: CLEARANCES[clearance].banner
});

// A tx body returns `fail(...)` to refuse; the rest of the transaction's writes never happen.
const fail = (status, body) => ({ failure: { status, body } });

export default async function intelRoutes(fastify) {
  const prisma = fastify.prisma;
  fastify.addHook('onRequest', fastify.authenticate);

  // The receipt of a request as the engine signed it for this pilot and still fresh, and the station it names, or null once
  // the reply has been sent with why not. A receipt for one dock is never read as another's: `stationId` must match it.
  async function dockedAt(request, reply, receipt, stationId, nowMs) {
    if (!receipt) {
      reply.code(403).send({ error: 'The intel terminal requires a docked receipt from the engine.', code: 'docked_receipt_required' });
      return null;
    }
    const refusal = dockedReceiptRefusal(receipt, { pilotId: request.user.sub, publicKey: fastify.claimKey.key, nowMs, log: request.log });
    if (refusal) {
      reply.code(403).send(refusal);
      return null;
    }
    if (stationId !== undefined && stationId !== receipt.dockedEntityId) {
      reply.code(403).send({ error: 'The docked receipt is for another station.', code: 'docked_receipt_station_mismatch' });
      return null;
    }
    const lockout = await stationLockoutRefusal(prisma, request.user.sub, receipt.dockedEntityId, nowMs);
    if (lockout) {
      reply.code(403).send(lockout);
      return null;
    }
    return receipt.dockedEntityId;
  }

  // The pool of `receipt`'s dock for `hourEpoch`, validated, or null once the reply has been sent with why not.
  async function poolOf(request, reply, receipt, hourEpoch) {
    const stationEntityId = receipt.dockedEntityId;
    try {
      const raw = await fastify.intelEngine.getPool({
        stationEntityId,
        systemH3: receipt.systemH3,
        controllingFactionId: receipt.controllingFactionId,
        hourEpoch,
        sightings: await sightingsForPool(prisma, stationEntityId, hourEpoch)
      });
      return validatePool(raw, { stationEntityId, systemH3: receipt.systemH3, hourEpoch }, fastify.claimKey.key);
    } catch (err) {
      if (err instanceof IntelEngineUnavailable) {
        request.log.warn({ err }, 'Intel engine unavailable.');
        reply.code(503).send({ error: 'The station intel network is unavailable. Try again shortly.', code: 'intel_engine_unavailable' });
      } else if (err instanceof IntelPoolError) {
        request.log.error({ err }, 'The engine sent an invalid intel pool.');
        reply.code(502).send({ error: 'The station intel network sent an invalid pool.', code: 'intel_pool_invalid' });
      } else {
        throw err;
      }
      return null;
    }
  }

  // What decides the terminal for `receipt`'s pilot: their standing with the governing faction, whether they fly its
  // colors, whether the dock is low-security, and the band these give. `db` is the client or an open transaction.
  async function clearanceOf(db, playerId, receipt) {
    const faction = receipt.controllingFactionId;
    const standings = await standingsOf(db, playerId);
    const player = await db.player.findUnique({ where: { id: playerId }, select: { activeColorsFactionId: true, credits: true } });
    const standing = faction ? (standings[faction] ?? 0) : 0;
    const clearance = clearanceFor({
      standing,
      flyingColors: Boolean(faction) && player?.activeColorsFactionId === faction,
      lowSec: stationServices.isLowSecDock(receipt)
    });
    return { clearance, standings, credits: player?.credits ?? 0 };
  }

  function parseReceipt(raw) {
    if (raw === undefined) return undefined;
    try {
      const receipt = JSON.parse(raw);
      return receipt && typeof receipt === 'object' && !Array.isArray(receipt) ? receipt : null;
    } catch {
      return null;
    }
  }

  fastify.get('/intel/pool', { schema: poolSchema, preHandler: fastify.requireClaimKey }, async (request, reply) => {
    const playerId = request.user.sub;
    const nowMs = Date.now();
    const parsed = parseReceipt(request.query.receipt);
    // An unreadable receipt is as good as a forged one: nothing about it is signed.
    const receipt = parsed === null ? { pilotId: null } : parsed;
    if (!(await dockedAt(request, reply, receipt, request.query.stationId, nowMs))) return reply;
    const hourEpoch = hourEpochOf(nowMs);

    const { clearance, standings } = await clearanceOf(prisma, playerId, receipt);
    if (isAccessRefused(clearance)) return reply.code(403).send(ACCESS_REFUSED_BODY(clearance));

    const pool = await poolOf(request, reply, receipt, hourEpoch);
    if (!pool) return reply;
    const ship = await prisma.spaceship.findFirst({ where: { playerId, active: true }, orderBy: { createdAt: 'asc' }, select: { id: true } });
    const crew = ship ? await activeCrewOf(prisma, ship.id) : [];
    const budget = await budgetOf(prisma, playerId, hourEpoch);
    const total = budgetTotalFor(crew);

    return {
      station_entity_id: receipt.dockedEntityId,
      hour_epoch: hourEpoch,
      clearance,
      clearance_banner: CLEARANCES[clearance].banner,
      budget_remaining: Math.max(0, total - budget.spent),
      budget_total: total,
      items: pool.filter((item) => visibleAt(item, clearance))
        .map((item) => itemView(item, { gathered: budget.gatheredIds.has(item.intelId), clearance, standings, crew })),
      next_refresh_at_ms: nextRefreshAtMs(hourEpoch)
    };
  });

  fastify.post('/intel/gather', { schema: gatherSchema, preHandler: fastify.requireClaimKey }, async (request, reply) => {
    const playerId = request.user.sub;
    const { intelId, hourEpoch, expectedCostCredits, stationId, dockedReceipt: receipt } = request.body;
    const nowMs = Date.now();

    // Stateless checks first, so a refusal changes nothing.
    if (!(await dockedAt(request, reply, receipt, stationId, nowMs))) return reply;
    const currentHour = hourEpochOf(nowMs);
    if (hourEpoch !== currentHour) {
      return reply.code(409).send({ error: 'That pool has rotated. Reload the terminal.', code: 'intel_pool_expired', hour_epoch: currentHour });
    }
    const pool = await poolOf(request, reply, receipt, currentHour);
    if (!pool) return reply;
    const item = pool.find((candidate) => candidate.intelId === intelId);
    const unknown = () => reply.code(404).send({ error: 'No such intel at this station this hour.', code: 'unknown_intel_item' });
    if (!item) return unknown();
    const voucherKind = VOUCHER_CATEGORIES.includes(item.category);
    if (voucherKind && !fastify.intelVoucherKey) {
      return reply.code(503).send({ error: 'This service cannot issue mission vouchers.', code: 'intel_voucher_key_not_configured' });
    }

    // The pilot's rules, the budget, the charge and the unlock commit or roll back together.
    const outcome = await prisma.$transaction(async (tx) => {
      const ship = await lockActiveShip(tx, request.user);
      const { clearance, standings } = await clearanceOf(tx, playerId, receipt);
      if (isAccessRefused(clearance)) return fail(403, ACCESS_REFUSED_BODY(clearance));
      // An item the pilot's terminal does not show does not exist for them.
      if (!visibleAt(item, clearance)) return { unknown: true };

      const crew = ship.crew;
      const total = budgetTotalFor(crew);
      const budget = await budgetOf(tx, playerId, currentHour);
      const view = (gathered) => itemView(item, { gathered, clearance, standings, crew });
      const row = voucherKind ? await tx.playerMissionUnlock.findFirst({ where: { playerId, intelId } }) : null;
      const voucherOf = (unlock) => (unlock ? issueVoucher(fastify.intelVoucherKey, { playerId, unlock }) : undefined);

      // Gathered before: the same item and voucher again, and nothing is charged or spent.
      if (budget.gatheredIds.has(intelId)) {
        return {
          body: {
            result: 'GATHER_INTEL_ITEM_RESULT_ALREADY_GATHERED',
            item: view(true),
            ...(row && { voucher: voucherOf(row) }),
            credits_charged: 0,
            budget_remaining: Math.max(0, total - budget.spent),
            budget_total: total,
            unlock_expires_at_ms: row ? row.expiresAt.getTime() : nextRefreshAtMs(currentHour)
          }
        };
      }

      if (!meetsRequirement(item, standings)) {
        return fail(403, {
          error: 'Your standing is too low for this intel.',
          code: 'clearance_too_low',
          required_standing: item.requiredStanding,
          required_standing_faction_id: item.requiredStandingFactionId
        });
      }
      const cost = costOf(item, clearance);
      if (expectedCostCredits !== cost) {
        return fail(409, { error: 'The price of this intel has changed.', code: 'price_changed', cost_credits: cost });
      }
      const budgetCost = budgetCostOf(item);
      if (total - budget.spent < budgetCost) {
        return fail(409, { error: 'You have no intel budget left this hour.', code: 'budget_exhausted', budget_remaining: Math.max(0, total - budget.spent), budget_total: total });
      }
      // A mission is unlocked once: a live or used unlock stands, an expired unused one is renewed below.
      const previous = voucherKind
        ? await tx.playerMissionUnlock.findUnique({ where: { playerId_missionId: { playerId, missionId: item.detail.mission_id } } })
        : null;
      if (previous && (previous.isAccepted || previous.expiresAt.getTime() > nowMs)) {
        return fail(409, { error: 'You already hold the unlock for this mission.', code: 'mission_already_unlocked' });
      }

      if (cost > 0) {
        const { count } = await tx.player.updateMany({ where: { id: playerId, credits: { gte: cost } }, data: { credits: { decrement: cost } } });
        if (count !== 1) {
          const player = await tx.player.findUnique({ where: { id: playerId }, select: { credits: true } });
          return fail(402, { error: `Insufficient credits: this intel costs ${cost}, balance is ${player?.credits ?? 0}.`, code: 'insufficient_credits', cost_credits: cost, credits: player?.credits ?? 0 });
        }
      }
      const spent = await spendBudget(tx, playerId, currentHour, intelId, budgetCost);

      let unlock = null;
      if (voucherKind) {
        const fields = {
          stationEntityId: receipt.dockedEntityId,
          intelId,
          category: item.category,
          systemH3: item.systemH3,
          voucherNonce: newVoucherNonce(),
          issuedAt: new Date(nowMs),
          expiresAt: unlockExpiryOf(nowMs),
          isAccepted: false
        };
        unlock = previous
          ? await tx.playerMissionUnlock.update({ where: { id: previous.id }, data: fields })
          : await tx.playerMissionUnlock.create({ data: { playerId, missionId: item.detail.mission_id, ...fields } });
      }
      const player = await tx.player.findUnique({ where: { id: playerId }, select: { credits: true } });
      return {
        body: {
          result: 'GATHER_INTEL_ITEM_RESULT_SUCCESS',
          item: view(true),
          ...(unlock && { voucher: voucherOf(unlock) }),
          credits_charged: cost,
          credits: player.credits,
          budget_remaining: Math.max(0, total - spent),
          budget_total: total,
          unlock_expires_at_ms: nowMs + DOSSIER_LIFETIME_MS
        }
      };
    });

    if (outcome.unknown) return unknown();
    if (outcome.failure) return reply.code(outcome.failure.status).send(outcome.failure.body);
    return outcome.body;
  });
}
