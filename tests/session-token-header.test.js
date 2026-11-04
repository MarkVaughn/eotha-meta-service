// The session JWT is accepted from Authorization: Bearer or, when no Bearer is present, from
// X-Eotha-Token (browsers behind a basic-auth tunnel cannot use Authorization). This drives the real
// security plugin on a minimal server, so it needs neither a database nor the shared test helpers.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const keysDir = mkdtempSync(join(tmpdir(), 'eotha-token-header-keys-'));
writeFileSync(join(keysDir, 'private.pem'), privateKey.export({ format: 'pem', type: 'pkcs8' }));
writeFileSync(join(keysDir, 'public.pem'), publicKey.export({ format: 'pem', type: 'spki' }));
process.env.KEYS_DIR = keysDir;
process.env.NODE_ENV = 'test';

const { default: securityPlugin } = await import('../src/plugins/security.js');

describe('session token header', () => {
  let server;
  before(async () => {
    server = Fastify();
    await server.register(securityPlugin, { keysDir });
    server.get('/whoami', { onRequest: server.authenticate }, async (request) => ({ sub: request.user.sub }));
    await server.ready();
  });
  after(async () => { await server.close(); });

  const whoami = (headers) => server.inject({ method: 'GET', url: '/whoami', headers });
  const mint = (sub, options) => server.jwt.sign({ sub }, options);

  test('Authorization: Bearer is accepted', async () => {
    const res = await whoami({ authorization: `Bearer ${mint('pilot-a')}` });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().sub, 'pilot-a');
  });

  test('X-Eotha-Token is accepted when no Bearer is present', async () => {
    const res = await whoami({ 'x-eotha-token': mint('pilot-b') });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().sub, 'pilot-b');
  });

  test('X-Eotha-Token is accepted next to a non-Bearer Authorization (basic auth)', async () => {
    const res = await whoami({ authorization: 'Basic ZGV2OnNlY3JldA==', 'x-eotha-token': mint('pilot-c') });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().sub, 'pilot-c');
  });

  test('neither header is 401', async () => {
    assert.equal((await whoami({})).statusCode, 401);
    assert.equal((await whoami({ authorization: 'Basic ZGV2OnNlY3JldA==' })).statusCode, 401);
  });

  test('an invalid X-Eotha-Token is 401', async () => {
    assert.equal((await whoami({ 'x-eotha-token': 'not-a-jwt' })).statusCode, 401);
    assert.equal((await whoami({ 'x-eotha-token': '' })).statusCode, 401);
    const tampered = mint('pilot-d').replace(/.$/, (c) => (c === 'A' ? 'B' : 'A'));
    assert.equal((await whoami({ 'x-eotha-token': tampered })).statusCode, 401);
  });

  test('an expired X-Eotha-Token is 401', async () => {
    const expired = mint('pilot-e', { expiresIn: -60 });
    assert.equal((await whoami({ 'x-eotha-token': expired })).statusCode, 401);
  });

  test('a token signed by another key in X-Eotha-Token is 401', async () => {
    const other = Fastify();
    const pair = generateKeyPairSync('ed25519');
    const dir = mkdtempSync(join(tmpdir(), 'eotha-token-header-other-'));
    writeFileSync(join(dir, 'private.pem'), pair.privateKey.export({ format: 'pem', type: 'pkcs8' }));
    writeFileSync(join(dir, 'public.pem'), pair.publicKey.export({ format: 'pem', type: 'spki' }));
    await other.register(securityPlugin, { keysDir: dir });
    await other.ready();
    const foreign = other.jwt.sign({ sub: 'intruder' });
    await other.close();
    assert.equal((await whoami({ 'x-eotha-token': foreign })).statusCode, 401);
  });

  test('Authorization wins when both are present', async () => {
    const good = mint('pilot-f');
    const both = (authorization, token) => whoami({ authorization, 'x-eotha-token': token });
    const ok = await both(`Bearer ${good}`, 'garbage');
    assert.equal(ok.statusCode, 200);
    assert.equal(ok.json().sub, 'pilot-f');
    assert.equal((await both('Bearer garbage', good)).statusCode, 401);
  });
});
