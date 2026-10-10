import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import Fastify from 'fastify';
import { app, attestationDouble, call, closeApp, json, keysDir, newPilot } from './helpers.js';
import prismaPlugin from '../src/plugins/prisma.js';
import securityPlugin from '../src/plugins/security.js';
import attestationPlugin from '../src/plugins/attestation.js';
import identityPlugin from '../src/plugins/identity.js';
import authRoutes from '../src/routes/auth/index.js';
import gameRoutes from '../src/routes/game/index.js';
import { parseGatewayWsUrl } from '../src/lib/gateway-url.js';

const LOCAL_URL = 'ws://localhost:8080/session';

// Headers a tunnel adds, and forged variants of them. None may influence the address.
const forwarded = [
  { host: 'localhost:3000' },
  { host: 'abc.ngrok-free.app', 'x-forwarded-proto': 'https', 'x-forwarded-host': 'abc.ngrok-free.app' },
  { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'evil.example, abc.ngrok-free.app' },
  { 'x-forwarded-proto': 'http', 'x-forwarded-host': 'evil.example/steal' },
  { host: 'evil.example', 'x-forwarded-proto': 'javascript' }
];

// Minimal servers with the routes under test, so GATEWAY_WS_URL can be set per test.
async function buildServer(gatewayWsUrl) {
  const server = Fastify();
  await server.register(prismaPlugin);
  await server.register(securityPlugin, { keysDir });
  await server.register(attestationPlugin, { verifiers: [attestationDouble] });
  await server.register(identityPlugin);
  await server.register(authRoutes, { prefix: '/auth', devLogin: true, gatewayWsUrl });
  await server.register(gameRoutes, { prefix: '/game', gatewayWsUrl });
  await server.ready();
  return server;
}

before(async () => { await app.ready(); });
after(async () => { await closeApp(); });

describe('GATEWAY_WS_URL validation', () => {
  const accepted = [
    'wss://gateway.example.com/session',
    'ws://localhost:8080/session',
    'ws://192.168.1.20:8080',
    'wss://gateway.example.com',
    'wss://gateway.example.com:443/a/b/session',
    'wss://[::1]:8080/session',
    'WSS://Gateway.Example.com/session'
  ];
  for (const value of accepted) {
    test(`accepts ${value}`, () => assert.equal(parseGatewayWsUrl(value), value));
  }

  const rejected = {
    'wss://user:pass@gateway.example.com/session': /credentials/,
    'wss://user@gateway.example.com/session': /credentials/,
    'wss://@gateway.example.com/session': /credentials/,
    'wss://gateway.example.com@evil.example/session': /credentials/,
    'https://gateway.example.com/session': /ws:\/\/ or wss:\/\//,
    'http://gateway.example.com/session': /ws:\/\/ or wss:\/\//,
    'javascript:alert(1)': /ws:\/\/ or wss:\/\//,
    'gateway.example.com/session': /valid URL/,
    'wss://': /valid URL/,
    'wss:///session': /hostname/,
    'wss:gateway.example.com/session': /hostname/,
    'wss://gateway.example.com:99999/session': /valid URL/,
    'wss://gateway.example.com/session?token=1': /query/,
    'wss://gateway.example.com/session#frag': /query/,
    'wss://gateway.example.com /session': /whitespace/,
    'wss://gateway.example.com\\@evil.example/session': /backslashes/,
    '': /valid URL/
  };
  for (const [value, message] of Object.entries(rejected)) {
    test(`rejects ${JSON.stringify(value)}`, () => assert.throws(() => parseGatewayWsUrl(value), message));
  }

  // The service validates the variable at startup through its real config module.
  const startWith = (value) => spawnSync(process.execPath, ['--input-type=module', '-e', "await import('./src/config/env.js')"], {
    env: { ...process.env, NODE_ENV: 'test', GATEWAY_WS_URL: value },
    encoding: 'utf8'
  });

  test('startup accepts a valid value and treats an empty one as unset', () => {
    assert.equal(startWith('wss://gateway.example.com/session').status, 0);
    assert.equal(startWith('').status, 0);
  });

  test('startup refuses credentials, other schemes and malformed values', () => {
    for (const value of ['wss://user:pass@gateway.example.com/session', 'https://gateway.example.com/session', 'not a url']) {
      const result = startWith(value);
      assert.notEqual(result.status, 0, value);
      assert.match(result.stderr, /GATEWAY_WS_URL/);
    }
  });
});

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

  test('forwarded headers are ignored, genuine or forged', async () => {
    for (const headers of forwarded) assert.equal(await devLogin(headers), LOCAL_URL, JSON.stringify(headers));
  });

  test('GATEWAY_WS_URL is returned as configured, whatever the request says', async () => {
    const configured = await buildServer('wss://gateway.example.com/session');
    try {
      for (const headers of forwarded) {
        assert.equal(await devLogin(headers, configured), 'wss://gateway.example.com/session', JSON.stringify(headers));
      }
    } finally {
      await configured.close();
    }
  });
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

  test('forwarded headers never reach the stored default, genuine or forged', async () => {
    const pilot = await newPilot('Host');
    for (const headers of forwarded) {
      const res = await create(app, pilot, headers);
      assert.equal(json(res).rtseHost, 'localhost:8080', JSON.stringify(headers));
      const stored = await app.prisma.gameSession.findUnique({ where: { playerId: pilot.id } });
      assert.equal(stored.rtseHost, 'localhost:8080');
    }
  });

  test('an explicit rtseHost in the body wins', async () => {
    const pilot = await newPilot('Host');
    const res = await create(app, pilot, { 'x-forwarded-host': 'abc.ngrok-free.app' }, { rtseHost: 'rtse.internal:9000' });
    assert.equal(json(res).rtseHost, 'rtse.internal:9000');
  });

  test('GATEWAY_WS_URL supplies the host, whatever the request says', async () => {
    const server = await buildServer('wss://gateway.example.com:8443/session');
    try {
      const pilot = await newPilot('Host');
      const res = await create(server, pilot, { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'abc.ngrok-free.app' });
      assert.equal(json(res).rtseHost, 'gateway.example.com:8443');
    } finally {
      await server.close();
    }
  });
});
