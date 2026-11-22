import fp from 'fastify-plugin';
import env from '../config/env.js';
import { createTerritoryClient } from '../lib/territory.js';

/**
 * `fastify.territory`: the engine's territory lookup (src/lib/territory.js), which decides a new player's spawn
 * standing. Off when RTSE_INTERNAL_URL or INTERNAL_RTSE_CREDENTIAL is unset; new players then start with none.
 * `opts.territory` replaces the client (tests).
 */
async function territoryPlugin(fastify, opts) {
  const territory = opts.territory ?? createTerritoryClient({
    url: env.RTSE_INTERNAL_URL,
    credential: env.INTERNAL_RTSE_CREDENTIAL,
    log: fastify.log
  });
  if (!territory.configured) {
    fastify.log.warn('RTSE_INTERNAL_URL or INTERNAL_RTSE_CREDENTIAL is not set: new players start with no spawn faction standing.');
  }
  fastify.decorate('territory', territory);
}

export default fp(territoryPlugin);
