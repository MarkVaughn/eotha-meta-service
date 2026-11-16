import './google-env.js';
import { test, describe, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import {
  app, attestationHeaders, closeApp, dockedReceipt, json, setCredits, track
} from './helpers.js';
import { safeReturnTo } from '../src/lib/google-signin.js';

before(async () => { await app.ready(); });
after(async () => { await closeApp(); });

const ORIGIN = 'https://demo.eotha.com';
const REDIRECT_URI = `${ORIGIN}/api/auth/callback/google`;
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';

// The Google provider call is mocked at the network edge: Better Auth's own code builds the token
// request and reads the id token, so only Google's answer is faked.
const realFetch = globalThis.fetch;
let googleProfile;
let tokenRequests = [];
globalThis.fetch = async (input, init) => {
  const url = String(input?.url ?? input);
  if (!url.startsWith(TOKEN_ENDPOINT)) return realFetch(input, init);
  tokenRequests.push(new URLSearchParams(String(init?.body ?? new URL(url).search)));
  if (!googleProfile) return new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400, headers: { 'content-type': 'application/json' } });
  const part = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const idToken = `${part({ alg: 'RS256', kid: 'test' })}.${part({
    iss: 'https://accounts.google.com', aud: process.env.GOOGLE_CLIENT_ID, iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600, ...googleProfile
  })}.${randomBytes(8).toString('base64url')}`;
  return new Response(
    JSON.stringify({ access_token: 'ya29.test', id_token: idToken, expires_in: 3600, token_type: 'Bearer', scope: 'openid email profile' }),
    { status: 200, headers: { 'content-type': 'application/json' } }
  );
};
after(() => { globalThis.fetch = realFetch; });
afterEach(() => { googleProfile = undefined; });

const newProfile = (overrides = {}) => {
  const sub = randomUUID();
  return { sub, email: `${sub}@gmail.example.test`, email_verified: true, name: 'Ada Lovelace', picture: 'https://example.test/a.png', ...overrides };
};

const start = (body = {}, headers = {}) => app.inject({ method: 'POST', url: '/auth/google/start', headers, payload: body });
const exchange = (code) => app.inject({ method: 'POST', url: '/auth/google/exchange', payload: { code } });
const cookieHeader = (res) => res.cookies.map(({ name, value }) => `${name}=${value}`).join('; ');

/** What a browser does after /start: go to Google, consent, come back to the callback with the same cookies. */
async function visitGoogle(startRes, profile, extraQuery = {}) {
  googleProfile = profile;
  const url = new URL(json(startRes).url);
  const callback = await app.inject({
    method: 'GET',
    url: `/auth/callback/google?${new URLSearchParams({ code: 'google-auth-code', state: url.searchParams.get('state'), ...extraQuery })}`,
    headers: { cookie: cookieHeader(startRes) }
  });
  return { url, callback };
}

const fragmentOf = (res) => new URLSearchParams(new URL(res.headers.location).hash.slice(1));

/** Runs the whole flow for an anonymous browser and returns the exchanged session. */
async function signInWithGoogle(profile, body = {}) {
  const startRes = await start(body);
  assert.equal(startRes.statusCode, 200, startRes.body);
  const { callback } = await visitGoogle(startRes, profile);
  assert.equal(callback.statusCode, 302, callback.body);
  const code = fragmentOf(callback).get('eotha_auth_code');
  assert.ok(code, callback.headers.location);
  const res = await exchange(code);
  assert.equal(res.statusCode, 200, res.body);
  const session = json(res);
  track(session.player.id);
  return session;
}

const newGuest = async () => {
  const res = await app.inject({ method: 'POST', url: '/auth/guest', headers: attestationHeaders, payload: { deviceId: randomUUID() } });
  assert.equal(res.statusCode, 200, res.body);
  const session = json(res);
  track(session.player.id);
  return session;
};
const bearer = (session) => ({ authorization: `Bearer ${session.token}` });

