// The three great factions and the caps on a pilot's standings with them. Pure data and functions;
// the database side is src/lib/reputation.js. Any other faction id (`independent`, say) keeps a
// standing too, bounded to [MIN_STANDING, MAX_STANDING] and subject to none of these caps.
export const FACTION_IDS = Object.freeze(['alpha', 'beta', 'gamma']);

// A pilot's standing with a faction is an integer in [MIN_STANDING, MAX_STANDING]; 0 is neutral.
export const MIN_STANDING = -1000;
export const MAX_STANDING = 1000;

// Rivals: while a pilot stands at RIVAL_CAP_THRESHOLD or above with one, the other is capped at RIVAL_CAP.
export const RIVALS = Object.freeze([Object.freeze(['alpha', 'beta'])]);
export const RIVAL_CAP_THRESHOLD = 450;
export const RIVAL_CAP = 449;

// Single Paragon: at most one faction at PARAGON_THRESHOLD or above; while one is, the others are
// capped at NON_PARAGON_CAP_WHEN_PARAGON_ACTIVE.
export const PARAGON_THRESHOLD = 800;
export const NON_PARAGON_CAP_WHEN_PARAGON_ACTIVE = 799;

// Flying a faction's colors needs this standing with it, and multiplies the reputation its missions
// gain while flown.
export const FLYING_COLORS_MIN_REP = 500;
export const FLYING_COLORS_REP_GROWTH_MULT = 1.2;

export const isFactionId = (factionId) => FACTION_IDS.includes(factionId);

export const boundedStanding = (standing) => Math.max(MIN_STANDING, Math.min(MAX_STANDING, standing));

// Which of `ids` keeps the status of standing at `threshold` or above in `next`, or null if none
// reaches it. A faction that already held it in `previous` keeps it, so a rising standing is the
// one capped; then the higher standing, then the earlier faction id.
function holder(ids, next, previous, threshold) {
  const rank = (id) => [previous[id] >= threshold ? 1 : 0, next[id], -FACTION_IDS.indexOf(id)];
  const better = (a, b) => {
    const [ra, rb] = [rank(a), rank(b)];
    const i = ra.findIndex((value, n) => value !== rb[n]);
    return i >= 0 && ra[i] > rb[i] ? a : b;
  };
  const reaching = ids.filter((id) => next[id] >= threshold);
  return reaching.length ? reaching.reduce(better) : null;
}

// The standings `{ alpha, beta, gamma }` a pilot may hold after a change to `alpha`, `beta` and
// `gamma`: each bounded to [MIN_STANDING, MAX_STANDING], then at most one faction at
// PARAGON_THRESHOLD or above (the others capped at NON_PARAGON_CAP_WHEN_PARAGON_ACTIVE), then for
// each rival pair at most one at RIVAL_CAP_THRESHOLD or above (the other capped at RIVAL_CAP).
// `previous` is the standings before the change and decides which faction keeps a contested status.
export function clampStandingsWithCaps(alpha, beta, gamma, previous = { alpha, beta, gamma }) {
  const next = { alpha: boundedStanding(alpha), beta: boundedStanding(beta), gamma: boundedStanding(gamma) };
  const paragon = holder(FACTION_IDS, next, previous, PARAGON_THRESHOLD);
  for (const id of FACTION_IDS) {
    if (paragon && id !== paragon) next[id] = Math.min(next[id], NON_PARAGON_CAP_WHEN_PARAGON_ACTIVE);
  }
  for (const pair of RIVALS) {
    const leader = holder(pair, next, previous, RIVAL_CAP_THRESHOLD);
    for (const id of pair) {
      if (leader && id !== leader) next[id] = Math.min(next[id], RIVAL_CAP);
    }
  }
  return next;
}

// The reputation a mission for `factionId` gains when the pilot flies `activeColors`: a gain for the
// faction whose colors are flown is multiplied by FLYING_COLORS_REP_GROWTH_MULT; a loss never is.
export const withColorsBonus = (delta, factionId, activeColors) =>
  delta > 0 && activeColors != null && factionId === activeColors ? Math.round(delta * FLYING_COLORS_REP_GROWTH_MULT) : delta;
