import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import app from '../src/app.js';

describe('Eotha Meta Service Endpoints', () => {
  before(async () => {
    await app.ready();
  });

  after(async () => {
    await app.close();
  });

  test('GET /health returns healthy status', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/health'
    });

    assert.equal(res.statusCode, 200);
    const json = JSON.parse(res.body);
    assert.equal(json.status, 'healthy');
    assert.equal(json.service, 'eotha-meta-service');
  });

  test('GET /auth/dev-login generates signed Ed25519 token and gateway url', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/auth/dev-login?callsign=Spectre&latitude=37.7749&longitude=-122.4194&h3=8828308281fffff'
    });

    assert.equal(res.statusCode, 200);
    const json = JSON.parse(res.body);
    assert.ok(json.token);
    assert.equal(json.gateway_ws_url, 'ws://localhost:8080/session');
    assert.equal(json.player.callsign, 'Spectre');
    assert.equal(json.player.dev, true);

    // Verify token using fastify.jwt
    const decoded = app.jwt.verify(json.token);
    assert.equal(decoded.callsign, 'Spectre');
    assert.equal(decoded.home_h3, '8828308281fffff');
    assert.equal(decoded.mock, true);
  });
});