describe('Sign in with Google: playable session', () => {
  test('a new Google player gets the default home harbor, the gateway address and 0 credits', async () => {
    const session = await signInWithGoogle(newProfile());
    assert.equal(session.created, true);
    assert.equal(session.gateway_ws_url, 'ws://localhost:8080/session');
    assert.deepEqual(session.player.spawn_point, { latitude: 37.7749, longitude: -122.4194, h3_index: '8828308281fffff' });
    assert.equal(app.jwt.verify(session.token).home_h3, '8828308281fffff');

    const row = await app.prisma.player.findUnique({ where: { id: session.player.id }, include: { harbor: true } });
    assert.equal(row.harbor.h3Index, '8828308281fffff');
    assert.equal(row.credits, 0);
  });
});

describe('Sign in with Google: start', () => {
  test('hands back the Google consent URL whose redirect URI is the public base URL plus /auth/callback/google', async () => {
    const res = await start();
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.headers['cache-control'], 'no-store');
    const url = new URL(json(res).url);
    assert.equal(url.origin + url.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
    assert.equal(url.searchParams.get('redirect_uri'), REDIRECT_URI);
    assert.equal(url.searchParams.get('client_id'), process.env.GOOGLE_CLIENT_ID);
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    assert.ok(url.searchParams.get('state'));
    assert.match(url.searchParams.get('scope'), /openid/);
    assert.ok(res.cookies.length > 0, 'Better Auth state cookie is set for the browser');
    assert.ok(res.cookies.every(({ httpOnly }) => httpOnly));
  });

  test('accepts an empty body and refuses a returnTo that is not a same-origin path', async () => {
    assert.equal((await app.inject({ method: 'POST', url: '/auth/google/start' })).statusCode, 200);
    for (const returnTo of ['https://evil.example/', '//evil.example', '/\\evil.example', 'javascript:alert(1)', 'relative']) {
      const res = await start({ returnTo });
      assert.equal(res.statusCode, 400, returnTo);
      assert.equal(json(res).error, 'invalid_return_to');
    }
  });

  test('rejects an invalid access token rather than silently starting an unlinked sign-in', async () => {
    const res = await start({}, { authorization: 'Bearer not-a-token' });
    assert.equal(res.statusCode, 401);
  });
});

