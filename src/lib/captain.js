import {
  LEVEL_XP,
  MAX_CAPTAIN_LEVEL,
  MAX_CAPTAIN_XP,
  LEGACY_DOCTRINES,
  doctrineXpMult,
  knownTraits,
  levelForXp,
  traitPointsForLevel
} from '../config/captain.js';
import { innateEffectId } from '../config/crew.js';

// `db` is the Prisma client or an open transaction. Returns the pilot's Captain, creating the Level 1
// starter (named after the pilot) if there is none yet. The insert skips an existing row instead of
// failing on it, so a concurrent first login cannot abort the caller's transaction.
export async function ensureCaptain(db, playerId, name) {
  const existing = await db.captain.findUnique({ where: { playerId } });
  if (existing) return existing;
  await db.captain.createMany({ data: [{ playerId, name }], skipDuplicates: true });
  return db.captain.findUnique({ where: { playerId } });
}

// The trait ids a stored captain (or none) has unlocked.
export const captainTraits = (captain) => knownTraits(captain?.unlockedTraits);

// `db` is the Prisma client or an open transaction. The ids of the Legacy Doctrines in force for the
// pilot: those of its retired captains marked active, whoever commands now.
export async function activeDoctrineIdsOf(db, playerId) {
  const rows = await db.retiredCaptain.findMany({
    where: { playerId, activeDoctrine: true, legacyDoctrineId: { not: null } },
    orderBy: [{ retiredAt: 'asc' }, { id: 'asc' }],
    select: { legacyDoctrineId: true }
  });
  return rows.map((row) => row.legacyDoctrineId).filter((id) => Object.hasOwn(LEGACY_DOCTRINES, id));
}

// The effect ids computeShipAttributes, the wage terms and the XP award read as the captain's
// `traits`: its unlocked trait ids, the pilot's active Legacy Doctrines `doctrineIds` and, for a
// captain promoted from the crew, its innate class (innateEffectId).
export function effectIdsFor(captain, doctrineIds = []) {
  const innate = innateEffectId(captain);
  return [...captainTraits(captain), ...doctrineIds, ...(innate ? [innate] : [])];
}

// What the client shows of a captain.
export function captainView(captain) {
  const traits = captainTraits(captain);
  const level = levelForXp(captain.xp);
  const innate = innateEffectId(captain);
  return {
    name: captain.name,
    originType: captain.originType,
    ...(innate && { innate: { crewClass: captain.innateClass, rank: captain.innateRank, quirkId: captain.quirkId } }),
    level,
    xp: captain.xp,
    xpForLevel: LEVEL_XP[level - 1],
    xpForNextLevel: level < MAX_CAPTAIN_LEVEL ? LEVEL_XP[level] : null,
    unlockedTraits: traits,
    traitPoints: traitPointsForLevel(level),
    traitPointsAvailable: Math.max(0, traitPointsForLevel(level) - traits.length),
    missionsCompleted: captain.missionsCompleted
  };
}

// `tx` is an open transaction holding the pilot's lock (lockActiveShip), and `captain` its Captain as
// read under that lock. Adds `xpGained`, raised by the XP doctrines among `traits` (lockActiveShip's
// `ship.traits`), and a completed mission when `missionCompleted`, keeping the stored level derived
// from the new XP. Callers award only inside the transaction that records the verified claim, so a
// replayed claim, refused there, awards nothing.
export async function awardCaptainXp(tx, captain, xpGained, { missionCompleted = false, traits = [] } = {}) {
  const boosted = Math.floor(Math.round(xpGained * doctrineXpMult(traits) * 1e6) / 1e6);
  const xp = Math.min(MAX_CAPTAIN_XP, captain.xp + boosted);
  const updated = await tx.captain.update({
    where: { id: captain.id },
    data: {
      xp,
      level: levelForXp(xp),
      ...(missionCompleted && { missionsCompleted: { increment: 1 } })
    }
  });
  const view = captainView(updated);
  return { xpGained: xp - captain.xp, currentLevel: view.level, traitPointsAvailable: view.traitPointsAvailable };
}
