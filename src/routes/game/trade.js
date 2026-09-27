import { TRADE_RESOURCES, UNIT_PRICES, MAX_TRADE_QUANTITY } from '../../config/trade.js';

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

  // Dev-login pilots have no database row, so their ledgers live in memory.
  const mockLedgers = new Map();
  const mockLedger = (playerId) => {
    if (!mockLedgers.has(playerId)) mockLedgers.set(playerId, { credits: 0, trades: [] });
    return mockLedgers.get(playerId);
  };

  fastify.addHook('onRequest', fastify.authenticate);

  fastify.get('/prices', async () => ({ prices: UNIT_PRICES }));

  fastify.get('/credits', async (request) => {
    const playerId = request.user.sub;
    if (request.user.mock) return { credits: mockLedger(playerId).credits };
    const player = await prisma.player.findUnique({ where: { id: playerId }, select: { credits: true } });
    return { credits: player?.credits ?? 0 };
  });

  fastify.get('/trades', async (request) => {
    const playerId = request.user.sub;
    if (request.user.mock) return { trades: [...mockLedger(playerId).trades].reverse() };
    const trades = await prisma.tradeTransaction.findMany({
      where: { playerId },
      orderBy: { createdAt: 'desc' },
      take: 50
    });
    return { trades };
  });

  // Sell minerals at a space harbor / station; records the transaction and credits the pilot.
  fastify.post('/trade/sell', { schema: sellSchema }, async (request, reply) => {
    const playerId = request.user.sub;
    const { resource, quantity } = request.body;
    const unitPrice = UNIT_PRICES[resource];
    const total = unitPrice * quantity;

    if (request.user.mock) {
      const ledger = mockLedger(playerId);
      ledger.credits += total;
      const trade = { id: crypto.randomUUID(), playerId, resource, quantity, unitPrice, total, createdAt: new Date().toISOString() };
      ledger.trades.push(trade);
      return { trade, credits: ledger.credits };
    }

    try {
      const [trade, player] = await prisma.$transaction([
        prisma.tradeTransaction.create({ data: { playerId, resource, quantity, unitPrice, total } }),
        prisma.player.update({ where: { id: playerId }, data: { credits: { increment: total } }, select: { credits: true } })
      ]);
      return { trade, credits: player.credits };
    } catch (err) {
      if (err.code === 'P2025' || err.code === 'P2003') {
        return reply.code(404).send({ error: 'Player not found.' });
      }
      throw err;
    }
  });
}
