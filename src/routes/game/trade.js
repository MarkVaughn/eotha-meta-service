import { TRADE_RESOURCES, UNIT_PRICES, MAX_TRADE_QUANTITY } from '../../config/trade.js';

const STOCK_FIELDS = { METAL: 'metalStock', GAS: 'gasStock' };

const sellSchema = {
  body: {
    type: 'object',
    required: ['resource', 'quantity'],
    properties: {
      resource: { type: 'string', enum: TRADE_RESOURCES },
      quantity: { type: 'integer', minimum: 1, maximum: MAX_TRADE_QUANTITY }
    }
  }
};

export default async function tradeRoutes(fastify, opts) {
  const prisma = fastify.prisma;

  fastify.addHook('onRequest', fastify.authenticate);

  fastify.get('/prices', async () => ({ prices: UNIT_PRICES }));

  fastify.get('/credits', async (request) => {
    const playerId = request.user.sub;
    const player = await prisma.player.findUnique({ where: { id: playerId }, select: { credits: true } });
    return { credits: player?.credits ?? 0 };
  });

  fastify.get('/trades', async (request) => {
    const playerId = request.user.sub;
    const trades = await prisma.tradeTransaction.findMany({
      where: { playerId },
      orderBy: { createdAt: 'desc' },
      take: 50
    });
    return { trades };
  });

  // Sell minerals from the pilot's harbor stock; records the transaction and credits the pilot.
  // Stock decrement, trade record and credit increment commit or roll back together.
  fastify.post('/trade/sell', { schema: sellSchema }, async (request, reply) => {
    const playerId = request.user.sub;
    const { resource, quantity } = request.body;
    const unitPrice = UNIT_PRICES[resource];
    const total = unitPrice * quantity;
    const stockField = STOCK_FIELDS[resource];

    const result = await prisma.$transaction(async (tx) => {
      // Guarded decrement: only succeeds while the stored stock still covers the sale.
      const { count } = await tx.spaceHarbor.updateMany({
        where: { playerId, [stockField]: { gte: quantity } },
        data: { [stockField]: { decrement: quantity } }
      });
      if (count !== 1) {
        const harbor = await tx.spaceHarbor.findUnique({ where: { playerId }, select: { [stockField]: true } });
        return harbor ? { insufficient: harbor[stockField] } : { missing: true };
      }
      const trade = await tx.tradeTransaction.create({ data: { playerId, resource, quantity, unitPrice, total } });
      const player = await tx.player.update({
        where: { id: playerId },
        data: { credits: { increment: total } },
        select: { credits: true }
      });
      return { trade, credits: player.credits };
    });

    if (result.missing) return reply.code(404).send({ error: 'Space harbor not found.' });
    if (result.insufficient !== undefined) {
      return reply.code(409).send({
        error: `Insufficient ${resource} stock at harbor.`,
        available: result.insufficient
      });
    }
    return { trade: result.trade, credits: result.credits };
  });
}
