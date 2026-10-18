import { randomUUID } from 'node:crypto';
import { CARGO_LEASE_RETENTION_MS } from '../../config/cargo.js';
import { MAX_REWARD_CREDITS } from '../../config/missions.js';
import {
  CARGO_WRITE,
  applyCargoWrite,
  cargoManifestSchema,
  currentLease,
  saleRecordSchema,
  toStoredLots,
  usedM3,
  verifyCargoManifest,
  verifySaleRecord
} from '../../lib/cargo.js';
import { lockActiveShip, reissueToken, toLoadout } from '../../lib/ship.js';

const manifestSchema = {
  body: { type: 'object', required: ['manifest'], properties: { manifest: cargoManifestSchema } }
};

const sellSchema = {
  body: { type: 'object', required: ['saleRecord'], properties: { saleRecord: saleRecordSchema } }
};

const OVERFLOW = Symbol('credit-overflow');

// The client answers either 409 by flushing what it still holds, leasing again and reconnecting.
const REFUSALS = {
  [CARGO_WRITE.UNKNOWN]: { error: 'The cargo record names no lease of this pilot.', code: 'cargo_lease_unknown' },
  [CARGO_WRITE.SUPERSEDED]: {
    error: 'The cargo record was superseded by a newer lease or session; the stored hold is unchanged.',
    code: 'cargo_superseded'
  }
};

const holdView = (lease) => {
  const lots = lease?.lots ?? [];
  return { lease_id: lease?.id ?? null, generation: lease?.generation ?? 0, lots, used_m3: usedM3(lots) };
};

// The fencing position and hold an engine record carries, as `applyCargoWrite` takes it.
const writeOf = (record, lots) => ({ leaseId: record.leaseId, sessionId: record.sessionId, seq: record.seq, lots });

export default async function cargoRoutes(fastify) {
  const prisma = fastify.prisma;
  fastify.addHook('onRequest', fastify.authenticate);

  // The stored hold, for display while no engine session is connected.
  fastify.get('/cargo', async (request) => holdView(await currentLease(prisma, request.user.sub)));

  // Issues a new lease, which fences every earlier one, and a token carrying it: the engine loads
  // the hold from the token's `cargo` claim when a connection begins with it.
  fastify.post('/cargo/lease', async (request) => {
    const playerId = request.user.sub;
    const { ship, lease } = await prisma.$transaction(async (tx) => {
      const ship = await lockActiveShip(tx, request.user);
      const previous = await currentLease(tx, playerId);
      const lease = await tx.cargoLease.create({
        data: {
          id: randomUUID(),
          playerId,
          generation: (previous?.generation ?? 0) + 1,
          lots: previous?.lots ?? []
        }
      });
      await tx.cargoLease.deleteMany({
        where: { playerId, id: { not: lease.id }, issuedAt: { lt: new Date(Date.now() - CARGO_LEASE_RETENTION_MS) } }
      });
      return { ship, lease };
    });

    const { ship_attributes: shipAttributes } = toLoadout(ship.id, ship.components, ship.passengersAboard);
    const token = reissueToken(fastify, request, shipAttributes, { cargo: { lease_id: lease.id, lots: lease.lots } });
    return { token, cargo: holdView(lease) };
  });

  // A signed snapshot of the hold. Applied, it becomes the stored hold; a stale snapshot of the same
  // lineage changes nothing.
  fastify.post('/cargo/manifest', { schema: manifestSchema, preHandler: fastify.requireClaimKey }, async (request, reply) => {
    const { manifest } = request.body;
    if (manifest.pilotId !== request.user.sub || !verifyCargoManifest(manifest, fastify.claimKey.key)) {
      return reply.code(403).send({ error: 'The cargo manifest is not valid for this pilot.', code: 'cargo_manifest_invalid' });
    }

    const { outcome } = await prisma.$transaction(async (tx) => {
      await lockActiveShip(tx, request.user);
      return applyCargoWrite(tx, request.user.sub, writeOf(manifest, toStoredLots(manifest.lots)));
    });
    if (REFUSALS[outcome]) return reply.code(409).send(REFUSALS[outcome]);
    return { applied: outcome === CARGO_WRITE.APPLIED };
  });

  // A signed sale: credits `totalCredits` once, keyed by its nonce, and stores the remaining hold in
  // the same transaction. A replay answers with the first sale and the current balance.
  fastify.post('/cargo/sell', { schema: sellSchema, preHandler: fastify.requireClaimKey }, async (request, reply) => {
    const playerId = request.user.sub;
    const { saleRecord } = request.body;
    if (saleRecord.pilotId !== playerId || !verifySaleRecord(saleRecord, fastify.claimKey.key)) {
      return reply.code(403).send({ error: 'The sale record is not valid for this pilot.', code: 'sale_record_invalid' });
    }
    const nonce = Buffer.from(saleRecord.nonce, 'base64');

    let outcome;
    try {
      outcome = await prisma.$transaction(async (tx) => {
        await lockActiveShip(tx, request.user);
        // The lock serialises this lookup with every other sale of the pilot's.
        const sale = await tx.cargoSale.findUnique({ where: { nonce } });
        if (sale && sale.playerId !== playerId) {
          return { refusal: { error: 'Another pilot already redeemed this sale nonce.', code: 'sale_nonce_conflict' } };
        }
        if (!sale) {
          const { outcome: write } = await applyCargoWrite(tx, playerId, writeOf(saleRecord, toStoredLots(saleRecord.remaining)));
          if (REFUSALS[write]) return { refusal: REFUSALS[write] };
          // Guarded increment; throwing rolls back the stored hold with it, so the record stays
          // creditable once the balance allows.
          const { count } = await tx.player.updateMany({
            where: { id: playerId, credits: { lte: MAX_REWARD_CREDITS - saleRecord.totalCredits } },
            data: { credits: { increment: saleRecord.totalCredits } }
          });
          if (count !== 1) throw OVERFLOW;
          await tx.cargoSale.create({
            data: {
              playerId,
              nonce,
              leaseId: saleRecord.leaseId,
              seq: BigInt(saleRecord.seq),
              stationId: saleRecord.stationId,
              items: toStoredLots(saleRecord.items),
              totalCredits: saleRecord.totalCredits,
              soldAtMs: BigInt(saleRecord.soldAtMs)
            }
          });
        }
        const player = await tx.player.findUnique({ where: { id: playerId }, select: { credits: true } });
        const { lots } = holdView(await currentLease(tx, playerId));
        return {
          credits: player.credits,
          total_credits: sale?.totalCredits ?? saleRecord.totalCredits,
          lots,
          replayed: Boolean(sale)
        };
      });
    } catch (err) {
      if (err !== OVERFLOW) throw err;
      return reply.code(409).send({ error: 'The sale would overflow the credit balance.', code: 'credit_overflow' });
    }
    if (outcome.refusal) return reply.code(409).send(outcome.refusal);
    return outcome;
  });
}
