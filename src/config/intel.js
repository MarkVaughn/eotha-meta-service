// Station Intel (eotha-contracts `common/v1/intel.proto`, design: the unified Station Intel & Mission Pool report).
// Pure data and functions; the database side is src/lib/intel.js and the routes are src/routes/game/intel.js.

// The pool and the budget both turn over on the clock hour: hour_epoch = floor(unix ms / 3_600_000).
export const INTEL_HOUR_MS = 3_600_000;
export const hourEpochOf = (ms) => Math.floor(ms / INTEL_HOUR_MS);

// The hourly gathering budget, per account and clock hour: 3 points, never more than 6 whatever a crew adds.
export const BASE_INTEL_BUDGET = 3;
export const MAX_INTEL_BUDGET = 6;
// A Comms Officer adds a point at Adept and two at Master (report 5.2). The captain traits and crew quirks of report 5
// are not wired yet: their catalog text (src/config/captain.js, src/config/crew.js) describes other effects.
export const COMMS_OFFICER_BUDGET_BONUS = Object.freeze({ NOVICE: 0, ADEPT: 1, MASTER: 2 });

// A pool is 8 to 12 items (so a slot is 0 to 11), exactly 2 of them free ambient items (OQ-5), at one of these list prices.
// This service sees one relayed item at a time, never the pool, so it checks the slot and the price, not the counts.
export const POOL_MAX_ITEMS = 12;
export const BASE_COSTS_CREDITS = Object.freeze([0, 100, 250, 500]);

// A gathered item, and the voucher it may carry, lasts 4 hours (OQ-4).
export const DOSSIER_LIFETIME_MS = 4 * INTEL_HOUR_MS;

// An Unfriendly pilot pays informants 25% more.
export const PROBATIONARY_SURCHARGE_PCT = 25;

// The ring buffer of departures a station keeps for sightings: the newest 10, at most 4 hours old, none shown before
// 15 minutes have passed (report 3 and 6.2). A ship flying with stealth rating 0.40 or more is masked, one under an
// active tier 5 cloak (rating 0.80) is never logged.
export const STATION_SIGHTING_CAP = 10;
export const SIGHTING_WINDOW_MS = 4 * INTEL_HOUR_MS;
export const SIGHTING_DELAY_MS = 15 * 60_000;
export const MASKED_STEALTH_RATING = 0.4;
export const CLOAKED_STEALTH_RATING = 0.8;

// `IntelCategory` numbers; the engine signs the number and the voucher binds it.
export const INTEL_CATEGORIES = Object.freeze({
  INTEL_CATEGORY_OUTFITTER_TIP: 1,
  INTEL_CATEGORY_MISSION_LEAD: 2,
  INTEL_CATEGORY_FACTION_RECRUITMENT: 3,
  INTEL_CATEGORY_AWAY_TEAM_SITE: 4,
  INTEL_CATEGORY_PLAYER_SIGHTING: 5
});
export const INTEL_CATEGORY_NAMES = Object.freeze(Object.fromEntries(Object.entries(INTEL_CATEGORIES).map(([name, value]) => [value, name])));
export const VOUCHER_CATEGORIES = Object.freeze([INTEL_CATEGORIES.INTEL_CATEGORY_MISSION_LEAD, INTEL_CATEGORIES.INTEL_CATEGORY_FACTION_RECRUITMENT]);

// The standing bands of `IntelClearance` and what each terminal shows (report 2.3). `categories` are the kinds of intel
// the band may read at all; gathering a kind a band cannot read is refused. `maxOutfitterTier` is the highest component
// tier of an outfitter tip it is shown. It is not enforced yet: a tip's tier is in the engine's unsigned detail, which this
// service never receives from a trustworthy source (the engine redacts paid items and a relayed detail is never trusted).
const ALL = Object.values(INTEL_CATEGORIES);
const { INTEL_CATEGORY_OUTFITTER_TIP: TIP, INTEL_CATEGORY_MISSION_LEAD: LEAD, INTEL_CATEGORY_AWAY_TEAM_SITE: SITE, INTEL_CATEGORY_PLAYER_SIGHTING: SIGHTING } = INTEL_CATEGORIES;
export const CLEARANCES = Object.freeze({
  INTEL_CLEARANCE_ACCESS_REFUSED: Object.freeze({ value: 1, minStanding: -1000, categories: Object.freeze([]), maxOutfitterTier: 0, banner: '[ACCESS REFUSED: HOSTILE COMBATANT]' }),
  INTEL_CLEARANCE_SYNDICATE_TAP: Object.freeze({ value: 2, minStanding: -749, categories: Object.freeze([TIP, LEAD]), maxOutfitterTier: 5, banner: '[UNREGISTERED SYNDICATE TAP]' }),
  INTEL_CLEARANCE_PROBATIONARY: Object.freeze({ value: 3, minStanding: -499, categories: Object.freeze([TIP]), maxOutfitterTier: 3, banner: '[PROBATIONARY MONITORING ACTIVE]' }),
  INTEL_CLEARANCE_CIVILIAN: Object.freeze({ value: 4, minStanding: -149, categories: Object.freeze([TIP, LEAD, SITE, SIGHTING]), maxOutfitterTier: 3, banner: '[CIVILIAN TIER GUEST TERMINAL]' }),
  INTEL_CLEARANCE_REGISTERED_OPERATIVE: Object.freeze({ value: 5, minStanding: 150, categories: Object.freeze(ALL), maxOutfitterTier: 4, banner: '[CLEARANCE: REGISTERED OPERATIVE]' }),
  INTEL_CLEARANCE_SECURITY_LEVEL_3: Object.freeze({ value: 6, minStanding: 450, categories: Object.freeze(ALL), maxOutfitterTier: 5, banner: '[SECURITY CLEARANCE: LEVEL 3 AUTHORIZED]' }),
  INTEL_CLEARANCE_ADMIRALTY: Object.freeze({ value: 7, minStanding: 800, categories: Object.freeze(ALL), maxOutfitterTier: 5, banner: '[CLEARED: ADMIRALTY PRIVILEGED ACCESS]' })
});
export const CLEARANCE_BANDS = Object.freeze(Object.entries(CLEARANCES).map(([name, band]) => Object.freeze({ name, ...band })));

// Flying Colors (500+ with the faction whose colors the pilot flies) count as Paragon at that faction's docks.
export const FLYING_COLORS_CLEARANCE_STANDING = 500;
// The Syndicate backchannel opens only at low-security docks (security < 0.40; src/lib/outfitting-station.js).
export const SYNDICATE_TAP = 'INTEL_CLEARANCE_SYNDICATE_TAP';
export const ACCESS_REFUSED = 'INTEL_CLEARANCE_ACCESS_REFUSED';
export const PROBATIONARY = 'INTEL_CLEARANCE_PROBATIONARY';
