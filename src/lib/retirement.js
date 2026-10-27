import { FACTION_IDS } from '../config/factions.js';
import { LEGACY_DOCTRINES, capstoneOf } from '../config/captain.js';
import { QUIRKS } from '../config/crew.js';
import { captainTraits } from './captain.js';

// The standings `{ alpha, beta, gamma }` of a factions claim (lockActiveShip's `ship.factions`), the
// shape a RetiredCaptain keeps them in.
export const standingsSnapshot = (factions) => Object.fromEntries(FACTION_IDS.map((id) => [id, factions?.[id] ?? 0]));

// The faction a retiring captain is aligned with: the one it stands highest with, the earlier id on a
// tie, or null when it stands above neutral with none.
export function primaryFactionOf(standings) {
  const best = FACTION_IDS.reduce((top, id) => (standings[id] > standings[top] ? id : top), FACTION_IDS[0]);
  return standings[best] > 0 ? best : null;
}

// Whether a crew member would resign when passed over for succession: a Master with the AMBITIOUS quirk.
export const resignsWhenPassedOver = (member) => member.rank === 'MASTER' && QUIRKS[member.quirkId]?.key === 'AMBITIOUS';

// The RetiredCaptain row data (no player or receipt) for `captain` retiring with `tier`, as read under
// the pilot's lock; `factions` is the pilot's factions claim and `dock` the receipt's `{ stationId, systemH3 }`.
export function retiredCaptainData(captain, { tier, level, factions, dock, doctrineId }) {
  const traits = captainTraits(captain);
  const standings = standingsSnapshot(factions);
  return {
    name: captain.name,
    originType: captain.originType,
    promotedFromCrewId: captain.promotedFromCrewId,
    innateClass: captain.innateClass,
    innateRank: captain.innateRank,
    quirkId: captain.quirkId,
    finalLevel: level,
    finalXp: captain.xp,
    retirementTier: tier,
    missionsCompleted: captain.missionsCompleted,
    unlockedTraits: traits,
    capstoneTraitId: capstoneOf(traits),
    legacyDoctrineId: doctrineId ?? null,
    activeDoctrine: doctrineId !== undefined,
    factionStandingsSnapshot: standings,
    primaryFactionId: primaryFactionOf(standings),
    retiredAtStationId: dock.stationId,
    retiredAtSystemH3: dock.systemH3
  };
}

export const doctrineView = (doctrineId) => {
  const d = LEGACY_DOCTRINES[doctrineId];
  return d && { id: d.id, name: d.name, tier: d.tier, summary: d.summary };
};

// What the client shows of a retired captain: the permanent dossier.
export function retiredCaptainView(row) {
  return {
    id: row.id,
    name: row.name,
    originType: row.originType,
    promotedFromCrewId: row.promotedFromCrewId,
    innate: row.innateClass ? { crewClass: row.innateClass, rank: row.innateRank, quirkId: row.quirkId } : null,
    finalLevel: row.finalLevel,
    finalXp: row.finalXp,
    retirementTier: row.retirementTier,
    missionsCompleted: row.missionsCompleted,
    unlockedTraits: captainTraits({ unlockedTraits: row.unlockedTraits }),
    capstoneTraitId: row.capstoneTraitId,
    legacyDoctrine: row.legacyDoctrineId ? { ...doctrineView(row.legacyDoctrineId), active: row.activeDoctrine } : null,
    factionStandings: row.factionStandingsSnapshot,
    primaryFactionId: row.primaryFactionId,
    retiredAtStationId: row.retiredAtStationId,
    retiredAtSystemH3: row.retiredAtSystemH3,
    assignmentStatus: row.assignmentStatus,
    assignedSpaceshipId: row.assignedSpaceshipId,
    retiredAt: row.retiredAt.toISOString()
  };
}

// `db` is the Prisma client or an open transaction. The pilot's retired captains, oldest first.
export const retiredCaptainsOf = (db, playerId) =>
  db.retiredCaptain.findMany({ where: { playerId }, orderBy: [{ retiredAt: 'asc' }, { id: 'asc' }] });
