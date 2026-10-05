import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { app, closeApp, json, keysDir, newPilot, PASSWORD } from './helpers.js';
import prismaPlugin from '../src/plugins/prisma.js';
import securityPlugin from '../src/plugins/security.js';
import authRoutes from '../src/routes/auth/index.js';

const decodeHeader = (token) => JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString());

// A minimal server with only the auth routes, so dev-login can be tested enabled and disabled
// regardless of NODE_ENV.
async function buildAuthApp(devLogin) {
  const server = Fastify();
  await server.register(prismaPlugin);
  await server.register(securityPlugin, { keysDir });
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
  const login = (email, password) => app.inject({ method: 'POST', url: '/auth/login', payload: { email, password } });

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
      assert.deepEqual(decoded.ship_attributes, body.player.ship.ship_attributes);

      // The pilot is a real row with a harbor, and repeat logins reuse it.
      const row = await server.prisma.player.findUnique({ where: { id: body.player.id }, include: { harbor: true } });
      assert.equal(row.callsign, callsign);
      assert.equal(row.harbor.h3Index, '8828308281fffff');
      const again = json(await server.inject({ method: 'GET', url: `/auth/dev-login?callsign=${callsign}&h3=8828308281ffffe` }));
      assert.equal(again.player.id, body.player.id);
      assert.equal((await server.prisma.spaceHarbor.findUnique({ where: { playerId: body.player.id } })).h3Index, '8828308281ffffe');

      // The account cannot be used with a password.
      const pwLogin = await server.inject({ method: 'POST', url: '/auth/login', payload: { email: row.email, password: '!' } });
      assert.equal(pwLogin.statusCode, 401);

      await server.prisma.player.delete({ where: { id: body.player.id } });
    } finally {
      await server.close();
    }
  });
});
