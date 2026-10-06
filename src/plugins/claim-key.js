import fp from 'fastify-plugin';
import env from '../config/env.js';
import { loadClaimPublicKey } from '../lib/claim-key.js';

/**
 * The public key that verifies engine-signed claims. Decorates `fastify.claimKey`
 * (`{ key, fingerprint }`, or `null` when unconfigured) and `fastify.requireClaimKey`, a preHandler
 * that refuses with 503 CLAIM_KEY_NOT_CONFIGURED instead of letting every claim fail as a bad
 * signature. Only the public half is ever configured here.
 *
 * @param {object} opts
 * @param {{ key: import('node:crypto').KeyObject, fingerprint: string } | null} [opts.claimKey]
 *   Overrides the configured key (tests); `null` means none.
 */
async function claimKeyPlugin(fastify, opts) {
  const claimKey = opts.claimKey !== undefined ? opts.claimKey : loadClaimPublicKey(env);
  if (claimKey) {
    fastify.log.info(`Engine claims are verified with Ed25519 key sha256:${claimKey.fingerprint}.`);
  } else {
    fastify.log.warn(
      'CLAIM_PUBLIC_KEY is not set: mission completion and chart claims are refused with 503 CLAIM_KEY_NOT_CONFIGURED.'
    );
  }

  fastify.decorate('claimKey', claimKey);
  fastify.decorate('requireClaimKey', async (request, reply) => {
    if (!fastify.claimKey) {
      return reply.code(503).send({
        error: 'CLAIM_KEY_NOT_CONFIGURED',
        message: 'This service has no engine claim public key configured.'
      });
    }
  });
}

export default fp(claimKeyPlugin);
