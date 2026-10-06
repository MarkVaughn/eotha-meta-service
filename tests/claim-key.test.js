import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { createPublicKey, generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Writable } from 'node:stream';
import Fastify from 'fastify';
import { closeApp, loginKey, keysDir } from './helpers.js';
import { ClaimKeyError, claimKeyFingerprint, loadClaimPublicKey } from '../src/lib/claim-key.js';
import claimKeyPlugin from '../src/plugins/claim-key.js';

after(closeApp);

const rawHex = (publicKey) => publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex');
const scratch = mkdtempSync(join(tmpdir(), 'eotha-claim-key-'));
const write = (name, content) => {
  const path = join(scratch, name);
  writeFileSync(path, content);
  return path;
};
const pair = generateKeyPairSync('ed25519');
const other = generateKeyPairSync('ed25519');

describe('claim public key loading', () => {
  test('is absent when nothing is configured', () => {
    assert.equal(loadClaimPublicKey({}), null);
  });

  test('reads 64 hex characters, from the environment or a file, or a PEM public key from a file', () => {
    const hex = rawHex(pair.publicKey);
    const fromEnv = loadClaimPublicKey({ CLAIM_PUBLIC_KEY: hex });
    assert.equal(fromEnv.key.asymmetricKeyType, 'ed25519');
    assert.equal(fromEnv.fingerprint, claimKeyFingerprint(pair.publicKey));
    assert.match(fromEnv.fingerprint, /^[0-9a-f]{16}$/);

    const fromHexFile = loadClaimPublicKey({ CLAIM_PUBLIC_KEY_FILE: write('claim.hex', `${hex}\n`) });
    const pem = pair.publicKey.export({ format: 'pem', type: 'spki' });
    const fromPemFile = loadClaimPublicKey({ CLAIM_PUBLIC_KEY_FILE: write('claim.pem', pem) });
    assert.equal(fromHexFile.fingerprint, fromEnv.fingerprint);
    assert.equal(fromPemFile.fingerprint, fromEnv.fingerprint);
  });

  test('refuses a file that is unreadable, is not a key, or holds a private key', () => {
    assert.throws(() => loadClaimPublicKey({ CLAIM_PUBLIC_KEY_FILE: join(scratch, 'missing') }), ClaimKeyError);
    assert.throws(() => loadClaimPublicKey({ CLAIM_PUBLIC_KEY_FILE: write('junk', 'not a key') }), ClaimKeyError);
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ format: 'pem', type: 'spki' });
    assert.throws(() => loadClaimPublicKey({ CLAIM_PUBLIC_KEY_FILE: write('rsa.pem', rsa) }), ClaimKeyError);
  });

  test('refuses an environment key and a file that name different keys', () => {
    const file = write('other.hex', rawHex(other.publicKey));
    assert.throws(
      () => loadClaimPublicKey({ CLAIM_PUBLIC_KEY: rawHex(pair.publicKey), CLAIM_PUBLIC_KEY_FILE: file }),
      /different keys/
    );
    const same = write('same.hex', rawHex(pair.publicKey));
    assert.ok(loadClaimPublicKey({ CLAIM_PUBLIC_KEY: rawHex(pair.publicKey), CLAIM_PUBLIC_KEY_FILE: same }));
  });

  test('the login key is a different key from the test claim key, and keys/public.pem is never consulted', () => {
    const configured = loadClaimPublicKey({ CLAIM_PUBLIC_KEY: process.env.CLAIM_PUBLIC_KEY });
    assert.notEqual(configured.fingerprint, claimKeyFingerprint(createPublicKey(loginKey)));
    assert.equal(loadClaimPublicKey({ KEYS_DIR: keysDir }), null);
  });
});

describe('environment validation', () => {
  const load = (vars) =>
    spawnSync(process.execPath, ['--input-type=module', '-e', "await import('./src/config/env.js')"], {
      env: { PATH: process.env.PATH, NODE_ENV: 'test', ...vars },
      encoding: 'utf8'
    });

  test('rejects a CLAIM_PUBLIC_KEY that is not 64 hex characters', () => {
    for (const bad of ['abc', 'z'.repeat(64), 'a'.repeat(63), 'a'.repeat(66)]) {
      const run = load({ CLAIM_PUBLIC_KEY: bad });
      assert.equal(run.status, 1, bad);
      assert.match(run.stderr, /CLAIM_PUBLIC_KEY/);
    }
  });

  test('accepts a valid key, and treats an empty variable as unset', () => {
    assert.equal(load({ CLAIM_PUBLIC_KEY: rawHex(pair.publicKey) }).status, 0);
    assert.equal(load({ CLAIM_PUBLIC_KEY: '', CLAIM_PUBLIC_KEY_FILE: '' }).status, 0);
  });
});

describe('claim key plugin', () => {
  async function boot(opts) {
    const lines = [];
    const stream = new Writable({ write(chunk, _enc, done) { lines.push(chunk.toString()); done(); } });
    const server = Fastify({ logger: { level: 'info', stream } });
    await server.register(claimKeyPlugin, opts);
    await server.ready();
    return { server, log: lines.join('') };
  }

  test('logs the fingerprint of the verification key and never the key itself', async () => {
    const claimKey = loadClaimPublicKey({ CLAIM_PUBLIC_KEY: rawHex(pair.publicKey) });
    const { server, log } = await boot({ claimKey });
    assert.ok(log.includes(`sha256:${claimKey.fingerprint}`));
    assert.ok(!log.includes(rawHex(pair.publicKey)));
    assert.equal(server.claimKey, claimKey);
  });

  test('warns that claims are refused when no key is configured', async () => {
    const { server, log } = await boot({ claimKey: null });
    assert.equal(server.claimKey, null);
    assert.match(log, /CLAIM_KEY_NOT_CONFIGURED/);
  });
});
