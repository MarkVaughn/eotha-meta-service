import { MINING_PERMIT_TTL_MS } from '../config/regulation.js';

// A permit row as the API shows it.
export const permitView = (permit) => ({
  system_h3: permit.systemH3,
  faction_id: permit.factionId,
  expires_at_ms: permit.expiresAt.getTime()
});

/** `db` is the Prisma client or an open transaction. The pilot's mining permits still running at `nowMs`. */
export const activeMiningPermits = (db, playerId, nowMs) =>
  db.systemMiningPermit.findMany({ where: { playerId, expiresAt: { gt: new Date(nowMs) } }, orderBy: { systemH3: 'asc' } });

/**
 * Inside the transaction that holds the pilot's lock (`lockActiveShip`): the mining permit for `systemH3` that runs
 * at `nowMs`, or null. A permit is bought once per window: while one runs, a second purchase changes nothing and is
 * not charged, which is what makes a repeated (or racing) relay of the same hail receipt safe.
 */
export async function runningMiningPermit(tx, playerId, systemH3, nowMs) {
  const permit = await tx.systemMiningPermit.findUnique({ where: { playerId_systemH3: { playerId, systemH3 } } });
  return permit && permit.expiresAt.getTime() > nowMs ? permit : null;
}

/** Inside the same transaction: records the permit for `systemH3`, a new one or the renewal of an expired one. */
export function grantMiningPermit(tx, playerId, systemH3, factionId, nowMs) {
  const expiresAt = new Date(nowMs + MINING_PERMIT_TTL_MS);
  return tx.systemMiningPermit.upsert({
    where: { playerId_systemH3: { playerId, systemH3 } },
    update: { factionId, expiresAt },
    create: { playerId, systemH3, factionId, expiresAt }
  });
}
