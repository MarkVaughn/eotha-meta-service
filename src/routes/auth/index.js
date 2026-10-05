import env from '../../config/env.js';
import { computeShipAttributes, defaultComponents } from '../../config/components.js';
import { hashPassword, verifyPassword, UNUSABLE_PASSWORD_HASH } from '../../lib/password.js';
import { registerSchema, loginSchema, devLoginSchema } from './schema.js';

export default async function authRoutes(fastify, opts) {
  const prisma = fastify.prisma;
  const devLoginEnabled = opts.devLogin ?? env.NODE_ENV === 'development';

  // Embed current ship attributes (Tier 1 defaults if the pilot has no ship yet).
  async function signSession(player) {
    const ship = await prisma.spaceship.findFirst({
      where: { playerId: player.id, active: true },
      orderBy: { createdAt: 'asc' },
      include: { components: true }
    });
    const components = ship?.components?.length
      ? ship.components.map(({ type, tier, healthPct }) => ({ type, tier, healthPct }))
      : defaultComponents();
    const shipAttributes = computeShipAttributes(components);
    const token = fastify.jwt.sign({
      sub: player.id,
      callsign: player.callsign,
      home_h3: player.harbor?.h3Index || "881f1d4887fffff",
      ship_attributes: shipAttributes
    });
    return { token, components, shipAttributes };
  }

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
  fastify.post('/login', { schema: loginSchema }, async (request, reply) => {
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

    const { token } = await signSession(player);
    return { token, player: { id: player.id, callsign: player.callsign } };
  });

  // Endpoint 3: Dev-Login (development only). Mints a real token for a persisted pilot so the
  // dev client and the RTSE exercise the same code paths as production sessions.
  if (devLoginEnabled) {
    fastify.get('/dev-login', { schema: devLoginSchema }, async (request, reply) => {
      const { callsign = 'DevPilot', latitude = '37.7749', longitude = '-122.4194', h3 = '8828308281fffff' } = request.query;
      const harbor = { latitude: parseFloat(latitude), longitude: parseFloat(longitude), h3Index: h3 };

      const player = await prisma.player.upsert({
        where: { callsign },
        update: { harbor: { upsert: { create: harbor, update: harbor } } },
        create: {
          email: `${encodeURIComponent(callsign)}@dev-login.invalid`,
          passwordHash: UNUSABLE_PASSWORD_HASH,
          callsign,
          harbor: { create: harbor }
        },
        include: { harbor: true }
      });

      const { token, components, shipAttributes } = await signSession(player);

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
