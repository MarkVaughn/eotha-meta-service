import {
  FACTION_IDS,
  FLYING_COLORS_MIN_REP,
  NON_PARAGON_CAP_WHEN_PARAGON_ACTIVE,
  PARAGON_THRESHOLD,
  boundedStanding,
  clampStandingsWithCaps,
  isFactionId
} from '../config/factions.js';
import { DEFAULT_FACTION_ID } from '../config/missions.js';
import { CREW_PERK, QUIRKS, crewPerk } from '../config/crew.js';

// What a ReputationLedger row's `reason` records.
export const LEDGER_REASONS = Object.freeze({
  MISSION_COMPLETED: 'MISSION_COMPLETED',
  COMPLETE_COVERT_CLEAN: 'COMPLETE_COVERT_CLEAN',
  COMPLETE_COVERT_DETECTED: 'COMPLETE_COVERT_DETECTED',
  MISSION_ABANDONED: 'MISSION_ABANDONED',
  RENOUNCE_PARAGON: 'RENOUNCE_PARAGON'
});

// The faction a mission's reputation goes to: its signed sponsor, else DEFAULT_FACTION_ID.
export const missionFaction = (offer) => offer.faction_id || DEFAULT_FACTION_ID;

// The share a gain with `factionId` is raised by the active `crew`'s LOYALISTs: the best `homeReputationBonus`
// among the working members whose home faction it is (it does not stack).
const loyalistReputationBonus = (crew, factionId) =>
  Math.max(0, ...crew.filter((member) => member.morale > 0 && member.homeFactionId === factionId)
    .map((member) => QUIRKS[member.quirkId]?.homeReputationBonus ?? 0));

// `delta` of a mission for `factionId` as the active `crew` change it: a gain is raised by a Diplomat's
// reputation bonus and by a LOYALIST of that faction. A loss is never raised.
export const withCrewReputationBonus = (delta, crew, factionId) =>
  delta > 0 ? Math.round(delta * (1 + crewPerk(crew, CREW_PERK.REPUTATION_GAIN_BONUS) + loyalistReputationBonus(crew, factionId))) : delta;

// The harm `delta` (negative) a mission does to its rival faction as the active `crew` soften it: a
// Diplomat's reduction takes a share off (never past none).
export const withCrewRivalHarmCut = (delta, crew) =>
  delta < 0 ? Math.round(delta * (1 - Math.min(1, crewPerk(crew, CREW_PERK.RIVAL_HARM_REDUCTION)))) : delta;

const DELTA_COLUMNS = { alpha: 'alphaDelta', beta: 'betaDelta', gamma: 'gammaDelta' };

// The pilot's standings with the three factions, `{ alpha, beta, gamma }`, a missing row being 0.
async function factionStandings(db, playerId) {
  const rows = await db.playerReputation.findMany({ where: { playerId, factionId: { in: FACTION_IDS } } });
  const standings = Object.fromEntries(FACTION_IDS.map((id) => [id, 0]));
  for (const row of rows) standings[row.factionId] = row.standing;
  return standings;
}

const upsertStanding = (tx, playerId, factionId, standing) => {
  const where = { playerId_factionId: { playerId, factionId } };
  return tx.playerReputation.upsert({ where, update: { standing }, create: { playerId, factionId, standing } });
};

// Inside `tx`, holding the pilot's lock: writes `change(previous)` as the pilot's three standings
// after clampStandingsWithCaps, appends what changed to the ledger with `entry` (`reason`,
// `missionId`, `factionId`), and stops flying colors whose standing fell below FLYING_COLORS_MIN_REP.
// Returns the standings written.
async function rewriteFactionStandings(tx, playerId, change, entry) {
  const previous = await factionStandings(tx, playerId);
  const wanted = change(previous);
  const next = clampStandingsWithCaps(wanted.alpha, wanted.beta, wanted.gamma, previous);
  const changed = FACTION_IDS.filter((id) => next[id] !== previous[id]);
  if (!changed.length) return next;
  for (const id of changed) await upsertStanding(tx, playerId, id, next[id]);
  const deltas = Object.fromEntries(changed.map((id) => [DELTA_COLUMNS[id], next[id] - previous[id]]));
  await tx.reputationLedger.create({
    data: { playerId, ...entry, factionDelta: next[entry.factionId] - previous[entry.factionId], ...deltas }
  });
  const player = await tx.player.findUnique({ where: { id: playerId }, select: { activeColorsFactionId: true } });
  const colors = player?.activeColorsFactionId;
  if (colors && next[colors] < FLYING_COLORS_MIN_REP) {
    await tx.player.update({ where: { id: playerId }, data: { activeColorsFactionId: null } });
  }
  return next;
}

