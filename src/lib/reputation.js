import { DEFAULT_FACTION_ID } from '../config/missions.js';

// A pilot's standing with a faction is an integer in [MIN_STANDING, MAX_STANDING]; 0 is neutral.
export const MIN_STANDING = -1000;
export const MAX_STANDING = 1000;

// The faction a mission's reputation goes to: its signed sponsor, else DEFAULT_FACTION_ID.
export const missionFaction = (offer) => offer.faction_id || DEFAULT_FACTION_ID;

const bounded = (standing) => Math.max(MIN_STANDING, Math.min(MAX_STANDING, standing));

// Adds `delta` to the pilot's standing with `factionId`, clamped to the bounds, and returns the new
// standing. `tx` is an open transaction holding the pilot's lock (lockActiveShip), which serialises
// this read-modify-write with every other one of the pilot's.
export async function adjustReputation(tx, playerId, factionId, delta) {
  const where = { playerId_factionId: { playerId, factionId } };
  const current = (await tx.playerReputation.findUnique({ where }))?.standing ?? 0;
  if (delta === 0) return current;
  const standing = bounded(current + delta);
  await tx.playerReputation.upsert({ where, update: { standing }, create: { playerId, factionId, standing } });
  return standing;
}

// `db` is the Prisma client or an open transaction. The pilot's standings as `{ [factionId]: standing }`;
// a faction with no row is neutral and left out.
export async function standingsOf(db, playerId) {
  const rows = await db.playerReputation.findMany({ where: { playerId }, orderBy: { factionId: 'asc' } });
  return Object.fromEntries(rows.map((row) => [row.factionId, row.standing]));
}
