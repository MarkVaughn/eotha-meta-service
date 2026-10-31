import { CUSTOMS_FLAG_MS, MINING_VIOLATION_REPUTATION } from '../config/regulation.js';
import { applyCustomsSeizure } from './customs.js';
import { buildEnforcementProjection } from './enforcement-projection.js';
import { LEDGER_REASONS, adjustReputation } from './reputation.js';
import { lockActiveShip } from './ship.js';
import { EnforcementProjection } from './contracts/penalty.js';

const retryOnUniqueViolation = async (run) => {
  try {
    return await run();
  } catch (err) {
    if (err?.code !== 'P2002') throw err;
    return run(); // A concurrent transaction won a nonce; replay its committed result.
  }
};

async function lockedShipForPlayer(tx, playerId) {
  const player = await tx.player.findUnique({ where: { id: playerId }, select: { callsign: true } });
  if (!player) return null;
  return lockActiveShip(tx, { sub: playerId, callsign: player.callsign });
}

async function recordAuthorityUpdate(tx, fastify, playerId, source, nowMs) {
  const player = await tx.player.update({
    where: { id: playerId },
    data: { authorityRevision: { increment: 1 }, authorityNotBeforeMs: BigInt(nowMs) },
    select: { authorityRevision: true }
  });
  const projection = await buildEnforcementProjection(tx, playerId, { nowMs, revision: player.authorityRevision });
  const signedProjection = fastify.signEnforcementProjection(projection);
  const payload = Buffer.from(EnforcementProjection.encode(signedProjection).finish());
  await tx.authorityProjection.create({ data: { playerId, authorityRevision: player.authorityRevision, payload } });
  await tx.authorityUpdateOutbox.create({ data: { playerId, authorityRevision: player.authorityRevision, projection: payload } });
  await source.update(player.authorityRevision);
  return { authorityRevision: player.authorityRevision, projection: signedProjection };
}

async function projectionForDuplicate(tx, fastify, playerId, authorityRevision, nowMs) {
  const stored = await tx.authorityProjection.findUnique({ where: { playerId_authorityRevision: { playerId, authorityRevision } } });
  if (stored) return EnforcementProjection.decode(stored.payload);
  // Backfilled pre-delivery rows have a revision but no historical payload. They were settled before
  // projections existed, so return a fresh complete view signed at their backfilled revision.
  return fastify.signEnforcementProjection(await buildEnforcementProjection(tx, playerId, { nowMs, revision: authorityRevision }));
}

/** Shared customs settlement for the public compatibility relay and the private consumer. */
export async function settleCustomsSeizure({ prisma, fastify, playerId, claim, nowMs = Date.now() }) {
  return retryOnUniqueViolation(() => prisma.$transaction(async (tx) => {
    const ship = await lockedShipForPlayer(tx, playerId);
    if (!ship) return { failure: { status: 404, body: { error: 'Pilot does not exist.', code: 'pilot_not_found' } } };
    const outcome = await applyCustomsSeizure(tx, { playerId, ship, claim, nowMs });
    if (outcome.failure) return outcome;
    const nonce = Buffer.from(claim.nonce, 'base64').toString('hex');
    if (outcome.replayed) {
      const row = await tx.customsSeizure.findUnique({ where: { playerId_nonce: { playerId, nonce } }, select: { authorityRevision: true } });
      const authorityRevision = row?.authorityRevision ?? 0n;
      return { ...outcome, authorityRevision, projection: await projectionForDuplicate(tx, fastify, playerId, authorityRevision, nowMs) };
    }
    const authority = await recordAuthorityUpdate(tx, fastify, playerId, {
      update: (authorityRevision) => tx.customsSeizure.update({ where: { playerId_nonce: { playerId, nonce } }, data: { authorityRevision } })
    }, nowMs);
    return { ...outcome, ...authority };
  }));
}

/** Shared mining-violation settlement for the public compatibility relay and the private consumer. */
export async function settleMiningViolation({ prisma, fastify, playerId, notice, nowMs = Date.now() }) {
  return retryOnUniqueViolation(() => prisma.$transaction(async (tx) => {
    const ship = await lockedShipForPlayer(tx, playerId);
    if (!ship) return { failure: { status: 404, body: { error: 'Pilot does not exist.', code: 'pilot_not_found' } } };
    const nonce = Buffer.from(notice.nonce, 'base64').toString('hex');
    const previous = await tx.miningViolation.findUnique({ where: { playerId_nonce: { playerId, nonce } } });
    if (previous) {
      const authorityRevision = previous.authorityRevision ?? 0n;
      return { ship, row: previous, replayed: true, authorityRevision, projection: await projectionForDuplicate(tx, fastify, playerId, authorityRevision, nowMs) };
    }
    const factionId = notice.controllingFactionId;
    const before = ship.factions[factionId];
    const after = await adjustReputation(tx, playerId, factionId, MINING_VIOLATION_REPUTATION, { reason: LEDGER_REASONS.MINING_VIOLATION });
    const current = await tx.player.findUnique({ where: { id: playerId }, select: { customsFlaggedUntil: true, customsFlaggedFactionId: true } });
    const running = (current?.customsFlaggedUntil?.getTime() ?? 0) > nowMs;
    const flaggedUntil = new Date(Math.max(nowMs + CUSTOMS_FLAG_MS, current?.customsFlaggedUntil?.getTime() ?? 0));
    const flaggedFactionId = running && current.customsFlaggedFactionId !== factionId ? null : factionId;
    await tx.player.update({ where: { id: playerId }, data: { customsFlaggedFactionId: flaggedFactionId, customsFlaggedUntil: flaggedUntil } });
    const row = await tx.miningViolation.create({
      data: {
        playerId, nonce, systemH3: notice.systemH3, factionId, issuedAtMs: BigInt(notice.issuedAtMs),
        reputationChange: after - before, flaggedUntil
      }
    });
    const authority = await recordAuthorityUpdate(tx, fastify, playerId, {
      update: (authorityRevision) => tx.miningViolation.update({ where: { playerId_nonce: { playerId, nonce } }, data: { authorityRevision } })
    }, nowMs);
    return { ship, row, replayed: false, ...authority };
  }));
}
