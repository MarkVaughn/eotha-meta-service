import { createHash } from 'node:crypto';
import { gridDisk, gridDistance, cellToChildrenSize, childPosToCell, cellToLatLng, isValidCell, getResolution } from 'h3-js';

export const MISSION_TYPE_PASSAGE = 'MISSION_TYPE_PASSAGE';
export const MISSION_TYPE_RESEARCH = 'MISSION_TYPE_RESEARCH';

export const SYSTEM_RESOLUTION = 8;
export const NODE_RESOLUTION = 12;
export const H3_PATTERN = '^[0-9a-f]{15}$';
export const STATION_PATTERN = '^[A-Za-z0-9_-]{1,64}$';

export const EPOCH_MS = 60 * 60 * 1000; // offers are regenerated hourly
export const MISSION_COOLDOWN_MS = 10 * 60 * 1000; // per (player, origin station) after completion
export const OFFERS_PER_STATION = 6;
export const MAX_REWARD_CREDITS = 2_147_483_647; // Player.credits is a 32-bit Int

export function isSystemCell(h3) {
  return typeof h3 === 'string' && new RegExp(H3_PATTERN).test(h3) && isValidCell(h3) && getResolution(h3) === SYSTEM_RESOLUTION;
}

export function makeMissionId(stationId, systemH3, epoch, index) {
  return `m1:${stationId}:${systemH3}:${epoch}:${index}`;
}

export function parseMissionId(missionId) {
  if (typeof missionId !== 'string') return null;
  const parts = missionId.split(':');
  if (parts.length !== 5 || parts[0] !== 'm1') return null;
  const [, stationId, systemH3, epochStr, indexStr] = parts;
  const epoch = Number(epochStr);
  const index = Number(indexStr);
  if (!new RegExp(STATION_PATTERN).test(stationId) || !isSystemCell(systemH3)) return null;
  if (!Number.isSafeInteger(epoch) || epoch < 0 || !Number.isInteger(index) || index < 0 || index >= OFFERS_PER_STATION) return null;
  return { stationId, systemH3, epoch, index };
}

export function currentEpoch(nowMs = Date.now()) {
  return Math.floor(nowMs / EPOCH_MS);
}

/**
 * Deterministically build one MissionOffer (proto JSON, snake_case) for a
 * station / system / hour / slot. Because it is a pure function of the
 * mission id, the server can re-derive any offer a client presents.
 */
export function buildOffer({ stationId, systemH3, epoch, index }) {
  const h = createHash('sha256').update(`${stationId}|${systemH3}|${epoch}|${index}`).digest();
  const research = h[0] % 3 === 2;
  const distance = 1 + (h[1] % 3);

  const ring = gridDisk(systemH3, 3)
    .filter((cell) => {
      try { return gridDistance(systemH3, cell) === distance; } catch { return false; }
    })
    .sort();
  const destSystem = ring[h.readUInt16BE(2) % ring.length];

  const childCount = cellToChildrenSize(destSystem, NODE_RESOLUTION);
  const destNode = childPosToCell(h.readUInt32BE(4) % childCount, destSystem, NODE_RESOLUTION);
  const [lat, lng] = cellToLatLng(destNode);

  const berths = research ? 0 : 1 + (h[8] % 12);
  const baseMs = 5 * 60 * 1000;

  return {
    mission_id: makeMissionId(stationId, systemH3, epoch, index),
    type: research ? MISSION_TYPE_RESEARCH : MISSION_TYPE_PASSAGE,
    title: research ? `Survey expedition, ${distance} hex${distance > 1 ? 'es' : ''} out` : `Passage for ${berths} to station-${destSystem}`,
    description: research
      ? 'Chart an anomaly at the destination node and report back.'
      : `Carry ${berths} passenger${berths > 1 ? 's' : ''} to the destination station.`,
    origin_station_id: stationId,
    origin_system_h3: systemH3,
    destination_station_id: `station-${destSystem}`,
    destination_system_h3: destSystem,
    destination_node_h3: destNode,
    destination_lat: lat,
    destination_lng: lng,
    distance_hexes: distance,
    required_berths: berths,
    duration_limit_ms: baseMs * (distance + 1) * (research ? 2 : 1),
    reward_credits: research ? 250 * distance : 100 * distance + 25 * berths,
    reputation_change: distance,
    faction_id: 'faction-independent',
    expires_at_ms: (epoch + 1) * EPOCH_MS
  };
}

export function generateOffers({ stationId, systemH3, passengerCapacity, nowMs = Date.now() }) {
  const epoch = currentEpoch(nowMs);
  const berths = Math.floor(passengerCapacity);
  const offers = [];
  for (let index = 0; index < OFFERS_PER_STATION; index++) {
    const offer = buildOffer({ stationId, systemH3, epoch, index });
    if (offer.required_berths <= berths) offers.push(offer);
  }
  return offers;
}
