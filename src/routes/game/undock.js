import { recordFlakyDeparture } from '../../lib/crew-docking.js';
import { lockActiveShip, reissueToken, toLoadout } from '../../lib/ship.js';
import { isUndockReceiptFresh, undockReceiptNonceKey, undockReceiptSchema, verifyUndockReceipt } from '../../lib/undock-receipt.js';

const undockSchema = {
  body: {
    type: 'object',
    required: ['undockReceipt'],
    additionalProperties: false,
    properties: { undockReceipt: undockReceiptSchema }
  }
};

// Applies the engine's signed proof that the pilot cast off from a station or outpost: the one place the FLAKY
// departure roll happens, so a mining-only departure rolls as a mission one does and no departure rolls twice. The
// receipt is single-use per (player, nonce): a repeat answers what the first did and changes nothing.
export default async function undockRoutes(fastify) {
  const prisma = fastify.prisma;
  fastify.addHook('onRequest', fastify.authenticate);

  fastify.post('/ship/undock', { schema: undockSchema, preHandler: fastify.requireClaimKey }, async (request, reply) => {
    const { undockReceipt: receipt } = request.body;
    const playerId = request.user.sub;
    const nowMs = Date.now();

    // Stateless checks first, so a refused receipt touches nothing.
    if (receipt.pilotId !== playerId || !verifyUndockReceipt(receipt, fastify.claimKey.key)) {
      return reply.code(403).send({ error: 'The undock receipt is not valid for this pilot.', code: 'undock_receipt_invalid' });
    }
    const nonce = undockReceiptNonceKey(receipt);

    const outcome = await prisma.$transaction(async (tx) => {
      const ship = await lockActiveShip(tx, request.user);
      // The pilot lock serialises this lookup with every other apply of the pilot's, so a nonce is applied once.
      const previous = await tx.undockRecord.findUnique({ where: { playerId_nonce: { playerId, nonce } } });
      if (previous) {
        return { ship, departed: previous.departedCrewIds, undockedAtMs: Number(previous.undockedAtMs), replayed: true };
      }
      // A replay is answered above even once its window has passed; only a first application must be fresh.
      if (!isUndockReceiptFresh(receipt, nowMs)) {
        return { failure: { error: 'The undock receipt has expired. Request it again and retry.', code: 'undock_receipt_expired' } };
      }
      const flaky = await recordFlakyDeparture(tx, ship, { dockedEntityId: receipt.stationEntityId }, receipt.undockedAtMs);
      const undockedAt = BigInt(receipt.undockedAtMs);
      // Flight runs from the latest cast-off; a receipt relayed out of order never moves it back.
      const latest = ship.lastCrewUndockedAtMs != null && ship.lastCrewUndockedAtMs > undockedAt ? ship.lastCrewUndockedAtMs : undockedAt;
      await tx.spaceship.update({ where: { id: ship.id }, data: { lastCrewUndockedAtMs: latest } });
      await tx.undockRecord.create({
        data: {
          playerId,
          stationId: receipt.stationEntityId,
          systemH3: receipt.systemH3,
          controllingFactionId: receipt.controllingFactionId,
          dockedAtMs: BigInt(receipt.dockedAtMs),
          undockedAtMs: undockedAt,
          nonce,
          departedCrewIds: flaky.departed
        }
      });
      return { ship: flaky.ship, departed: flaky.departed, undockedAtMs: receipt.undockedAtMs, replayed: false };
    });

    if (outcome.failure) return reply.code(403).send(outcome.failure);
    const { ship } = outcome;
    // A replay's ship is as it stands now: crew a first application removed are already gone from it.
    const { ship_attributes } = toLoadout(ship.id, ship.components, ship.passengersAboard, ship.traits, ship.crew);
    return {
      undocked_at_ms: outcome.undockedAtMs,
      departed_crew: outcome.departed,
      replayed: outcome.replayed,
      token: await reissueToken(fastify, request, ship_attributes, ship.factions)
    };
  });
}
