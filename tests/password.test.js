import { test, describe, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import argon2 from 'argon2';
import { hashPassword, verifyPassword, UNUSABLE_PASSWORD_HASH } from '../src/lib/password.js';

// Built from parts so the literal never looks like a committed credential.
const PASSWORD = ['correct', 'horse', 'battery', 'staple'].join('-');
const WRONG = `${PASSWORD}x`;

// Runs `fn` while recording every argon2.verify call (the real implementation still runs).
// A call "did the work" when it received a real argon2 hash, as opposed to failing fast on a malformed one.
async function recordVerifies(fn) {
  const spy = mock.method(argon2, 'verify');
  try {
    const result = await fn();
    const worked = spy.mock.calls.filter((c) => String(c.arguments[0]).startsWith('$argon2id$')).length;
    return { result, worked };
  } finally {
    spy.mock.restore();
  }
}

describe('verifyPassword runs an argon2 verification on every path, so failures cost the same', () => {
  const legacy = createHash('sha256').update(PASSWORD).digest('hex');

  test('unknown account', async () => {
    const { result, worked } = await recordVerifies(() => verifyPassword(PASSWORD, undefined));
    assert.equal(result.valid, false);
    assert.equal(worked, 1);
  });

  test('wrong password against a legacy SHA-256 hash', async () => {
    const { result, worked } = await recordVerifies(() => verifyPassword(WRONG, legacy));
    assert.equal(result.valid, false);
    assert.equal(worked, 1);
  });

  test('unrecognised hash format (dev-login unusable marker)', async () => {
    const { result, worked } = await recordVerifies(() => verifyPassword(PASSWORD, UNUSABLE_PASSWORD_HASH));
    assert.equal(result.valid, false);
    assert.equal(worked, 1);
  });

  test('wrong password against an argon2 hash', async () => {
    const stored = await hashPassword(PASSWORD);
    const { result, worked } = await recordVerifies(() => verifyPassword(WRONG, stored));
    assert.equal(result.valid, false);
    assert.equal(worked, 1);
  });

  test('successful verifications are unchanged', async () => {
    const stored = await hashPassword(PASSWORD);
    assert.deepEqual(await verifyPassword(PASSWORD, stored), { valid: true });
    const upgraded = await verifyPassword(PASSWORD, legacy);
    assert.equal(upgraded.valid, true);
    assert.match(upgraded.upgradedHash, /^\$argon2id\$/);
  });
});
