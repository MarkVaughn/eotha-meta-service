import { cellToLatLng, latLngToCell } from 'h3-js';
import { DEFAULT_HARBOR, HARBOR_H3_RESOLUTION } from '../config/harbor.js';
import { isFactionId, spawnStandingGains } from '../config/factions.js';
import { grantSpawnStandings } from './reputation.js';

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

// Gives the player of the harbor just created the standing its territory grants (spawnStandingGains): the engine
// says who controls the harbor's cell and its ring-1 neighbors. Nothing when there is no `territory` client or it
// has no answer; never throws, so a sign-in never fails on it.
async function grantHarborStanding(prisma, harbor, territory, log) {
  try {
    const cell = await territory.lookup(harbor.h3Index);
    if (!cell) return;
    const gains = spawnStandingGains(cell);
    if (!Object.keys(gains).length) return;
    const factionId = isFactionId(cell.controllingFactionId) ? cell.controllingFactionId : null;
    await grantSpawnStandings(prisma, harbor.playerId, gains, { factionId });
  } catch (err) {
    log?.error({ err, playerId: harbor.playerId }, 'could not grant spawn standing; the harbor stands without it');
  }
}

/**
 * Returns the player's SpaceHarbor, creating one when the player has none: guests and Google
 * players are created without one. A new harbor is placed at `location` (see `harborAt`) when it
 * is a usable position, otherwise at the default (see config/harbor.js). Safe to call concurrently
 * and repeatedly; an existing harbor is never changed, whatever `location` says.
 *
 * The call that creates the harbor also gives the player the faction standing of where it is (see
 * `spawnStandingGains`), as `territory` (src/lib/territory.js) reports it: once, since only one call
 * creates it, and never for a harbor that already exists (a development-login pilot's, say). Without
 * `territory`, or when the engine has no answer, the harbor is created with no standing.
 *
 * @param {{ latitude?: unknown, longitude?: unknown }} [location] Where the client reports it is.
 * @param {{ territory?: { lookup(h3Index: string): Promise<object | null> }, log?: object }} [options]
 */
export async function ensureHarbor(prisma, playerId, location, { territory, log } = {}) {
  const existing = await prisma.spaceHarbor.findUnique({ where: { playerId } });
  if (existing) return existing;
  const harbor = harborAt(location) ?? DEFAULT_HARBOR;
  // ON CONFLICT DO NOTHING: a concurrent first sign-in cannot fail on the playerId unique key, and
  // whichever insert lands first is the harbor every caller returns. Only that insert counts 1, so
  // only its caller grants the spawn standing.
  const { count } = await prisma.spaceHarbor.createMany({ data: [{ playerId, ...harbor }], skipDuplicates: true });
  const created = await prisma.spaceHarbor.findUniqueOrThrow({ where: { playerId } });
  if (count === 1 && territory) await grantHarborStanding(prisma, created, territory, log);
  return created;
}

/** The spawn point a client is shown for a harbor, in the shape development login returns it. */
export const spawnPointOf = (harbor) => ({
  latitude: harbor.latitude,
  longitude: harbor.longitude,
  h3_index: harbor.h3Index
});