describe('Sign in with Google: new and returning players', () => {
  test('a new Google user gets a player and a session shaped like the login response', async () => {
    const profile = newProfile();
    const session = await signInWithGoogle(profile);

    assert.deepEqual(Object.keys(session).sort(), ['created', 'expiresIn', 'gateway_ws_url', 'player', 'refreshToken', 'token']);
    assert.equal(session.created, true);
    assert.equal(session.player.anonymous, false);
    assert.match(session.player.callsign, /^Pilot-[0-9a-f]{12}$/, 'the callsign is never taken from the Google profile');
    const claims = app.jwt.verify(session.token);
    assert.equal(claims.sub, session.player.id);
    assert.equal(claims.callsign, session.player.callsign);
    assert.equal(claims.ship_attributes.hull_tier, 1);

    const row = await app.prisma.player.findUnique({ where: { id: session.player.id }, include: { accounts: true } });
    assert.equal(row.email, profile.email);
    assert.equal(row.isAnonymous, false);
    assert.equal(row.passwordHash, '!');
    assert.deepEqual(row.accounts.map(({ providerId, accountId }) => [providerId, accountId]), [['google', profile.sub]]);

    assert.equal(tokenRequests.at(-1).get('redirect_uri'), REDIRECT_URI);
    assert.equal(tokenRequests.at(-1).get('code'), 'google-auth-code');
  });

  test('the refresh token from the exchange renews the login', async () => {
    const session = await signInWithGoogle(newProfile());
    const res = await app.inject({ method: 'POST', url: '/auth/refresh', payload: { refreshToken: session.refreshToken } });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(json(res).player.id, session.player.id);
  });

  test('a returning Google user resolves to the same player, even from a new browser', async () => {
    const profile = newProfile();
    const first = await signInWithGoogle(profile);
    const second = await signInWithGoogle(profile);
    assert.equal(second.player.id, first.player.id);
    assert.equal(second.created, false);
    assert.equal(second.player.callsign, first.player.callsign);
    assert.notEqual(second.refreshToken, first.refreshToken);
    assert.equal(await app.prisma.account.count({ where: { providerId: 'google', accountId: profile.sub } }), 1);
  });

  test('the browser is returned to the client with the code in the fragment, and no Better Auth session cookie', async () => {
    const startRes = await start();
    const { callback } = await visitGoogle(startRes, newProfile());
    const location = new URL(callback.headers.location);
    assert.equal(location.origin + location.pathname, `${ORIGIN}/`);
    assert.equal(location.search, '');
    assert.ok(location.hash.startsWith('#eotha_auth_code='));
    assert.equal(callback.headers['referrer-policy'], 'no-referrer');
    assert.equal(callback.headers['cache-control'], 'no-store');
    assert.ok(callback.cookies.every(({ name, value }) => !/session/.test(name) || value === ''), 'no session cookie is handed to the browser');
    const player = await app.prisma.account.findFirst({ where: { providerId: 'google' }, orderBy: { createdAt: 'desc' } });
    track(player.userId);
    assert.equal(await app.prisma.authSession.count({ where: { userId: player.userId } }), 0, 'the callback session is removed; the exchange starts the real one');
  });

  test('returnTo carries a same-origin path and query back to the client', async () => {
    const startRes = await start({ returnTo: '/play/index.html?lang=en#ignored' });
    const { callback } = await visitGoogle(startRes, newProfile());
    const location = new URL(callback.headers.location);
    assert.equal(location.pathname, '/play/index.html');
    assert.equal(location.search, '?lang=en');
    assert.ok(fragmentOf(callback).get('eotha_auth_code'));
    const session = json(await exchange(fragmentOf(callback).get('eotha_auth_code')));
    track(session.player.id);
  });

  test('a Google sign-in never attaches itself to an existing player by matching email', async () => {
    const email = `${randomUUID()}@gmail.example.test`;
    const existing = await app.inject({
      method: 'POST', url: '/auth/register',
      payload: { email, password: 'correct-horse-battery', callsign: `Reg-${randomBytes(4).toString('hex')}`, latitude: 1, longitude: 2, h3Index: '8828308281fffff' }
    });
    assert.equal(existing.statusCode, 201, existing.body);
    track(json(existing).id);

    const startRes = await start();
    const { callback } = await visitGoogle(startRes, newProfile({ email }));
    assert.equal(callback.statusCode, 302);
    assert.ok(fragmentOf(callback).get('eotha_auth_error'), callback.headers.location);
    assert.equal(fragmentOf(callback).get('eotha_auth_code'), null);
    assert.equal(await app.prisma.account.count({ where: { userId: json(existing).id } }), 0);
  });
});

describe('Sign in with Google: one-time code', () => {
  test('is single use', async () => {
    const startRes = await start();
    const { callback } = await visitGoogle(startRes, newProfile());
    const code = fragmentOf(callback).get('eotha_auth_code');
    const first = await exchange(code);
    assert.equal(first.statusCode, 200);
    track(json(first).player.id);
    const second = await exchange(code);
    assert.equal(second.statusCode, 401);
    assert.equal(json(second).error, 'invalid_code');
  });

  test('concurrent exchanges of one code yield exactly one session', async () => {
    const startRes = await start();
    const { callback } = await visitGoogle(startRes, newProfile());
    const code = fragmentOf(callback).get('eotha_auth_code');
    const results = await Promise.all([exchange(code), exchange(code), exchange(code)]);
    assert.deepEqual(results.map((r) => r.statusCode).sort(), [200, 401, 401]);
    track(json(results.find((r) => r.statusCode === 200)).player.id);
  });

  test('expires, and an unknown code is refused', async () => {
    const startRes = await start();
    const { callback } = await visitGoogle(startRes, newProfile());
    const code = fragmentOf(callback).get('eotha_auth_code');
    await app.prisma.verification.updateMany({
      where: { identifier: { startsWith: 'eotha-google-code:' } }, data: { expiresAt: new Date(Date.now() - 1000) }
    });
    assert.equal((await exchange(code)).statusCode, 401);
    assert.equal((await exchange('nope')).statusCode, 401);
    const player = await app.prisma.account.findFirst({ where: { providerId: 'google' }, orderBy: { createdAt: 'desc' } });
    track(player.userId);
  });

  test('the stored record is a hash of the code, never the code', async () => {
    const startRes = await start();
    const { callback } = await visitGoogle(startRes, newProfile());
    const code = fragmentOf(callback).get('eotha_auth_code');
    const rows = await app.prisma.verification.findMany({ where: { identifier: { startsWith: 'eotha-google-code:' } } });
    assert.ok(rows.length > 0);
    assert.ok(rows.every((row) => !row.identifier.includes(code) && !row.value.includes(code)));
    const player = await app.prisma.account.findFirst({ where: { providerId: 'google' }, orderBy: { createdAt: 'desc' } });
    track(player.userId);
  });
});