// Adds `delta` to the pilot's standing with `factionId` and returns the new standing. A standing
// with one of FACTION_IDS goes through clampStandingsWithCaps with the other two, which it may cap;
// any other is only bounded. Every change is appended to the ReputationLedger with `reason` and
// `missionId`. `tx` is an open transaction holding the pilot's lock (lockActiveShip), which
// serialises this read-modify-write with every other one of the pilot's.
export async function adjustReputation(tx, playerId, factionId, delta, { reason, missionId = null } = {}) {
  const entry = { reason, missionId, factionId };
  if (isFactionId(factionId)) {
    if (delta === 0) return (await factionStandings(tx, playerId))[factionId];
    const next = await rewriteFactionStandings(tx, playerId, (s) => ({ ...s, [factionId]: s[factionId] + delta }), entry);
    return next[factionId];
  }
  const where = { playerId_factionId: { playerId, factionId } };
  const current = (await tx.playerReputation.findUnique({ where }))?.standing ?? 0;
  if (delta === 0) return current;
  const standing = boundedStanding(current + delta);
  await upsertStanding(tx, playerId, factionId, standing);
  if (standing !== current) await tx.reputationLedger.create({ data: { ...entry, playerId, factionDelta: standing - current } });
  return standing;
}

// A completion can change sponsor and rival together. Apply both before the faction caps so
// rival harm that frees a cap in this same event does not prematurely truncate sponsor gains.
// The ledger records the combined capped deltas with the sponsor as its primary faction.
export async function adjustMissionReputation(tx, playerId, factionId, sponsorDelta, opposedFactionId, opposedDelta, entry) {
  if (isFactionId(factionId) && isFactionId(opposedFactionId) && opposedDelta !== 0) {
    return rewriteFactionStandings(tx, playerId, (previous) => {
      const next = { ...previous };
      next[factionId] += sponsorDelta;
      next[opposedFactionId] += opposedDelta;
      return next;
    }, { ...entry, factionId });
  }
  await adjustReputation(tx, playerId, factionId, sponsorDelta, entry);
  if (opposedFactionId && opposedDelta !== 0) {
    await adjustReputation(tx, playerId, opposedFactionId, opposedDelta, entry);
  }
}

// Inside `tx`, holding the pilot's lock: lowers the pilot's Paragon standing with `factionId` to
// NON_PARAGON_CAP_WHEN_PARAGON_ACTIVE, freeing another faction to reach Paragon. Returns
// `{ renounced: <new standing> }`, or `{ current }` when the pilot is not that faction's Paragon.
export async function renounceParagon(tx, playerId, factionId) {
  const current = (await factionStandings(tx, playerId))[factionId];
  if (current < PARAGON_THRESHOLD) return { current };
  const next = await rewriteFactionStandings(
    tx,
    playerId,
    (s) => ({ ...s, [factionId]: NON_PARAGON_CAP_WHEN_PARAGON_ACTIVE }),
    { reason: LEDGER_REASONS.RENOUNCE_PARAGON, missionId: null, factionId }
  );
  return { renounced: next[factionId] };
}

// `db` is the Prisma client or an open transaction. The pilot's standings as `{ [factionId]: standing }`;
// a faction with no row is neutral and left out.
export async function standingsOf(db, playerId) {
  const rows = await db.playerReputation.findMany({ where: { playerId }, orderBy: { factionId: 'asc' } });
  return Object.fromEntries(rows.map((row) => [row.factionId, row.standing]));
}

// `db` is the Prisma client or an open transaction. The token's `factions` claim: the pilot's
// standings with the three factions and the faction whose colors it flies (or null).
export async function factionsClaim(db, playerId) {
  const standings = await factionStandings(db, playerId);
  const player = await db.player.findUnique({ where: { id: playerId }, select: { activeColorsFactionId: true } });
  return { ...standings, active_colors: player?.activeColorsFactionId ?? null };
}
