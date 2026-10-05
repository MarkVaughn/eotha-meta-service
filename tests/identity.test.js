import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createPublicKey, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Fastify from 'fastify';
import { createLocalJWKSet, jwtVerify } from 'jose';
import {
  app, attestationDouble, attestationHeaders, call, closeApp, GOOD_ATTESTATION, json, keysDir, newPilot,
  PASSWORD, setCredits, track
} from './helpers.js';
import { createPlayIntegrityVerifier } from '../src/lib/attestation/play-integrity.js';
import attestationPlugin from '../src/plugins/attestation.js';

before(async () => { await app.ready(); });
after(async () => { await closeApp(); });

const decodeHeader = (token) => JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString());
const newDeviceId = () => randomUUID();

const guestLogin = (deviceId, headers = attestationHeaders) =>
  app.inject({ method: 'POST', url: '/auth/guest', headers, payload: { deviceId } });
const refresh = (refreshToken) => app.inject({ method: 'POST', url: '/auth/refresh', payload: { refreshToken } });
const linkEmail = (session, payload) =>
  app.inject({ method: 'POST', url: '/auth/link/email', headers: { authorization: `Bearer ${session.token}` }, payload });

/** A guest signed in through the public endpoint, registered for cleanup. */
async function newGuest(deviceId = newDeviceId()) {
  const res = await guestLogin(deviceId);
  assert.equal(res.statusCode, 200, res.body);
  const session = json(res);
  track(session.player.id);
  return { ...session, deviceId };
}

const uniqueEmail = (prefix) => `${prefix}-${randomBytes(4).toString('hex')}@example.test`;

describe('guest login', () => {
  test('creates an anonymous player and signs the same EdDSA token claims as a normal login', async () => {
    const guest = await newGuest();
    assert.equal(guest.created, true);
    assert.equal(guest.player.anonymous, true);
    assert.match(guest.player.callsign, /^Pilot-[0-9a-f]{12}$/);

    assert.equal(decodeHeader(guest.token).alg, 'EdDSA');
    const claims = app.jwt.verify(guest.token);
    assert.equal(claims.sub, guest.player.id);
    assert.equal(claims.callsign, guest.player.callsign);
    assert.ok(claims.home_h3);
    assert.ok(claims.ship_attributes.max_hull_hp);
    assert.equal(claims.mock, undefined);

    const row = await app.prisma.player.findUnique({ where: { id: guest.player.id } });
    assert.equal(row.isAnonymous, true);
    assert.equal(row.passwordHash, '!');
    assert.match(row.email, /^temp-.+@guest\.eotha\.invalid$/);
  });

  test('access tokens are short-lived', async () => {
    const guest = await newGuest();
    const { iat, exp } = app.jwt.verify(guest.token);
    assert.equal(exp - iat, guest.expiresIn);
    assert.ok(guest.expiresIn <= 15 * 60);
  });

  test('is tied to the device: the same device resumes the same player, another device gets a new one', async () => {
    const first = await newGuest();
    const again = json(await guestLogin(first.deviceId));
    assert.equal(again.created, false);
    assert.equal(again.player.id, first.player.id);
    assert.equal(again.player.callsign, first.player.callsign);

    const other = await newGuest();
    assert.notEqual(other.player.id, first.player.id);

    // Only a hash of the device id is stored.
    const hash = createHash('sha256').update(first.deviceId).digest('hex');
    const binding = await app.prisma.guestDevice.findUnique({ where: { deviceHash: hash } });
    assert.equal(binding.playerId, first.player.id);
  });

  test('concurrent first launches from one device converge on a single player', async () => {
    const deviceId = newDeviceId();
    const results = await Promise.all(Array.from({ length: 4 }, () => guestLogin(deviceId)));
    for (const res of results) assert.equal(res.statusCode, 200, res.body);
    const bodies = results.map(json);
    bodies.forEach((b) => track(b.player.id));
    assert.equal(new Set(bodies.map((b) => b.player.id)).size, 1);
    const hash = createHash('sha256').update(deviceId).digest('hex');
    assert.equal(await app.prisma.guestDevice.count({ where: { deviceHash: hash } }), 1);
  });

  test('a guest cannot sign in with a password', async () => {
    const guest = await newGuest();
    const { email } = await app.prisma.player.findUnique({ where: { id: guest.player.id } });
    for (const password of ['!', PASSWORD, '']) {
      const res = await app.inject({
        method: 'POST', url: '/auth/login', headers: attestationHeaders, payload: { email, password, deviceId: 'login-test-device-id' }
      });
      assert.equal(res.statusCode, 401);
    }
  });

  test('rejects device ids too short to serve as a credential', async () => {
    assert.equal((await guestLogin('short')).statusCode, 400);
  });

  test('a guest token authenticates game endpoints', async () => {
    const guest = await newGuest();
    const res = await call({ headers: { authorization: `Bearer ${guest.token}` } }, 'GET', '/game/credits');
    assert.equal(res.statusCode, 200);
    assert.equal(json(res).credits, 0);
  });
});

