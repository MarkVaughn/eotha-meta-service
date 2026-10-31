import { EnforcementProjection } from './contracts/penalty.js';

const toWireUint64 = (value) => BigInt(value ?? 0).toString();

/**
 * Builds the complete, sorted meta-owned enforcement view. Station lockouts are stored by station
 * in the existing model; their station ids occupy the contract's legacy `faction_id` slot so the
 * RTSE keeps the already-established station-scoped enforcement semantics.
 */
export async function buildEnforcementProjection(db, playerId, { nowMs = Date.now(), revision } = {}) {
  const now = new Date(nowMs);
  const player = await db.player.findUnique({
    where: { id: playerId },
    select: { authorityRevision: true, authorityNotBeforeMs: true, activeColorsFactionId: true }
  });
  if (!player) return null;
  const [lockouts, citations, standings] = await Promise.all([
    db.stationLockout.findMany({ where: { playerId, until: { gt: now } }, orderBy: [{ stationId: 'asc' }, { until: 'asc' }] }),
    db.miningViolation.findMany({ where: { playerId, flaggedUntil: { gt: now } }, orderBy: [{ nonce: 'asc' }, { factionId: 'asc' }, { issuedAtMs: 'asc' }] }),
    db.playerReputation.findMany({ where: { playerId }, orderBy: { factionId: 'asc' } })
  ]);
  return EnforcementProjection.create({
    version: 1,
    pilotId: playerId,
    authorityRevision: toWireUint64(revision ?? player.authorityRevision),
    notBeforeMs: toWireUint64(player.authorityNotBeforeMs),
    lockouts: lockouts.map((lockout) => ({ factionId: lockout.stationId, expiresAtMs: toWireUint64(lockout.until.getTime()) })),
    customsCitations: citations.map((citation) => ({
      citationId: `mining-violation:${citation.nonce}`,
      factionId: citation.factionId,
      issuedAtMs: toWireUint64(citation.issuedAtMs),
      expiresAtMs: toWireUint64(citation.flaggedUntil.getTime())
    })),
    factionEnforcement: standings.map((standing) => ({ factionId: standing.factionId, standingMilli: standing.standing })),
    flyingColorsFactionId: player.activeColorsFactionId ?? ''
  });
}
