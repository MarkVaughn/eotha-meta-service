import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync, randomUUID } from 'node:crypto';

// NODE_ENV is read once at import, so each production scenario boots the app in its own process.
const keysDir = mkdtempSync(join(tmpdir(), 'eotha-prod-keys-'));
const pair = generateKeyPairSync('ed25519');
writeFileSync(join(keysDir, 'private.pem'), pair.privateKey.export({ format: 'pem', type: 'pkcs8' }));
writeFileSync(join(keysDir, 'public.pem'), pair.publicKey.export({ format: 'pem', type: 'spki' }));

const dbName = new URL(process.env.DATABASE_URL ?? 'postgresql://localhost/').pathname.slice(1);
if (!dbName.endsWith('_test')) throw new Error(`Refusing to run against database "${dbName}": it must end in _test.`);

const script = `
  const { default: app } = await import('./src/app.js');
  await app.ready();
  const out = {};
  const call = async (key, opts) => {
    const res = await app.inject(opts);
    out[key] = { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
    return out[key].body;
  };
  await call('devLogin', { method: 'GET', url: '/auth/dev-login' });
  await call('devPassengers', { method: 'POST', url: '/ship/dev/passengers', payload: { passengersAboard: 1 } });
  const guest = await call('guest', { method: 'POST', url: '/auth/guest', payload: { deviceId: process.env.TEST_DEVICE_ID } });
  if (out.guest.status === 200) {
    const bearer = { authorization: 'Bearer ' + guest.token };
    await call('refresh', { method: 'POST', url: '/auth/refresh', payload: { refreshToken: guest.refreshToken } });
    await call('googleLink', { method: 'POST', url: '/auth/google/start', headers: bearer, payload: {} });
    await call('linkEmail', { method: 'POST', url: '/auth/link/email', headers: bearer, payload: { email: process.env.TEST_DEVICE_ID + '@example.test', password: 'correct-horse-battery' } });
    await app.prisma.player.deleteMany({ where: { id: guest.player.id } });
  }
  await app.close();
  console.log('RESULT ' + JSON.stringify(out));
`;

function runProduction(extraEnv = {}) {
  const env = {
    ...process.env, NODE_ENV: 'production', KEYS_DIR: keysDir, TEST_DEVICE_ID: randomUUID(),
    ALLOW_UNATTESTED_SIGNIN: '', GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '', BETTER_AUTH_URL: '', ...extraEnv
  };
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: new URL('..', import.meta.url), env, encoding: 'utf8', timeout: 60_000 });
  const line = run.stdout.split('\n').find((l) => l.startsWith('RESULT '));
  assert.ok(line, `production app did not finish:\n${run.stdout}\n${run.stderr}`);
  return JSON.parse(line.slice('RESULT '.length));
}

describe('NODE_ENV=production', () => {
  const demo = { ALLOW_UNATTESTED_SIGNIN: 'true', GOOGLE_CLIENT_ID: 'id.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'secret', BETTER_AUTH_URL: 'https://demo.eotha.com/api' };

  test('turns the dev login and the dev passenger route off, and strict attestation refuses guests by default', () => {
    const result = runProduction();
    assert.equal(result.devLogin.status, 404);
    assert.equal(result.devPassengers.status, 404);
    assert.equal(result.guest.status, 503);
    assert.equal(result.guest.body.error, 'attestation_unavailable');
  });

  test('a demo with ALLOW_UNATTESTED_SIGNIN and Google configured starts guests, refreshes them and links them in place', () => {
    const result = runProduction(demo);
    assert.equal(result.devLogin.status, 404);
    assert.equal(result.guest.status, 200, JSON.stringify(result.guest));
    assert.equal(result.guest.body.player.anonymous, true);
    assert.equal(result.refresh.status, 200);
    assert.equal(result.googleLink.status, 200, JSON.stringify(result.googleLink));
    assert.equal(new URL(result.googleLink.body.url).searchParams.get('redirect_uri'), 'https://demo.eotha.com/api/auth/callback/google');
    assert.equal(result.linkEmail.status, 200, JSON.stringify(result.linkEmail));
    assert.equal(result.linkEmail.body.player.anonymous, false);
  });

  test('refuses to start with half of the Google credentials, or Google without a public base URL', () => {
    const boot = (extra) => spawnSync(process.execPath, ['--input-type=module', '-e', "await import('./src/config/env.js')"], {
      cwd: new URL('..', import.meta.url), encoding: 'utf8',
      env: { ...process.env, NODE_ENV: 'production', GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '', BETTER_AUTH_URL: '', ...extra }
    });
    const half = boot({ GOOGLE_CLIENT_ID: 'only-an-id' });
    assert.notEqual(half.status, 0);
    assert.match(half.stderr, /must be set together/);
    const noBase = boot({ GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 'secret' });
    assert.notEqual(noBase.status, 0);
    assert.match(noBase.stderr, /BETTER_AUTH_URL/);
    assert.equal(boot({ GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 'secret', BETTER_AUTH_URL: 'https://demo.eotha.com/api' }).status, 0);
    assert.equal(boot({}).status, 0);
  });
});