describe('linking an email account', () => {
  test('keeps the player id and enables password login', async () => {
    const guest = await newGuest();
    const email = uniqueEmail('link');
    const res = await linkEmail(guest, { email, password: PASSWORD });
    assert.equal(res.statusCode, 200, res.body);
    const body = json(res);
    assert.equal(body.player.id, guest.player.id);
    assert.equal(body.player.anonymous, false);
    assert.equal(app.jwt.verify(body.token).sub, guest.player.id);

    const row = await app.prisma.player.findUnique({ where: { id: guest.player.id } });
    assert.equal(row.isAnonymous, false);
    assert.equal(row.email, email);
    assert.match(row.passwordHash, /^\$argon2id\$/);

    // Password login now yields the same player id.
    const login = await app.inject({
      method: 'POST', url: '/auth/login', headers: attestationHeaders, payload: { email, password: PASSWORD, deviceId: 'login-test-device-id' }
    });
    assert.equal(login.statusCode, 200);
    assert.equal(json(login).player.id, guest.player.id);
    assert.equal(json(login).player.anonymous, false);
  });

  test('a second link is refused', async () => {
    const guest = await newGuest();
    assert.equal((await linkEmail(guest, { email: uniqueEmail('once'), password: PASSWORD })).statusCode, 200);

    const second = await linkEmail(guest, { email: uniqueEmail('twice'), password: PASSWORD });
    assert.equal(second.statusCode, 409);
    assert.equal(json(second).error, 'already_linked');
  });

  test('concurrent link requests let exactly one through', async () => {
    const guest = await newGuest();
    const results = await Promise.all(
      Array.from({ length: 4 }, () => linkEmail(guest, { email: uniqueEmail('race'), password: PASSWORD }))
    );
    assert.equal(results.filter((r) => r.statusCode === 200).length, 1);
    assert.ok(results.every((r) => [200, 409].includes(r.statusCode)));
  });

  test('a taken email is refused without promoting the guest', async () => {
    const taken = await newPilot('Taken');
    const guest = await newGuest();
    const res = await linkEmail(guest, { email: taken.email, password: PASSWORD });
    assert.equal(res.statusCode, 409);
    assert.equal(json(res).error, 'email_or_callsign_taken');
    const row = await app.prisma.player.findUnique({ where: { id: guest.player.id } });
    assert.equal(row.isAnonymous, true);
  });

  test('an already-registered pilot cannot be linked again', async () => {
    const pilot = await newPilot('Registered');
    const res = await linkEmail(pilot, { email: uniqueEmail('reg'), password: PASSWORD });
    assert.equal(res.statusCode, 409);
  });

  test('requires a valid access token', async () => {
    const res = await app.inject({
      method: 'POST', url: '/auth/link/email', payload: { email: uniqueEmail('anon'), password: PASSWORD }
    });
    assert.equal(res.statusCode, 401);
  });

  test('may rename the callsign while linking', async () => {
    const guest = await newGuest();
    const callsign = `Renamed-${randomBytes(4).toString('hex')}`;
    const res = await linkEmail(guest, { email: uniqueEmail('rename'), password: PASSWORD, callsign });
    assert.equal(res.statusCode, 200);
    assert.equal(app.jwt.verify(json(res).token).callsign, callsign);
  });

  test('the device of a linked guest can no longer start a guest session', async () => {
    const guest = await newGuest();
    await linkEmail(guest, { email: uniqueEmail('dev'), password: PASSWORD });
    const res = await guestLogin(guest.deviceId);
    assert.equal(res.statusCode, 409);
    assert.equal(json(res).error, 'device_account_linked');
  });

  test('an external provider account linked through Better Auth promotes the guest', async () => {
    const guest = await newGuest();
    const { internalAdapter } = await app.betterAuth.$context;
    // 'test-provider' stands in for Apple / Google / Play Games, none of which is enabled.
    await internalAdapter.linkAccount({ userId: guest.player.id, providerId: 'test-provider', accountId: randomUUID() });
    const row = await app.prisma.player.findUnique({ where: { id: guest.player.id } });
    assert.equal(row.isAnonymous, false);
    assert.equal(row.id, guest.player.id);
  });
});

