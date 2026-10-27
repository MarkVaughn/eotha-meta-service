// The hiring board of a station: the candidates it offers in each 30-minute window, and what stops a
// pilot hiring each. A board is a pure function of the station and the window, so every pilot sees the
// same people and refreshing cannot reroll them; only the availability is the pilot's own.
import { createHash } from 'node:crypto';
import {
  CREW_BOARD_OFFER_COUNT,
  CREW_BOARD_WINDOW_MS,
  CREW_CLASS_IDS,
  CREW_REP_REQ_SCORE,
  CREW_WAGE_SHARE_BP,
  HOME_FACTION_WEIGHTS,
  HUB_RANK_WEIGHTS,
  HUB_SLOT_INDEX,
  INDEPENDENT_STATION_REP_REQ_SCORE,
  INDEPENDENT_STATION_STANDING,
  QUIRKS,
  QUIRK_IDS,
  STANDARD_RANK_WEIGHTS,
  classEffectsView,
  effectiveWageShareBp,
  quirkView,
  signingBonusCredits
} from '../config/crew.js';
import { UNAVAILABLE, boardingReasons } from './crew.js';

const FIRST_NAMES = [
  'Kaelen', 'Talia', 'Orin', 'Mira', 'Dax', 'Seren', 'Joss', 'Ilya', 'Nadia', 'Teodor', 'Vesna', 'Rook',
  'Anselm', 'Yara', 'Corin', 'Leda', 'Bram', 'Sunniva', 'Kito', 'Odalys', 'Piers', 'Zofia', 'Halden', 'Imara'
];
const LAST_NAMES = [
  'Vance', 'Orlov', 'Marsh', 'Okafor', 'Reyes', 'Lindqvist', 'Tanaka', 'Brandt', 'Achterberg', 'Voss',
  'Calloway', 'Dunmore', 'Esposito', 'Farrow', 'Grieve', 'Halloran', 'Ibarra', 'Jovanovic', 'Kessler',
  'Lacroix', 'Mbeki', 'Novak', 'Ostrander', 'Pryce'
];

const REP_TIER_LABEL = Object.freeze({ NOVICE: 'Unfriendly', ADEPT: 'Neutral', MASTER: 'Trusted' });

/** The window `nowMs` falls in: its index and the times it opens and expires. */
export function crewBoardWindow(nowMs) {
  const index = Math.floor(nowMs / CREW_BOARD_WINDOW_MS);
  return { index, startsAtMs: index * CREW_BOARD_WINDOW_MS, expiresAtMs: (index + 1) * CREW_BOARD_WINDOW_MS };
}

// SHA256("crew_board_v1" || stationId || window_30m || slotIndex): the tag, the station id as text,
// the window index as a big-endian u64 and the slot as one byte.
export function candidateSeed(stationId, windowIndex, slotIndex) {
  const window = Buffer.alloc(8);
  window.writeBigUInt64BE(BigInt(windowIndex));
  return createHash('sha256')
    .update('crew_board_v1')
    .update(stationId)
    .update(window)
    .update(Buffer.from([slotIndex]))
    .digest();
}

// A number below `n` drawn from `seed` for the named facet of a candidate, independent of the others.
const roll = (seed, facet, n) => createHash('sha256').update(seed).update(facet).digest().readUInt32BE(0) % n;

// The entry of `table` (`[value, weight]` pairs whose weights sum to `total`) a roll below `total` lands on.
function pick(seed, facet, table, total = 1000) {
  let point = roll(seed, facet, total);
  for (const [value, weight] of table) {
    if (point < weight) return value;
    point -= weight;
  }
  return table[table.length - 1][0];
}

const QUIRK_TABLE = QUIRK_IDS.map((id) => [id, QUIRKS[id].weight]);

