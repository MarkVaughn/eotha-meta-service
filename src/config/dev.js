import env from './env.js';

// Email domain of the placeholder accounts that development login creates.
export const DEV_LOGIN_EMAIL_DOMAIN = 'dev-login.invalid';

// One-time starting balance of a development-login pilot (env DEV_STARTING_CREDITS).
export const DEV_STARTING_CREDITS = env.DEV_STARTING_CREDITS;

// The test-only passenger route (POST /ship/dev/passengers) exists in every environment but production.
export const devPassengersEnabled = (nodeEnv = env.NODE_ENV) => nodeEnv !== 'production';

// --- Development seed pilots --------------------------------------------------------------------------
//
// The dev client's five ships log in through GET /auth/dev-login as Pilot-1-NY .. Pilot-5-Sydney
// (eotha-dev-client src/spaceships.ts). The first dev login of each callsign below outfits its ship and
// sets its standings once (src/lib/dev-seed.js, marked by Player.devSeededAt); later logins change nothing.
// Pilot-1-NY is not listed: it keeps the plain dev-login start (Tier 1 defaults, neutral standings).
// Dev login only exists under NODE_ENV=development, so this never seeds a production or demo pilot.
//
// Standing scale (src/config/factions.js, bands in src/config/regulation.js and src/config/outfitting.js):
// -1000..1000, Friendly from 150, Trusted from 450, Unfriendly at -150 and below, Hostile at -500 and below.
// The words of the request map to:
//   bad          -300  Unfriendly: dearer outfitting (+30%), but still served, not Hostile-barred
//   good         +450  Trusted (the best band below Flying Colors and Paragon)
//   medium good  +250  Friendly
//   medium bad   -250  Unfriendly (the inverse of medium good)
// alpha and beta are rivals (only one may stand at 450+), and nothing here reaches Paragon (800), so every
// standing is written as listed. There is no Delta faction: the three great factions are alpha, beta and
// gamma, so "Delta" is taken to be gamma, the third.
//
// Outfitting: every component type is set, each at BASIC quality and full health. A T4 hull budgets 27
// subsystem points and the 11 others at T2 take 22; a T5 hull budgets 36 and the 11 at T3 take 33. The
// lander (at most T3) needs a hull of T2 or above, which both have.
const DEV_SEED_BAD = -300;
const DEV_SEED_GOOD = 450;
const DEV_SEED_MEDIUM_GOOD = 250;

const outfit = (hullTier, otherTier) => Object.freeze({ hullTier, otherTier });

export const DEV_SEED_PILOTS = Object.freeze({
  'Pilot-2-Hamburg': Object.freeze({
    ...outfit(4, 2),
    standings: Object.freeze({ alpha: DEV_SEED_BAD, beta: DEV_SEED_GOOD, gamma: DEV_SEED_MEDIUM_GOOD })
  }),
  'Pilot-3-Rio': Object.freeze({
    ...outfit(4, 2),
    standings: Object.freeze({ alpha: DEV_SEED_GOOD, beta: DEV_SEED_BAD, gamma: -DEV_SEED_MEDIUM_GOOD })
  }),
  'Pilot-4-Jakarta': Object.freeze({
    ...outfit(5, 3),
    standings: Object.freeze({ alpha: 0, beta: 0, gamma: 0 })
  }),
  'Pilot-5-Sydney': Object.freeze({
    ...outfit(5, 3),
    standings: Object.freeze({ alpha: -250, beta: -250, gamma: 700 })
  })
});
