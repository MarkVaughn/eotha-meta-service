import { DockableKind } from './contracts/penalty/eotha/common/v1/sector.js';

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
  requireKnownDockableKind: false
};
