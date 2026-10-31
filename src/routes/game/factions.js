import { FACTION_IDS, FLYING_COLORS_MIN_REP } from '../../config/factions.js';
import { HAIL_INTENT_REQUEST_MINING_PERMIT, MINING_VIOLATION_MAX_FUTURE_SKEW_MS, miningPermitCost, standingTier } from '../../config/regulation.js';
import { stationLockoutRefusal } from '../../lib/customs.js';
import { dockedReceiptRefusal, dockedReceiptSchema } from '../../lib/docked-receipt.js';
import { hailReceiptSchema, isHailReceiptFresh, verifyHailReceipt } from '../../lib/hail-receipt.js';
import { activeMiningPermits, grantMiningPermit, permitView, redeemedMiningPermit } from '../../lib/mining-permits.js';
import { miningViolationSchema, verifyMiningViolation } from '../../lib/mining-violation.js';
import { factionsClaim, renounceParagon, standingsOf } from '../../lib/reputation.js';
import { lockActiveShip, reissueToken, toLoadout } from '../../lib/ship.js';
import { settleMiningViolation } from '../../lib/penalty-settlement.js';

// `dockedReceipt` is optional in both schemas on purpose: the routes answer its absence with the
// coded 403 `docked_receipt_required` rather than a generic schema 400.
const colorsSchema = {
  body: {
    type: 'object',
    required: ['factionId'],
    additionalProperties: false,
    properties: {
      // null stops flying colors.
      factionId: { enum: [...FACTION_IDS, null] },
      dockedReceipt: dockedReceiptSchema
    }
  }
};

const renounceSchema = {
  body: {
    type: 'object',
    required: ['currentParagonFactionId'],
    additionalProperties: false,
    properties: {
      currentParagonFactionId: { type: 'string', enum: FACTION_IDS },
      dockedReceipt: dockedReceiptSchema
    }
  }
};

const permitSchema = {
  body: {
    type: 'object',
    required: ['hailReceipt'],
    additionalProperties: false,
    properties: { hailReceipt: hailReceiptSchema }
  }
};

const violationSchema = {
  body: {
    type: 'object',
    required: ['notice'],
    additionalProperties: false,
    properties: { notice: miningViolationSchema }
  }
};

const MESSAGES = {
  docked_receipt_required: 'Changing faction standing or colors requires a current docked receipt from the engine.',
  docked_receipt_invalid: 'The docked receipt is not valid for this pilot.',
  insufficient_reputation: `Flying a faction's colors requires a standing of at least ${FLYING_COLORS_MIN_REP} with it.`,
  not_paragon: 'The pilot is not the Paragon of this faction.',
  hail_receipt_invalid: 'The hail receipt is not valid for this pilot.',
  hail_receipt_wrong_intent: 'The hail receipt was not issued for a mining permit.',
  hail_receipt_expired: 'The hail receipt has expired. Hail the station again and retry.',
  permit_not_required: 'An independent system needs no mining permit.',
  permit_denied_hostile: 'The faction will not sell a mining permit to a pilot it holds hostile.',
  permit_unaffordable: 'Not enough credits for the mining permit.',
  mining_violation_invalid: 'The mining violation notice is not valid for this pilot.'
};
const STATUS = {
  insufficient_reputation: 403, not_paragon: 409, hail_receipt_invalid: 403, hail_receipt_wrong_intent: 403,
  hail_receipt_expired: 403, permit_not_required: 409, permit_denied_hostile: 403, permit_unaffordable: 402,
  mining_violation_invalid: 403
};

// `{ error: <code>, message, ...details }`, the shape the faction routes answer refusals with.
const refusal = ({ code, ...details }) => ({ error: code, message: MESSAGES[code], ...details });

