import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import {
  app, attestationDouble, attestationHeaders, closeApp, json, keysDir, newPilot, PASSWORD, track
} from './helpers.js';
import { DEFAULT_HARBOR, HARBOR_H3_RESOLUTION } from '../src/config/harbor.js';
import { cellToLatLng, getResolution, latLngToCell } from 'h3-js';
import { ensureHarbor, harborAt } from '../src/lib/harbor.js';
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

const guestLogin = (server, deviceId = randomUUID(), location = {}) =>
  server.inject({ method: 'POST', url: '/auth/guest', headers: attestationHeaders, payload: { deviceId, ...location } });
const refresh = (server, refreshToken) => server.inject({ method: 'POST', url: '/auth/refresh', payload: { refreshToken } });

async function newGuest(server = app, location = {}) {
  const res = await guestLogin(server, randomUUID(), location);
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

// Hamburg, as a browser reports it, and the resolution 8 cell (and its center) it falls in.
const HAMBURG = { latitude: 53.5511, longitude: 9.9937 };
const HAMBURG_CELL = '881f15ad3dfffff';
const HAMBURG_SPAWN = { latitude: 53.55182558904559, longitude: 9.99281878388885, h3_index: HAMBURG_CELL };

const harborFields = ({ latitude, longitude, h3Index }) => ({ latitude, longitude, h3Index });

describe('harborAt', () => {
  test('the default harbor names the resolution 8 cell its coordinates fall in', () => {
    assert.equal(HARBOR_H3_RESOLUTION, 8);
    assert.equal(latLngToCell(DEFAULT_HARBOR.latitude, DEFAULT_HARBOR.longitude, HARBOR_H3_RESOLUTION), DEFAULT_HARBOR.h3Index);
  });

  test('snaps a reported position to the center of its resolution 8 cell', () => {
    const harbor = harborAt(HAMBURG);
    assert.equal(harbor.h3Index, HAMBURG_CELL);
    assert.equal(getResolution(harbor.h3Index), 8);
    assert.equal(harbor.h3Index, latLngToCell(HAMBURG.latitude, HAMBURG.longitude, 8));
    assert.deepEqual([harbor.latitude, harbor.longitude], cellToLatLng(harbor.h3Index));
    // The stored point is the cell's, not the player's: it names the same cell and differs from the input.
    assert.equal(latLngToCell(harbor.latitude, harbor.longitude, 8), harbor.h3Index);
    assert.notDeepEqual([harbor.latitude, harbor.longitude], [HAMBURG.latitude, HAMBURG.longitude]);
  });

  test('two positions in the same cell give the same harbor', () => {
    const nearby = { latitude: HAMBURG.latitude + 0.0005, longitude: HAMBURG.longitude - 0.0005 };
    assert.deepEqual(harborAt(nearby), harborAt(HAMBURG));
  });

  test('accepts the edges of the valid range', () => {
    for (const location of [{ latitude: 90, longitude: 180 }, { latitude: -90, longitude: -180 }, { latitude: 0, longitude: 0 }]) {
      const harbor = harborAt(location);
      assert.ok(harbor, JSON.stringify(location));
      assert.equal(getResolution(harbor.h3Index), 8);
    }
  });

  test('is null for a missing, non-numeric, non-finite or out-of-range position', () => {
    const unusable = [
      undefined, null, {}, 'here',
      { latitude: 53.5 }, { longitude: 9.9 },
      { latitude: '53.5511', longitude: '9.9937' },
      { latitude: null, longitude: null },
      { latitude: true, longitude: 9.9 },
      { latitude: [53.5], longitude: [9.9] },
      { latitude: Number.NaN, longitude: 9.9 },
      { latitude: 53.5, longitude: Number.POSITIVE_INFINITY },
      { latitude: 90.0001, longitude: 0 }, { latitude: -91, longitude: 0 },
      { latitude: 0, longitude: 180.5 }, { latitude: 0, longitude: -181 }
    ];
    for (const location of unusable) assert.equal(harborAt(location), null, JSON.stringify(location));
  });
});

describe('guest sessions with a browser location', () => {
  test('a new guest with a valid location gets its harbor at the snapped cell center', async () => {
    const guest = await newGuest(app, HAMBURG);
    assert.equal(guest.created, true);
    assert.deepEqual(guest.player.spawn_point, HAMBURG_SPAWN);
    assert.equal(app.jwt.verify(guest.token).home_h3, HAMBURG_CELL);
    assert.deepEqual(harborFields(await harborOf(guest.player.id)), harborFields(harborAt(HAMBURG)));
  });

  test('a missing, out-of-range or non-numeric location is not refused and falls back to the default harbor', async () => {
    const fallbacks = [
      {},
      { latitude: 53.5511 },
      { latitude: 91, longitude: 9.9937 },
      { latitude: 53.5511, longitude: -180.01 },
      { latitude: 'north', longitude: 'east' },
      { latitude: '53.5511', longitude: '9.9937' },
      { latitude: null, longitude: null },
      { latitude: { lat: 1 }, longitude: [2] },
      { latitude: true, longitude: false }
    ];
    for (const location of fallbacks) {
      const res = await guestLogin(app, randomUUID(), location);
      assert.equal(res.statusCode, 200, `${JSON.stringify(location)}: ${res.body}`);
      const guest = json(res);
      track(guest.player.id);
      assert.deepEqual(guest.player.spawn_point, DEFAULT_SPAWN, JSON.stringify(location));
      assert.equal(app.jwt.verify(guest.token).home_h3, DEFAULT_HARBOR.h3Index);
      assert.deepEqual(harborFields(await harborOf(guest.player.id)), DEFAULT_HARBOR);
    }
  });

  test('a later sign-in from somewhere else never moves an existing harbor', async () => {
    const deviceId = randomUUID();
    const first = json(await guestLogin(app, deviceId, HAMBURG));
    track(first.player.id);
    assert.deepEqual(first.player.spawn_point, HAMBURG_SPAWN);

    const again = json(await guestLogin(app, deviceId, { latitude: -33.8688, longitude: 151.2093 }));
    assert.equal(again.created, false);
    assert.equal(again.player.id, first.player.id);
    assert.deepEqual(again.player.spawn_point, HAMBURG_SPAWN);
    assert.equal(app.jwt.verify(again.token).home_h3, HAMBURG_CELL);
    assert.equal(await app.prisma.spaceHarbor.count({ where: { playerId: first.player.id } }), 1);
  });

  test('a guest that already has the default harbor keeps it when it later reports a location', async () => {
    const deviceId = randomUUID();
    const first = json(await guestLogin(app, deviceId));
    track(first.player.id);
    const again = json(await guestLogin(app, deviceId, HAMBURG));
    assert.deepEqual(again.player.spawn_point, DEFAULT_SPAWN);
    assert.deepEqual(harborFields(await harborOf(first.player.id)), DEFAULT_HARBOR);
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

  test('concurrent first sessions from different locations still create exactly one harbor', async () => {
    const guest = await newGuest();
    await app.prisma.spaceHarbor.delete({ where: { playerId: guest.player.id } });
    const locations = [HAMBURG, { latitude: -33.8688, longitude: 151.2093 }, undefined, { latitude: 'x' }, HAMBURG, undefined];
    const harbors = await Promise.all(locations.map((location) => ensureHarbor(app.prisma, guest.player.id, location)));
    assert.equal(new Set(harbors.map(({ id }) => id)).size, 1);
    assert.equal(await app.prisma.spaceHarbor.count({ where: { playerId: guest.player.id } }), 1);
    // Whichever insert won, the harbor is one of the candidates, whole: never a mix of two of them.
    // Compared by cell: stored coordinates are rounded to the column's 15 significant digits.
    const candidates = [harborAt(HAMBURG), harborAt(locations[1]), DEFAULT_HARBOR].map(({ h3Index }) => h3Index);
    assert.ok(candidates.includes(harbors[0].h3Index), JSON.stringify(harbors[0]));
  });

  test('an existing harbor is returned unchanged whatever location is passed', async () => {
    const guest = await newGuest(app, HAMBURG);
    const before = await harborOf(guest.player.id);
    const after = await ensureHarbor(app.prisma, guest.player.id, { latitude: -33.8688, longitude: 151.2093 });
    assert.deepEqual(after, before);
  });

  test('concurrent first guest sign-ins from one device with a location yield one player and one harbor there', async () => {
    const deviceId = randomUUID();
    const sessions = (await Promise.all(Array.from({ length: 4 }, () => guestLogin(app, deviceId, HAMBURG)))).map((res) => {
      assert.equal(res.statusCode, 200, res.body);
      return json(res);
    });
    const ids = new Set(sessions.map(({ player }) => player.id));
    for (const id of ids) track(id);
    assert.equal(ids.size, 1);
    for (const session of sessions) assert.deepEqual(session.player.spawn_point, HAMBURG_SPAWN);
    assert.equal(await app.prisma.spaceHarbor.count({ where: { playerId: [...ids][0] } }), 1);
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
