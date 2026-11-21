import { COMPONENT_TYPES } from '../config/components.js';
import { DEV_LOGIN_EMAIL_DOMAIN, DEV_SEED_PILOTS } from '../config/dev.js';
import { DEFAULT_QUALITY } from '../config/outfitting.js';
import { LEDGER_REASONS, setFactionStandings } from './reputation.js';
import { lockActiveShip } from './ship.js';

// The tier DEV_SEED_PILOTS gives `type` on a seeded ship: the hull its own, every other component the rest.
export const devSeedTier = (seed, type) => (type === 'HULL' ? seed.hullTier : seed.otherTier);

/**
 * Inside the dev-login transaction `tx`: outfits the active ship of `player` and sets its faction standings
 * as DEV_SEED_PILOTS lists for its callsign, once. The claim on Player.devSeededAt is the guard, so a later
 * or concurrent login of the same pilot changes nothing; a callsign that is not listed, a guest and an account
 * that did not come from dev login are never touched. Returns whether this call seeded the pilot.
 */
export async function applyDevSeed(tx, player, now = new Date()) {
  const seed = DEV_SEED_PILOTS[player.callsign];
  if (!seed) return false;
  const { count } = await tx.player.updateMany({
    where: { id: player.id, email: { endsWith: `@${DEV_LOGIN_EMAIL_DOMAIN}` }, isAnonymous: false, devSeededAt: null },
    data: { devSeededAt: now }
  });
  if (count !== 1) return false;

  const ship = await lockActiveShip(tx, { sub: player.id, callsign: player.callsign });
  for (const type of COMPONENT_TYPES) {
    const values = { tier: devSeedTier(seed, type), quality: DEFAULT_QUALITY, healthPct: 100 };
    await tx.shipComponentRecord.upsert({
      where: { spaceshipId_type: { spaceshipId: ship.id, type } },
      update: values,
      create: { spaceshipId: ship.id, type, ...values }
    });
  }
  await setFactionStandings(tx, player.id, seed.standings, { reason: LEDGER_REASONS.DEV_SEED });
  return true;
}
