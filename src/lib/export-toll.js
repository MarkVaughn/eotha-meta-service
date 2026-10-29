import { DEFAULT_ORE_BASE_PRICE, ORE_BASE_PRICES } from '../config/cargo.js';
import { CUSTOMS_STATUS, exportTollBp, isClearableStatus } from '../config/regulation.js';
import { provenanceOf } from './cargo.js';

// units * base_price * purity * (1 + grade * 0.2), the engine's `item_value`, of a stored lot as the exact
// fraction `numerator / VALUE_DENOMINATOR` credits: units_milli / 1000 * price * purity_bp / 10 000 * (5 + grade) / 5.
const VALUE_DENOMINATOR = 1000n * 10_000n * 5n;
const lotValueNumerator = (lot) =>
  BigInt(lot.units_milli) * BigInt(ORE_BASE_PRICES[lot.resource_type] ?? DEFAULT_ORE_BASE_PRICE)
  * BigInt(lot.purity_bp) * BigInt(5 + lot.grade);

// `numerator / denominator` rounded half up.
const roundDiv = (numerator, denominator) => (2n * numerator + denominator) / (2n * denominator);

/**
 * What clearing the export of the ore in `lots` (a stored hold) costs at a dock in `systemH3`, whose system
 * `factionId` controls, for a pilot at `standing` flying `activeColors`. The toll clears the lots mined in that very
 * system under the faction that controls it whose status is one the toll clears (ore mined there legitimately, or
 * left undeclared; poached ore is not clearable); ore mined elsewhere, in free space, or already cleared is left
 * alone. It is a share (exportTollBp) of the baseline market value of the cleared ore, the sum of each lot's
 * `item_value` rounded once.
 *
 * Returns `{ lots, cleared, valueCredits, tollBp, tollCredits }`: `lots` the hold with the cleared ones marked
 * EXPORT_CLEARED, `cleared` how many lots that was. `cleared` is 0 and `lots` the hold itself when nothing qualifies.
 */
export function planExportClearance(lots, { systemH3, factionId, standing, activeColors }) {
  const clears = (lot) => {
    const origin = provenanceOf(lot);
    return origin.originSystemH3 === systemH3 && origin.originFactionId === factionId && isClearableStatus(origin.customsStatus);
  };
  const tollBp = exportTollBp(standing, factionId, activeColors);
  const numerator = lots.filter(clears).reduce((sum, lot) => sum + lotValueNumerator(lot), 0n);
  const cleared = lots.filter(clears).length;
  return {
    lots: lots.map((lot) => (clears(lot) ? { ...lot, customs_status: CUSTOMS_STATUS.EXPORT_CLEARED } : lot)),
    cleared,
    valueCredits: Number(roundDiv(numerator, VALUE_DENOMINATOR)),
    tollBp,
    tollCredits: Number(roundDiv(numerator * BigInt(tollBp), VALUE_DENOMINATOR * 10_000n))
  };
}
