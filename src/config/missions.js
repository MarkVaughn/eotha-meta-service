// Procedural passenger passage & research expedition missions offered at
// outposts/stations. Mission offers are never persisted: they're derived
// deterministically from (stationId, stationNode, epochHour) so every pilot
// asking the same station in the same hour sees the same offer board.

export const MISSION_TYPES = ['ONE_WAY_PASSAGE', 'RESEARCH_EXPEDITION'];

export const ONE_WAY_PASSAGE_MIN_HEXES = 2;
export const ONE_WAY_PASSAGE_MAX_HEXES = 8;
export const RESEARCH_EXPEDITION_MIN_HEXES = 2;
export const RESEARCH_EXPEDITION_MAX_HEXES = 6;

export const MIN_OFFERS_PER_STATION = 1;
export const MAX_OFFERS_PER_STATION = 3;

export const MIN_COOLDOWN_MS = 15 * 60 * 1000;
export const MAX_COOLDOWN_MS = 30 * 60 * 1000;

// Credits paid per passenger per hex of distance.
export const BASE_FARE = 25;
// Maximum fraction of basePayout awarded as an "expedited" time bonus.
export const EXPEDITED_BONUS_RATE = 0.5;
// Pacing assumption (seconds/hex) used to grade how "expedited" a completion was.
// Research expeditions cover the distance twice (there and back).
export const SECONDS_PER_HEX = 90;
// A research expedition can't be completed before this fraction of its expected
// duration has elapsed (server-side, since accept), so a pilot can't accept at
// the origin and instantly "return" to it.
export const RESEARCH_EXPEDITION_MIN_ELAPSED_FRACTION = 0.5;

const RESEARCH_SITE_KINDS = ['NEBULA_SURVEY', 'MINING_SITE', 'ANOMALY'];
const RESEARCH_SITE_LABELS = {
  NEBULA_SURVEY: 'Nebula',
  MINING_SITE: 'Mining Site',
  ANOMALY: 'Anomaly'
};

const NODE_NAME_PREFIXES = [
  'Kepler', 'Vareth', 'Orin', 'Thal', 'Ceres', 'Nyx', 'Borealis',
  'Ashen', 'Drakon', 'Solace', 'Meridian', 'Voss', 'Halcyon', 'Ithari'
];
const STATION_NAME_SUFFIXES = ['Outpost', 'Waypoint', 'Relay', 'Anchorage', 'Terminus'];

