import { FACTION_IDS } from '../config/factions.js';
import {
  CUSTOMS_STATUS,
  DOMESTIC_ORE_MAX_REPUTATION_PER_SALE,
  DOMESTIC_ORE_MILLI_PER_REPUTATION,
  isPoachedStatus
} from '../config/regulation.js';
import { LEDGER_REASONS, adjustReputation } from './reputation.js';

// The ore a signed sale sells that the faction governing the station's own system regards as its domestic ore: lots
// mined in that very system, under that faction. `items` are the sale record's lots as relayed (camelCase) and
// `station` is `{ systemH3, factionId }` as the sale's docked receipt proves it. Of those lots:
// - `reputationMilli` counts the units (in milli-units) mined legally (DOMESTIC_OR_FREE), which earn standing;
// - `poached` says whether any was poached (UNLICENSED_POACHED, or a status not known), which the amnesty charges for.
// Ore that was cleared for export, or left the system undeclared, is neither: it earns nothing and owes nothing here.
// (Clearing a legal lot for export turns it EXPORT_CLEARED, so it no longer earns standing at a home sale.)
export function domesticOre(items, station) {
  const domestic = FACTION_IDS.includes(station?.factionId)
    ? items.filter((lot) => lot.originSystemH3 === station.systemH3 && lot.originFactionId === station.factionId)
    : [];
  return {
    reputationMilli: domestic.filter((lot) => lot.customsStatus === CUSTOMS_STATUS.DOMESTIC_OR_FREE)
      .reduce((sum, lot) => sum + lot.unitsMilli, 0),
    poached: domestic.some((lot) => isPoachedStatus(lot.customsStatus))
  };
}

// Whether the sale needs its station's system and faction proven (by a docked receipt for that very station) before
// it can be credited: it sells poached ore of a faction's system, which the amnesty must be able to charge for. Without
// the proof a pilot would sell it untaxed by leaving the receipt out.
export const needsStationProof = (items) =>
  items.some((lot) => FACTION_IDS.includes(lot.originFactionId) && isPoachedStatus(lot.customsStatus));

/**
 * Inside the transaction holding the pilot's lock: credits `milli` milli-units of domestic ore sold to `factionId`
 * toward the reputation it earns: one point per 50 units, at most DOMESTIC_ORE_MAX_REPUTATION_PER_SALE a sale, the
 * part short of a point kept in PlayerReputation.domesticOreRemainder (what a capped sale left over is dropped, so a
 * large haul cannot be banked past the cap). Returns the standing points the faction actually gained after its caps.
 */
export async function awardDomesticOre(tx, playerId, factionId, milli, standingBefore) {
  if (milli <= 0) return 0;
  const where = { playerId_factionId: { playerId, factionId } };
  const row = await tx.playerReputation.findUnique({ where });
  const total = (row?.domesticOreRemainder ?? 0) + milli;
  const points = Math.min(DOMESTIC_ORE_MAX_REPUTATION_PER_SALE, Math.floor(total / DOMESTIC_ORE_MILLI_PER_REPUTATION));
  const domesticOreRemainder = total % DOMESTIC_ORE_MILLI_PER_REPUTATION;
  await tx.playerReputation.upsert({
    where,
    update: { domesticOreRemainder },
    create: { playerId, factionId, standing: 0, domesticOreRemainder }
  });
  if (points === 0) return 0;
  const standing = await adjustReputation(tx, playerId, factionId, points, { reason: LEDGER_REASONS.DOMESTIC_ORE_SALE });
  return standing - standingBefore;
}
