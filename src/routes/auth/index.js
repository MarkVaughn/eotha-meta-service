import crypto from 'crypto';
import { registerSchema, loginSchema, devLoginSchema } from './schema.js';

export default async function authRoutes(fastify, opts) {
  const prisma = fastify.prisma;

  // Endpoint 1: Register Player
  fastify.post('/register', { schema: registerSchema }, async (request, reply) => {
    const { email, password, callsign, latitude, longitude, h3Index } = request.body;
    
    // Hash password (simplistic for prototyping, use bcrypt/argon2 in prod)
    const passwordHash = crypto.createHash('sha256').update(password).digest('hex');

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
    const passwordHash = crypto.createHash('sha256').update(password).digest('hex');

    const player = await prisma.player.findUnique({
      where: { email },
      include: { harbor: true }
    });

    if (!player || player.passwordHash !== passwordHash) {
      return reply.code(401).send({ error: 'Invalid user credentials.' });
    }

    const token = fastify.jwt.sign({
      sub: player.id,
      callsign: player.callsign,
      home_h3: player.harbor?.h3Index || "881f1d4887fffff"
    });

    return { token, player: { id: player.id, callsign: player.callsign } };
  });

  // Endpoint 3: Dev-Login Bypass ("Fake Auth" strategy for easy CLI testing)
  fastify.get('/dev-login', { schema: devLoginSchema }, async (request, reply) => {
    const { callsign = 'DevPilot', latitude = '37.7749', longitude = '-122.4194', h3 = '8828308281fffff' } = request.query;

    // Simulate an instant development ID
    const mockId = crypto.randomUUID();

    // Sign complete production claims. The Rust RTSE verifies this token as if it were production [3].
    const token = fastify.jwt.sign({
      sub: mockId,
      callsign,
      home_h3: h3,
      mock: true
    });

    fastify.log.info(`🎯 Dev token minted for pilot ${callsign} located at H3: ${h3}`);

    return {
      token,
      gateway_ws_url: "ws://localhost:8080/session", // Local Minikube RTSE WebSocket port [3]
      player: {
        id: mockId,
        callsign,
        dev: true,
        spawn_point: {
          latitude: parseFloat(latitude),
          longitude: parseFloat(longitude),
          h3_index: h3
        }
      }
    };
  });
}
