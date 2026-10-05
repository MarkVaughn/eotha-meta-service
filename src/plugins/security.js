import fp from 'fastify-plugin';
import fastifyJwt from '@fastify/jwt';
import { readFileSync } from 'fs';
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

  await fastify.register(fastifyJwt, {
    secret: {
      private: privateKey,
      public: publicKey
    },
    sign: {
      algorithm: 'EdDSA',
      issuer: 'eotha.meta-service',
      expiresIn: '24h'
    }
  });

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
