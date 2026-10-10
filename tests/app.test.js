import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { app, attestationDouble, attestationHeaders, closeApp, json, keysDir, newPilot, PASSWORD } from './helpers.js';
import { DEV_STARTING_CREDITS } from '../src/config/dev.js';
import { upgradeCost } from '../src/config/components.js';
import prismaPlugin from '../src/plugins/prisma.js';
import securityPlugin from '../src/plugins/security.js';
import attestationPlugin from '../src/plugins/attestation.js';
import identityPlugin from '../src/plugins/identity.js';
import authRoutes from '../src/routes/auth/index.js';

const decodeHeader = (token) => JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString());

// A minimal server with only the auth routes, so dev-login can be tested enabled and disabled
// regardless of NODE_ENV.
async function buildAuthApp(devLogin) {
  const server = Fastify();
  await server.register(prismaPlugin);
  await server.register(securityPlugin, { keysDir });
  await server.register(attestationPlugin, { verifiers: [attestationDouble] });
  await server.register(identityPlugin);
  await server.register(authRoutes, { prefix: '/auth', devLogin });
  await server.ready();
  return server;
}

before(async () => { await app.ready(); });
after(async () => { await closeApp(); });

describe('Eotha Meta Service Endpoints', () => {
  test('GET /health returns healthy status', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    assert.equal(res.statusCode, 200);
    const body = json(res);
    assert.equal(body.status, 'healthy');
    assert.equal(body.service, 'eotha-meta-service');
  });
});

describe('signing keys', () => {
  test('startup fails when the keypair is missing instead of falling back to a shared secret', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'eotha-no-keys-'));
    const server = Fastify();
    server.register(securityPlugin, { keysDir: empty });
    await assert.rejects(server.ready(), /Refusing to start without the shared Ed25519 keypair/);

    const half = mkdtempSync(join(tmpdir(), 'eotha-half-keys-'));
    writeFileSync(join(half, 'public.pem'), 'irrelevant');
    const halfServer = Fastify();
    halfServer.register(securityPlugin, { keysDir: half });
    await assert.rejects(halfServer.ready(), /private\.pem/);
  });

  test('tokens are EdDSA-signed and carry the claims the RTSE verifies', async () => {
    const pilot = await newPilot('Claims');
    assert.equal(decodeHeader(pilot.token).alg, 'EdDSA');
    const decoded = app.jwt.verify(pilot.token);
    assert.equal(decoded.sub, pilot.id);
    assert.equal(decoded.callsign, pilot.callsign);
    assert.equal(decoded.home_h3, '8828308281fffff');
    assert.ok(decoded.ship_attributes.max_hull_hp);
    assert.equal(decoded.mock, undefined);
  });
});

describe('password hashing', () => {
  const login = (email, password) =>
    app.inject({ method: 'POST', url: '/auth/login', headers: attestationHeaders, payload: { email, password, deviceId: 'login-test-device-id' } });

  test('registration stores a salted argon2id hash, not SHA-256', async () => {
    const a = await newPilot('HashA');
    const b = await newPilot('HashB');
    const [rowA, rowB] = await Promise.all([a, b].map((p) => app.prisma.player.findUnique({ where: { id: p.id } })));
    assert.match(rowA.passwordHash, /^\$argon2id\$/);
    assert.notEqual(rowA.passwordHash, rowB.passwordHash); // same password, different salts
    assert.notEqual(rowA.passwordHash, createHash('sha256').update(PASSWORD).digest('hex'));
  });

  test('login rejects wrong passwords and unknown emails', async () => {
    const pilot = await newPilot('Wrong');
    assert.equal((await login(pilot.email, `${PASSWORD}x`)).statusCode, 401);
    assert.equal((await login('nobody@example.test', PASSWORD)).statusCode, 401);
    assert.equal((await login(pilot.email, PASSWORD)).statusCode, 200);
  });

  test('legacy SHA-256 hashes still verify and are upgraded to argon2id on login', async () => {
    const suffix = randomBytes(4).toString('hex');
    const email = `legacy-${suffix}@example.test`;
    const legacy = createHash('sha256').update(PASSWORD).digest('hex');
    const player = await app.prisma.player.create({
      data: {
        email,
        passwordHash: legacy,
        callsign: `Legacy-${suffix}`,
        harbor: { create: { latitude: 1, longitude: 2, h3Index: '8828308281fffff' } }
      }
    });
    try {
      assert.equal((await login(email, `${PASSWORD}x`)).statusCode, 401);
      assert.equal((await app.prisma.player.findUnique({ where: { id: player.id } })).passwordHash, legacy);

      assert.equal((await login(email, PASSWORD)).statusCode, 200);
      const upgraded = (await app.prisma.player.findUnique({ where: { id: player.id } })).passwordHash;
      assert.match(upgraded, /^\$argon2id\$/);

      assert.equal((await login(email, PASSWORD)).statusCode, 200); // still works on the new hash
      assert.equal((await login(email, `${PASSWORD}x`)).statusCode, 401);
      assert.equal((await app.prisma.player.findUnique({ where: { id: player.id } })).passwordHash, upgraded);
    } finally {
      await app.prisma.player.delete({ where: { id: player.id } });
    }
  });
});

