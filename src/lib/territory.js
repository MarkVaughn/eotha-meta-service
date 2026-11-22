import { TerritoryLookupResponse } from './contracts/territory.js';
import { CONTROLLING_FACTION_IDS } from './docked-receipt.js';

// The engine's private territory route (eotha-contracts proto/eotha/internal/v1/territory.proto); the cell is the
// one path segment after it.
export const TERRITORY_ROUTE = '/internal/v1/territory/';
// How long a lookup may take before a new player's harbor is created without spawn standing. A sign-in waits
// this long at most for the engine.
export const TERRITORY_LOOKUP_TIMEOUT_MS = 2000;
const WORKLOAD_CREDENTIAL_HEADER = 'x-eotha-workload-credential';
// A ring-1 disk holds 6 neighbors, 5 at a pentagon.
const MAX_NEIGHBORS = 6;

const isControllingFactionId = (id) => typeof id === 'string' && CONTROLLING_FACTION_IDS.includes(id);

/**
 * The territory of resolution 8 cell `h3Index` from a TerritoryLookupResponse body, or null when the body does
 * not describe that cell: `{ controllingFactionId, neighborFactionIds }`, each '' for an uncontrolled cell or
 * 'alpha', 'beta' or 'gamma', one entry per ring-1 neighbor.
 */
export function decodeTerritory(body, h3Index) {
  const { cell, neighbors } = TerritoryLookupResponse.decode(body);
  if (cell?.h3Cell !== h3Index || !isControllingFactionId(cell.controllingFactionId)) return null;
  if (neighbors.length > MAX_NEIGHBORS) return null;
  const cells = new Set(neighbors.map(({ h3Cell }) => h3Cell));
  if (cells.size !== neighbors.length || cells.has(h3Index)) return null;
  if (!neighbors.every(({ controllingFactionId }) => isControllingFactionId(controllingFactionId))) return null;
  return {
    controllingFactionId: cell.controllingFactionId,
    neighborFactionIds: neighbors.map(({ controllingFactionId }) => controllingFactionId)
  };
}

/**
 * A client of the engine's territory lookup: `{ lookup(h3Index) }`, which resolves to the cell's territory (see
 * `decodeTerritory`) or null when it cannot be had: no `url` or `credential` configured, the engine unreachable,
 * slower than `timeoutMs`, answering anything but 200, or with a body that does not describe the cell. It never
 * rejects, so a lookup can never fail a sign-in; a failure is logged as a warning on `log`.
 */
export function createTerritoryClient({ url, credential, timeoutMs = TERRITORY_LOOKUP_TIMEOUT_MS, log, fetch: fetchImpl = fetch } = {}) {
  const configured = Boolean(url && credential);
  async function lookup(h3Index) {
    if (!configured) return null;
    try {
      const endpoint = new URL(`${TERRITORY_ROUTE}${encodeURIComponent(h3Index)}`, url);
      const res = await fetchImpl(endpoint, {
        headers: { [WORKLOAD_CREDENTIAL_HEADER]: credential, accept: 'application/x-protobuf' },
        signal: AbortSignal.timeout(timeoutMs)
      });
      if (res.status !== 200) {
        log?.warn({ h3Index, status: res.status }, 'territory lookup refused; the new harbor gets no spawn standing');
        return null;
      }
      const territory = decodeTerritory(new Uint8Array(await res.arrayBuffer()), h3Index);
      if (!territory) log?.warn({ h3Index }, 'territory lookup answered for another cell; the new harbor gets no spawn standing');
      return territory;
    } catch (err) {
      log?.warn({ h3Index, err: err?.message }, 'territory lookup failed; the new harbor gets no spawn standing');
      return null;
    }
  }
  return { configured, lookup };
}
