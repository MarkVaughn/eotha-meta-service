import fp from 'fastify-plugin';
import env from '../config/env.js';
import { createAuth } from '../lib/auth.js';
import { linkExternalAccount } from '../lib/identity.js';
import { createRefreshTokens } from '../lib/refresh-tokens.js';

const DAY_SECONDS = 24 * 60 * 60;

/**
 * Better Auth plus refresh-token rotation. Decorates `fastify.betterAuth` and `fastify.refreshTokens`.
 * Requires the prisma and security plugins.
 */
async function identityPlugin(fastify, opts) {
  const betterAuth = createAuth({
    prisma: fastify.prisma,
    secret: env.BETTER_AUTH_SECRET ?? fastify.authSecret,
    baseURL: env.BETTER_AUTH_URL ?? `http://localhost:${env.PORT}`,
    sessionTtlSeconds: env.SESSION_TTL_DAYS * DAY_SECONDS,
    onAccountLinked: linkExternalAccount(fastify.prisma)
  });

  fastify.decorate('betterAuth', betterAuth);
  fastify.decorate(
    'refreshTokens',
    createRefreshTokens({
      prisma: fastify.prisma,
      auth: betterAuth,
      refreshTtlMs: env.REFRESH_TOKEN_TTL_DAYS * DAY_SECONDS * 1000
    })
  );
}

export default fp(identityPlugin);
