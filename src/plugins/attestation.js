import fp from 'fastify-plugin';
import env from '../config/env.js';
import { AttestationError, createAttestationService } from '../lib/attestation/index.js';

/**
 * Device attestation for native-client sign-in. Decorates `fastify.attestation` (the verifier
 * registry) and `fastify.requireAttestation` (a preHandler that refuses unverified requests).
 * Clients send `X-Attestation-Platform` and `X-Attestation-Token`.
 *
 * @param {object} opts
 * @param {import('../lib/attestation/index.js').Verifier[]} [opts.verifiers]
 * @param {boolean} [opts.development] Overrides the NODE_ENV check (tests).
 * @param {boolean} [opts.allowUnattested] Overrides ALLOW_UNATTESTED_SIGNIN (tests).
 */
async function attestationPlugin(fastify, opts) {
  // ALLOW_UNATTESTED_SIGNIN is the explicit opt-in for a browser demo, which cannot attest: it relaxes
  // only the empty-registry case exactly as development does, and a registered verifier still applies.
  const allowUnattested = opts.allowUnattested ?? env.ALLOW_UNATTESTED_SIGNIN;
  if (allowUnattested && env.NODE_ENV !== 'development') {
    fastify.log.warn('ALLOW_UNATTESTED_SIGNIN is on: guest and password sign-in run without device attestation unless a verifier is registered.');
  }
  const attestation = createAttestationService({
    development: opts.development ?? (env.NODE_ENV === 'development' || allowUnattested),
    log: fastify.log
  });
  for (const verifier of opts.verifiers ?? []) attestation.register(verifier);

  fastify.decorate('attestation', attestation);
  fastify.decorate('requireAttestation', async (request, reply) => {
    try {
      await attestation.check({
        platform: request.headers['x-attestation-platform'],
        token: request.headers['x-attestation-token'],
        deviceId: request.body?.deviceId
      });
    } catch (err) {
      if (!(err instanceof AttestationError)) throw err;
      return reply.code(err.status).send({ error: err.code });
    }
  });
}

export default fp(attestationPlugin);