describe('dev login', () => {
  const query = '?callsign=Spectre&latitude=37.7749&longitude=-122.4194&h3=8828308281fffff';

  test('is not routed outside development', async () => {
    const server = await buildAuthApp(false);
    try {
      const res = await server.inject({ method: 'GET', url: `/auth/dev-login${query}` });
      assert.equal(res.statusCode, 404);
    } finally {
      await server.close();
    }
  });

  test('in development mints an Ed25519 token for a persisted pilot', async () => {
    const server = await buildAuthApp(true);
    const callsign = `Spectre-${randomBytes(4).toString('hex')}`;
    try {
      const res = await server.inject({ method: 'GET', url: `/auth/dev-login?callsign=${callsign}&latitude=37.7749&longitude=-122.4194&h3=8828308281fffff` });
      assert.equal(res.statusCode, 200);
      const body = json(res);
      assert.equal(body.gateway_ws_url, 'ws://localhost:8080/session');
      assert.equal(body.player.callsign, callsign);
      assert.equal(body.player.dev, true);
      assert.equal(body.player.ship.components.length, 11);
      assert.deepEqual(body.player.spawn_point, { latitude: 37.7749, longitude: -122.4194, h3_index: '8828308281fffff' });

      assert.equal(decodeHeader(body.token).alg, 'EdDSA');
      const decoded = server.jwt.verify(body.token);
      assert.equal(decoded.sub, body.player.id);
      assert.equal(decoded.callsign, callsign);
      assert.equal(decoded.home_h3, '8828308281fffff');
      assert.equal(decoded.mock, undefined);
      assert.ok(Math.abs(decoded.exp - decoded.iat - 24 * 60 * 60) <= 1); // the dev client has no refresh flow
      assert.deepEqual(decoded.ship_attributes, body.player.ship.ship_attributes);

      // The pilot is a real row with a harbor, and repeat logins reuse it.
      const row = await server.prisma.player.findUnique({ where: { id: body.player.id }, include: { harbor: true } });
      assert.equal(row.callsign, callsign);
      assert.equal(row.harbor.h3Index, '8828308281fffff');
      const again = json(await server.inject({ method: 'GET', url: `/auth/dev-login?callsign=${callsign}&h3=8828308281ffffe` }));
      assert.equal(again.player.id, body.player.id);
      assert.equal((await server.prisma.spaceHarbor.findUnique({ where: { playerId: body.player.id } })).h3Index, '8828308281ffffe');

      // The account cannot be used with a password.
      const pwLogin = await server.inject({
        method: 'POST',
        url: '/auth/login',
        headers: attestationHeaders,
        payload: { email: row.email, password: '!', deviceId: 'login-test-device-id' }
      });
      assert.equal(pwLogin.statusCode, 401);

      await server.prisma.player.delete({ where: { id: body.player.id } });
    } finally {
      await server.close();
    }
  });
});

