import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import app from '../src/app.js';

describe('station trade endpoints', () => {
  before(async () => { await app.ready(); });
  after(async () => { await app.close(); });

  test('dev pilot sells minerals and credits accrue', async () => {
    const { token } = JSON.parse((await app.inject({ method: 'GET', url: '/auth/dev-login?callsign=Trader' })).body);
    const headers = { authorization: `Bearer ${token}` };

    assert.equal((await app.inject({ method: 'GET', url: '/game/credits' })).statusCode, 401);
    assert.equal(JSON.parse((await app.inject({ method: 'GET', url: '/game/credits', headers })).body).credits, 0);

    const sell = await app.inject({ method: 'POST', url: '/game/trade/sell', headers, payload: { resource: 'METAL', quantity: 5 } });
    assert.equal(sell.statusCode, 200);
    const body = JSON.parse(sell.body);
    assert.equal(body.trade.total, 50);
    assert.equal(body.credits, 50);

    await app.inject({ method: 'POST', url: '/game/trade/sell', headers, payload: { resource: 'GAS', quantity: 2 } });
    assert.equal(JSON.parse((await app.inject({ method: 'GET', url: '/game/credits', headers })).body).credits, 80);
    const trades = JSON.parse((await app.inject({ method: 'GET', url: '/game/trades', headers })).body).trades;
    assert.equal(trades.length, 2);
    assert.equal(trades[0].resource, 'GAS');

    for (const payload of [{ resource: 'GOLD', quantity: 1 }, { resource: 'METAL', quantity: 0 }, { resource: 'METAL', quantity: 1.5 }, { resource: 'METAL' }]) {
      const bad = await app.inject({ method: 'POST', url: '/game/trade/sell', headers, payload });
      assert.equal(bad.statusCode, 400);
    }
  });
});
