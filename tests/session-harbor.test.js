import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import {
  app, attestationDouble, attestationHeaders, closeApp, json, keysDir, newPilot, PASSWORD, track
} from './helpers.js';
import { DEFAULT_HARBOR } from '../src/config/harbor.js';
import { ensureHarbor } from '../src/lib/harbor.js';
import prismaPlugin from '../src/plugins/prisma.js';
import securityPlugin from '../src/plugins/security.js';
import attestationPlugin from '../src/plugins/attestation.js';
import identityPlugin from '../src/plugins/identity.js';
import authRoutes from '../src/routes/auth/index.js';

// Every sign-in path (guest, login, refresh) hands out a playable session, not only dev login: the
// player's SpaceHarbor exists, the token carries it as home_h3, and the response names the gateway.

before(async () => { await app.ready(); });
after(async () => { await closeApp(); });

const DEFAULT_SPAWN = { latitude: 37.7749, longitude: -122.4194, h3_index: '8828308281fffff' };
const LOCAL_GATEWAY = 'ws://localhost:8080/session';

const guestLogin = (server, deviceId = randomUUID()) =>
  server.inject({ method: 'POST', url: '/auth/guest', headers: attestationHeaders, payload: { deviceId } });
const refresh = (server, refreshToken) => server.inject({ method: 'POST', url: '/auth/refresh', payload: { refreshToken } });

async function newGuest(server = app) {
  const res = await guestLogin(server);
  assert.equal(res.statusCode, 200, res.body);
  const session = json(res);
  track(session.player.id);
  return session;
}

const harborOf = (playerId) => app.prisma.spaceHarbor.findUnique({ where: { playerId } });

async function buildServer(gatewayWsUrl) {
  const server = Fastify();
  await server.register(prismaPlugin);
  await server.register(securityPlugin, { keysDir });
  await server.register(attestationPlugin, { verifiers: [attestationDouble] });
  await server.register(identityPlugin);
  await server.register(authRoutes, { prefix: '/auth', devLogin: false, gatewayWsUrl });
  await server.ready();
  return server;
}

describe('guest sessions', () => {
  test('a new guest gets the default harbor, a token with that home_h3, and the spawn point', async () => {
    const guest = await newGuest();
    assert.deepEqual(guest.player.spawn_point, DEFAULT_SPAWN);
    assert.equal(app.jwt.verify(guest.token).home_h3, DEFAULT_HARBOR.h3Index);
    const harbor = await harborOf(guest.player.id);
    assert.deepEqual(
      { latitude: harbor.latitude, longitude: harbor.longitude, h3Index: harbor.h3Index },
      DEFAULT_HARBOR
    );
  });

  test('a new guest still starts with 0 credits', async () => {
    const guest = await newGuest();
    const row = await app.prisma.player.findUnique({ where: { id: guest.player.id } });
    assert.equal(row.credits, 0);
    assert.equal(row.devCreditsGrantedAt, null);
  });

  test('resuming the same device keeps the one harbor', async () => {
    const deviceId = randomUUID();
    const first = json(await guestLogin(app, deviceId));
    track(first.player.id);
    const again = json(await guestLogin(app, deviceId));
    assert.equal(again.created, false);
    assert.equal(again.player.id, first.player.id);
    assert.equal(await app.prisma.spaceHarbor.count({ where: { playerId: first.player.id } }), 1);
  });

  test('a guest created before harbors existed gets one on its next session, and a harbor is never moved', async () => {
    const guest = await newGuest();
    await app.prisma.spaceHarbor.delete({ where: { playerId: guest.player.id } });

    const res = await refresh(app, guest.refreshToken);
    assert.equal(res.statusCode, 200, res.body);
    const next = json(res);
    assert.deepEqual(next.player.spawn_point, DEFAULT_SPAWN);
    assert.equal(app.jwt.verify(next.token).home_h3, DEFAULT_HARBOR.h3Index);

    await app.prisma.spaceHarbor.update({ where: { playerId: guest.player.id }, data: { h3Index: '8828308281ffffe' } });
    const moved = json(await refresh(app, next.refreshToken));
    assert.equal(moved.player.spawn_point.h3_index, '8828308281ffffe');
    assert.equal(app.jwt.verify(moved.token).home_h3, '8828308281ffffe');
  });

  test('linking an email to a guest keeps its harbor', async () => {
    const guest = await newGuest();
    const res = await app.inject({
      method: 'POST',
      url: '/auth/link/email',
      headers: { authorization: `Bearer ${guest.token}` },
      payload: { email: `link-${randomUUID()}@example.test`, password: PASSWORD }
    });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(app.jwt.verify(json(res).token).home_h3, DEFAULT_HARBOR.h3Index);
    assert.equal(await app.prisma.spaceHarbor.count({ where: { playerId: guest.player.id } }), 1);
  });
});

