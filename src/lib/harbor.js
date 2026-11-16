import { DEFAULT_HARBOR } from '../config/harbor.js';

/**
 * Returns the player's SpaceHarbor, creating the default one (see config/harbor.js) when the player
 * has none: guests and Google players are created without one. Safe to call concurrently and
 * repeatedly; an existing harbor is never changed.
 */
export async function ensureHarbor(prisma, playerId) {
  const existing = await prisma.spaceHarbor.findUnique({ where: { playerId } });
  if (existing) return existing;
  // ON CONFLICT DO NOTHING: a concurrent first sign-in cannot fail on the playerId unique key.
  await prisma.spaceHarbor.createMany({ data: [{ playerId, ...DEFAULT_HARBOR }], skipDuplicates: true });
  return prisma.spaceHarbor.findUniqueOrThrow({ where: { playerId } });
}

/** The spawn point a client is shown for a harbor, in the shape development login returns it. */
export const spawnPointOf = (harbor) => ({
  latitude: harbor.latitude,
  longitude: harbor.longitude,
  h3_index: harbor.h3Index
});
