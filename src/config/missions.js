// Player rules for missions. The offers themselves (which docks offer work, destinations, payout,
// time limit, berths, expiry) are the engine's: it signs every offer with its claim key
// (`src/lib/mission-offer.js`), and this service keeps no copy of the world to derive them from.
export const MISSION_COOLDOWN_MS = 10 * 60 * 1000; // per (player, origin station) after completion
export const MAX_REWARD_CREDITS = 2_147_483_647; // Player.credits is a 32-bit Int

// How far ahead of this process's clock the engine may have signed an offer (clock skew).
// Only the not-in-the-future bound is relaxed; expiry is not.
export const MAX_OFFER_FUTURE_SKEW_MS = 5_000;

// Most missions of each type (the offer's `type`) a pilot may hold at once. The types are
// independent, so a pilot may hold one passage, three research and one gather mission together.
// One passage at a time means that passage owns every passenger aboard.
export const MISSION_LIMITS = Object.freeze({
  MISSION_TYPE_PASSAGE: 1,
  MISSION_TYPE_RESEARCH: 3,
  MISSION_TYPE_GATHER: 1
});

// Whether a pilot holding `offers` may take one more of `type`. A type with no limit is never taken.
export const underMissionLimit = (offers, type) =>
  offers.filter((offer) => offer.type === type).length < (MISSION_LIMITS[type] ?? 0);

// A claim completed after its deadline is still paid, with the pay and reputation the engine decayed
// and signed, up to this much later: min(3 x the offer's duration limit, 24 h). Beyond it the mission
// can no longer be completed.
export const LATE_WINDOW_MULTIPLIER = 3;
export const MAX_LATE_WINDOW_MS = 24 * 60 * 60 * 1000;
export const lateCutoffMs = (deadlineMs, durationLimitMs) =>
  deadlineMs + Math.min(LATE_WINDOW_MULTIPLIER * durationLimitMs, MAX_LATE_WINDOW_MS);

// What abandoning a mission costs, by type: the reputation applied to the sponsoring faction and the
// cooldown it starts at the mission's origin, so accepting and abandoning cannot churn a dock's
// board. A passage cancelled while docked at its origin (the passengers step back off) is the
// administrative cancel; a passage abandoned anywhere else costs nothing here and starts no cooldown:
// its passengers stay aboard as hostages and the penalty comes at the disembark (HOSTAGE_*).
export const ABANDON_TERMS = Object.freeze({
  MISSION_TYPE_PASSAGE: Object.freeze({ reputation: -2, cooldownMs: 5 * 60 * 1000 }),
  MISSION_TYPE_RESEARCH: Object.freeze({ reputation: -8, cooldownMs: 15 * 60 * 1000 }),
  MISSION_TYPE_GATHER: Object.freeze({ reputation: -10, cooldownMs: 20 * 60 * 1000 })
});

// The hostage state of a passage abandoned away from its origin. The pilot disembarks the passengers
// while docked, and loses the faction's reputation: a base penalty by where they are dropped (the
// mission's destination, its origin or anywhere else), plus a time penalty of one point per
// HOSTAGE_MINUTES_PER_POINT whole minutes since the abandon (0.5 a minute), at most HOSTAGE_TIME_PENALTY_CAP.
// The clock runs at that one rate whether or not the pilot is logged in.
export const HOSTAGE_BASE_PENALTY = Object.freeze({
  DISEMBARK_PLACE_DESTINATION: 10,
  DISEMBARK_PLACE_ORIGIN: 12,
  DISEMBARK_PLACE_ELSEWHERE: 20
});
export const HOSTAGE_MINUTES_PER_POINT = 2;
export const HOSTAGE_TIME_PENALTY_CAP = 60;

// The faction an offer without one is credited to.
export const DEFAULT_FACTION_ID = 'independent';