describe('ensureHarbor', () => {
  test('concurrent first sessions create exactly one harbor', async () => {
    const guest = await newGuest();
    await app.prisma.spaceHarbor.delete({ where: { playerId: guest.player.id } });
    const harbors = await Promise.all(Array.from({ length: 6 }, () => ensureHarbor(app.prisma, guest.player.id)));
    assert.equal(new Set(harbors.map(({ id }) => id)).size, 1);
    assert.equal(await app.prisma.spaceHarbor.count({ where: { playerId: guest.player.id } }), 1);
  });
});

describe('password login and refresh', () => {
  test('a registered pilot keeps the harbor it registered with and is told where it spawns', async () => {
    const pilot = await newPilot('Harbor');
    await app.prisma.spaceHarbor.update({ where: { playerId: pilot.id }, data: { h3Index: '8828308281ffffe', latitude: 10, longitude: 20 } });
    const res = await app.inject({
      method: 'POST',
      url: '/auth/login',
      headers: attestationHeaders,
      payload: { email: pilot.email, password: PASSWORD, deviceId: 'login-test-device-id' }
    });
    assert.equal(res.statusCode, 200, res.body);
    const session = json(res);
    assert.deepEqual(session.player.spawn_point, { latitude: 10, longitude: 20, h3_index: '8828308281ffffe' });
    assert.equal(session.gateway_ws_url, LOCAL_GATEWAY);
    assert.equal(app.jwt.verify(session.token).home_h3, '8828308281ffffe');
  });
});

describe('gateway_ws_url on session responses', () => {
  test('guest, login and refresh all return the local default when none is configured', async () => {
    const guest = await newGuest();
    assert.equal(guest.gateway_ws_url, LOCAL_GATEWAY);
    const refreshed = json(await refresh(app, guest.refreshToken));
    assert.equal(refreshed.gateway_ws_url, LOCAL_GATEWAY);
  });

  test('all of them return the configured GATEWAY_WS_URL, never anything from the request', async () => {
    const configured = 'wss://gateway.example.com/session';
    const server = await buildServer(configured);
    try {
      const forged = { 'x-forwarded-host': 'evil.example', 'x-forwarded-proto': 'https', host: 'evil.example' };
      const res = await server.inject({
        method: 'POST', url: '/auth/guest', headers: { ...attestationHeaders, ...forged }, payload: { deviceId: randomUUID() }
      });
      assert.equal(res.statusCode, 200, res.body);
      const guest = json(res);
      track(guest.player.id);
      assert.equal(guest.gateway_ws_url, configured);
      const refreshed = json(await refresh(server, guest.refreshToken));
      assert.equal(refreshed.gateway_ws_url, configured);

      const pilot = await newPilot('Gateway');
      const login = await server.inject({
        method: 'POST',
        url: '/auth/login',
        headers: { ...attestationHeaders, ...forged },
        payload: { email: pilot.email, password: PASSWORD, deviceId: 'login-test-device-id' }
      });
      assert.equal(json(login).gateway_ws_url, configured);
    } finally {
      await server.close();
    }
  });
});

describe('dev login is unchanged', () => {
  test('still returns its own spawn point, gateway address and starting credits', async () => {
    const server = Fastify();
    await server.register(prismaPlugin);
    await server.register(securityPlugin, { keysDir });
    await server.register(attestationPlugin, { verifiers: [attestationDouble] });
    await server.register(identityPlugin);
    await server.register(authRoutes, { prefix: '/auth', devLogin: true });
    await server.ready();
    const callsign = `Dev-${randomUUID().slice(0, 8)}`;
    try {
      const res = await server.inject({ method: 'GET', url: `/auth/dev-login?callsign=${callsign}&latitude=1&longitude=2&h3=8828308281ffffe` });
      assert.equal(res.statusCode, 200, res.body);
      const body = json(res);
      track(body.player.id);
      assert.equal(body.gateway_ws_url, LOCAL_GATEWAY);
      assert.deepEqual(body.player.spawn_point, { latitude: 1, longitude: 2, h3_index: '8828308281ffffe' });
      assert.equal(body.player.dev, true);
      assert.equal(server.jwt.verify(body.token).home_h3, '8828308281ffffe');
    } finally {
      await server.close();
    }
  });
});
