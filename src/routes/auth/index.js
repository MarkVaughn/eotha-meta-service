import { createHash } from 'node:crypto';
import env from '../../config/env.js';
import { DEV_LOGIN_EMAIL_DOMAIN, DEV_STARTING_CREDITS } from '../../config/dev.js';
import { computeShipAttributes, defaultComponents } from '../../config/components.js';
import { convertGuest } from '../../lib/identity.js';
import { hashPassword, verifyPassword, UNUSABLE_PASSWORD_HASH } from '../../lib/password.js';
import { RefreshError } from '../../lib/refresh-tokens.js';
import {
  registerSchema, loginSchema, devLoginSchema, guestSchema, refreshSchema, logoutSchema, linkEmailSchema
} from './schema.js';

const DEV_TOKEN_TTL_SECONDS = 24 * 60 * 60;

export default async function authRoutes(fastify, opts) {
  const prisma = fastify.prisma;
  const devLoginEnabled = opts.devLogin ?? env.NODE_ENV === 'development';

  // Embed current ship attributes (Tier 1 defaults if the pilot has no ship yet). The claims are
  // exactly what the RTSE validates; `ttlSeconds` only overrides the default token lifetime.
  async function signSession(player, { ttlSeconds } = {}) {
    const ship = await prisma.spaceship.findFirst({
      where: { playerId: player.id, active: true },
      orderBy: { createdAt: 'asc' },
      include: { components: true }
    });
    const components = ship?.components?.length
      ? ship.components.map(({ type, tier, healthPct }) => ({ type, tier, healthPct }))
      : defaultComponents();
    const shipAttributes = computeShipAttributes(components);
    const claims = {
      sub: player.id,
      callsign: player.callsign,
      home_h3: player.harbor?.h3Index || "881f1d4887fffff",
      ship_attributes: shipAttributes
    };
    const token = ttlSeconds
      ? fastify.signWithExpiry({ ...claims, exp: Math.floor(Date.now() / 1000) + ttlSeconds })
      : fastify.jwt.sign(claims);
    return { token, components, shipAttributes };
  }

  // The response of every login: a short-lived access token plus the refresh token that renews it.
  async function issueSession(player, refreshToken) {
    const { token } = await signSession(player);
    return {
      token,
      refreshToken,
      expiresIn: env.ACCESS_TOKEN_TTL_SECONDS,
      player: { id: player.id, callsign: player.callsign, anonymous: player.isAnonymous }
    };
  }

  const clientMeta = (request) => ({ ipAddress: request.ip, userAgent: request.headers['user-agent'] });

  // Endpoint 1: Register Player
  fastify.post('/register', { schema: registerSchema }, async (request, reply) => {
    const { email, password, callsign, latitude, longitude, h3Index } = request.body;

    const passwordHash = await hashPassword(password);

    try {
      const player = await prisma.player.create({
        data: {
          email,
          passwordHash,
          callsign,
          harbor: {
            create: {
              latitude,
              longitude,
              h3Index
            }
          }
        },
        include: { harbor: true }
      });

      return reply.code(201).send({ id: player.id, callsign: player.callsign });
    } catch (err) {
      fastify.log.error(err);
      return reply.code(400).send({ error: 'Callsign or Email already exists.' });
    }
  });

  // Endpoint 2: Standard Cryptographic Login
  fastify.post('/login', { schema: loginSchema, preHandler: fastify.requireAttestation }, async (request, reply) => {
    const { email, password } = request.body;

    const player = await prisma.player.findUnique({
      where: { email },
      include: { harbor: true }
    });

    const { valid, upgradedHash } = await verifyPassword(password, player?.passwordHash);
    if (!player || !valid) {
      return reply.code(401).send({ error: 'Invalid user credentials.' });
    }

    if (upgradedHash) {
      // Guarded on the old hash so a concurrent password change is never overwritten.
      await prisma.player.updateMany({
        where: { id: player.id, passwordHash: player.passwordHash },
        data: { passwordHash: upgradedHash }
      });
    }

    const { refreshToken } = await fastify.refreshTokens.start(player.id, clientMeta(request));
    return issueSession(player, refreshToken);
  });

  // Finds the guest bound to a device, or creates one through Better Auth's anonymous flow.
  // `session` is set only for a freshly created guest, whose first Better Auth session already exists.
  async function resolveGuest(deviceHash) {
    const bound = () => prisma.guestDevice.findUnique({
      where: { deviceHash },
      include: { player: { include: { harbor: true } } }
    });
    const existing = await bound();
    if (existing) return { player: existing.player, created: false };

    const { token, user } = await fastify.betterAuth.api.signInAnonymous({ headers: new Headers() });
    try {
      await prisma.guestDevice.create({ data: { deviceHash, playerId: user.id } });
    } catch (err) {
      if (err.code !== 'P2002') throw err;
      // A concurrent first launch from this device won the binding; discard our duplicate guest.
      await prisma.player.delete({ where: { id: user.id } });
      return { player: (await bound()).player, created: false };
    }
    const session = await prisma.authSession.findUnique({ where: { token } });
    const { player } = await bound();
    return { player, created: true, session };
  }

  // Endpoint 2b: Guest login. Instant launch: the first call from a device creates an anonymous
  // player; later calls from the same device resume the same player.
  fastify.post('/guest', { schema: guestSchema, preHandler: fastify.requireAttestation }, async (request, reply) => {
    const deviceHash = createHash('sha256').update(request.body.deviceId).digest('hex');
    const { player, created, session } = await resolveGuest(deviceHash);
    if (!player.isAnonymous) return reply.code(409).send({ error: 'device_account_linked' });

    let refreshToken;
    if (session) {
      ({ refreshToken } = await fastify.refreshTokens.adopt(session));
    } else {
      ({ refreshToken } = await fastify.refreshTokens.start(player.id, clientMeta(request)));
    }
    return { ...(await issueSession(player, refreshToken)), created };
  });

  // Endpoint 2c: Exchange a refresh token for a new access token and a replacement refresh token.
  fastify.post('/refresh', { schema: refreshSchema }, async (request, reply) => {
    try {
      const { refreshToken, playerId } = await fastify.refreshTokens.rotate(request.body.refreshToken);
      const player = await prisma.player.findUnique({ where: { id: playerId }, include: { harbor: true } });
      if (!player) return reply.code(401).send({ error: 'invalid_refresh_token' });
      return issueSession(player, refreshToken);
    } catch (err) {
      if (err instanceof RefreshError) return reply.code(401).send({ error: err.code });
      throw err;
    }
  });

  // Endpoint 2d: End the login a refresh token belongs to.
  fastify.post('/logout', { schema: logoutSchema }, async (request) => {
    await fastify.refreshTokens.revoke(request.body.refreshToken);
    return { success: true };
  });

  // Endpoint 2e: Link an email and password to the calling guest. The player id is unchanged, so
  // nothing is lost, and guest-only restrictions (such as locked hull upgrades) lift.
  fastify.post('/link/email', {
    schema: linkEmailSchema,
    onRequest: fastify.authenticate
  }, async (request, reply) => {
    const { email, password, callsign } = request.body;
    const playerId = request.user.sub;
    const passwordHash = await hashPassword(password);

    let linked;
    try {
      linked = await convertGuest(prisma, playerId, { email, passwordHash, ...(callsign && { callsign }) });
    } catch (err) {
      if (err.code === 'P2002') return reply.code(409).send({ error: 'email_or_callsign_taken' });
      throw err;
    }
    if (!linked) return reply.code(409).send({ error: 'already_linked' });

    const player = await prisma.player.findUnique({ where: { id: playerId }, include: { harbor: true } });
    const { token } = await signSession(player);
    return {
      token,
      expiresIn: env.ACCESS_TOKEN_TTL_SECONDS,
      player: { id: player.id, callsign: player.callsign, anonymous: false }
    };
  });

  // Endpoint 3: Dev-Login (development only). Mints a real token for a persisted pilot so the
  // dev client and the RTSE exercise the same code paths as production sessions.
  if (devLoginEnabled) {
    fastify.get('/dev-login', { schema: devLoginSchema }, async (request, reply) => {
      const { callsign = 'DevPilot', latitude = '37.7749', longitude = '-122.4194', h3 = '8828308281fffff' } = request.query;
      const harbor = { latitude: parseFloat(latitude), longitude: parseFloat(longitude), h3Index: h3 };

      // The starting credits are granted exactly once per dev pilot: with the pilot's creation, or
      // (for a dev pilot created before the grant existed) by the guarded update below. Real
      // accounts, guests and linked accounts never match it.
      const player = await prisma.$transaction(async (tx) => {
        const now = new Date();
        const pilot = await tx.player.upsert({
          where: { callsign },
          update: { harbor: { upsert: { create: harbor, update: harbor } } },
          create: {
            email: `${encodeURIComponent(callsign)}@${DEV_LOGIN_EMAIL_DOMAIN}`,
            passwordHash: UNUSABLE_PASSWORD_HASH,
            callsign,
            credits: DEV_STARTING_CREDITS,
            devCreditsGrantedAt: now,
            harbor: { create: harbor }
          },
          include: { harbor: true }
        });
        await tx.player.updateMany({
          where: {
            id: pilot.id,
            email: { endsWith: `@${DEV_LOGIN_EMAIL_DOMAIN}` },
            isAnonymous: false,
            devCreditsGrantedAt: null,
            credits: 0,
            spaceships: { none: { components: { some: { tier: { gt: 1 } } } } }
          },
          data: { credits: { increment: DEV_STARTING_CREDITS }, devCreditsGrantedAt: now }
        });
        return pilot;
      });

      const { token, components, shipAttributes } = await signSession(player, { ttlSeconds: DEV_TOKEN_TTL_SECONDS });

      fastify.log.info(`🎯 Dev token minted for pilot ${callsign} located at H3: ${h3}`);

      return {
        token,
        gateway_ws_url: "ws://localhost:8080/session", // Local Minikube RTSE WebSocket port [3]
        player: {
          id: player.id,
          callsign,
          dev: true,
          ship: {
            components,
            ship_attributes: shipAttributes
          },
          spawn_point: {
            latitude: harbor.latitude,
            longitude: harbor.longitude,
            h3_index: h3
          }
        }
      };
    });
  }
}
