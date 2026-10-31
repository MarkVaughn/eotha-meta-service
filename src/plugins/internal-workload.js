import { timingSafeEqual } from 'node:crypto';
import fp from 'fastify-plugin';
import env from '../config/env.js';

const normalizeFingerprint = (value) => String(value).replaceAll(':', '').toLowerCase();

function credentialsMatch(expected, actual) {
  if (typeof actual !== 'string' || !expected) return false;
  const expectedBytes = Buffer.from(expected);
  const actualBytes = Buffer.from(actual);
  return expectedBytes.length === actualBytes.length && timingSafeEqual(expectedBytes, actualBytes);
}

function verifiedClientFingerprint(request) {
  const socket = request.raw?.socket;
  if (!socket?.authorized || typeof socket.getPeerCertificate !== 'function') return null;
  const fingerprint = socket.getPeerCertificate()?.fingerprint256;
  return fingerprint ? normalizeFingerprint(fingerprint) : null;
}

/**
 * Authenticates private RTSE control-plane calls without ever interpreting an Authorization bearer
 * token as a workload credential. The static credential is the development transport; deployments
 * can instead (or additionally) allowlist mTLS certificate SHA-256 fingerprints.
 */
async function internalWorkloadPlugin(fastify, opts) {
  const credential = opts.credential ?? env.INTERNAL_RTSE_CREDENTIAL;
  const mtlsFingerprints = new Set((opts.mtlsFingerprints ?? env.INTERNAL_RTSE_MTLS_FINGERPRINTS ?? '')
    .split(',').map((value) => normalizeFingerprint(value.trim())).filter(Boolean));
  const ready = Boolean(credential || mtlsFingerprints.size > 0);

  if (!ready) fastify.log.warn('No internal RTSE workload credential or mTLS fingerprint allowlist is configured.');
  fastify.decorate('internalWorkloadReady', ready);
  fastify.decorate('authenticateRtseWorkload', async (request, reply) => {
    // A player bearer token must never gain access to the internal API, even if a proxy also
    // supplied a valid workload credential.
    if (typeof request.headers.authorization === 'string' && /^Bearer\s+/i.test(request.headers.authorization)) {
      return reply.code(401).send({ error: 'WORKLOAD_CREDENTIAL_REQUIRED' });
    }
    const supplied = request.headers['x-eotha-workload-credential'];
    const credentialAccepted = credentialsMatch(credential, Array.isArray(supplied) ? undefined : supplied);
    const mtlsAccepted = mtlsFingerprints.has(verifiedClientFingerprint(request));
    if (!credentialAccepted && !mtlsAccepted) return reply.code(401).send({ error: 'WORKLOAD_CREDENTIAL_REQUIRED' });
  });
}

export default fp(internalWorkloadPlugin);