describe('guest hull lock', () => {
  const upgrade = (session, componentType, targetTier) => app.inject({
    method: 'POST', url: '/ship/upgrade', headers: { authorization: `Bearer ${session.token}` }, payload: { componentType, targetTier }
  });
  const fundedGuest = async () => {
    const guest = await newGuest();
    await setCredits({ id: guest.player.id }, 100_000);
    return guest;
  };

  test('a guest cannot upgrade the hull, and nothing is charged or changed', async () => {
    const guest = await fundedGuest();
    const res = await upgrade(guest, 'HULL', 2);
    assert.equal(res.statusCode, 403);
    assert.equal(json(res).code, 'guest_hull_locked');
    assert.equal((await app.prisma.player.findUnique({ where: { id: guest.player.id } })).credits, 100_000);
    const hull = await app.prisma.shipComponentRecord.findFirst({
      where: { type: 'HULL', spaceship: { playerId: guest.player.id } }
    });
    assert.ok(!hull || hull.tier === 1);
  });

  test('a guest can still upgrade other components', async () => {
    const guest = await fundedGuest();
    // Subsystem upgrades are bounded by the hull tier, and a guest's hull cannot be raised, so give
    // the guest a roomier hull directly in the database to show the lock is specific to HULL.
    const loadout = json(await call({ headers: { authorization: `Bearer ${guest.token}` } }, 'GET', '/ship/loadout'));
    await app.prisma.shipComponentRecord.upsert({
      where: { spaceshipId_type: { spaceshipId: loadout.ship_id, type: 'HULL' } },
      update: { tier: 3 },
      create: { spaceshipId: loadout.ship_id, type: 'HULL', tier: 3 }
    });
    const res = await upgrade(guest, 'RADAR', 3);
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(json(res).components.find((c) => c.type === 'RADAR').tier, 3);
  });

  test('a registered (non-guest) player can upgrade the hull', async () => {
    const pilot = await newPilot('Hulled');
    await setCredits(pilot, 100_000);
    const res = await upgrade(pilot, 'HULL', 2);
    assert.equal(res.statusCode, 200, res.body);
  });

  test('linking an account unlocks the hull for the same player', async () => {
    const guest = await fundedGuest();
    assert.equal((await upgrade(guest, 'HULL', 2)).statusCode, 403);

    const linked = json(await linkEmail(guest, { email: uniqueEmail('unlock'), password: PASSWORD }));
    assert.equal(linked.player.id, guest.player.id);
    // The old guest token still works: the lock follows the identity record, not the token.
    const res = await upgrade(guest, 'HULL', 2);
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(json(res).components.find((c) => c.type === 'HULL').tier, 2);
  });

  test('guest status comes from the identity record, not from anything the client sends', async () => {
    const guest = await fundedGuest();
    const res = await app.inject({
      method: 'POST',
      url: '/ship/upgrade',
      headers: { authorization: `Bearer ${guest.token}`, 'x-guest': 'false' },
      payload: { componentType: 'HULL', targetTier: 2, isAnonymous: false, anonymous: false }
    });
    assert.ok([400, 403].includes(res.statusCode));
    assert.notEqual(res.statusCode, 200);
    assert.equal((await app.prisma.player.findUnique({ where: { id: guest.player.id } })).credits, 100_000);
  });

  test('guests and linked players carry the same claims in their access tokens', async () => {
    const guest = await newGuest();
    const linked = json(await linkEmail(guest, { email: uniqueEmail('claims'), password: PASSWORD }));
    assert.deepEqual(Object.keys(app.jwt.verify(guest.token)).sort(), Object.keys(app.jwt.verify(linked.token)).sort());
  });
});