describe('Sign in with Google: callback failures', () => {
  test('a provider error returns the browser to the client with the error, and no code', async () => {
    const startRes = await start({ returnTo: '/lobby' });
    const url = new URL(json(startRes).url);
    const callback = await app.inject({
      method: 'GET',
      url: `/auth/callback/google?${new URLSearchParams({ error: 'access_denied', state: url.searchParams.get('state') })}`,
      headers: { cookie: cookieHeader(startRes) }
    });
    assert.equal(callback.statusCode, 302);
    const location = new URL(callback.headers.location);
    assert.equal(location.pathname, '/lobby');
    assert.equal(fragmentOf(callback).get('eotha_auth_error'), 'access_denied');
    assert.equal(fragmentOf(callback).get('eotha_auth_code'), null);
  });

  test('a callback without the browser that started it (no state cookie) is refused', async () => {
    const startRes = await start();
    const url = new URL(json(startRes).url);
    googleProfile = newProfile();
    const callback = await app.inject({
      method: 'GET', url: `/auth/callback/google?${new URLSearchParams({ code: 'x', state: url.searchParams.get('state') })}`
    });
    assert.equal(callback.statusCode, 302);
    assert.ok(fragmentOf(callback).get('eotha_auth_error'));
    assert.equal(fragmentOf(callback).get('eotha_auth_code'), null);
  });

  test('a callback with no state, or a failed code exchange with Google, is refused', async () => {
    const bare = await app.inject({ method: 'GET', url: '/auth/callback/google?code=x' });
    assert.equal(bare.statusCode, 302);
    assert.ok(fragmentOf(bare).get('eotha_auth_error'));

    const startRes = await start();
    const { callback } = await visitGoogle(startRes, undefined);
    assert.ok(fragmentOf(callback).get('eotha_auth_error'));
    assert.equal(fragmentOf(callback).get('eotha_auth_code'), null);
  });
});

