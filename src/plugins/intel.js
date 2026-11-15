import fp from 'fastify-plugin';
import env from '../config/env.js';
import { loadVoucherKey } from '../lib/intel-voucher.js';

/**
 * Station Intel's one outside dependency: `fastify.intelVoucherKey`, `{ keyId, privateKey }`, this service's own voucher
 * signing key, or null when INTEL_VOUCHER_PRIVATE_KEY_FILE is unset, in which case gathering any intel is refused
 * 503 before anything is charged. The pool itself needs nothing from here: the engine builds it and the client relays each
 * signed item it wants to gather (verified against the claim key, `fastify.claimKey`).
 */
async function intelPlugin(fastify, opts) {
  const voucherKey = opts.voucherKey !== undefined ? opts.voucherKey
    : loadVoucherKey({ keyFile: env.INTEL_VOUCHER_PRIVATE_KEY_FILE, keyId: env.INTEL_VOUCHER_KEY_ID });
  if (!voucherKey) {
    fastify.log.warn('INTEL_VOUCHER_PRIVATE_KEY_FILE is not set: gathering any intel is refused 503 intel_voucher_key_not_configured.');
  }
  fastify.decorate('intelVoucherKey', voucherKey);
}

export default fp(intelPlugin);
