import {
  ACCESS_REFUSED,
  BASE_INTEL_BUDGET,
  CLEARANCES,
  CLEARANCE_BANDS,
  COMMS_OFFICER_BUDGET_BONUS,
  FLYING_COLORS_CLEARANCE_STANDING,
  INTEL_CATEGORY_NAMES,
  INTEL_HOUR_MS,
  MAX_INTEL_BUDGET,
  PROBATIONARY,
  PROBATIONARY_SURCHARGE_PCT,
  SYNDICATE_TAP
} from '../config/intel.js';

// A crew member who is actually at work: not mutinous and not held.
const working = (member) => member.morale > 0 && !member.detained;

/**
 * The standing band of a pilot at a dock (report 2.3): `standing` is the pilot's standing with the faction governing the
 * dock (0 at an independent one), `flyingColors` whether the pilot flies that faction's colors, and `lowSec` whether the
 * dock is low-security. Flying Colors count as Paragon. A Hostile pilot only gets the Syndicate backchannel at a low-security
 * dock, and nothing anywhere else, as a Nemesis gets nothing at all. Returns the band's name, a key of CLEARANCES.
 */
export function clearanceFor({ standing, flyingColors = false, lowSec = false }) {
  const band = flyingColors && standing >= FLYING_COLORS_CLEARANCE_STANDING
    ? 'INTEL_CLEARANCE_ADMIRALTY'
    : CLEARANCE_BANDS.toSorted((a, b) => b.minStanding - a.minStanding).find((candidate) => standing >= candidate.minStanding).name;
  return band === SYNDICATE_TAP && !lowSec ? ACCESS_REFUSED : band;
}

export const isAccessRefused = (clearance) => clearance === ACCESS_REFUSED;

/**
 * The pilot's hourly gathering budget with `crew` aboard: 3 points, plus a Comms Officer's (+1 Adept, +2 Master), never more
 * than 6. A budget is spent by gathering, `budgetCost` points each; see src/config/intel.js for the effects not wired yet.
 */
export function budgetTotalFor(crew) {
  const bonus = Math.max(0, ...crew.filter((member) => working(member) && member.crewClass === 'COMMS_OFFICER')
    .map((member) => COMMS_OFFICER_BUDGET_BONUS[member.rank] ?? 0));
  return Math.min(MAX_INTEL_BUDGET, BASE_INTEL_BUDGET + bonus);
}

// The points gathering `item` spends; every item costs one.
export const budgetCostOf = () => 1;

/**
 * What `item` costs the pilot to gather, in credits: nothing for a free ambient item, else its signed list price, raised by
 * an Unfriendly pilot's 25% informant surcharge and rounded to whole credits.
 */
export function costOf(item, clearance) {
  if (item.isFreeAmbient || item.baseCostCredits === 0) return 0;
  return clearance === PROBATIONARY
    ? Math.round(item.baseCostCredits * (100 + PROBATIONARY_SURCHARGE_PCT) / 100)
    : item.baseCostCredits;
}

// Whether the pilot's clearance reads `item`'s category at all. The tier an outfitter tip is shown at (see
// CLEARANCES[...].maxOutfitterTier) is not checked: it is in the engine's unsigned detail, which a relayed item cannot vouch for.
export const visibleAt = (item, clearance) => CLEARANCES[clearance].categories.includes(item.category);

// Whether the pilot's `standings` meet the item's own requirement; an item with no gating faction is open to any.
export const meetsRequirement = (item, standings) =>
  !item.requiredStandingFactionId || (standings[item.requiredStandingFactionId] ?? 0) >= item.requiredStanding;

/**
 * `item` (a relayed item the engine signed, see validateRelayedItem) as a gather response carries it, snake_case, the
 * station as its UUID and the signature as base64: the engine's signed fields as they came, and the pilot's terms for
 * it. There is deliberately no headline, body, veracity or detail: this service holds none it can trust, the engine
 * unredacts a gathered item itself when the client presents the voucher over the game connection.
 */
export function itemView(item, { clearance, standings }) {
  return {
    intel_id: item.intelId,
    category: INTEL_CATEGORY_NAMES[item.category],
    station_entity_id: item.stationEntityId,
    system_h3: item.systemH3,
    hour_epoch: item.hourEpoch,
    slot_index: item.slotIndex,
    is_free_ambient: item.isFreeAmbient,
    base_cost_credits: item.baseCostCredits,
    required_standing: item.requiredStanding,
    required_standing_faction_id: item.requiredStandingFactionId,
    issued_at_ms: item.issuedAtMs,
    expires_at_ms: item.expiresAtMs,
    signature: item.signature,
    cost_credits: costOf(item, clearance),
    budget_cost: budgetCostOf(item),
    is_gathered: true,
    is_locked: !meetsRequirement(item, standings)
  };
}

export const nextRefreshAtMs = (hourEpoch) => (hourEpoch + 1) * INTEL_HOUR_MS;

/**
 * Inside a transaction holding the pilot's lock: spends `points` of the pilot's budget for `hourEpoch` on `intelId`
 * and records the item as gathered. Returns the points spent so far this hour.
 */
export async function spendBudget(tx, playerId, hourEpoch, intelId, points) {
  const where = { playerId_hourEpoch: { playerId, hourEpoch: BigInt(hourEpoch) } };
  const row = await tx.playerIntelBudget.upsert({
    where,
    update: { gatheredCount: { increment: points }, unlockedIntelIds: { push: intelId } },
    create: { playerId, hourEpoch: BigInt(hourEpoch), gatheredCount: points, unlockedIntelIds: [intelId] }
  });
  return row.gatheredCount;
}

// The pilot's budget row for `hourEpoch`: `{ spent, gatheredIds }`, nothing spent without one.
export async function budgetOf(db, playerId, hourEpoch) {
  const row = await db.playerIntelBudget.findUnique({ where: { playerId_hourEpoch: { playerId, hourEpoch: BigInt(hourEpoch) } } });
  return { spent: row?.gatheredCount ?? 0, gatheredIds: new Set(row?.unlockedIntelIds ?? []) };
}