describe('refresh tokens', () => {
  test('rotate: each refresh yields a new access and refresh token, and the old refresh token dies', async () => {
    const guest = await newGuest();
    const res = await refresh(guest.refreshToken);
    assert.equal(res.statusCode, 200, res.body);
    const next = json(res);
    assert.notEqual(next.refreshToken, guest.refreshToken);
    assert.equal(next.player.id, guest.player.id);
    const claims = app.jwt.verify(next.token);
    assert.equal(claims.sub, guest.player.id);
    assert.equal(claims.callsign, guest.player.callsign);
    assert.ok(claims.ship_attributes.max_hull_hp);

    const chained = await refresh(next.refreshToken);
    assert.equal(chained.statusCode, 200);
  });

  test('reusing a rotated refresh token revokes the whole family and its session', async () => {
    const guest = await newGuest();
    const second = json(await refresh(guest.refreshToken));
    const third = json(await refresh(second.refreshToken));

    const replay = await refresh(guest.refreshToken); // first token, already rotated
    assert.equal(replay.statusCode, 401);
    assert.equal(json(replay).error, 'refresh_token_reused');

    // The legitimate holder's newest token is dead too, and the Better Auth session is gone.
    assert.equal((await refresh(third.refreshToken)).statusCode, 401);
    assert.equal(await app.prisma.authSession.count({ where: { userId: guest.player.id } }), 0);
  });

  test('concurrent use of one refresh token lets at most one request through and revokes the family', async () => {
    const guest = await newGuest();
    const results = await Promise.all(Array.from({ length: 4 }, () => refresh(guest.refreshToken)));
    assert.ok(results.every((r) => [200, 401].includes(r.statusCode)), results.map((r) => r.body).join('\n'));
    assert.ok(results.filter((r) => r.statusCode === 200).length <= 1);
    assert.ok(results.filter((r) => r.statusCode === 401).length >= 3);
    // Whatever the interleaving, the reuse is detected and no token of the family still works.
    for (const winner of results.filter((r) => r.statusCode === 200)) {
      assert.equal((await refresh(json(winner).refreshToken)).statusCode, 401);
    }
    assert.equal(await app.prisma.authSession.count({ where: { userId: guest.player.id } }), 0);
  });

  test('rejects unknown and expired refresh tokens', async () => {
    assert.equal((await refresh(randomBytes(32).toString('base64url'))).statusCode, 401);

    const guest = await newGuest();
    await app.prisma.refreshToken.updateMany({
      where: { playerId: guest.player.id },
      data: { expiresAt: new Date(Date.now() - 1000) }
    });
    const res = await refresh(guest.refreshToken);
    assert.equal(res.statusCode, 401);
    assert.equal(json(res).error, 'invalid_refresh_token');
  });

  test('stores only a hash of the refresh token', async () => {
    const guest = await newGuest();
    const rows = await app.prisma.refreshToken.findMany({ where: { playerId: guest.player.id } });
    assert.equal(rows.length, 1);
    assert.notEqual(rows[0].tokenHash, guest.refreshToken);
    assert.equal(rows[0].tokenHash, createHash('sha256').update(guest.refreshToken).digest('hex'));
  });

  test('logout ends the login', async () => {
    const guest = await newGuest();
    const out = await app.inject({ method: 'POST', url: '/auth/logout', payload: { refreshToken: guest.refreshToken } });
    assert.equal(out.statusCode, 200);
    assert.equal((await refresh(guest.refreshToken)).statusCode, 401);
    assert.equal(await app.prisma.authSession.count({ where: { userId: guest.player.id } }), 0);
  });

  test('a password login and a resumed guest login each get their own refresh family', async () => {
    const pilot = await newPilot('Refresher');
    const login = json(await app.inject({
      method: 'POST', url: '/auth/login', headers: attestationHeaders, payload: { email: pilot.email, password: PASSWORD, deviceId: 'login-test-device-id' }
    }));
    assert.equal((await refresh(login.refreshToken)).statusCode, 200);

    const guest = await newGuest();
    const relaunch = json(await guestLogin(guest.deviceId));
    assert.equal((await refresh(guest.refreshToken)).statusCode, 200);
    assert.equal((await refresh(relaunch.refreshToken)).statusCode, 200);
  });

  test('refresh stops when the Better Auth session itself expires', async () => {
    const guest = await newGuest();
    await app.prisma.authSession.updateMany({
      where: { userId: guest.player.id },
      data: { expiresAt: new Date(Date.now() - 1000) }
    });
    assert.equal((await refresh(guest.refreshToken)).statusCode, 401);
  });
});

