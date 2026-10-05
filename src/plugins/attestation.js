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
 */
async function attestationPlugin(fastify, opts) {
  const attestation = createAttestationService({
    development: opts.development ?? env.NODE_ENV === 'development',
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
