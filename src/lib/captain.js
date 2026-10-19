import {
  LEVEL_XP,
  MAX_CAPTAIN_LEVEL,
  MAX_CAPTAIN_XP,
  knownTraits,
  levelForXp,
  traitPointsForLevel
} from '../config/captain.js';

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

// What the client shows of a captain.
export function captainView(captain) {
  const traits = captainTraits(captain);
  const level = levelForXp(captain.xp);
  return {
    name: captain.name,
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
// read under that lock. Adds `xpGained` (and a completed mission when `missionCompleted`), keeping the
// stored level derived from the new XP. Callers award only inside the transaction that records the
// verified claim, so a replayed claim, refused there, awards nothing.
export async function awardCaptainXp(tx, captain, xpGained, { missionCompleted = false } = {}) {
  const xp = Math.min(MAX_CAPTAIN_XP, captain.xp + xpGained);
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