/** The candidate of `slotIndex` on `stationId`'s board in the window `windowIndex`. */
export function generateCandidate(stationId, windowIndex, slotIndex) {
  const seed = candidateSeed(stationId, windowIndex, slotIndex);
  return {
    slotIndex,
    candidateId: `cand-${slotIndex}-${seed.toString('hex').slice(0, 8)}`,
    name: `${FIRST_NAMES[roll(seed, 'first', FIRST_NAMES.length)]} ${LAST_NAMES[roll(seed, 'last', LAST_NAMES.length)]}`,
    crewClass: CREW_CLASS_IDS[roll(seed, 'class', CREW_CLASS_IDS.length)],
    rank: pick(seed, 'rank', slotIndex === HUB_SLOT_INDEX ? HUB_RANK_WEIGHTS : STANDARD_RANK_WEIGHTS),
    homeFactionId: pick(seed, 'faction', HOME_FACTION_WEIGHTS),
    quirkId: pick(seed, 'quirk', QUIRK_TABLE)
  };
}

/** `stationId`'s candidates in the window `nowMs` falls in, and that window. */
export function generateCrewBoard(stationId, nowMs) {
  const window = crewBoardWindow(nowMs);
  const candidates = Array.from({ length: CREW_BOARD_OFFER_COUNT }, (_, slot) => generateCandidate(stationId, window.index, slot));
  return { window, candidates };
}

/**
 * Every reason `candidate` cannot be hired right now, as `{ code, label, ...details }`, in the order
 * the board lists them. `ctx` is the pilot's side: `{ ship, credits, standings, stationFactionId }`,
 * where `ship` is lockActiveShip's result (components, passengersAboard, traits, active crew),
 * `standings` maps faction ids to standings and `stationFactionId` is the faction governing the station,
 * as its verified docked receipt signs it (`''` for an independent station). The candidate's rank is
 * judged against the pilot's standing with that faction, whatever the candidate's own home faction.
 */
export function unavailableReasons(candidate, { ship, credits, standings, stationFactionId }) {
  const bonus = signingBonusCredits(candidate.rank, candidate.quirkId, ship.traits);
  const independent = !stationFactionId;
  const required = (independent ? INDEPENDENT_STATION_REP_REQ_SCORE : CREW_REP_REQ_SCORE)[candidate.rank];
  const standing = independent ? INDEPENDENT_STATION_STANDING : standings[stationFactionId] ?? 0;
  const reasons = [];
  if (standing < required) {
    reasons.push({
      code: UNAVAILABLE.INSUFFICIENT_FACTION_REP,
      label: `Requires ${REP_TIER_LABEL[candidate.rank]} (${required}) standing with ${stationFactionId} (current: ${standing})`,
      factionId: stationFactionId,
      requiredScore: required,
      currentScore: standing
    });
  }
  if (credits < bonus) {
    reasons.push({
      code: UNAVAILABLE.INSUFFICIENT_CREDITS,
      label: `Requires ${bonus} cr signing bonus (have: ${credits} cr)`,
      requiredCredits: bonus,
      currentCredits: credits
    });
  }
  return [...reasons, ...boardingReasons(ship, candidate.crewClass)];
}

/** The card the board shows for `candidate`: the person, the quirk in full, the terms and whether the pilot can hire. */
export function candidateView(candidate, ctx) {
  const reasons = unavailableReasons(candidate, ctx);
  const baseWageShareBp = CREW_WAGE_SHARE_BP[candidate.rank];
  return {
    slotIndex: candidate.slotIndex,
    candidateId: candidate.candidateId,
    name: candidate.name,
    crewClass: candidate.crewClass,
    rank: candidate.rank,
    homeFactionId: candidate.homeFactionId,
    quirk: quirkView(candidate.quirkId),
    effects: classEffectsView(candidate.crewClass, candidate.rank),
    baseWageShareBp,
    effectiveWageShareBp: effectiveWageShareBp(baseWageShareBp, candidate.quirkId, ctx.ship.traits),
    signingBonusCredits: signingBonusCredits(candidate.rank, candidate.quirkId, ctx.ship.traits),
    hireable: reasons.length === 0,
    unavailableReasons: reasons
  };
}

/** The candidate with `candidateId` on `stationId`'s board at `nowMs`, or undefined once its window has passed. */
export const findCandidate = (stationId, candidateId, nowMs) =>
  generateCrewBoard(stationId, nowMs).candidates.find((candidate) => candidate.candidateId === candidateId);