describe('Sign in with Google: linking a guest in place', () => {
  test('keeps the player id, ship and progress, and lifts the guest hull lock', async () => {
    const guest = await newGuest();
    await setCredits({ id: guest.player.id }, 100_000);
    const upgrade = (session, componentType, targetTier) => app.inject({
      method: 'POST', url: '/ship/upgrade', headers: bearer(session),
      payload: { componentType, targetTier, dockedReceipt: dockedReceipt(session) }
    });
    assert.equal(json(await upgrade(guest, 'HULL', 2)).code, 'guest_hull_locked');
    // Subsystem upgrades are bounded by the hull tier, so give the guest a tier 2 hull directly.
    const { ship_id: shipId } = json(await app.inject({ method: 'GET', url: '/ship/loadout', headers: bearer(guest) }));
    await app.prisma.shipComponentRecord.upsert({
      where: { spaceshipId_type: { spaceshipId: shipId, type: 'HULL' } },
      update: { tier: 2 },
      create: { spaceshipId: shipId, type: 'HULL', tier: 2 }
    });
    const radar = await upgrade(guest, 'RADAR', 2);
    assert.equal(radar.statusCode, 200, radar.body);
    const before = await app.prisma.player.findUnique({ where: { id: guest.player.id }, include: { spaceships: { include: { components: true } } } });

    const profile = newProfile();
    const startRes = await start({}, bearer(guest));
    assert.equal(startRes.statusCode, 200, startRes.body);
    assert.equal(await app.prisma.authSession.count({ where: { userId: guest.player.id } }), 1, 'the temporary link session is removed');
    const { callback } = await visitGoogle(startRes, profile);
    const code = fragmentOf(callback).get('eotha_auth_code');
    assert.ok(code, callback.headers.location);
    const res = await exchange(code);
    assert.equal(res.statusCode, 200, res.body);
    const session = json(res);

    assert.equal(session.player.id, guest.player.id);
    assert.equal(session.player.anonymous, false);
    assert.equal(session.player.callsign, guest.player.callsign);
    assert.equal(session.created, false);
    assert.equal(app.jwt.verify(session.token).sub, guest.player.id);

    const after = await app.prisma.player.findUnique({ where: { id: guest.player.id }, include: { spaceships: { include: { components: true } }, accounts: true } });
    assert.equal(after.isAnonymous, false);
    assert.equal(after.credits, before.credits);
    assert.deepEqual(after.spaceships.map((s) => s.id), before.spaceships.map((s) => s.id));
    assert.deepEqual(after.accounts.map((a) => [a.providerId, a.accountId]), [['google', profile.sub]]);
    assert.equal(await app.prisma.guestDevice.count({ where: { playerId: guest.player.id } }), 1);

    // The hull lock lifts at once, even for the token issued while still a guest.
    const hull = await upgrade(guest, 'HULL', 3);
    assert.equal(hull.statusCode, 200, hull.body);
    const kept = await app.prisma.shipComponentRecord.findMany({ where: { spaceshipId: shipId } });
    assert.equal(kept.find((c) => c.type === 'RADAR').tier, 2, 'the guest\'s earlier upgrade survives the link');

    // And the same Google account signs the same player in from another browser.
    const again = await signInWithGoogle(profile);
    assert.equal(again.player.id, guest.player.id);
  });

  test('an already-linked player cannot start a link, and a Google account on another player is refused', async () => {
    const taken = newProfile();
    const owner = await signInWithGoogle(taken);
    const ownerStart = await start({}, bearer(owner));
    assert.equal(ownerStart.statusCode, 409);
    assert.equal(json(ownerStart).error, 'already_linked');

    const guest = await newGuest();
    const startRes = await start({}, bearer(guest));
    const { callback } = await visitGoogle(startRes, taken);
    assert.ok(fragmentOf(callback).get('eotha_auth_error'), callback.headers.location);
    assert.equal(fragmentOf(callback).get('eotha_auth_code'), null);
    const row = await app.prisma.player.findUnique({ where: { id: guest.player.id } });
    assert.equal(row.isAnonymous, true, 'the guest is untouched');
  });

  test('a stale guest link cannot be replayed by a browser that lacks the start cookies', async () => {
    const guest = await newGuest();
    const startRes = await start({}, bearer(guest));
    const url = new URL(json(startRes).url);
    googleProfile = newProfile();
    const callback = await app.inject({
      method: 'GET', url: `/auth/callback/google?${new URLSearchParams({ code: 'x', state: url.searchParams.get('state') })}`
    });
    assert.equal(fragmentOf(callback).get('eotha_auth_code'), null);
    assert.equal((await app.prisma.player.findUnique({ where: { id: guest.player.id } })).isAnonymous, true);
  });
});

describe('safeReturnTo', () => {
  test('keeps same-origin paths and refuses everything else', () => {
    assert.equal(safeReturnTo(undefined, ORIGIN), '/');
    assert.equal(safeReturnTo('/', ORIGIN), '/');
    assert.equal(safeReturnTo('/a/b?c=d#e', ORIGIN), '/a/b?c=d');
    for (const bad of ['//x.test', '/\\x.test', 'https://x.test/', 'x', '/a\nb', `/${'a'.repeat(600)}`, 5]) {
      assert.equal(safeReturnTo(bad, ORIGIN), null, String(bad));
    }
  });
});
