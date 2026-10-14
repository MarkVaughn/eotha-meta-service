// Player rules for missions. The offers themselves (which docks offer work, destinations, payout,
// time limit, berths, expiry) are the engine's: it signs every offer with its claim key
// (`src/lib/mission-offer.js`), and this service keeps no copy of the world to derive them from.
export const MISSION_COOLDOWN_MS = 10 * 60 * 1000; // per (player, origin station) after completion
export const MAX_REWARD_CREDITS = 2_147_483_647; // Player.credits is a 32-bit Int

// How far ahead of this process's clock the engine may have signed an offer (clock skew).
// Only the not-in-the-future bound is relaxed; expiry is not.
export const MAX_OFFER_FUTURE_SKEW_MS = 5_000;
