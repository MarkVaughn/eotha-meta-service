import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import Fastify from 'fastify';
import { app, attestationDouble, call, closeApp, json, keysDir, newPilot } from './helpers.js';
import prismaPlugin from '../src/plugins/prisma.js';
import securityPlugin from '../src/plugins/security.js';
import attestationPlugin from '../src/plugins/attestation.js';
import identityPlugin from '../src/plugins/identity.js';
import authRoutes from '../src/routes/auth/index.js';
import gameRoutes from '../src/routes/game/index.js';

const LOCAL_URL = 'ws://localhost:8080/session';

// Minimal servers with the routes under test, so GATEWAY_WS_URL can be set per test.
async function buildServer(gatewayWsUrl, development = true) {
  const server = Fastify();
  await server.register(prismaPlugin);
  await server.register(securityPlugin, { keysDir });
  await server.register(attestationPlugin, { verifiers: [attestationDouble] });
  await server.register(identityPlugin);
  await server.register(authRoutes, { prefix: '/auth', devLogin: true, development, gatewayWsUrl });
  await server.register(gameRoutes, { prefix: '/game', gatewayWsUrl });
  await server.ready();
  return server;
}

before(async () => { await app.ready(); });
after(async () => { await closeApp(); });

describe('dev-login gateway_ws_url', () => {
  const callsigns = [];
  let server;
  before(async () => { server = await buildServer(undefined); });
  after(async () => {
    await server.prisma.player.deleteMany({ where: { callsign: { in: callsigns } } });
    await server.close();
  });

  async function devLogin(headers, srv = server) {
    const callsign = `Tunnel-${randomBytes(4).toString('hex')}`;
    callsigns.push(callsign);
    const res = await srv.inject({ method: 'GET', url: `/auth/dev-login?callsign=${callsign}`, headers });
    assert.equal(res.statusCode, 200);
    return json(res).gateway_ws_url;
  }

  test('a direct call from localhost keeps the local gateway address', async () => {
    assert.equal(await devLogin({ host: 'localhost:3000' }), LOCAL_URL);
  });

  test('a tunnelled request yields a wss address on the forwarded host', async () => {
    const url = await devLogin({ host: 'localhost:3000', 'x-forwarded-proto': 'https', 'x-forwarded-host': 'abc.ngrok-free.app' });
    assert.equal(url, 'wss://abc.ngrok-free.app/session');
  });

  test('http forwarding yields ws, and the Host header stands in for a missing forwarded host', async () => {
    assert.equal(await devLogin({ host: 'localhost:3000', 'x-forwarded-proto': 'http', 'x-forwarded-host': '192.168.1.20:8080' }), 'ws://192.168.1.20:8080/session');
    assert.equal(await devLogin({ host: 'abc.ngrok-free.app', 'x-forwarded-proto': 'https' }), 'wss://abc.ngrok-free.app/session');
  });

  test('only the first entry of a forwarded list is used', async () => {
    const url = await devLogin({ 'x-forwarded-proto': 'https, http', 'x-forwarded-host': 'abc.ngrok-free.app, evil.example' });
    assert.equal(url, 'wss://abc.ngrok-free.app/session');
  });

  test('outside development the forwarded headers are ignored', async () => {
    const production = await buildServer(undefined, false);
    try {
      const url = await devLogin({ 'x-forwarded-proto': 'https', 'x-forwarded-host': 'abc.ngrok-free.app' }, production);
      assert.equal(url, LOCAL_URL);
    } finally {
      await production.close();
    }
  });

  test('GATEWAY_WS_URL wins over the request', async () => {
    const configured = await buildServer('wss://gateway.example.com/session');
    try {
      const url = await devLogin({ 'x-forwarded-proto': 'https', 'x-forwarded-host': 'abc.ngrok-free.app' }, configured);
      assert.equal(url, 'wss://gateway.example.com/session');
    } finally {
      await configured.close();
    }
  });

  const malicious = [
    'evil.example/path',
    'user:pass@evil.example',
    'evil.example#',
    'evil.example?x=1',
    'evil .example',
    'evil.example:99999',
    '-evil.example',
    '//evil.example',
    '',
    'a'.repeat(300) + '.example'
  ];
  for (const host of malicious) {
    test(`a malicious forwarded host is ignored: ${JSON.stringify(host.slice(0, 30))}`, async () => {
      const url = await devLogin({ host: 'localhost:3000', 'x-forwarded-proto': 'https', 'x-forwarded-host': host });
      assert.equal(url, LOCAL_URL);
    });
  }

  for (const proto of ['javascript', 'wss://evil.example', 'ftp', '']) {
    test(`a forged forwarded scheme is ignored: ${JSON.stringify(proto)}`, async () => {
      const url = await devLogin({ 'x-forwarded-proto': proto, 'x-forwarded-host': 'abc.ngrok-free.app' });
      assert.equal(url, LOCAL_URL);
    });
  }
});

describe('POST /game/session default host', () => {
  const create = (srv, pilot, headers, payload = {}) =>
    srv.inject({ method: 'POST', url: '/game/session', headers: { ...pilot.headers, ...headers }, payload });

  test('a direct call defaults to localhost:8080', async () => {
    const pilot = await newPilot('Host');
    const res = await call(pilot, 'POST', '/game/session', {});
    assert.equal(res.statusCode, 200);
    assert.equal(json(res).rtseHost, 'localhost:8080');
  });

  test('a tunnelled request never defaults to the forwarded host, in development too', async () => {
    const development = await buildServer(undefined, true);
    try {
      for (const srv of [app, development]) {
        const pilot = await newPilot('Host');
        const res = await create(srv, pilot, { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'abc.ngrok-free.app' });
        assert.equal(json(res).rtseHost, 'localhost:8080');
      }
    } finally {
      await development.close();
    }
  });

  test('an explicit rtseHost in the body wins', async () => {
    const pilot = await newPilot('Host');
    const res = await create(app, pilot, { 'x-forwarded-host': 'abc.ngrok-free.app' }, { rtseHost: 'rtse.internal:9000' });
    assert.equal(json(res).rtseHost, 'rtse.internal:9000');
  });

  test('GATEWAY_WS_URL wins over the request', async () => {
    const server = await buildServer('wss://gateway.example.com/session');
    try {
      const pilot = await newPilot('Host');
      const res = await create(server, pilot, { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'abc.ngrok-free.app' });
      assert.equal(json(res).rtseHost, 'gateway.example.com');
    } finally {
      await server.close();
    }
  });
});
