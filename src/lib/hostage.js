import { HOSTAGE_BASE_PENALTY, HOSTAGE_MINUTES_PER_POINT, HOSTAGE_TIME_PENALTY_CAP } from '../config/missions.js';

// Whole minutes the hostage state of an `AbandonedMission` row has lasted at `nowMs`.
export const hostageMinutes = (row, nowMs) => Math.max(0, Math.floor((nowMs - row.abandonedAt.getTime()) / 60_000));

// The time penalty after `minutes` whole minutes: 0.5 a minute (one point per 2), at most 60.
export const accruedPenalty = (minutes) => Math.min(HOSTAGE_TIME_PENALTY_CAP, Math.floor(minutes / HOSTAGE_MINUTES_PER_POINT));

// The contract's `HostageState` of a row with passengers still aboard, as of `nowMs`.
export const hostageState = (row, nowMs) => ({
  mission_id: row.missionId,
  hostage_started_at_ms: row.abandonedAt.getTime(),
  accrued_penalty: accruedPenalty(hostageMinutes(row, nowMs)),
  as_of_ms: nowMs,
  required_berths: row.hostageBerths
});

const at = (receipt, stationId, systemH3) =>
  Boolean(stationId) && receipt.dockedEntityId === stationId && receipt.systemH3 === systemH3;

// Where a `receipt` drops the hostages of `row`, as a `DisembarkPlace` name: the mission's destination
// first, then its origin, else anywhere.
export function disembarkPlace(row, receipt) {
  if (at(receipt, row.destinationStationId, row.destinationSystemH3)) return 'DISEMBARK_PLACE_DESTINATION';
  if (at(receipt, row.originStationId, row.originSystemH3)) return 'DISEMBARK_PLACE_ORIGIN';
  return 'DISEMBARK_PLACE_ELSEWHERE';
}

export const basePenalty = (place) => HOSTAGE_BASE_PENALTY[place];
