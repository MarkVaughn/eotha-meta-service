import fp from 'fastify-plugin';
import fastifyJwt from '@fastify/jwt';
import { readFileSync } from 'fs';
import { join } from 'path';

async function securityPlugin(fastify, opts) {
  let privateKey;
  let publicKey;

  try {
    privateKey = readFileSync(join(process.cwd(), 'keys', 'private.pem'), 'utf8');
    publicKey = readFileSync(join(process.cwd(), 'keys', 'public.pem'), 'utf8');
  } catch (err) {
    fastify.log.warn("⚠️ Security keys not found. Falling back to local symmetric development secret!");
    privateKey = 'super-secret-dev-key';
    publicKey = 'super-secret-dev-key';
  }

  const isAsymmetric = privateKey.includes('PRIVATE KEY');

  await fastify.register(fastifyJwt, {
    secret: {
      private: privateKey,
      public: publicKey
    },
    sign: {
      algorithm: isAsymmetric ? 'EdDSA' : 'HS256',
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
