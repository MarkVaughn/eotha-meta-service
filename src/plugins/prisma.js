import fp from 'fastify-plugin';
import { PrismaClient } from '@prisma/client';

async function prismaPlugin(fastify, opts) {
  const prisma = new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error']
  });

  // All state lives in PostgreSQL, so the service cannot run without it.
  await prisma.$connect();
  fastify.log.info('🔌 Connected to PostgreSQL via Prisma');

  fastify.decorate('prisma', prisma);

  fastify.addHook('onClose', async (server) => {
    await server.prisma.$disconnect();
    fastify.log.info('🔌 Prisma disconnected');
  });
}

export default fp(prismaPlugin);
