import {
  COMPONENT_TYPES,
  ESSENTIAL_COMPONENTS,
  MIN_TIER,
  computeShipAttributes,
  defaultComponents
} from '../config/components.js';
import { captainTraits, ensureCaptain } from './captain.js';
import { activeCrewOf } from './crew.js';
import { factionsClaim } from './reputation.js';
import { activeMissionClaim } from './active-mission.js';

// Inside transaction `tx`: takes the per-player advisory lock, so concurrent requests cannot
// create duplicate active ships or interleave a check with its write, and returns the pilot's
// active ship with its components, creating the default ship if there is none yet. The ship also
// carries the pilot's `captain` (created at Level 1 if there is none yet), its unlocked `traits`, the
// active `crew` aboard and its `factions` claim as of the lock (factionsClaim).
export async function lockActiveShip(tx, user) {
  const playerId = user.sub;
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${playerId}))`;
  const existing = await tx.spaceship.findFirst({
    where: { playerId, active: true },
    orderBy: { createdAt: 'asc' },
    include: { components: true }
  });
  const ship = existing ?? await tx.spaceship.create({
    data: {
      playerId,
      callsign: user.callsign,
      components: { create: defaultComponents().map(({ type, tier, healthPct }) => ({ type, tier, healthPct })) }
    },
    include: { components: true }
  });
  const captain = await ensureCaptain(tx, playerId, user.callsign);
  return { ...ship, captain, traits: captainTraits(captain), crew: await activeCrewOf(tx, ship.id), factions: await factionsClaim(tx, playerId) };
}

// `traits` are the captain's unlocked trait ids and `crew` the active crew (lockActiveShip's
// `ship.traits` and `ship.crew`).
export function toLoadout(shipId, components, passengersAboard, traits = [], crew = []) {
  const list = COMPONENT_TYPES.map((type) => {
    const found = components.find((c) => c.type === type);
    const fallbackTier = ESSENTIAL_COMPONENTS.includes(type) ? MIN_TIER : 0;
    return { type, tier: found?.tier ?? fallbackTier, healthPct: found?.healthPct ?? 100 };
  });
  return { ship_id: shipId, components: list, ship_attributes: computeShipAttributes(list, passengersAboard, traits, crew) };
}

// Re-sign the caller's claims with fresh ship attributes and `factions` claim (factionsClaim, read
// under the pilot's lock) so the token RTSE verifies is current. The expiry is carried over: only a
// refresh token may extend a login. A `cargo` lease claim is never carried over (a reissued token
// would load a stale hold); only POST /game/cargo/lease adds one, through `extraClaims`.
// The optional covert `active_mission` is reconstructed from the DB on every reissue, never
// copied from the caller, so an old token cannot restore abandoned/completed mission tracking.
export async function reissueToken(fastify, request, shipAttributes, factions, extraClaims = {}) {
  const { iat, iss, cargo, active_mission, ...claims } = request.user;
  const mission = await activeMissionClaim(fastify.prisma, request.user.sub);
  return fastify.signWithExpiry({
    ...claims, ship_attributes: shipAttributes, factions, ...extraClaims,
    ...(mission && { active_mission: mission })
  });
}
