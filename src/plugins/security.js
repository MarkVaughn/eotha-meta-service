import fp from 'fastify-plugin';
import fastifyJwt from '@fastify/jwt';
import { createPublicKey, hkdfSync } from 'node:crypto';
import { readFileSync } from 'fs';
import { calculateJwkThumbprint, exportJWK } from 'jose';
import { join, resolve } from 'path';
import env from '../config/env.js';

function readKey(dir, name) {
  const path = join(dir, name);
  try {
    return readFileSync(path, 'utf8');
  } catch (err) {
    throw new Error(
      `Signing key ${path} could not be read (${err.code ?? err.message}). ` +
      'Refusing to start without the shared Ed25519 keypair; run `npm run keys:generate` for local development.'
    );
  }
}

async function securityPlugin(fastify, opts) {
  const keysDir = resolve(opts.keysDir ?? env.KEYS_DIR);
  const privateKey = readKey(keysDir, 'private.pem');
  const publicKey = readKey(keysDir, 'public.pem');

  // Public half of the signing key as a JWKS, so verifiers can fetch it instead of pinning the PEM.
  // The kid (RFC 7638 thumbprint) is also stamped into every token header.
  const jwk = await exportJWK(createPublicKey(publicKey));
  const kid = await calculateJwkThumbprint(jwk);
  fastify.decorate('jwks', { keys: [{ ...jwk, kid, alg: 'EdDSA', use: 'sig' }] });
  // Secret for Better Auth, derived so every replica sharing the keypair agrees on it.
  fastify.decorate(
    'authSecret',
    Buffer.from(hkdfSync('sha256', privateKey, 'eotha-meta-service', 'better-auth-secret', 32)).toString('hex')
  );

  await fastify.register(fastifyJwt, {
    secret: {
      private: privateKey,
      public: publicKey
    },
    sign: {
      algorithm: 'EdDSA',
      issuer: 'eotha.meta-service',
      expiresIn: env.ACCESS_TOKEN_TTL_SECONDS,
      kid
    }
  });

  // Signs claims that already carry their own `exp`. A configured `expiresIn` would override it, and
  // per-call sign options replace the defaults, so the key id is restated here.
  fastify.decorate('signWithExpiry', (claims) => fastify.jwt.sign(claims, { kid }));

  // Decorator to protect specific meta endpoints
  fastify.decorate('authenticate', async (request, reply) => {
    try {
      await request.jwtVerify();
    } catch (err) {
      reply.code(401).send({ error: 'Unauthorized credentials' });
    }
  });
}

export default fp(securityPlugin);