export default async function factionsRoutes(fastify) {
  const prisma = fastify.prisma;
  fastify.addHook('onRequest', fastify.authenticate);

  // Stateless, so a refusal changes nothing: the engine vouches the pilot is docked right now. An
  // expired receipt is answered like a missing one: either way the client must fetch a fresh one.
  async function receiptRefusal(request) {
    const { dockedReceipt } = request.body;
    if (!dockedReceipt) return refusal({ code: 'docked_receipt_required' });
    const refused = dockedReceiptRefusal(dockedReceipt, {
      pilotId: request.user.sub,
      publicKey: fastify.claimKey.key,
      nowMs: Date.now(),
      log: request.log
    });
    if (!refused) return stationLockoutRefusal(prisma, request.user.sub, dockedReceipt.dockedEntityId, Date.now());
    return refusal({ code: refused.code === 'docked_receipt_expired' ? 'docked_receipt_required' : refused.code });
  }

  const tokenFor = (request, ship, factions) =>
    reissueToken(fastify, request, toLoadout(ship.id, ship.components, ship.passengersAboard, ship.traits, ship.crew).ship_attributes, factions);

  // Flies a faction's colors (standing at least FLYING_COLORS_MIN_REP with it), or with a null
  // `factionId` stops, and answers with a token carrying the new `factions.active_colors`.
  fastify.post('/factions/colors', { schema: colorsSchema, preHandler: fastify.requireClaimKey }, async (request, reply) => {
    const refused = await receiptRefusal(request);
    if (refused) return reply.code(403).send(refused);
    const { factionId } = request.body;
    const playerId = request.user.sub;

    // The pilot's lock serialises the standing check with every change to it.
    const outcome = await prisma.$transaction(async (tx) => {
      const ship = await lockActiveShip(tx, request.user);
      const current = factionId && ship.factions[factionId];
      if (factionId && current < FLYING_COLORS_MIN_REP) {
        return { refused: { code: 'insufficient_reputation', required: FLYING_COLORS_MIN_REP, current } };
      }
      await tx.player.update({ where: { id: playerId }, data: { activeColorsFactionId: factionId } });
      return { ship, factions: { ...ship.factions, active_colors: factionId } };
    });
    if (outcome.refused) return reply.code(STATUS[outcome.refused.code]).send(refusal(outcome.refused));
    return { success: true, active_colors: factionId, factions: outcome.factions, token: await tokenFor(request, outcome.ship, outcome.factions) };
  });

  // Gives up Paragon standing with a faction: it drops to NON_PARAGON_CAP_WHEN_PARAGON_ACTIVE, so
  // another faction may reach Paragon. Logged as RENOUNCE_PARAGON in the ReputationLedger.
  fastify.post('/factions/renounce-paragon', { schema: renounceSchema, preHandler: fastify.requireClaimKey }, async (request, reply) => {
    const refused = await receiptRefusal(request);
    if (refused) return reply.code(403).send(refused);
    const factionId = request.body.currentParagonFactionId;
    const playerId = request.user.sub;

    const outcome = await prisma.$transaction(async (tx) => {
      const ship = await lockActiveShip(tx, request.user);
      const { renounced, current } = await renounceParagon(tx, playerId, factionId);
      if (renounced === undefined) return { refused: { code: 'not_paragon', factionId, current } };
      return { ship, standing: renounced, factions: await factionsClaim(tx, playerId) };
    });
    if (outcome.refused) return reply.code(STATUS[outcome.refused.code]).send(refusal(outcome.refused));
    return {
      success: true,
      [`${factionId}Score`]: outcome.standing,
      factions: outcome.factions,
      token: await tokenFor(request, outcome.ship, outcome.factions)
    };
  });

  // The pilot's mining permits that still run.
  fastify.get('/factions/mining-permits', async (request) => {
    const permits = await activeMiningPermits(prisma, request.user.sub, Date.now());
    return { permits: permits.map(permitView) };
  });

  // Buys a 2 hour mining permit for the system a station's signed hail receipt names (the pilot hailed that
  // station from space, within range, and the engine vouched for it). The price follows the pilot's standing with
  // the faction governing the system, read under the pilot's lock rather than from the token. Each receipt is
  // redeemed once (by its nonce, so also across the permit's expiry): a repeat of it is answered with its first
  // result, uncharged, while a further receipt buys the permit again, renewing one that still runs to 2 hours from
  // now. The station need not be docked at, but a customs lockout there still refuses the pilot.
  fastify.post('/factions/mining-permit', { schema: permitSchema, preHandler: fastify.requireClaimKey }, async (request, reply) => {
    const playerId = request.user.sub;
    const { hailReceipt } = request.body;
    const nowMs = Date.now();
    const fail = (code, details) => reply.code(STATUS[code]).send(refusal({ code, ...details }));

    if (hailReceipt.pilotId !== playerId || !verifyHailReceipt(hailReceipt, fastify.claimKey.key)) return fail('hail_receipt_invalid');
    if (hailReceipt.hailIntent !== HAIL_INTENT_REQUEST_MINING_PERMIT) return fail('hail_receipt_wrong_intent');
    if (!isHailReceiptFresh(hailReceipt, nowMs)) return fail('hail_receipt_expired');
    const lockout = await stationLockoutRefusal(prisma, playerId, hailReceipt.stationEntityId, nowMs);
    if (lockout) return reply.code(403).send(lockout);
    const { systemH3, controllingFactionId: factionId } = hailReceipt;
    const nonce = Buffer.from(hailReceipt.nonce, 'base64').toString('hex');
    if (!factionId) return fail('permit_not_required', { system_h3: systemH3 });

    const outcome = await prisma.$transaction(async (tx) => {
      const ship = await lockActiveShip(tx, request.user);
      const redeemed = await redeemedMiningPermit(tx, playerId, nonce);
      if (redeemed) return { ship, permit: redeemed, cost: 0, replayed: true };
      const standing = ship.factions[factionId];
      const cost = miningPermitCost(standing, factionId, ship.factions.active_colors);
      if (cost === null) return { refused: { code: 'permit_denied_hostile', faction_id: factionId, standing, tier: standingTier(standing) } };
      if (cost > 0) {
        const { count } = await tx.player.updateMany({ where: { id: playerId, credits: { gte: cost } }, data: { credits: { decrement: cost } } });
        if (count !== 1) {
          const { credits } = await tx.player.findUnique({ where: { id: playerId }, select: { credits: true } });
          return { refused: { code: 'permit_unaffordable', cost_credits: cost, credits } };
        }
      }
      const permit = await grantMiningPermit(tx, playerId, systemH3, factionId, nowMs, nonce);
      return { ship, permit, cost, replayed: false, tier: standingTier(standing) };
    });
    if (outcome.refused) return fail(outcome.refused.code, outcome.refused);

    // Read after the commit so the token and balance are as the transaction left them; a failure here cannot undo it.
    const { credits } = await prisma.player.findUnique({ where: { id: playerId }, select: { credits: true } });
    const factions = await factionsClaim(prisma, playerId);
    return {
      success: true,
      replayed: outcome.replayed,
      permit: permitView(outcome.permit),
      cost_credits: outcome.cost,
      credits,
      factions,
      token: await tokenFor(request, outcome.ship, factions)
    };
  });

  // Applies a mining violation notice the engine signed when the pilot's Patrol Alert filled, once per nonce: the
  // faction governing the system takes MINING_VIOLATION_REPUTATION off the pilot's standing, and the pilot's
  // transponder is flagged for a mandatory customs inspection at that faction's docks for an hour from issuance, signed
  // into the token's `factions.customs_flagged_*` so a reconnect cannot shed it. A late notice still settles once,
  // but cannot revive a citation whose signed hour has already elapsed; a replay changes nothing and answers with
  // the first result and the pilot's standings now.
  fastify.post('/factions/mining-violation', { schema: violationSchema, preHandler: fastify.requireClaimKey }, async (request, reply) => {
    const playerId = request.user.sub;
    const { notice } = request.body;
    const nowMs = Date.now();
    if (notice.pilotId !== playerId || !verifyMiningViolation(notice, fastify.claimKey.key)
        || notice.issuedAtMs > nowMs + MINING_VIOLATION_MAX_FUTURE_SKEW_MS) {
      return reply.code(STATUS.mining_violation_invalid).send(refusal({ code: 'mining_violation_invalid' }));
    }
    const outcome = await settleMiningViolation({ prisma, fastify, playerId, notice, nowMs });
    if (outcome.failure) return reply.code(outcome.failure.status).send(outcome.failure.body);

    const { credits } = await prisma.player.findUnique({ where: { id: playerId }, select: { credits: true } });
    const factions = await factionsClaim(prisma, playerId);
    return {
      success: true,
      replayed: outcome.replayed,
      faction_id: outcome.row.factionId,
      system_h3: outcome.row.systemH3,
      reputation_change: outcome.row.reputationChange,
      flagged_until_ms: outcome.row.flaggedUntil.getTime(),
      credits,
      standings: await standingsOf(prisma, playerId),
      factions,
      token: await tokenFor(request, outcome.ship, factions)
    };
  });
}