// Mulberry32: small, fast, deterministic PRNG from an integer seed.
function mulberry32(seed) {
  let t = seed >>> 0;
  return function rng() {
    t += 0x6d2b79f5;
    let r = t;
    r = Math.imul(r ^ (r >>> 15), r | 1);
    r ^= r + Math.imul(r ^ (r >>> 7), r | 61);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

// FNV-1a string hash, used to turn arbitrary seed strings into PRNG seeds.
function hashSeed(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function randInt(rng, min, max) {
  return min + Math.floor(rng() * (max - min + 1));
}

function pick(rng, list) {
  return list[Math.floor(rng() * list.length)];
}

function syntheticNodeId(rng) {
  let hex = '';
  for (let i = 0; i < 13; i++) hex += Math.floor(rng() * 16).toString(16);
  return `88${hex}`;
}

export function epochHourFor(date = new Date()) {
  return Math.floor(date.getTime() / 3_600_000);
}

// Cooldown length is itself deterministic per station, so repeated lookups agree.
export function missionCooldownMs(stationId, stationNode) {
  const rng = mulberry32(hashSeed(`cooldown:${stationId}:${stationNode}`));
  return randInt(rng, MIN_COOLDOWN_MS, MAX_COOLDOWN_MS);
}

function generateDestination(rng, type) {
  const prefix = pick(rng, NODE_NAME_PREFIXES);
  const node = syntheticNodeId(rng);

  if (type === 'ONE_WAY_PASSAGE') {
    const suffix = pick(rng, STATION_NAME_SUFFIXES);
    // A distinct destination outpost: its own stationId as well as node, so
    // arrival can be validated against both (unlike a research POI, which
    // isn't a station a pilot could dock at).
    const stationId = syntheticNodeId(rng);
    return { stationId, node, name: `${prefix} ${suffix}`, kind: 'STATION' };
  }

  const kind = pick(rng, RESEARCH_SITE_KINDS);
  return { node, name: `${prefix} ${RESEARCH_SITE_LABELS[kind]}`, kind };
}

function buildMissionId(stationId, stationNode, epochHour, index) {
  return `${stationId}::${stationNode}::${epochHour}::${index}`;
}

// Station ids/nodes are embedded in delimiter-joined mission ids and cooldown
// keys, so they must not contain the delimiter character themselves.
export const STATION_TOKEN_PATTERN = '^[^:]+$';
const STATION_TOKEN_RE = new RegExp(STATION_TOKEN_PATTERN);

export function parseMissionId(missionId) {
  const parts = typeof missionId === 'string' ? missionId.split('::') : [];
  if (parts.length !== 4) return null;
  const [stationId, stationNode, epochHourStr, indexStr] = parts;
  if (!STATION_TOKEN_RE.test(stationId) || !STATION_TOKEN_RE.test(stationNode)) return null;
  if (!/^\d+$/.test(epochHourStr) || !/^\d+$/.test(indexStr)) return null;
  return { stationId, stationNode, epochHour: Number(epochHourStr), index: Number(indexStr) };
}

/**
 * Deterministically generate the mission offer board for a station/node at a
 * given point in time, sized to the pilot's current passenger capacity. Every
 * rng() draw happens in the same order regardless of capacity, so the
 * mission's type/distance/destination stay stable across different pilots -
 * only the rolled passenger count depends on `passengerCapacity`.
 */
export function generateMissions({ stationId, stationNode, passengerCapacity, now = new Date() }) {
  if (!Number.isFinite(passengerCapacity) || passengerCapacity <= 0) return [];

  const epochHour = epochHourFor(now);
  const rng = mulberry32(hashSeed(`${stationId}:${stationNode}:${epochHour}`));
  const offerCount = randInt(rng, MIN_OFFERS_PER_STATION, MAX_OFFERS_PER_STATION);

  const missions = [];
  for (let index = 0; index < offerCount; index++) {
    const type = pick(rng, MISSION_TYPES);
    const passengers = randInt(rng, 1, passengerCapacity);
    const [minHexes, maxHexes] = type === 'ONE_WAY_PASSAGE'
      ? [ONE_WAY_PASSAGE_MIN_HEXES, ONE_WAY_PASSAGE_MAX_HEXES]
      : [RESEARCH_EXPEDITION_MIN_HEXES, RESEARCH_EXPEDITION_MAX_HEXES];
    const distanceHexes = randInt(rng, minHexes, maxHexes);
    const destination = generateDestination(rng, type);
    const roundTrip = type === 'RESEARCH_EXPEDITION';
    const basePayout = Math.round(BASE_FARE * passengers * distanceHexes);
    const expectedSeconds = distanceHexes * SECONDS_PER_HEX * (roundTrip ? 2 : 1);

    missions.push({
      missionId: buildMissionId(stationId, stationNode, epochHour, index),
      type,
      passengers,
      distanceHexes,
      roundTrip,
      originStationId: stationId,
      originStationNode: stationNode,
      destination,
      basePayout,
      expectedSeconds,
      generatedEpochHour: epochHour
    });
  }
  return missions;
}

// Re-derive a single offer by missionId (used at accept-time), regenerating
// the board with the requesting pilot's current passenger capacity. Only the
// current and immediately previous hour's boards are acceptable; arbitrary
// past/future epoch hours are rejected.
export function findMissionOffer(missionId, passengerCapacity, now = new Date()) {
  const parsed = parseMissionId(missionId);
  if (!parsed) return null;
  const { stationId, stationNode, epochHour, index } = parsed;
  const currentEpochHour = epochHourFor(now);
  if (epochHour !== currentEpochHour && epochHour !== currentEpochHour - 1) return null;
  const missions = generateMissions({
    stationId,
    stationNode,
    passengerCapacity,
    now: new Date(epochHour * 3_600_000)
  });
  return missions[index] ?? null;
}

// basePayout, unless the pilot beat the expected time - then a bonus is
// added, scaling linearly up to EXPEDITED_BONUS_RATE for a near-instant run.
export function computePayout({ basePayout, expectedSeconds, elapsedSeconds }) {
  if (!(elapsedSeconds < expectedSeconds) || expectedSeconds <= 0) {
    return { payout: basePayout, bonus: 0 };
  }
  const speedFactor = 1 - elapsedSeconds / expectedSeconds;
  const bonus = Math.round(basePayout * EXPEDITED_BONUS_RATE * speedFactor);
  return { payout: basePayout + bonus, bonus };
}
