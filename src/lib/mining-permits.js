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

/** Inside a transaction that holds the pilot's lock (`lockActiveShip`): the mining permit for `systemH3` that runs at `nowMs`, or null. */
export async function runningMiningPermit(tx, playerId, systemH3, nowMs) {
  const permit = await tx.systemMiningPermit.findUnique({ where: { playerId_systemH3: { playerId, systemH3 } } });
  return permit && permit.expiresAt.getTime() > nowMs ? permit : null;
}

/**
 * Inside the transaction that holds the pilot's lock (`lockActiveShip`): the permit a hail receipt, by its nonce (hex),
 * was redeemed for, as it was granted, or null when the receipt is unspent. A receipt buys one permit, once, whether or
 * not that permit still runs, which is what makes a repeated (or racing) relay of it safe.
 */
export async function redeemedMiningPermit(tx, playerId, nonce) {
  return tx.miningPermitRedemption.findUnique({ where: { playerId_nonce: { playerId, nonce } } });
}

/**
 * Inside the same transaction: records the permit for `systemH3` as running 2 hours from `nowMs` (a new one, or the
 * renewal of one running or expired), and the redemption of the hail receipt `nonce` that bought it.
 */
export async function grantMiningPermit(tx, playerId, systemH3, factionId, nowMs, nonce) {
  const expiresAt = new Date(nowMs + MINING_PERMIT_TTL_MS);
  await tx.miningPermitRedemption.create({ data: { playerId, nonce, systemH3, factionId, expiresAt } });
  return tx.systemMiningPermit.upsert({
    where: { playerId_systemH3: { playerId, systemH3 } },
    update: { factionId, expiresAt },
    create: { playerId, systemH3, factionId, expiresAt }
  });
}
