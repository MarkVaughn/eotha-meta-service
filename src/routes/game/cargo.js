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
import { amnestyFee } from '../../config/regulation.js';
import { deductCrewRevenueShare, oreSaleBonusCredits, payrollCrewOf, recordCrewSettlement } from '../../lib/crew.js';
import { lockActiveShip, reissueToken, toLoadout } from '../../lib/ship.js';
import { stationLockoutRefusal } from '../../lib/customs.js';
import { dockedReceiptRefusal, dockedReceiptSchema } from '../../lib/docked-receipt.js';
import { recordCrewDock } from '../../lib/crew-docking.js';
import { awardDomesticOre, domesticOre, needsStationProof } from '../../lib/domestic-sale.js';
import { planExportClearance } from '../../lib/export-toll.js';
import { runningMiningPermit } from '../../lib/mining-permits.js';
import { factionsClaim } from '../../lib/reputation.js';

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

// `dockedReceipt` is optional in the schema so that the route answers its absence with the coded 403.
const clearExportSchema = {
  body: { type: 'object', additionalProperties: false, properties: { dockedReceipt: dockedReceiptSchema } }
};

const STATION_PROOF_REFUSALS = Object.freeze({
  missing: { error: 'Selling ore poached from a faction system needs a docked receipt for the station.', code: 'docked_receipt_required' },
  wrong: { error: 'The docked receipt is for another station than the sale.', code: 'docked_receipt_wrong_station' }
});

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

  // A signed sale: credits `totalCredits` (plus the active Quartermaster's bonus) less the crew's share
  // once, keyed by its nonce, and stores the remaining hold in the same transaction. A replay answers
  // with the first sale, its bonus and split and the current balance.
  fastify.post('/cargo/sell', { schema: sellSchema, preHandler: fastify.requireClaimKey }, async (request, reply) => {
    const playerId = request.user.sub;
    const { saleRecord, deferCrewPay, dockedReceipt } = request.body;
    if (dockedReceipt) {
      const refused = dockedReceiptRefusal(dockedReceipt, { pilotId: playerId, publicKey: fastify.claimKey.key, nowMs: Date.now(), log: request.log });
      if (refused) return reply.code(403).send(refused);
      const lockout = await stationLockoutRefusal(prisma, playerId, dockedReceipt.dockedEntityId, Date.now());
      if (lockout) return reply.code(403).send(lockout);
    }
    // The sale is made at the station the record names, whatever receipt (if any) came with it.
    const saleLockout = await stationLockoutRefusal(prisma, playerId, saleRecord.stationId, Date.now());
    if (saleLockout) return reply.code(403).send(saleLockout);
    if (saleRecord.pilotId !== playerId || !verifySaleRecord(saleRecord, fastify.claimKey.key)) {
      return reply.code(403).send({ error: 'The sale record is not valid for this pilot.', code: 'sale_record_invalid' });
    }
    const nonce = Buffer.from(saleRecord.nonce, 'base64');
    const nowMs = Date.now();
    // What the docked receipt proves about the station the sale is made at: its system and the faction governing
    // it. A receipt for another station proves nothing about this one.
    const station = dockedReceipt && dockedReceipt.dockedEntityId === saleRecord.stationId.toLowerCase()
      ? { systemH3: dockedReceipt.systemH3, factionId: dockedReceipt.controllingFactionId }
      : null;

    let outcome;
    try {
      outcome = await prisma.$transaction(async (tx) => {
        let ship = await lockActiveShip(tx, request.user);
        // The lock serialises this lookup with every other sale of the pilot's.
        const sale = await tx.cargoSale.findUnique({ where: { nonce } });
        if (sale && sale.playerId !== playerId) {
          return { refusal: { error: 'Another pilot already redeemed this sale nonce.', code: 'sale_nonce_conflict' } };
        }
        // Poached ore of a faction's system is sold only with proof of the station it is sold at, or the amnesty
        // could be dodged by leaving the receipt out. A replay is exempt: it credits nothing.
        if (!sale && !station && needsStationProof(saleRecord.items)) {
          return dockedReceipt ? { forbidden: STATION_PROOF_REFUSALS.wrong } : { forbidden: STATION_PROOF_REFUSALS.missing };
        }
        let split;
        let settled;
        let docking;
        let bonusCredits = 0;
        let amnestyCredits = 0;
        let domesticReputation = 0;
        if (!sale) {
          const { outcome: write } = await applyCargoWrite(tx, playerId, writeOf(saleRecord, toStoredLots(saleRecord.remaining)));
          if (CARGO_REFUSALS[write]) return { refusal: CARGO_REFUSALS[write] };
          const domestic = domesticOre(saleRecord.items, station);
          // The amnesty (design-factions §7.3): poached ore sold where it was mined is not seized, the permit it
          // should have had plus a late surcharge comes off the proceeds instead, never more than the proceeds.
          // A pilot who holds a permit for the system now has paid it and owes nothing.
          if (domestic.poached && !await runningMiningPermit(tx, playerId, station.systemH3, nowMs)) {
            const fee = amnestyFee(ship.factions[station.factionId], station.factionId, ship.factions.active_colors);
            amnestyCredits = Math.min(fee, saleRecord.totalCredits);
          }
          const proceeds = saleRecord.totalCredits - amnestyCredits;
          // The crew aboard take their share of the proceeds; the pilot is credited the rest.
          // Guarded increment; throwing rolls back the stored hold with it, so the record stays
          // creditable once the balance allows.
          const payroll = await payrollCrewOf(tx, playerId, ship);
          // The Quartermaster's bonus is paid on top of the proceeds, so the crew share it too.
          bonusCredits = oreSaleBonusCredits(ship.crew, proceeds);
          split = deductCrewRevenueShare(payroll, ship.traits, proceeds + bonusCredits, { deferred: deferCrewPay });
          const { count } = await tx.player.updateMany({
            where: { id: playerId, credits: { lte: MAX_REWARD_CREDITS - split.netCredits } },
            data: { credits: { increment: split.netCredits } }
          });
          if (count !== 1) throw OVERFLOW;
          // Domestic ore earns the governing faction's standing (one point per 50 units), once per sale.
          if (domestic.reputationMilli > 0) {
            domesticReputation = await awardDomesticOre(tx, playerId, station.factionId, domestic.reputationMilli, ship.factions[station.factionId]);
          }
          await tx.cargoSale.create({
            data: {
              playerId,
              nonce,
              leaseId: saleRecord.leaseId,
              seq: BigInt(saleRecord.seq),
              stationId: saleRecord.stationId,
              items: toStoredLots(saleRecord.items),
              totalCredits: proceeds + bonusCredits,
              crewShareCredits: split.crewShareCredits,
              amnestyCredits,
              domesticReputation,
              soldAtMs: BigInt(saleRecord.soldAtMs)
            }
          });
          settled = await recordCrewSettlement(tx, ship, payroll, {
            settlement: { kind: SETTLEMENT.CARGO_SALE }, payout: split, deferred: deferCrewPay
          });
          ship = { ...ship, crew: settled.crew };
          if (dockedReceipt) ({ ship, docking } = await recordCrewDock(tx, ship, dockedReceipt, { payoutSettled: true }));
          // The token carries the standings, so it is reissued with them as they now stand.
          if (domesticReputation !== 0) ship = { ...ship, factions: await factionsClaim(tx, playerId) };
        } else {
          amnestyCredits = sale.amnestyCredits;
          domesticReputation = sale.domesticReputation;
        }
        const player = await tx.player.findUnique({ where: { id: playerId }, select: { credits: true } });
        const { lots } = holdView(await currentLease(tx, playerId));
        // `total_credits` is the gross credited: the signed total less the amnesty, and the Quartermaster's bonus,
        // which a replay finds as what the stored gross holds beyond the signed total less the amnesty. A replay
        // does not list the crew's payouts: only the total share is kept with the sale.
        const grossCredits = sale?.totalCredits ?? saleRecord.totalCredits - amnestyCredits + bonusCredits;
        if (sale) bonusCredits = Math.max(0, sale.totalCredits - (saleRecord.totalCredits - amnestyCredits));
        const crewShareCredits = sale?.crewShareCredits ?? split.crewShareCredits;
        return {
          credits: player.credits,
          total_credits: grossCredits,
          grossCredits,
          crewShareCredits,
          netCredits: grossCredits - crewShareCredits,
          ...(bonusCredits > 0 && { oreSaleBonusCredits: bonusCredits }),
          ...(amnestyCredits > 0 && { amnestyCredits }),
          ...(domesticReputation !== 0 && { domesticReputation }),
          ...(split && { crewPayouts: split.crewPayouts }),
          ...(split?.deferredCrewShareCredits !== undefined && { deferredCrewShareCredits: split.deferredCrewShareCredits }),
          ...(settled?.effects.length && { crew_morale: settled.effects, ship }),
          ...(docking && { docking, ship }),
          ...(domesticReputation !== 0 && !sale && { ship }),
          lots,
          replayed: Boolean(sale)
        };
      });
    } catch (err) {
      if (err !== OVERFLOW) throw err;
      return reply.code(409).send({ error: 'The sale would overflow the credit balance.', code: 'credit_overflow' });
    }
    if (outcome.forbidden) return reply.code(403).send(outcome.forbidden);
    if (outcome.refusal) return reply.code(409).send(outcome.refusal);
    // Morale moved: the token carries the crew as it now stands.
    const { ship, ...body } = outcome;
    return ship ? {
      ...body,
      token: await reissueToken(fastify, request, toLoadout(ship.id, ship.components, ship.passengersAboard, ship.traits, ship.crew).ship_attributes, ship.factions)
    } : body;
  });

  // Pays the export toll on the ore in the stored hold that was mined in the system of the station the pilot is docked
  // at, which that system's faction regulates, and marks it EXPORT_CLEARED (design-factions §7.3). The toll is a share of
  // the ore's baseline market value that follows the pilot's standing with the faction, read under the pilot's lock.
  // Ore that is already cleared, was mined elsewhere or under a permit needs no clearing and is left alone.
  //
  // The cleared hold becomes a new lease, like POST /game/cargo/lease, and the answer carries the token with its
  // `cargo` claim: a lease that merely changed in place would be overwritten by the engine session's next record, which
  // still holds the ore uncleared. The client reconnects with the token, which fences the old session out.
  fastify.post('/cargo/clear-export', { schema: clearExportSchema, preHandler: fastify.requireClaimKey }, async (request, reply) => {
    const playerId = request.user.sub;
    const { dockedReceipt } = request.body;
    if (!dockedReceipt) {
      return reply.code(403).send({ error: 'Clearing an export requires a current docked receipt from the engine.', code: 'docked_receipt_required' });
    }
    const nowMs = Date.now();
    const refused = dockedReceiptRefusal(dockedReceipt, { pilotId: playerId, publicKey: fastify.claimKey.key, nowMs, log: request.log });
    if (refused) return reply.code(403).send(refused);
    const lockout = await stationLockoutRefusal(prisma, playerId, dockedReceipt.dockedEntityId, nowMs);
    if (lockout) return reply.code(403).send(lockout);
    const { systemH3, controllingFactionId: factionId } = dockedReceipt;
    if (!factionId) {
      return reply.code(409).send({ error: 'This station is in an independent system, which levies no export toll.', code: 'export_not_regulated' });
    }

    const outcome = await prisma.$transaction(async (tx) => {
      const ship = await lockActiveShip(tx, request.user);
      const previous = await currentLease(tx, playerId);
      const plan = planExportClearance(previous?.lots ?? [], {
        systemH3, factionId, standing: ship.factions[factionId], activeColors: ship.factions.active_colors
      });
      if (plan.cleared === 0) {
        return { refusal: { error: 'The hold has no ore from this system awaiting export clearance.', code: 'nothing_to_clear' } };
      }
      if (plan.tollCredits > 0) {
        const { count } = await tx.player.updateMany({
          where: { id: playerId, credits: { gte: plan.tollCredits } },
          data: { credits: { decrement: plan.tollCredits } }
        });
        if (count !== 1) {
          const { credits } = await tx.player.findUnique({ where: { id: playerId }, select: { credits: true } });
          return { refusal: { error: 'Not enough credits for the export toll.', code: 'toll_unaffordable', toll_credits: plan.tollCredits, credits } };
        }
      }
      const lease = await tx.cargoLease.create({
        data: { id: randomUUID(), playerId, generation: previous.generation + 1, lots: plan.lots }
      });
      const { credits } = await tx.player.findUnique({ where: { id: playerId }, select: { credits: true } });
      // Signed inside the transaction: if building the answer fails, the toll and the new lease roll back with it.
      const { ship_attributes: shipAttributes } = toLoadout(ship.id, ship.components, ship.passengersAboard, ship.traits, ship.crew);
      const token = await reissueToken(fastify, request, shipAttributes, ship.factions, { cargo: { lease_id: lease.id, lots: lease.lots } });
      return { plan, lease, credits, token };
    });
    if (outcome.refusal) return reply.code(outcome.refusal.code === 'toll_unaffordable' ? 402 : 409).send(outcome.refusal);

    const { plan, lease, credits, token } = outcome;
    return {
      success: true,
      system_h3: systemH3,
      faction_id: factionId,
      cleared_lots: plan.cleared,
      value_credits: plan.valueCredits,
      toll_bp: plan.tollBp,
      toll_credits: plan.tollCredits,
      credits,
      cargo: holdView(lease),
      token
    };
  });
}
