import { DockableKind, Wealth } from './contracts/penalty/eotha/common/v1/sector.js';

// What the meta-service knows about the dock a pilot outfits at. The docked receipt signs only the station id,
// its system cell and its governing faction, so anything richer (kind, wealth, the stocked catalog, security)
// comes from the station capability profile, which is the next ticket (M1-2). Until then this is its seam:
// the route asks `stationServices` and the defaults assume nothing about the dock, so tests (and M1-2)
// replace a method here rather than the route.
export const stationServices = {
  /** Whether the dock `receipt` vouches for is low-security, where a Hostile pilot can buy a black-market refit. */
  isLowSecDock: (receipt) => false, // eslint-disable-line no-unused-vars
  /**
   * The `DockableKind` of the dock `receipt` vouches for. Receipts do not carry it yet, so until the capability
   * profile exists every dock is UNSPECIFIED (unknown).
   */
  dockableKind: (receipt) => DockableKind.DOCKABLE_KIND_UNSPECIFIED, // eslint-disable-line no-unused-vars
  /**
   * Whether a service that needs a dock kind (the infirmary) refuses a dock whose kind is unknown. Off while
   * kinds are unavailable, so any valid docked receipt will do; switch it on once receipts or the capability
   * profile carry the kind, and unknown docks then stop qualifying.
   */
  requireKnownDockableKind: false,
  /**
   * The `Wealth` of the dock `receipt` vouches for. Receipts do not carry it yet, so until the capability profile
   * exists every dock is WEALTH_UNSPECIFIED (unknown).
   */
  wealth: (receipt) => Wealth.WEALTH_UNSPECIFIED, // eslint-disable-line no-unused-vars
  /**
   * Whether the dock `receipt` vouches for is a major shipyard. Neither the receipt nor `DockableKind` says so, so
   * until the capability profile exists no dock is one.
   */
  isMajorShipyard: (receipt) => false // eslint-disable-line no-unused-vars
};

// --- Planetary Lander stock (away-team plan T-M2-3) ------------------------------------------------------

// The highest lander tier each kind of dock fits. The lander has three tiers, so 3 is the ceiling. A colony
// (which includes a faction citadel) fits all three; a major shipyard of any kind does too.
const LANDER_MAX_TIER_BY_KIND = Object.freeze({
  [DockableKind.DOCKABLE_KIND_MINING]: 2,
  [DockableKind.DOCKABLE_KIND_RESEARCH]: 2,
  [DockableKind.DOCKABLE_KIND_TRADING]: 1,
  [DockableKind.DOCKABLE_KIND_COLONY]: 3
});
const LANDER_SHIPYARD_MAX_TIER = 3;

/**
 * Whether the dock is a free port that stocks Artisan landers: a trading dock in independent space (the receipt
 * names no controlling faction) whose populace is thriving.
 */
const isWealthyFreePort = (receipt, kind) => kind === DockableKind.DOCKABLE_KIND_TRADING
  && !receipt.controllingFactionId
  && stationServices.wealth(receipt) === Wealth.WEALTH_THRIVING;

/**
 * What the dock the docked `receipt` vouches for stocks in landers: `{ known, maxTier, artisan }`. A dock of
 * unknown kind has no profile: it stocks everything (the lander's own ceiling and every grade) unless
 * `stationServices.requireKnownDockableKind` is set, when it stocks nothing (`known: false`).
 */
export function landerStock(receipt) {
  const kind = stationServices.dockableKind(receipt);
  const maxTier = Math.max(LANDER_MAX_TIER_BY_KIND[kind] ?? 0, stationServices.isMajorShipyard(receipt) ? LANDER_SHIPYARD_MAX_TIER : 0);
  if (maxTier === 0 && kind === DockableKind.DOCKABLE_KIND_UNSPECIFIED) {
    return stationServices.requireKnownDockableKind
      ? { known: false, maxTier: 0, artisan: false }
      : { known: false, maxTier: LANDER_SHIPYARD_MAX_TIER, artisan: true };
  }
  return { known: true, maxTier, artisan: isWealthyFreePort(receipt, kind) };
}

/**
 * The coded 403 body when the dock `receipt` does not stock a lander of `targetTier` and `qualityGrade`, or null
 * when it does.
 */
export function landerStockRefusal(receipt, { targetTier, qualityGrade }) {
  const stock = landerStock(receipt);
  if (!stock.known && stock.maxTier === 0) {
    return { error: 'This dock stocks no planetary landers.', code: 'lander_not_stocked', maxTier: 0 };
  }
  if (targetTier > stock.maxTier) {
    return {
      error: `This dock stocks planetary landers up to tier ${stock.maxTier}.`,
      code: 'lander_tier_not_stocked',
      maxTier: stock.maxTier
    };
  }
  if (qualityGrade === 'ARTISAN' && !stock.artisan) {
    return { error: 'This dock does not stock Artisan planetary landers.', code: 'lander_quality_not_stocked', qualityGrade };
  }
  return null;
}
