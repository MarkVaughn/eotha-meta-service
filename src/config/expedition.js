// Planetary away-team expeditions: the bounds the AwayTeamClaim verifier (src/lib/expedition.js) holds a signed claim
// to. The engine signs the claim and is trusted for its content; these only refuse a claim no engine could have
// produced, so a bug or a leaked key cannot pour an absurd value into a pilot's account.
import { MAX_CREW_BY_HULL_TIER, MAX_CREW_MORALE } from './crew.js';
import { MAX_STANDING } from './factions.js';

// ExpeditionOutcomeTier (eotha-contracts expedition.proto): 1 critical success .. 5 disaster; 0 is unspecified.
export const EXPEDITION_OUTCOME_TIERS = Object.freeze([1, 2, 3, 4, 5]);

// The away team is a subset of the active crew: at least one member, at most the largest hull's berths plus the
// H6_FLEET_CAPTAIN slot.
export const EXPEDITION_MIN_CREW = 1;
export const EXPEDITION_MAX_CREW = Math.max(...MAX_CREW_BY_HULL_TIER) + 1;

// One expedition changes a member's morale by at most the whole morale scale.
export const EXPEDITION_MAX_MORALE_DELTA = MAX_CREW_MORALE;

// Longest identifier or label a signed claim may carry (the engine's ids are far shorter).
export const EXPEDITION_MAX_ID_LENGTH = 256;
export const EXPEDITION_MAX_LABEL_LENGTH = 64;

// A recovered lot: grade 1..5 as in a cargo lot, purity in basis points, at least one milli-unit.
export const EXPEDITION_LOT_GRADES = Object.freeze([1, 2, 3, 4, 5]);
export const EXPEDITION_MAX_PURITY_BP = 10_000;

// Sponsor and rival reputation deltas are held to the width of the standing scale: a delta beyond it would only ever
// clamp. The contracts do not bound the deltas more tightly than that.
export const EXPEDITION_MAX_REPUTATION_DELTA = 2 * MAX_STANDING;

// How long a crew member who suffered severe medical trauma on an expedition stays incapacitated, from the moment
// the claim is settled (design: 30 to 60 minutes, or until treated at an infirmary).
export const EXPEDITION_TRAUMA_DURATION_MS = 45 * 60_000;

// A claim may be dated this far ahead of this service's clock (the engine's and ours may disagree) and no further:
// a future `completedAtMs` is refused rather than stored.
export const EXPEDITION_MAX_FUTURE_SKEW_MS = 60_000;