describe('token lifetime', () => {
  test('a ship upgrade reissue keeps the original expiry instead of extending the login', async () => {
    const guest = await newPilot('Reissue'); // a guest could not upgrade the hull
    await setCredits(guest, 100_000);
    // A token with a distinctive expiry, well short of a freshly minted one.
    const { iat, exp, ...claims } = app.jwt.verify(guest.token);
    const exp5min = Math.floor(Date.now() / 1000) + 300;
    const token = app.signWithExpiry({ ...claims, exp: exp5min });

    const res = await call({ headers: { authorization: `Bearer ${token}` } }, 'POST', '/ship/upgrade', {
      componentType: 'HULL', targetTier: 2
    });
    assert.equal(res.statusCode, 200, res.body);
    const reissued = app.jwt.verify(json(res).token);
    assert.equal(reissued.exp, exp5min);
    assert.equal(reissued.sub, guest.id);
    assert.equal(decodeHeader(json(res).token).kid, app.jwks.keys[0].kid);
  });
});

describe('device attestation', () => {
  // Guests are only ever created by this file, so the count is not disturbed by other test files.
  const countPlayers = () => app.prisma.player.count({ where: { isAnonymous: true } });
  const login = (headers) => app.inject({
    method: 'POST', url: '/auth/login', headers, payload: { email: 'nobody@example.test', password: PASSWORD, deviceId: 'login-test-device-id' }
  });
  const withToken = (token, platform = 'play-integrity') => ({
    'x-attestation-platform': platform, 'x-attestation-token': token
  });

  test('guest and login are refused without attestation, and a refused guest creates nothing', async () => {
    const before = await countPlayers();
    const res = await guestLogin(newDeviceId(), {});
    assert.equal(res.statusCode, 403);
    assert.equal(json(res).error, 'attestation_required');
    assert.equal(await countPlayers(), before);

    const loginRes = await login({});
    assert.equal(loginRes.statusCode, 403);
    assert.equal(json(loginRes).error, 'attestation_required');
  });

  test('a token the verifier rejects is refused', async () => {
    const before = await countPlayers();
    const res = await guestLogin(newDeviceId(), withToken('emulator-token'));
    assert.equal(res.statusCode, 403);
    assert.equal(json(res).error, 'attestation_failed');
    assert.equal(json(await login(withToken('emulator-token'))).error, 'attestation_failed');
    assert.equal(await countPlayers(), before);
  });

  test('a platform with no verifier is refused', async () => {
    const res = await guestLogin(newDeviceId(), withToken(GOOD_ATTESTATION, 'app-attest'));
    assert.equal(res.statusCode, 403);
    assert.equal(json(res).error, 'attestation_platform_unsupported');
    assert.equal((await guestLogin(newDeviceId(), withToken(GOOD_ATTESTATION, 'made-up'))).statusCode, 403);
  });

  test('a verifier that throws refuses the request instead of letting it through', async () => {
    const server = Fastify();
    await server.register(attestationPlugin, {
      development: false,
      verifiers: [{ platform: 'play-integrity', verify: async () => { throw new Error('upstream down'); } }]
    });
    server.post('/guarded', { preHandler: server.requireAttestation }, async () => ({ ok: true }));
    await server.ready();
    const res = await server.inject({ method: 'POST', url: '/guarded', headers: withToken('anything'), payload: {} });
    assert.equal(res.statusCode, 403);
    assert.equal(json(res).error, 'attestation_failed');
    await server.close();
  });

  test('with no verifier configured, requests are refused outside development and allowed in development', async () => {
    const build = async (development) => {
      const server = Fastify();
      await server.register(attestationPlugin, { development });
      server.post('/guarded', { preHandler: server.requireAttestation }, async () => ({ ok: true }));
      await server.ready();
      return server;
    };
    const strict = await build(false);
    const refused = await strict.inject({ method: 'POST', url: '/guarded', headers: withToken('anything'), payload: {} });
    assert.equal(refused.statusCode, 503);
    assert.equal(json(refused).error, 'attestation_unavailable');
    await strict.close();

    const dev = await build(true);
    assert.equal((await dev.inject({ method: 'POST', url: '/guarded', payload: {} })).statusCode, 200);
    await dev.close();
  });

  test('registering an unknown platform or a verifier without verify() is rejected', async () => {
    const server = Fastify();
    await server.register(attestationPlugin, { development: false });
    await server.ready();
    assert.throws(() => server.attestation.register({ platform: 'nope', verify: async () => ({ ok: true }) }), /Unknown attestation platform/);
    assert.throws(() => server.attestation.register({ platform: 'app-attest' }), /verify\(\)/);
    await server.close();
  });

  test('refresh, logout and linking do not need a fresh attestation', async () => {
    const guest = await newGuest();
    assert.equal((await refresh(guest.refreshToken)).statusCode, 200);
  });

  describe('Play Integrity policy', () => {
    const packageName = 'test.eotha.game';
    const deviceId = 'device-id-for-the-policy-test';
    const nonce = createHash('sha256').update(deviceId).digest('base64url');
    const now = 1_800_000_000_000;
    const payload = (patch = {}) => ({
      requestDetails: { requestPackageName: packageName, nonce, timestampMillis: String(now - 1000) },
      appIntegrity: { appRecognitionVerdict: 'PLAY_RECOGNIZED' },
      deviceIntegrity: { deviceRecognitionVerdict: ['MEETS_DEVICE_INTEGRITY'] },
      ...patch
    });
    const verify = (decoded, id = deviceId) =>
      createPlayIntegrityVerifier({ packageName, decode: async () => decoded, now: () => now })
        .verify({ token: 't', deviceId: id });

    test('accepts a recognized app on a certified device', async () => {
      assert.deepEqual(await verify(payload()), { ok: true });
    });

    test('refuses a tampered app, an uncertified device, another package, a stale or foreign nonce', async () => {
      const bad = [
        payload({ appIntegrity: { appRecognitionVerdict: 'UNRECOGNIZED_VERSION' } }),
        payload({ deviceIntegrity: { deviceRecognitionVerdict: [] } }),
        payload({ deviceIntegrity: {} }),
        payload({ requestDetails: { requestPackageName: 'other.app', nonce, timestampMillis: String(now) } }),
        payload({ requestDetails: { requestPackageName: packageName, nonce: 'x', timestampMillis: String(now) } }),
        payload({ requestDetails: { requestPackageName: packageName, nonce, timestampMillis: String(now - 10 * 60 * 1000) } }),
        {}
      ];
      for (const decoded of bad) assert.equal((await verify(decoded)).ok, false);
      assert.equal((await verify(payload(), 'a-different-device-id')).ok, false);
    });
  });
});

describe('JWKS', () => {
  test('publishes the Ed25519 public key that verifies issued tokens', async () => {
    const res = await app.inject({ method: 'GET', url: '/.well-known/jwks.json' });
    assert.equal(res.statusCode, 200);
    assert.match(res.headers['cache-control'], /max-age/);
    const jwks = json(res);
    assert.equal(jwks.keys.length, 1);
    const [key] = jwks.keys;
    assert.equal(key.kty, 'OKP');
    assert.equal(key.crv, 'Ed25519');
    assert.equal(key.alg, 'EdDSA');
    assert.equal(key.use, 'sig');
    assert.equal(key.d, undefined, 'private key material must never be published');

    // Same key as the PEM the RTSE pins today.
    const pem = readFileSync(join(keysDir, 'public.pem'), 'utf8');
    assert.equal(key.x, createPublicKey(pem).export({ format: 'jwk' }).x);

    const guest = await newGuest();
    assert.equal(decodeHeader(guest.token).kid, key.kid);
    const { payload } = await jwtVerify(guest.token, createLocalJWKSet(jwks));
    assert.equal(payload.sub, guest.player.id);
  });
});
