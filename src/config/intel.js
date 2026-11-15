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
// A Master Comms Officer flags stale and planted rumors; everyone else sees UNSPECIFIED, "not revealed".
export const VERACITY_REVEAL_RANK = 'MASTER';

// A pool is 8 to 12 items, exactly 2 of them free ambient items (OQ-5), at one of these list prices.
export const POOL_MIN_ITEMS = 8;
export const POOL_MAX_ITEMS = 12;
export const FREE_AMBIENT_COUNT = 2;
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

// `IntelVeracity` numbers.
export const INTEL_VERACITY_NAMES = Object.freeze({
  0: 'INTEL_VERACITY_UNSPECIFIED',
  1: 'INTEL_VERACITY_VERIFIED_TRUE',
  2: 'INTEL_VERACITY_STALE_OUTDATE',
  3: 'INTEL_VERACITY_EXAGGERATED',
  4: 'INTEL_VERACITY_DECEPTIVE_FALSE'
});

// The standing bands of `IntelClearance` and what each terminal shows (report 2.3). `categories` are the kinds of intel
// the band may see at all; a kind a band cannot see is left out of its pool, redacted or not. `maxOutfitterTier` is the
// highest component tier of an outfitter tip it is shown.
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

// What a redacted card says: the category's generic headline, never the item's own.
export const REDACTED_HEADLINES = Object.freeze({
  [INTEL_CATEGORIES.INTEL_CATEGORY_OUTFITTER_TIP]: '[ENCRYPTED OUTFITTER DOSSIER]',
  [INTEL_CATEGORIES.INTEL_CATEGORY_MISSION_LEAD]: '[ENCRYPTED MISSION DOSSIER]',
  [INTEL_CATEGORIES.INTEL_CATEGORY_FACTION_RECRUITMENT]: '[ENCRYPTED RECRUITMENT DOSSIER]',
  [INTEL_CATEGORIES.INTEL_CATEGORY_AWAY_TEAM_SITE]: '[CLASSIFIED AWAY-TEAM SITE TELEMETRY]',
  [INTEL_CATEGORIES.INTEL_CATEGORY_PLAYER_SIGHTING]: '[RESTRICTED NAVAL TELEMETRY]'
});

// The fields of each category's `detail` message (contracts `common/v1/intel.proto`), in snake_case. The engine's detail
// is cut to these, so nothing it adds can reach a client.
export const DETAIL_KEYS = Object.freeze({
  [INTEL_CATEGORIES.INTEL_CATEGORY_OUTFITTER_TIP]: Object.freeze({
    wire: 'outfitter_tip',
    fields: Object.freeze(['target_station_id', 'target_station_name', 'target_system_h3', 'distance_hexes', 'component_type', 'tier',
      'quality_grade', 'price_condition_pct', 'required_standing_faction_id', 'required_standing_score'])
  }),
  [INTEL_CATEGORIES.INTEL_CATEGORY_MISSION_LEAD]: Object.freeze({
    wire: 'mission_lead',
    fields: Object.freeze(['mission_id', 'base_mission_type', 'archetype', 'title', 'narrative', 'destination_system_h3', 'distance_hexes',
      'reward_credits', 'reputation_change', 'sponsoring_faction_id', 'prerequisite_traits', 'required_crew_classes', 'required_hull_tier'])
  }),
  [INTEL_CATEGORIES.INTEL_CATEGORY_FACTION_RECRUITMENT]: Object.freeze({
    wire: 'faction_recruitment',
    fields: Object.freeze(['mission_id', 'faction_id', 'call_sign', 'minimum_standing', 'mission_headline', 'operational_theater_h3',
      'operational_role', 'mobilization_bonus_credits', 'bonus_reputation'])
  }),
  [INTEL_CATEGORIES.INTEL_CATEGORY_AWAY_TEAM_SITE]: Object.freeze({
    wire: 'away_team_site',
    fields: Object.freeze(['site_id', 'planet_id', 'planet_name', 'system_h3', 'site_node_h3', 'biome', 'hazard_rating',
      'encounter_archetype', 'recommended_lead_class', 'expected_loot'])
  }),
  [INTEL_CATEGORIES.INTEL_CATEGORY_PLAYER_SIGHTING]: Object.freeze({
    wire: 'player_sighting',
    fields: Object.freeze(['sighting_id', 'ship_name', 'captain_name', 'hull_class', 'weapon_bracket', 'shield_bracket',
      'transponder_faction_id', 'customs_flagged', 'minutes_since_departure', 'is_masked', 'conduct_note'])
  })
});
