import { getSessionSchema, createSessionSchema } from './schema.js';

export default async function gameRoutes(fastify, opts) {
  const prisma = fastify.prisma;

  // Protect all game endpoints with JWT authentication
  fastify.addHook('onRequest', fastify.authenticate);

  // Endpoint 1: Get Current Player Game Session
  fastify.get('/session', { schema: getSessionSchema }, async (request, reply) => {
    const playerId = request.user.sub;

    const session = await prisma.gameSession.findUnique({
      where: { playerId }
    });

    if (!session) {
      return reply.code(404).send({ error: 'No active game session found for player.' });
    }

    return session;
  });

  // Endpoint 2: Lookup or Instantiate Game Session
  fastify.post('/session', { schema: createSessionSchema }, async (request, reply) => {
    const playerId = request.user.sub;
    const defaultHost = process.env.DEFAULT_RTSE_HOST || 'localhost:8080';
    const rtseHost = request.body?.rtseHost || defaultHost;

    const session = await prisma.gameSession.upsert({
      where: { playerId },
      update: {
        rtseHost,
        connected: false
      },
      create: {
        playerId,
        rtseHost,
        connected: false
      }
    });

    return session;
  });
}
