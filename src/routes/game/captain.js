import { TRAIT_IDS, traitUnlockRefusal } from '../../config/captain.js';
import { DOCKED_ENTITY_ID_PATTERN, dockedReceiptRefusal, dockedReceiptSchema } from '../../lib/docked-receipt.js';
import { captainView } from '../../lib/captain.js';
import { lockActiveShip, reissueToken, toLoadout } from '../../lib/ship.js';

// `dockedReceipt` is optional here on purpose: the route answers its absence with the coded 403
// `docked_receipt_required` rather than a generic schema 400. `stationId`, when sent, is the dock
// the client believes the ship is at; a receipt from any other dock is refused.
const traitSchema = {
  body: {
    type: 'object',
    required: ['traitId'],
    additionalProperties: false,
    properties: {
      traitId: { type: 'string', enum: TRAIT_IDS },
      stationId: { type: 'string', pattern: DOCKED_ENTITY_ID_PATTERN },
      dockedReceipt: dockedReceiptSchema
    }
  }
};

const MESSAGES = {
  docked_receipt_required: 'Unlocking a trait requires a current docked receipt from the engine.',
  docked_receipt_invalid: 'The docked receipt is not valid for this pilot.',
  docked_receipt_wrong_station: 'The docked receipt is for a different station.',
  trait_already_unlocked: 'This trait is already unlocked.',
  prerequisite_not_met: 'Not enough points are spent in this branch to unlock this trait.',
  no_trait_points: 'No trait points are available.'
};
const STATUS = { trait_already_unlocked: 409, prerequisite_not_met: 400, no_trait_points: 409 };

// `{ error: <code>, message, ...details }`, the shape the captain routes answer refusals with.
const refusal = ({ code, ...details }) => ({ error: code, message: MESSAGES[code], ...details });

export default async function captainRoutes(fastify) {
  const prisma = fastify.prisma;
  fastify.addHook('onRequest', fastify.authenticate);

  fastify.get('/captain', async (request) => {
    const ship = await prisma.$transaction((tx) => lockActiveShip(tx, request.user));
    return { captain: captainView(ship.captain) };
  });

  // Spends one trait point and answers with a token re-signed with the new ship attributes, which the
  // engine adopts while docked. Trait points are only spent in port, and the engine alone knows that.
  fastify.post('/captain/trait', { schema: traitSchema, preHandler: fastify.requireClaimKey }, async (request, reply) => {
    const { traitId, stationId, dockedReceipt } = request.body;
    const playerId = request.user.sub;

    // Stateless checks first, so a refusal changes nothing. An expired receipt is answered like a
    // missing one: either way the client must fetch a fresh one.
    if (!dockedReceipt) return reply.code(403).send(refusal({ code: 'docked_receipt_required' }));
    const receiptRefusal = dockedReceiptRefusal(dockedReceipt, {
      pilotId: playerId,
      publicKey: fastify.claimKey.key,
      nowMs: Date.now(),
      log: request.log
    });
    if (receiptRefusal) {
      const code = receiptRefusal.code === 'docked_receipt_expired' ? 'docked_receipt_required' : receiptRefusal.code;
      return reply.code(403).send(refusal({ code }));
    }
    if (stationId !== undefined && stationId !== dockedReceipt.dockedEntityId) {
      return reply.code(403).send(refusal({ code: 'docked_receipt_wrong_station' }));
    }

    // The pilot's lock serialises every unlock, so one point is never spent twice.
    const outcome = await prisma.$transaction(async (tx) => {
      const ship = await lockActiveShip(tx, request.user);
      const { captain, traits } = ship;
      const refused = traitUnlockRefusal(traitId, { level: captainView(captain).level, traitIds: traits });
      if (refused) return { refused };
      const unlockedTraits = [...traits, traitId];
      const updated = await tx.captain.update({ where: { id: captain.id }, data: { unlockedTraits } });
      return { ship, captain: updated, traits: unlockedTraits };
    });
    if (outcome.refused) return reply.code(STATUS[outcome.refused.code]).send(refusal(outcome.refused));

    const { ship } = outcome;
    const loadout = toLoadout(ship.id, ship.components, ship.passengersAboard, outcome.traits);
    return {
      captain: captainView(outcome.captain),
      ship_attributes: loadout.ship_attributes,
      token: reissueToken(fastify, request, loadout.ship_attributes, ship.factions)
    };
  });
}
