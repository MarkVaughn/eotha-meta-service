import fp from 'fastify-plugin';
import env from '../config/env.js';
import { createAuth } from '../lib/auth.js';
import { linkExternalAccount } from '../lib/identity.js';
import { createRefreshTokens } from '../lib/refresh-tokens.js';

const DAY_SECONDS = 24 * 60 * 60;

/**
 * Better Auth plus refresh-token rotation. Decorates `fastify.betterAuth`, `fastify.refreshTokens`,
 * `fastify.publicBaseUrl` and `fastify.googleSignIn` (whether the Google provider is configured).
 * Requires the prisma and security plugins.
 */
async function identityPlugin(fastify, opts) {
  const publicBaseUrl = (opts.publicBaseUrl ?? env.BETTER_AUTH_URL ?? `http://localhost:${env.PORT}`).replace(/\/+$/, '');
  const clientId = opts.google ? opts.google.clientId : env.GOOGLE_CLIENT_ID;
  const clientSecret = opts.google ? opts.google.clientSecret : env.GOOGLE_CLIENT_SECRET;
  const google = clientId && clientSecret ? { clientId, clientSecret } : undefined;
  const betterAuth = createAuth({
    prisma: fastify.prisma,
    secret: env.BETTER_AUTH_SECRET ?? fastify.authSecret,
    baseURL: publicBaseUrl,
    google,
    sessionTtlSeconds: env.SESSION_TTL_DAYS * DAY_SECONDS,
    onAccountLinked: linkExternalAccount(fastify.prisma)
  });

  fastify.decorate('betterAuth', betterAuth);
  fastify.decorate('publicBaseUrl', publicBaseUrl);
  fastify.decorate('googleSignIn', Boolean(google));
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
