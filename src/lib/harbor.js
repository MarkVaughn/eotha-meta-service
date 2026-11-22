import { cellToLatLng, latLngToCell } from 'h3-js';
import { DEFAULT_HARBOR, HARBOR_H3_RESOLUTION } from '../config/harbor.js';

const inRange = (value, limit) => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= limit;

/**
 * The harbor for a location a client reported, or null when it is not a usable WGS84 position
 * (missing, not a number, not finite, latitude outside [-90, 90] or longitude outside [-180, 180]).
 * The harbor is the center of the location's resolution 8 cell, never the reported coordinates,
 * so the player's precise position is not stored: latitude, longitude and h3Index name one cell.
 */
export function harborAt(location) {
  const { latitude, longitude } = location ?? {};
  if (!inRange(latitude, 90) || !inRange(longitude, 180)) return null;
  const h3Index = latLngToCell(latitude, longitude, HARBOR_H3_RESOLUTION);
  const [centerLatitude, centerLongitude] = cellToLatLng(h3Index);
  return { latitude: centerLatitude, longitude: centerLongitude, h3Index };
}

/**
 * Returns the player's SpaceHarbor, creating one when the player has none: guests and Google
 * players are created without one. A new harbor is placed at `location` (see `harborAt`) when it
 * is a usable position, otherwise at the default (see config/harbor.js). Safe to call concurrently
 * and repeatedly; an existing harbor is never changed, whatever `location` says.
 *
 * @param {{ latitude?: unknown, longitude?: unknown }} [location] Where the client reports it is.
 */
export async function ensureHarbor(prisma, playerId, location) {
  const existing = await prisma.spaceHarbor.findUnique({ where: { playerId } });
  if (existing) return existing;
  const harbor = harborAt(location) ?? DEFAULT_HARBOR;
  // ON CONFLICT DO NOTHING: a concurrent first sign-in cannot fail on the playerId unique key, and
  // whichever insert lands first is the harbor every caller returns.
  await prisma.spaceHarbor.createMany({ data: [{ playerId, ...harbor }], skipDuplicates: true });
  return prisma.spaceHarbor.findUniqueOrThrow({ where: { playerId } });
}

/** The spawn point a client is shown for a harbor, in the shape development login returns it. */
export const spawnPointOf = (harbor) => ({
  latitude: harbor.latitude,
  longitude: harbor.longitude,
  h3_index: harbor.h3Index
});
