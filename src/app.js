import Fastify from 'fastify';
import cors from '@fastify/cors';
import env from './config/env.js';
import prismaPlugin from './plugins/prisma.js';
import securityPlugin from './plugins/security.js';
import authRoutes from './routes/auth/index.js';
import gameRoutes from './routes/game/index.js';
import tradeRoutes from './routes/game/trade.js';
import shipRoutes from './routes/ship/index.js';

const fastify = Fastify({
  logger: {
    transport: {
      target: 'pino-pretty',
      options: { colorize: true }
    }
  }
});

// Register Plugins
await fastify.register(cors, { origin: '*' });
await fastify.register(prismaPlugin);
await fastify.register(securityPlugin);

// Register Routes
await fastify.register(authRoutes, { prefix: '/auth' });
await fastify.register(gameRoutes, { prefix: '/game' });
await fastify.register(tradeRoutes, { prefix: '/game' });
await fastify.register(shipRoutes, { prefix: '/ship' });

// Health check endpoint
fastify.get('/health', async () => {
  return { status: 'healthy', service: 'eotha-meta-service' };
});

const start = async () => {
  try {
    const port = env.PORT || 3000;
    const host = env.HOST || '0.0.0.0';
    await fastify.listen({ port, host });
    fastify.log.info(`🌐 Eotha Meta Service listening on port ${port}`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

// Start server if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  start();
}

export default fastify;