describe('dev login starting credits', () => {
  let server;
  const made = [];
  before(async () => { server = await buildAuthApp(true); });
  after(async () => {
    await server.prisma.player.deleteMany({ where: { id: { in: made } } });
    await server.close();
  });

  const uniqueCallsign = (prefix = 'Starter') => `${prefix}-${randomBytes(4).toString('hex')}`;
  const devLogin = async (callsign) => {
    const res = await server.inject({ method: 'GET', url: `/auth/dev-login?callsign=${callsign}` });
    assert.equal(res.statusCode, 200);
    const body = json(res);
    if (!made.includes(body.player.id)) made.push(body.player.id);
    return body;
  };
  const row = (id) => server.prisma.player.findUnique({ where: { id } });
  const upgrade = (token, componentType, targetTier) => app.inject({
    method: 'POST',
    url: '/ship/upgrade',
    headers: { authorization: `Bearer ${token}` },
    payload: { componentType, targetTier }
  });

  test('a new dev pilot is granted the starting credits once', async () => {
    assert.equal(DEV_STARTING_CREDITS, 20_000);
    const callsign = uniqueCallsign();
    const first = await devLogin(callsign);
    const created = await row(first.player.id);
    assert.equal(created.credits, DEV_STARTING_CREDITS);
    assert.ok(created.devCreditsGrantedAt);

    await devLogin(callsign);
    await devLogin(callsign);
    const again = await row(first.player.id);
    assert.equal(again.credits, DEV_STARTING_CREDITS);
    assert.deepEqual(again.devCreditsGrantedAt, created.devCreditsGrantedAt);
  });

  test('concurrent first logins still grant only once', async () => {
    const callsign = uniqueCallsign();
    const results = await Promise.allSettled(
      Array.from({ length: 4 }, () => server.inject({ method: 'GET', url: `/auth/dev-login?callsign=${callsign}` }))
    );
    const ok = results.filter((r) => r.status === 'fulfilled' && r.value.statusCode === 200);
    assert.ok(ok.length >= 1);
    const player = await server.prisma.player.findUnique({ where: { callsign } });
    made.push(player.id);
    assert.equal(player.credits, DEV_STARTING_CREDITS);
  });

  test('an existing dev pilot with the creation default is granted once', async () => {
    const callsign = uniqueCallsign('Legacy');
    const legacy = await server.prisma.player.create({
      data: { email: `${callsign}@dev-login.invalid`, passwordHash: '!', callsign }
    });
    made.push(legacy.id);
    assert.equal(legacy.credits, 0);
    assert.equal(legacy.devCreditsGrantedAt, null);

    await devLogin(callsign);
    assert.equal((await row(legacy.id)).credits, DEV_STARTING_CREDITS);
    await devLogin(callsign);
    assert.equal((await row(legacy.id)).credits, DEV_STARTING_CREDITS);
  });

  test('a dev pilot that spent its credits or already upgraded is not re-credited', async () => {
    const callsign = uniqueCallsign('Spent');
    const first = await devLogin(callsign);
    // Forget the marker as a pre-grant pilot would, then drain the balance by upgrading.
    await server.prisma.player.update({ where: { id: first.player.id }, data: { devCreditsGrantedAt: null, credits: 0 } });
    await server.prisma.spaceship.create({
      data: {
        playerId: first.player.id,
        callsign,
        components: { create: [{ type: 'ENGINES', tier: 2 }] }
      }
    });
    await devLogin(callsign);
    const after = await row(first.player.id);
    assert.equal(after.credits, 0);
    assert.equal(after.devCreditsGrantedAt, null);

    const richCallsign = uniqueCallsign('Rich');
    const rich = await server.prisma.player.create({
      data: { email: `${richCallsign}@dev-login.invalid`, passwordHash: '!', callsign: richCallsign, credits: 5 }
    });
    made.push(rich.id);
    await devLogin(richCallsign);
    assert.equal((await row(rich.id)).credits, 5);
  });

  test('registered, guest and linked accounts never get it', async () => {
    const registered = await newPilot('Registered');
    const res = await server.inject({ method: 'GET', url: `/auth/dev-login?callsign=${registered.callsign}` });
    assert.equal(res.statusCode, 200);
    const reg = await row(registered.id);
    assert.equal(reg.credits, 0);
    assert.equal(reg.devCreditsGrantedAt, null);

    const guestRes = json(await app.inject({
      method: 'POST',
      url: '/auth/guest',
      headers: attestationHeaders,
      payload: { deviceId: randomBytes(16).toString('hex') }
    }));
    made.push(guestRes.player.id);
    assert.equal(guestRes.player.anonymous, true);
    await devLogin(guestRes.player.callsign);
    const guest = await row(guestRes.player.id);
    assert.equal(guest.credits, 0);
    assert.equal(guest.devCreditsGrantedAt, null);

    // Once linked, the guest is a real account with a real email.
    const linkedEmail = `linked-${randomBytes(4).toString('hex')}@example.test`;
    const link = await app.inject({
      method: 'POST',
      url: '/auth/link/email',
      headers: { authorization: `Bearer ${guestRes.token}` },
      payload: { email: linkedEmail, password: PASSWORD }
    });
    assert.equal(link.statusCode, 200);
    await devLogin(guestRes.player.callsign);
    const linked = await row(guestRes.player.id);
    assert.equal(linked.isAnonymous, false);
    assert.equal(linked.credits, 0);
    assert.equal(linked.devCreditsGrantedAt, null);
  });

  test('outside development nothing is granted', async () => {
    const off = await buildAuthApp(false);
    const callsign = uniqueCallsign('Prod');
    try {
      const res = await off.inject({ method: 'GET', url: `/auth/dev-login?callsign=${callsign}` });
      assert.equal(res.statusCode, 404);
      assert.equal(await off.prisma.player.findUnique({ where: { callsign } }), null);
    } finally {
      await off.close();
    }
  });

  test('an upgrade bought with the grant persists across a new login', async () => {
    const callsign = uniqueCallsign('Racer');
    const first = await devLogin(callsign);
    assert.equal(first.player.ship.ship_attributes.max_speed_mps, 20);

    // Tier 1 hull budgets only the default loadout, so the hull is raised before the engines.
    const hull = await upgrade(first.token, 'HULL', 2);
    assert.equal(hull.statusCode, 200);
    const engines = await upgrade(first.token, 'ENGINES', 4);
    assert.equal(engines.statusCode, 200);
    const upgraded = json(engines);
    const cost = upgradeCost(1, 2) + upgradeCost(1, 4);
    assert.equal(upgraded.credits, DEV_STARTING_CREDITS - cost);
    assert.equal(app.jwt.verify(upgraded.token).ship_attributes.max_speed_mps, 75);

    const second = await devLogin(callsign);
    assert.equal(second.player.id, first.player.id);
    assert.equal(second.player.ship.ship_attributes.max_speed_mps, 75);
    assert.equal(server.jwt.verify(second.token).ship_attributes.max_speed_mps, 75);
    assert.equal(second.player.ship.components.find((c) => c.type === 'ENGINES').tier, 4);
    assert.equal((await row(first.player.id)).credits, DEV_STARTING_CREDITS - cost); // not re-credited
  });
});
