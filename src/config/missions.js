// Mission offers, derived exactly as the RTSE derives them (eotha-rtse `simulation/missions/
// generator.rs`), because the RTSE re-derives an accepted offer from the procedural content it
// names and refuses to sign a completion claim for anything it did not generate: station and
// destination ids, mission id, payout, duration limit and offer window all follow the engine.
// `tests/fixtures/rtse-mission-vectors.json` holds offers the engine itself produced and
// `tests/mission-vectors.test.js` asserts this module reproduces them.
//
// Offers are a pure function of (system, origin station, passenger berths, 30-minute window), so
// the server can regenerate whatever a client presents (`authenticateOffer`) instead of storing
// it. What the engine leaves open is which of the engine-valid offers to show: `generateOffers`
// shows the engine's own top picks, except that it never shows a destination whose coordinates
// it cannot reproduce bit for bit, and never leaves a pilot with an empty board (see there).
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { isValidCell, getResolution } from 'h3-js';
import {
  MIN_ROUNDING_MARGIN,
  SYSTEM_RESOLUTION,
  cellBytes,
  generateCellNodes,
  nodeGeometry,
  nodeName,
  securityLevel,
  systemName,
  systemsWithin,
  u64Bytes,
  uuidFromDigest
} from '../lib/procedural.js';

export const MISSION_TYPE_PASSAGE = 'MISSION_TYPE_PASSAGE';
export const MISSION_TYPE_RESEARCH = 'MISSION_TYPE_RESEARCH';

export const H3_PATTERN = '^[0-9a-f]{15}$';
export const STATION_PATTERN = '^[A-Za-z0-9_-]{1,64}$';

// Engine rules (generator.rs). The captain decided they are authoritative.
export const MISSION_RADIUS_HEXES = 3; // farthest a destination lies from the system it is offered in
export const OFFER_WINDOW_MS = 1_800_000; // offers are reseeded, and expire, every 30 minutes
export const DURATION_PER_HEX_MS = 300_000; // flight time allowed per system of distance
export const MAX_PASSENGERS_PER_OFFER = 4;
export const MIN_RESEARCH_GRADE = 3;
export const MISSION_REPUTATION_GAIN = 5;
export const BASE_OFFER_COUNT = 3;
export const BASE_PAYOUT_CREDITS = 1000;
export const PAYOUT_PER_HEX_CREDITS = 500;
export const PAYOUT_PER_BERTH_CREDITS = 250;
const TRUSTED_REPUTATION = 100;
const ENGINE_COOLDOWN_MS = 900_000;

// Meta-service rules the engine does not have.
export const MISSION_COOLDOWN_MS = 10 * 60 * 1000; // per (player, origin station) after completion
export const MAX_REWARD_CREDITS = 2_147_483_647; // Player.credits is a 32-bit Int

// How far ahead of this process's clock a presented offer may have been made. Offers are stamped
// by whichever replica served the board, so another replica whose clock is a little behind sees
// them "from the future". Only the not-in-the-future bound is relaxed; expiry is not.
export const MAX_FUTURE_SKEW_MS = 60_000;

export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isSystemCell(h3) {
  return typeof h3 === 'string' && new RegExp(H3_PATTERN).test(h3) && isValidCell(h3) && getResolution(h3) === SYSTEM_RESOLUTION;
}

export const missionDurationLimitMs = (distanceHexes) => distanceHexes * DURATION_PER_HEX_MS;

export const missionPayout = (distanceHexes, requiredBerths) =>
  BASE_PAYOUT_CREDITS + distanceHexes * PAYOUT_PER_HEX_CREDITS + requiredBerths * PAYOUT_PER_BERTH_CREDITS;

const sha256 = (...parts) => {
  const hash = createHash('sha256');
  for (const part of parts) hash.update(part);
  return hash.digest();
};

const idBytes = (uuid) => Buffer.from(uuid.replaceAll('-', ''), 'hex');

/** The seed every offer of `systemH3` is drawn from during the window containing `nowMs`. */
export function missionSeed(systemH3, nowMs) {
  return sha256('mission_seed', cellBytes(systemH3), u64Bytes(Math.floor(nowMs / OFFER_WINDOW_MS)));
}

/** The seeded digest ranking destination `nodeId` among a window's candidates. */
const destinationRank = (seed, nodeId) => sha256(seed, idBytes(nodeId));

/** A mission's id: unique per window, destination and origin station. */
const missionId = (rank, originStationId) => uuidFromDigest(sha256('mission_id', rank, Buffer.from(originStationId)));

