import { randomUUID } from 'node:crypto';
import { MAX_REWARD_CREDITS } from '../../config/missions.js';
import {
  CARGO_REFUSALS,
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
import { SETTLEMENT } from '../../config/crew-morale.js';
import { deductCrewRevenueShare, payrollCrewOf, recordCrewSettlement } from '../../lib/crew.js';
import { lockActiveShip, reissueToken, toLoadout } from '../../lib/ship.js';
import { dockedReceiptRefusal, dockedReceiptSchema } from '../../lib/docked-receipt.js';
import { recordCrewDock } from '../../lib/crew-docking.js';

const manifestSchema = {
  body: { type: 'object', required: ['manifest'], properties: { manifest: cargoManifestSchema } }
};

const sellSchema = {
  body: {
    type: 'object',
    required: ['saleRecord'],
    // `deferCrewPay` takes the whole sale and owes the crew their cut (see POST /game/crew/pay-arrears).
    properties: { saleRecord: saleRecordSchema, deferCrewPay: { type: 'boolean', default: false }, dockedReceipt: dockedReceiptSchema }
  }
};

const OVERFLOW = Symbol('credit-overflow');

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
      return { ship, lease };
    });

    const { ship_attributes: shipAttributes } = toLoadout(ship.id, ship.components, ship.passengersAboard, ship.traits, ship.crew);
    const token = await reissueToken(fastify, request, shipAttributes, ship.factions, { cargo: { lease_id: lease.id, lots: lease.lots } });
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
    if (CARGO_REFUSALS[outcome]) return reply.code(409).send(CARGO_REFUSALS[outcome]);
    return { applied: outcome === CARGO_WRITE.APPLIED };
  });

  // A signed sale: credits `totalCredits` less the crew's share once, keyed by its nonce, and stores
  // the remaining hold in the same transaction. A replay answers with the first sale, its split and
  // the current balance.
  fastify.post('/cargo/sell', { schema: sellSchema, preHandler: fastify.requireClaimKey }, async (request, reply) => {
    const playerId = request.user.sub;
    const { saleRecord, deferCrewPay, dockedReceipt } = request.body;
    if (dockedReceipt) {
      const refused = dockedReceiptRefusal(dockedReceipt, { pilotId: playerId, publicKey: fastify.claimKey.key, nowMs: Date.now(), log: request.log });
      if (refused) return reply.code(403).send(refused);
    }
    if (saleRecord.pilotId !== playerId || !verifySaleRecord(saleRecord, fastify.claimKey.key)) {
      return reply.code(403).send({ error: 'The sale record is not valid for this pilot.', code: 'sale_record_invalid' });
    }
    const nonce = Buffer.from(saleRecord.nonce, 'base64');

    let outcome;
    try {
      outcome = await prisma.$transaction(async (tx) => {
        let ship = await lockActiveShip(tx, request.user);
        // The lock serialises this lookup with every other sale of the pilot's.
        const sale = await tx.cargoSale.findUnique({ where: { nonce } });
        if (sale && sale.playerId !== playerId) {
          return { refusal: { error: 'Another pilot already redeemed this sale nonce.', code: 'sale_nonce_conflict' } };
        }
        let split;
        let settled;
        let docking;
        if (!sale) {
          const { outcome: write } = await applyCargoWrite(tx, playerId, writeOf(saleRecord, toStoredLots(saleRecord.remaining)));
          if (CARGO_REFUSALS[write]) return { refusal: CARGO_REFUSALS[write] };
          // The crew aboard take their share of the signed total; the pilot is credited the rest.
          // Guarded increment; throwing rolls back the stored hold with it, so the record stays
          // creditable once the balance allows.
          const payroll = await payrollCrewOf(tx, playerId, ship);
          split = deductCrewRevenueShare(payroll, ship.traits, saleRecord.totalCredits, { deferred: deferCrewPay });
          const { count } = await tx.player.updateMany({
            where: { id: playerId, credits: { lte: MAX_REWARD_CREDITS - split.netCredits } },
            data: { credits: { increment: split.netCredits } }
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
              crewShareCredits: split.crewShareCredits,
              soldAtMs: BigInt(saleRecord.soldAtMs)
            }
          });
          settled = await recordCrewSettlement(tx, ship, payroll, {
            settlement: { kind: SETTLEMENT.CARGO_SALE }, payout: split, deferred: deferCrewPay
          });
          ship = { ...ship, crew: settled.crew };
          if (dockedReceipt) ({ ship, docking } = await recordCrewDock(tx, ship, dockedReceipt, { payoutSettled: true }));
        }
        const player = await tx.player.findUnique({ where: { id: playerId }, select: { credits: true } });
        const { lots } = holdView(await currentLease(tx, playerId));
        // `total_credits` is the signed gross. A replay does not list the crew's payouts: only the
        // total share is kept with the sale.
        const grossCredits = sale?.totalCredits ?? saleRecord.totalCredits;
        const crewShareCredits = sale?.crewShareCredits ?? split.crewShareCredits;
        return {
          credits: player.credits,
          total_credits: grossCredits,
          grossCredits,
          crewShareCredits,
          netCredits: grossCredits - crewShareCredits,
          ...(split && { crewPayouts: split.crewPayouts }),
          ...(split?.deferredCrewShareCredits !== undefined && { deferredCrewShareCredits: split.deferredCrewShareCredits }),
          ...(settled?.effects.length && { crew_morale: settled.effects, ship }),
          ...(docking && { docking, ship }),
          lots,
          replayed: Boolean(sale)
        };
      });
    } catch (err) {
      if (err !== OVERFLOW) throw err;
      return reply.code(409).send({ error: 'The sale would overflow the credit balance.', code: 'credit_overflow' });
    }
    if (outcome.refusal) return reply.code(409).send(outcome.refusal);
    // Morale moved: the token carries the crew as it now stands.
    const { ship, ...body } = outcome;
    return ship ? {
      ...body,
      token: await reissueToken(fastify, request, toLoadout(ship.id, ship.components, ship.passengersAboard, ship.traits, ship.crew).ship_attributes, ship.factions)
    } : body;
  });
}
