import { DockableKind } from './contracts/penalty/eotha/common/v1/sector.js';
import { NOMINAL_MORALE_THRESHOLD, RANKS, effectiveMorale } from '../config/crew.js';
import { TRAUMA_FEE_WAIVER_MIN_RANK, TRAUMA_TREATED_MORALE_FLOOR, TRAUMA_TREATMENT_FEE_CREDITS } from '../config/expedition.js';
import { stationServices } from './outfitting-station.js';

// The docks with medical facilities. Mining outposts have none.
const INFIRMARY_KINDS = Object.freeze([DockableKind.DOCKABLE_KIND_COLONY, DockableKind.DOCKABLE_KIND_RESEARCH, DockableKind.DOCKABLE_KIND_TRADING]);

/**
 * Whether the dock the docked `receipt` vouches for has an infirmary: a colony, research or trading dock. A dock
 * of known kind that is none of those (a mining outpost) has none. A dock of unknown kind qualifies unless
 * `stationServices.requireKnownDockableKind` is set (receipts do not carry the kind yet).
 */
export function hasInfirmary(receipt) {
  const kind = stationServices.dockableKind(receipt);
  if (kind === DockableKind.DOCKABLE_KIND_UNSPECIFIED) return !stationServices.requireKnownDockableKind;
  return INFIRMARY_KINDS.includes(kind);
}

/** Whether `member` is still incapacitated by an expedition trauma at `nowMs`. */
export const isTraumatized = (member, nowMs) => member.traumaUntil != null && member.traumaUntil.getTime() > nowMs;

/**
 * Whether the active `crew` includes a Doctor who treats for free: Adept or Master, at Nominal morale or better,
 * not held by customs and not themselves incapacitated.
 */
export const hasWaivingDoctor = (crew, nowMs) => crew.some((member) => member.crewClass === 'DOCTOR'
  && RANKS.indexOf(member.rank) >= RANKS.indexOf(TRAUMA_FEE_WAIVER_MIN_RANK)
  && effectiveMorale(member) >= NOMINAL_MORALE_THRESHOLD
  && !member.detained
  && !isTraumatized(member, nowMs));

/** The medical fee for treating `member` aboard a ship with the active `crew`: 0 with a waiving Doctor. */
export const treatmentFee = (member, crew, nowMs) => (hasWaivingDoctor(crew, nowMs) ? 0 : TRAUMA_TREATMENT_FEE_CREDITS[member.rank]);

/** The morale a treated `member` is left with: at least the nominal floor, but a resigned member (0) stays resigned. */
export const treatedMorale = (member) => (member.morale > 0 ? Math.max(member.morale, TRAUMA_TREATED_MORALE_FLOOR) : 0);
