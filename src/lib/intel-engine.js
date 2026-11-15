// The meta-service's one door to the engine's Station Intel generator. The pool is a pure function of the dockable, the
// hour and the sighting log, so this is a thin request/response seam: `getPool` and nothing else. Routes only ever see
// `fastify.intelEngine` (src/plugins/intel.js), so tests swap in a double and the HTTP client below can change when the
// engine's endpoint lands without touching a route.

export class IntelEngineUnavailable extends Error {}

/**
 * A client for the engine's intel pool endpoint. `getPool` takes
 * `{ stationEntityId, systemH3, controllingFactionId, hourEpoch, sightings }` (`sightings`: the station's logged
 * departures as they stood when the hour began, `[{ sighting_id, ship_name, captain_name, hull_tier, weapon_tier,
 * shield_tier, flying_colors, is_stealthed, undocked_at_ms }]`, snake_case like the rest of the request, 15 minutes to 4 hours old then) and answers the engine's raw `items`
 * (proto-JSON `IntelItem`s), which src/lib/intel-offer.js validates before anything is shown.
 *
 * The wire is provisional until the engine's side lands: `POST {baseUrl}/v1/intel/pool` with the request as JSON
 * (snake_case keys), answered with `{ "items": [...] }`. Throws IntelEngineUnavailable on any transport failure.
 */
export function createHttpIntelEngine({ baseUrl, credential, timeoutMs = 3000, fetchImpl = globalThis.fetch }) {
  return {
    async getPool({ stationEntityId, systemH3, controllingFactionId, hourEpoch, sightings }) {
      let response;
      try {
        response = await fetchImpl(new URL('/v1/intel/pool', baseUrl), {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...(credential && { 'x-eotha-workload-credential': credential }) },
          body: JSON.stringify({
            station_entity_id: stationEntityId,
            system_h3: systemH3,
            controlling_faction_id: controllingFactionId,
            hour_epoch: hourEpoch,
            sightings
          }),
          signal: AbortSignal.timeout(timeoutMs)
        });
      } catch (err) {
        throw new IntelEngineUnavailable(`The intel engine could not be reached: ${err.message}`);
      }
      if (!response.ok) throw new IntelEngineUnavailable(`The intel engine answered ${response.status}.`);
      try {
        return (await response.json()).items;
      } catch {
        throw new IntelEngineUnavailable('The intel engine answered something that is not JSON.');
      }
    }
  };
}

// The stand-in while no engine is configured: every pool request fails as unavailable.
export const unconfiguredIntelEngine = Object.freeze({
  async getPool() {
    throw new IntelEngineUnavailable('No intel engine is configured.');
  }
});
