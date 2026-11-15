import {
  CLOAKED_STEALTH_RATING,
  INTEL_HOUR_MS,
  MASKED_STEALTH_RATING,
  SIGHTING_DELAY_MS,
  SIGHTING_WINDOW_MS,
  STATION_SIGHTING_CAP
} from '../config/intel.js';
import { computeShipAttributes } from '../config/components.js';
import { CREW_CAPABILITY } from '../config/crew.js';

const tierOf = (components, type) => components.find((component) => component.type === type)?.tier ?? 0;

/**
 * Inside a transaction: logs the departure of `ship` (a lockActiveShip result, its crew as it left) from `stationId` at
 * `undockedAtMs` in the station's ring buffer, then prunes the buffer to its newest STATION_SIGHTING_CAP departures
 * within SIGHTING_WINDOW_MS. A ship flying with stealth rating 0.40 or more, or with Cold Drift aboard, is logged masked;
 * one under an active tier 5 cloak (rating 0.80) leaves no record. Returns whether a record was written. Only in-game names and
 * tiers are stored, never an account identity.
 */
export async function logDeparture(tx, { ship, stationId, undockedAtMs, nowMs = Date.now() }) {
  const attributes = computeShipAttributes(ship.components, ship.passengersAboard, ship.traits, ship.crew);
  if (attributes.stealth_rating >= CLOAKED_STEALTH_RATING) return false;
  const player = await tx.player.findUnique({ where: { id: ship.playerId }, select: { activeColorsFactionId: true } });
  await tx.stationSightingRecord.create({
    data: {
      stationEntityId: stationId,
      shipName: ship.callsign,
      captainName: ship.captain.name,
      hullTier: tierOf(ship.components, 'HULL'),
      weaponTier: tierOf(ship.components, 'WEAPONS'),
      shieldTier: tierOf(ship.components, 'SHIELDS'),
      flyingColors: player?.activeColorsFactionId ?? null,
      isStealthed: attributes.stealth_rating >= MASKED_STEALTH_RATING
        || (attributes.crew_capability_flags & CREW_CAPABILITY.COLD_DRIFT) !== 0,
      undockedAt: new Date(undockedAtMs)
    }
  });
  await tx.stationSightingRecord.deleteMany({ where: { stationEntityId: stationId, undockedAt: { lt: new Date(nowMs - SIGHTING_WINDOW_MS) } } });
  const surplus = await tx.stationSightingRecord.findMany({
    where: { stationEntityId: stationId }, orderBy: [{ undockedAt: 'desc' }, { id: 'asc' }], skip: STATION_SIGHTING_CAP, select: { id: true }
  });
  if (surplus.length) await tx.stationSightingRecord.deleteMany({ where: { id: { in: surplus.map((row) => row.id) } } });
  return true;
}

/**
 * The departures the engine may build `hourEpoch`'s sightings from, as it takes them: those logged at `stationId` that
 * were at least 15 minutes old when the hour began and at most 4 hours old then, newest first. Reading the log as of the
 * hour's start keeps the pool the same for the whole hour, whatever leaves the dock meanwhile.
 */
export async function sightingsForPool(db, stationId, hourEpoch) {
  const hourStartMs = hourEpoch * INTEL_HOUR_MS;
  const rows = await db.stationSightingRecord.findMany({
    where: {
      stationEntityId: stationId,
      undockedAt: { gte: new Date(hourStartMs - SIGHTING_WINDOW_MS), lte: new Date(hourStartMs - SIGHTING_DELAY_MS) }
    },
    orderBy: [{ undockedAt: 'desc' }, { id: 'asc' }],
    take: STATION_SIGHTING_CAP
  });
  return rows.map((row) => ({
    sighting_id: row.id,
    ship_name: row.shipName,
    captain_name: row.captainName,
    hull_tier: row.hullTier,
    weapon_tier: row.weaponTier,
    shield_tier: row.shieldTier,
    flying_colors: row.flyingColors ?? '',
    is_stealthed: row.isStealthed,
    undocked_at_ms: row.undockedAt.getTime()
  }));
}