/** Whether `stationId` names a station of system `systemH3`. */
export function isStationOf(systemH3, stationId) {
  return generateCellNodes(systemH3).some((node) => node.isStation && node.id === stationId);
}

const plural = (n) => (n === 1 ? '' : 's');

/**
 * Whether the engine would authenticate a survey of `node` as some *other* node: it looks the
 * destination up by node cell among the system's research-grade resource nodes and checks the
 * offered coordinates against the first one it finds, so a node sharing its node cell with an
 * earlier research-grade node (or whose position cannot be reproduced to tell) can never pass.
 */
function isShadowedSurvey(node, geometry) {
  return generateCellNodes(node.systemCell)
    .filter((other) => other.slot < node.slot && !other.isStation && other.grade >= MIN_RESEARCH_GRADE)
    .some((other) => {
      const where = nodeGeometry(other);
      return where === null || where.nodeCell === geometry.nodeCell;
    });
}

/**
 * Every destination the engine considers for work offered in `systemH3`, best-ranked first:
 * stations (for passage) or high-grade resource nodes (for research) 1 to 3 systems away.
 */
function rankedCandidates(systemH3, seed, passage) {
  const candidates = [];
  for (const { cell, distance } of systemsWithin(systemH3, MISSION_RADIUS_HEXES)) {
    for (const node of generateCellNodes(cell)) {
      if (passage ? node.isStation : !node.isStation && node.grade >= MIN_RESEARCH_GRADE) {
        candidates.push({ node, distance, rank: destinationRank(seed, node.id) });
      }
    }
  }
  return candidates.sort((a, b) => Buffer.compare(a.rank, b.rank));
}

function offerFor({ systemH3, stationId, availableBerths, nowMs }, { node, distance, rank }, geometry) {
  const destinationSystem = systemName(node.systemCell);
  const destinationNode = nodeName(geometry.nodeCell);
  const durationLimitMs = missionDurationLimitMs(distance);
  const minutes = Math.floor(durationLimitMs / 60_000);
  const sponsor = `faction-${securityLevel(systemH3).toLowerCase()}`;

  let type;
  let berths;
  let destinationStationId;
  let title;
  let description;
  if (node.isStation) {
    berths = 1 + (rank[0] % Math.min(availableBerths, MAX_PASSENGERS_PER_OFFER));
    type = MISSION_TYPE_PASSAGE;
    destinationStationId = node.id;
    title = `Passage to Station ${destinationNode} in ${destinationSystem} System`;
    description = `Ferry ${berths} passenger${plural(berths)} from the ${systemName(systemH3)} System to Station ${destinationNode} in the ${destinationSystem} System, ${distance} system${plural(distance)} out. Dock within ${minutes} minutes.`;
  } else {
    berths = 0;
    type = MISSION_TYPE_RESEARCH;
    destinationStationId = stationId; // a survey ends back where it started
    title = `Survey of ${node.entityType} Node ${destinationNode} in ${destinationSystem} System`;
    description = `Assay the grade ${node.grade} ${node.entityType} node ${destinationNode} in the ${destinationSystem} System, ${distance} system${plural(distance)} out, and dock back here with the readings within ${minutes} minutes.`;
  }

  return {
    mission_id: missionId(rank, stationId),
    type,
    title,
    description,
    origin_station_id: stationId,
    origin_system_h3: systemH3,
    destination_station_id: destinationStationId,
    destination_system_h3: node.systemCell,
    destination_node_h3: geometry.nodeCell,
    destination_lat: geometry.lat,
    destination_lng: geometry.lng,
    distance_hexes: distance,
    required_berths: berths,
    duration_limit_ms: durationLimitMs,
    reward_credits: missionPayout(distance, berths),
    reputation_change: MISSION_REPUTATION_GAIN,
    faction_id: sponsor,
    expires_at_ms: nowMs + OFFER_WINDOW_MS
  };
}

/** How many offers the engine shows: fewer to a pilot who just flew a mission or a distrusted one, more to a trusted one. */
function offerCount(factionReputation, onCooldown) {
  if (onCooldown) return 1;
  if (factionReputation < 0) return BASE_OFFER_COUNT - 1;
  if (factionReputation >= TRUSTED_REPUTATION) return BASE_OFFER_COUNT + 1;
  return BASE_OFFER_COUNT;
}

