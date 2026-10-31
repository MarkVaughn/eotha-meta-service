import Fastify from 'fastify';
import cors from '@fastify/cors';
import env from './config/env.js';
import prismaPlugin from './plugins/prisma.js';
import securityPlugin from './plugins/security.js';
import claimKeyPlugin from './plugins/claim-key.js';
import attestationPlugin from './plugins/attestation.js';
import identityPlugin from './plugins/identity.js';
import internalWorkloadPlugin from './plugins/internal-workload.js';
import authRoutes from './routes/auth/index.js';
import jwksRoutes from './routes/jwks.js';
import gameRoutes from './routes/game/index.js';
import tradeRoutes from './routes/game/trade.js';
import missionsRoutes from './routes/game/missions.js';
import chartsRoutes from './routes/game/charts.js';
import cargoRoutes from './routes/game/cargo.js';
import captainRoutes from './routes/game/captain.js';
import crewRoutes from './routes/game/crew.js';
import captainRetirementRoutes from './routes/game/captain-retirement.js';
import factionsRoutes from './routes/game/factions.js';
import shipRoutes from './routes/ship/index.js';
import rtseInternalRoutes from './routes/internal/rtse.js';

const fastify = Fastify({
  logger: {
    transport: {
      target: 'pino-pretty',
      options: { colorize: true }
    }
  }
});

for (const contentType of ['application/protobuf', 'application/x-protobuf']) {
  fastify.addContentTypeParser(contentType, { parseAs: 'buffer' }, (request, body, done) => done(null, body));
}

// Register Plugins
await fastify.register(cors, { origin: '*' });
await fastify.register(prismaPlugin);
await fastify.register(securityPlugin);
await fastify.register(claimKeyPlugin);
await fastify.register(internalWorkloadPlugin);
await fastify.register(attestationPlugin);
await fastify.register(identityPlugin);

// Register Routes
await fastify.register(authRoutes, { prefix: '/auth' });
await fastify.register(jwksRoutes);
await fastify.register(gameRoutes, { prefix: '/game' });
await fastify.register(tradeRoutes, { prefix: '/game' });
await fastify.register(missionsRoutes, { prefix: '/game' });
await fastify.register(chartsRoutes, { prefix: '/game' });
await fastify.register(cargoRoutes, { prefix: '/game' });
await fastify.register(captainRoutes, { prefix: '/game' });
await fastify.register(captainRetirementRoutes, { prefix: '/game' });
await fastify.register(crewRoutes, { prefix: '/game' });
await fastify.register(factionsRoutes, { prefix: '/game' });
await fastify.register(shipRoutes, { prefix: '/ship' });
await fastify.register(rtseInternalRoutes, { prefix: '/internal/v1/rtse' });

// Health check endpoint
fastify.get('/health', async () => {
  return { status: 'healthy', service: 'eotha-meta-service' };
});

// Health means the process is reachable; readiness means it can safely settle signed penalties.
fastify.get('/ready', async (request, reply) => {
  let database = false;
  try {
    await fastify.prisma.$queryRaw`SELECT 1`;
    database = true;
  } catch (err) {
    request.log.error(err, 'Readiness database check failed.');
  }
  const checks = {
    database,
    claim_key: Boolean(fastify.claimKey),
    internal_workload_credential: fastify.internalWorkloadReady
  };
  if (Object.values(checks).every(Boolean)) return { status: 'ready', checks };
  return reply.code(503).send({ status: 'not_ready', checks });
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
