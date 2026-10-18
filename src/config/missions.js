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
