import { FACTION_IDS, FLYING_COLORS_MIN_REP } from '../../config/factions.js';
import { dockedReceiptRefusal, dockedReceiptSchema } from '../../lib/docked-receipt.js';
import { factionsClaim, renounceParagon } from '../../lib/reputation.js';
import { lockActiveShip, reissueToken, toLoadout } from '../../lib/ship.js';

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

const MESSAGES = {
  docked_receipt_required: 'Changing faction standing or colors requires a current docked receipt from the engine.',
  docked_receipt_invalid: 'The docked receipt is not valid for this pilot.',
  insufficient_reputation: `Flying a faction's colors requires a standing of at least ${FLYING_COLORS_MIN_REP} with it.`,
  not_paragon: 'The pilot is not the Paragon of this faction.'
};
const STATUS = { insufficient_reputation: 403, not_paragon: 409 };

// `{ error: <code>, message, ...details }`, the shape the faction routes answer refusals with.
const refusal = ({ code, ...details }) => ({ error: code, message: MESSAGES[code], ...details });

export default async function factionsRoutes(fastify) {
  const prisma = fastify.prisma;
  fastify.addHook('onRequest', fastify.authenticate);

  // Stateless, so a refusal changes nothing: the engine vouches the pilot is docked right now. An
  // expired receipt is answered like a missing one: either way the client must fetch a fresh one.
  function receiptRefusal(request) {
    const { dockedReceipt } = request.body;
    if (!dockedReceipt) return refusal({ code: 'docked_receipt_required' });
    const refused = dockedReceiptRefusal(dockedReceipt, {
      pilotId: request.user.sub,
      publicKey: fastify.claimKey.key,
      nowMs: Date.now(),
      log: request.log
    });
    if (!refused) return null;
    return refusal({ code: refused.code === 'docked_receipt_expired' ? 'docked_receipt_required' : refused.code });
  }

  const tokenFor = (request, ship, factions) =>
    reissueToken(fastify, request, toLoadout(ship.id, ship.components, ship.passengersAboard, ship.traits).ship_attributes, factions);

  // Flies a faction's colors (standing at least FLYING_COLORS_MIN_REP with it), or with a null
  // `factionId` stops, and answers with a token carrying the new `factions.active_colors`.
  fastify.post('/factions/colors', { schema: colorsSchema, preHandler: fastify.requireClaimKey }, async (request, reply) => {
    const refused = receiptRefusal(request);
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
    return { success: true, active_colors: factionId, factions: outcome.factions, token: tokenFor(request, outcome.ship, outcome.factions) };
  });

  // Gives up Paragon standing with a faction: it drops to NON_PARAGON_CAP_WHEN_PARAGON_ACTIVE, so
  // another faction may reach Paragon. Logged as RENOUNCE_PARAGON in the ReputationLedger.
  fastify.post('/factions/renounce-paragon', { schema: renounceSchema, preHandler: fastify.requireClaimKey }, async (request, reply) => {
    const refused = receiptRefusal(request);
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
      token: tokenFor(request, outcome.ship, outcome.factions)
    };
  });
}