/**
 * The missions offered at station `stationId` of system `systemH3` in the window containing
 * `nowMs` to a pilot whose ship has `availableBerths` free passenger berths: the engine's
 * `generate_mission_offers`, with these deliberate differences in what is *shown* (every
 * offer returned is one the engine generates and authenticates):
 *
 * - A destination whose coordinates cannot be reproduced bit for bit (see `nodeGeometry`) is
 *   passed over for the next-ranked one, because the engine compares the offered coordinates
 *   for exact equality and would reject the claim of a mission to it. So is a survey the engine
 *   would mistake for another node of the same system (see `isShadowedSurvey`).
 * - If that leaves nothing at all (or the engine's own rule has no destination: no station
 *   within three systems of a passage origin), the board is filled from what remains:
 *   the best-ranked destination whose position is reproducible at all, and, when a ship with
 *   berths has no station to carry passengers to, research offers (which any ship may take).
 *
 * `minMargin` is the rounding margin a destination's position needs to be trusted; 0 trusts every
 * reproducible position, which yields exactly the engine's own board (the equality tests use it).
 * Returns `null` for a station that does not exist in the system.
 */
export function generateMissionOffers({
  systemH3,
  stationId,
  availableBerths,
  factionReputation = 0,
  lastMissionTimestampMs = 0,
  nowMs,
  minMargin = MIN_ROUNDING_MARGIN
}) {
  if (!isStationOf(systemH3, stationId)) return null;
  const berths = Math.max(0, Math.floor(availableBerths));
  const onCooldown = lastMissionTimestampMs !== 0 && Math.max(0, nowMs - lastMissionTimestampMs) < ENGINE_COOLDOWN_MS;
  const count = offerCount(factionReputation, onCooldown);
  const seed = missionSeed(systemH3, nowMs);
  const context = { systemH3, stationId, availableBerths: berths, nowMs };

  const pick = (candidates) => {
    const trusted = [];
    let fallback = null; // best-ranked reproducible destination, however close to a rounding tie
    for (const candidate of candidates) {
      const geometry = nodeGeometry(candidate.node);
      if (!geometry || (!candidate.node.isStation && isShadowedSurvey(candidate.node, geometry))) continue;
      if (geometry.margin >= minMargin) trusted.push({ candidate, geometry });
      else fallback ??= { candidate, geometry };
      if (trusted.length === count) break;
    }
    if (trusted.length === 0 && fallback) trusted.push(fallback);
    return trusted.map(({ candidate, geometry }) => offerFor(context, candidate, geometry));
  };

  const offers = berths > 0 ? pick(rankedCandidates(systemH3, seed, true)) : [];
  if (offers.length > 0) return offers;
  return pick(rankedCandidates(systemH3, seed, false));
}

/** The board a pilot at `stationId` sees right now. */
export const generateOffers = ({ stationId, systemH3, passengerCapacity, nowMs = Date.now() }) =>
  generateMissionOffers({ systemH3, stationId, availableBerths: passengerCapacity, nowMs });

/**
 * The authoritative offer behind one a client presents: `{ offer, expired }`, or `null` if it is
 * not one this service offered a ship with `availableBerths` berths. The presented offer names the
 * window it was made in (its expiry less one window), which must not lie in the future (beyond
 * `MAX_FUTURE_SKEW_MS` of clock skew), and must
 * equal, field for field, what is regenerated for that window.
 */
export function authenticateOffer(presented, { availableBerths, nowMs = Date.now() }) {
  if (!presented || typeof presented !== 'object') return null;
  const { origin_system_h3: systemH3, origin_station_id: stationId, expires_at_ms: expiresAtMs, mission_id: id } = presented;
  if (!isSystemCell(systemH3) || typeof stationId !== 'string' || !UUID_PATTERN.test(stationId)) return null;
  if (!Number.isSafeInteger(expiresAtMs)) return null;
  const offeredAtMs = expiresAtMs - OFFER_WINDOW_MS;
  // An offer made up to MAX_FUTURE_SKEW_MS ahead of this clock is still the engine's offer: its
  // fields and id depend only on the window containing offeredAtMs, and the engine bounds nothing
  // against our clock. What it does check at claim time is that the mission was accepted no
  // earlier than the offer was made, which is why callers record the acceptance as
  // `max(now, offeredAtMs)` (returned here as `offeredAtMs`).
  if (offeredAtMs < 0 || offeredAtMs > nowMs + MAX_FUTURE_SKEW_MS) return null;

  const offers = generateMissionOffers({ systemH3, stationId, availableBerths, nowMs: offeredAtMs });
  const authoritative = offers?.find((offer) => offer.mission_id === id);
  if (!authoritative || !isDeepStrictEqual(JSON.parse(JSON.stringify(presented)), authoritative)) return null;
  return { offer: authoritative, expired: nowMs > expiresAtMs, offeredAtMs };
}
