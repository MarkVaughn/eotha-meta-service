import fp from 'fastify-plugin';
import env from '../config/env.js';
import { createHttpIntelEngine, unconfiguredIntelEngine } from '../lib/intel-engine.js';
import { loadVoucherKey } from '../lib/intel-voucher.js';

/**
 * Station Intel's two outside dependencies.
 * - `fastify.intelEngine`: the engine's pool generator behind a swappable seam (`getPool`); `intelEngine.use(impl)` replaces
 *   it (tests), `intelEngine.reset()` restores the configured one. Without INTEL_ENGINE_URL the pool answers
 *   503 intel_engine_unavailable.
 * - `fastify.intelVoucherKey`: `{ keyId, privateKey }`, this service's own voucher signing key, or null when
 *   INTEL_VOUCHER_PRIVATE_KEY_FILE is unset, in which case gathering a mission lead is refused 503 before anything is charged.
 */
async function intelPlugin(fastify, opts) {
  const configured = opts.engine ?? (env.INTEL_ENGINE_URL
    ? createHttpIntelEngine({ baseUrl: env.INTEL_ENGINE_URL, credential: env.INTEL_ENGINE_CREDENTIAL })
    : unconfiguredIntelEngine);
  let current = configured;
  fastify.decorate('intelEngine', {
    getPool: (request) => current.getPool(request),
    use(impl) { current = impl; },
    reset() { current = configured; }
  });

  const voucherKey = opts.voucherKey !== undefined ? opts.voucherKey
    : loadVoucherKey({ keyFile: env.INTEL_VOUCHER_PRIVATE_KEY_FILE, keyId: env.INTEL_VOUCHER_KEY_ID });
  if (!voucherKey) {
    fastify.log.warn('INTEL_VOUCHER_PRIVATE_KEY_FILE is not set: gathering a mission lead or faction recruitment call is refused 503 intel_voucher_key_not_configured.');
  }
  fastify.decorate('intelVoucherKey', voucherKey);
}

export default fp(intelPlugin);
