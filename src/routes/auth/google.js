import { createGoogleSignIn, GoogleSignInError } from '../../lib/google-signin.js';
import { googleStartSchema, googleExchangeSchema } from './schema.js';

const hasCredentials = (request) => Boolean(request.headers.authorization || request.headers['x-eotha-token']);

/**
 * Sign in with Google (see src/lib/google-signin.js). Registered only when the provider is
 * configured; with no Google credentials these routes do not exist.
 *
 * @param {import('fastify').FastifyInstance} fastify
 * @param {object} deps
 * @param {(player: object, refreshToken: string, location?: object) => Promise<object>} deps.issueSession
 * @param {(request: import('fastify').FastifyRequest) => object} deps.clientMeta
 */
export function registerGoogleRoutes(fastify, { issueSession, clientMeta }) {
  const prisma = fastify.prisma;
  const google = createGoogleSignIn({ prisma, auth: fastify.betterAuth, publicBaseUrl: fastify.publicBaseUrl });

  // Step 1. Anonymous: signs in (or up) with Google. With a guest's access token: links Google to that
  // guest in place. The browser must keep the cookies this sets (a same-origin fetch does) and then
  // navigate to `url`.
  fastify.post('/google/start', { schema: googleStartSchema }, async (request, reply) => {
    let linkPlayerId;
    if (hasCredentials(request)) {
      await fastify.authenticate(request, reply);
      if (reply.sent) return reply;
      const player = await prisma.player.findUnique({ where: { id: request.user.sub }, select: { id: true, isAnonymous: true } });
      if (!player) return reply.code(401).send({ error: 'Unauthorized credentials' });
      if (!player.isAnonymous) return reply.code(409).send({ error: 'already_linked' });
      linkPlayerId = player.id;
    }

    try {
      const { url, cookies } = await google.start({ returnTo: request.body?.returnTo, linkPlayerId });
      reply.header('cache-control', 'no-store');
      if (cookies.length) reply.header('set-cookie', cookies);
      return { url };
    } catch (err) {
      if (!(err instanceof GoogleSignInError)) throw err;
      return reply.code(err.status).send({ error: err.code });
    }
  });

  // Step 2. The redirect URI registered in Google Cloud: `<public base URL>/auth/callback/google`.
  fastify.get('/callback/google', async (request, reply) => {
    const { location, cookies, error } = await google.callback({ query: request.query, cookie: request.headers.cookie });
    if (error) request.log.error(error, 'Google callback failed.');
    reply.header('cache-control', 'no-store');
    reply.header('referrer-policy', 'no-referrer');
    if (cookies.length) reply.header('set-cookie', cookies);
    return reply.redirect(location, 302);
  });

  // Step 3. Trades the one-time code for the game's own session, shaped like the guest and login
  // responses. A new Google player's harbor is placed at the optional `latitude`/`longitude`.
  fastify.post('/google/exchange', { schema: googleExchangeSchema }, async (request, reply) => {
    let redeemed;
    try {
      redeemed = await google.redeem(request.body.code);
    } catch (err) {
      if (!(err instanceof GoogleSignInError)) throw err;
      return reply.code(err.status).send({ error: err.code });
    }
    const player = await prisma.player.findUnique({ where: { id: redeemed.playerId }, include: { harbor: true } });
    if (!player) return reply.code(401).send({ error: 'invalid_code' });
    const { refreshToken } = await fastify.refreshTokens.start(player.id, clientMeta(request));
    reply.header('cache-control', 'no-store');
    const { latitude, longitude } = request.body;
    return { ...(await issueSession(player, refreshToken, { latitude, longitude })), created: redeemed.created };
  });
}
