import fp from 'fastify-plugin';
import { PrismaClient } from '@prisma/client';

async function prismaPlugin(fastify, opts) {
  const prisma = new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error']
  });

  try {
    await prisma.$connect();
    fastify.log.info('🔌 Connected to PostgreSQL via Prisma');
  } catch (err) {
    fastify.log.warn(`⚠️ Database connection not established: ${err.message}. Running in offline/dev-login mode.`);
  }

  fastify.decorate('prisma', prisma);

  fastify.addHook('onClose', async (server) => {
    await server.prisma.$disconnect();
    fastify.log.info('🔌 Prisma disconnected');
  });
}

export default fp(prismaPlugin);
