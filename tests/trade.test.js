import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { app, call, closeApp, credits, json, newPilot } from './helpers.js';

const sell = (pilot, payload) => call(pilot, 'POST', '/game/trade/sell', payload);
const stock = async (pilot) => {
  const { metalStock, gasStock } = await app.prisma.spaceHarbor.findUnique({ where: { playerId: pilot.id } });
  return { metalStock, gasStock };
};
const fill = (pilot, metalStock, gasStock) =>
  app.prisma.spaceHarbor.update({ where: { playerId: pilot.id }, data: { metalStock, gasStock } });

describe('station trade endpoints', () => {
  before(async () => { await app.ready(); });
  after(async () => { await closeApp(); });

  test('pilot sells harbor stock, credits accrue and stock is consumed', async () => {
    const pilot = await newPilot('Trader');
    await fill(pilot, 20, 10);

    assert.equal((await app.inject({ method: 'GET', url: '/game/credits' })).statusCode, 401);
    assert.equal(await credits(pilot), 0);

    const res = await sell(pilot, { resource: 'METAL', quantity: 5 });
    assert.equal(res.statusCode, 200);
    const body = json(res);
    assert.equal(body.trade.total, 50);
    assert.equal(body.credits, 50);
    assert.deepEqual(await stock(pilot), { metalStock: 15, gasStock: 10 });

    await sell(pilot, { resource: 'GAS', quantity: 2 });
    assert.equal(await credits(pilot), 80);
    assert.deepEqual(await stock(pilot), { metalStock: 15, gasStock: 8 });

    const trades = json(await call(pilot, 'GET', '/game/trades')).trades;
    assert.equal(trades.length, 2);
    assert.equal(trades[0].resource, 'GAS');

    for (const payload of [{ resource: 'GOLD', quantity: 1 }, { resource: 'METAL', quantity: 0 }, { resource: 'METAL', quantity: 1.5 }, { resource: 'METAL' }]) {
      assert.equal((await sell(pilot, payload)).statusCode, 400);
    }
  });

  test('refuses a sale the harbor stock cannot cover and changes nothing', async () => {
    const pilot = await newPilot('Short');
    await fill(pilot, 3, 0);

    let res = await sell(pilot, { resource: 'METAL', quantity: 4 });
    assert.equal(res.statusCode, 409);
    assert.deepEqual(json(res), { error: 'Insufficient METAL stock at harbor.', available: 3 });
    res = await sell(pilot, { resource: 'GAS', quantity: 1 });
    assert.equal(res.statusCode, 409);

    assert.equal(await credits(pilot), 0);
    assert.deepEqual(await stock(pilot), { metalStock: 3, gasStock: 0 });
    assert.deepEqual(json(await call(pilot, 'GET', '/game/trades')).trades, []);

    // Selling exactly what is in stock works and empties it.
    assert.equal((await sell(pilot, { resource: 'METAL', quantity: 3 })).statusCode, 200);
    assert.deepEqual(await stock(pilot), { metalStock: 0, gasStock: 0 });
  });

  test('concurrent sales cannot sell more than the stock', async () => {
    const pilot = await newPilot('Racer');
    await fill(pilot, 10, 0);

    const results = await Promise.all(Array.from({ length: 5 }, () => sell(pilot, { resource: 'METAL', quantity: 4 })));
    assert.equal(results.filter((r) => r.statusCode === 200).length, 2);
    assert.equal(results.filter((r) => r.statusCode === 409).length, 3);
    assert.equal(await credits(pilot), 80);
    assert.deepEqual(await stock(pilot), { metalStock: 2, gasStock: 0 });
    assert.equal(json(await call(pilot, 'GET', '/game/trades')).trades.length, 2);
  });

  test('stock is per pilot', async () => {
    const a = await newPilot('StockA');
    const b = await newPilot('StockB');
    await fill(a, 5, 0);
    assert.equal((await sell(b, { resource: 'METAL', quantity: 1 })).statusCode, 409);
    assert.equal((await sell(a, { resource: 'METAL', quantity: 1 })).statusCode, 200);
  });
});
