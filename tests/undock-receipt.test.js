import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign } from 'node:crypto';
import Fastify from 'fastify';
import { UNDOCK_RECEIPT_MAX_SKEW_MS, UNDOCK_RECEIPT_TTL_MS } from '../src/config/docking.js';
import {
  UNDOCK_RECEIPT_DOMAIN,
  canonicalUndockReceiptPayload,
  isUndockReceiptFresh,
  undockReceiptNonceKey,
  undockReceiptSchema,
  verifyUndockReceipt
} from '../src/lib/undock-receipt.js';

// The fixed vectors from eotha-contracts `scripts/check-undock-receipt-vector.js`: Ed25519 seed [7; 32], the seed
// the RTSE verifier tests use. This file assembles the expected bytes itself so the verifier is checked against
// the contracts hex, not against its own encoder.
const COMMON_HEX =
  '454f5448415f554e444f434b5f524543454950545f5631' +
  '07000000' + '70696c6f742d31' +
  '07070707070747078707070707070707' +
  '0f000000' + '383832383330383238316666666666' +
  '391f3930a1010000' +
  'f9464230a1010000' +
  'cd'.repeat(16);
// An undock from a station governed by `beta`, and one from an independent station, whose empty faction id
// signs as a zero length prefix.
const VECTOR_HEX = COMMON_HEX + '04000000' + '62657461';
const VECTOR_SIGNATURE =
  'DYzj0bBPLVfzUg452zKuwDUAR2vBXQ0A331XapOtfc5+SNJRpxpHgGJjuJxsQUiIn28gbMrZBUJVxbyqAMeTAw==';
const INDEPENDENT_VECTOR_HEX = COMMON_HEX + '00000000';
const INDEPENDENT_SIGNATURE =
  'ZtP8BQg1tbaNz8eJ0glF/jvLxSVAZCGzyz4NYccXOZ3YNbOu9l5srKlUTJgELPppY1pazvtxAhc1GLqUxINlCw==';

const vectorReceipt = (overrides = {}) => ({
  pilotId: 'pilot-1',
  stationEntityId: '07070707-0707-4707-8707-070707070707',
  systemH3: '8828308281fffff',
  dockedAtMs: 1791810412345,
  undockedAtMs: 1791811012345,
  nonce: Buffer.alloc(16, 0xcd).toString('base64'),
  controllingFactionId: 'beta',
  signature: VECTOR_SIGNATURE,
  ...overrides
});
const vectorKey = createPrivateKey({
  key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.alloc(32, 7)]),
  format: 'der',
  type: 'pkcs8'
});
const publicKey = createPublicKey(vectorKey);

describe('undock receipt verifier', () => {
  test('canonical payload and signature match the eotha-contracts vectors', () => {
    const payload = canonicalUndockReceiptPayload(vectorReceipt());
    assert.equal(payload.length, 109);
    assert.equal(payload.toString('hex'), VECTOR_HEX);
    assert.equal(payload.subarray(0, 23).toString('ascii'), 'EOTHA_UNDOCK_RECEIPT_V1');
    assert.equal(sign(null, payload, vectorKey).toString('base64'), VECTOR_SIGNATURE);
    assert.equal(verifyUndockReceipt(vectorReceipt(), publicKey), true);

    const independent = vectorReceipt({ controllingFactionId: '', signature: INDEPENDENT_SIGNATURE });
    const independentPayload = canonicalUndockReceiptPayload(independent);
    assert.equal(independentPayload.length, 105);
    assert.equal(independentPayload.toString('hex'), INDEPENDENT_VECTOR_HEX);
    assert.equal(sign(null, independentPayload, vectorKey).toString('base64'), INDEPENDENT_SIGNATURE);
    assert.equal(verifyUndockReceipt(independent, publicKey), true);
  });

  test('the domain tag is the 23 byte EOTHA_UNDOCK_RECEIPT_V1', () => {
    assert.equal(UNDOCK_RECEIPT_DOMAIN.length, 23);
    assert.equal(UNDOCK_RECEIPT_DOMAIN.toString('ascii'), 'EOTHA_UNDOCK_RECEIPT_V1');
  });

  test('flipping any signed field breaks the signature', () => {
    const flippedId = '17070707-0707-4707-8707-070707070707';
    const flippedNonce = Buffer.alloc(16, 0xcd);
    flippedNonce[0] ^= 1;
    for (const [field, value] of Object.entries({
      pilotId: 'pilot-2',
      stationEntityId: flippedId,
      systemH3: '8828308283fffff',
      dockedAtMs: 1791810412344,
      undockedAtMs: 1791811012344,
      nonce: flippedNonce.toString('base64'),
      controllingFactionId: 'alpha'
    })) {
      assert.equal(verifyUndockReceipt(vectorReceipt({ [field]: value }), publicKey), false, field);
    }
  });

  test('the governing faction is signed: dropping it to independent, or to nothing, breaks the signature', () => {
    assert.equal(verifyUndockReceipt(vectorReceipt({ controllingFactionId: '' }), publicKey), false);
    assert.equal(verifyUndockReceipt(vectorReceipt({ controllingFactionId: undefined }), publicKey), false);
    // The independent signature is not valid for a faction station, nor the faction one for an independent station.
    assert.equal(verifyUndockReceipt(vectorReceipt({ signature: INDEPENDENT_SIGNATURE }), publicKey), false);
    assert.equal(
      verifyUndockReceipt(vectorReceipt({ controllingFactionId: '', signature: VECTOR_SIGNATURE }), publicKey),
      false
    );
  });

  test('a faction id the engine never signs is rejected', () => {
    for (const controllingFactionId of ['independent', 'delta', 'BETA']) {
      assert.equal(verifyUndockReceipt(vectorReceipt({ controllingFactionId }), publicKey), false, controllingFactionId);
    }
  });

  test('another signed record’s domain never verifies as an undock receipt over the same body', () => {
    const body = canonicalUndockReceiptPayload(vectorReceipt()).subarray(23);
    for (const domain of ['EOTHA_DOCKED_RECEIPT_V2', 'EOTHA_HAIL_RECEIPT_V1\u0000\u0000']) {
      const signature = sign(null, Buffer.concat([Buffer.from(domain, 'utf8'), body]), vectorKey).toString('base64');
      assert.equal(verifyUndockReceipt(vectorReceipt({ signature }), publicKey), false, domain);
    }
  });

  test('a receipt signed by another key is rejected', () => {
    const other = generateKeyPairSync('ed25519');
    assert.equal(verifyUndockReceipt(vectorReceipt(), other.publicKey), false);
    const payload = canonicalUndockReceiptPayload(vectorReceipt());
    const signature = sign(null, payload, other.privateKey).toString('base64');
    assert.equal(verifyUndockReceipt(vectorReceipt({ signature }), publicKey), false);
    assert.equal(verifyUndockReceipt(vectorReceipt({ signature }), other.publicKey), true);
  });

  test('verifying never throws on a malformed receipt or key', () => {
    assert.equal(verifyUndockReceipt(vectorReceipt(), undefined), false);
    assert.equal(verifyUndockReceipt(undefined, publicKey), false);
    assert.equal(verifyUndockReceipt(vectorReceipt({ signature: undefined }), publicKey), false);
    assert.equal(verifyUndockReceipt(vectorReceipt({ signature: 'AAAA' }), publicKey), false);
    assert.equal(verifyUndockReceipt(vectorReceipt({ stationEntityId: 'not-a-uuid' }), publicKey), false);
    assert.equal(verifyUndockReceipt(vectorReceipt({ nonce: 'AAAA' }), publicKey), false);
    assert.equal(verifyUndockReceipt(vectorReceipt({ pilotId: undefined }), publicKey), false);
  });

  test('canonicalising a malformed id or nonce throws', () => {
    assert.throws(() => canonicalUndockReceiptPayload(vectorReceipt({ stationEntityId: '0707' })), /16-byte UUID/);
    assert.throws(() => canonicalUndockReceiptPayload(vectorReceipt({ nonce: 'AAAA' })), /16 bytes/);
  });

  test('the replay key is the hex of the 16 nonce bytes', () => {
    assert.equal(undockReceiptNonceKey(vectorReceipt()), 'cd'.repeat(16));
  });
});

describe('undock receipt freshness', () => {
  const NOW = 1_800_000_000_000;
  const at = (undockedAtMs, dockedAtMs = undockedAtMs - 60_000) => ({ dockedAtMs, undockedAtMs });

  test('a receipt is fresh from the future skew back to the 15 minute relay window', () => {
    assert.equal(UNDOCK_RECEIPT_TTL_MS, 900_000);
    assert.equal(UNDOCK_RECEIPT_MAX_SKEW_MS, 5_000);
    assert.equal(isUndockReceiptFresh(at(NOW), NOW), true);
    assert.equal(isUndockReceiptFresh(at(NOW - 1), NOW), true);
    assert.equal(isUndockReceiptFresh(at(NOW - UNDOCK_RECEIPT_TTL_MS), NOW), true);
    assert.equal(isUndockReceiptFresh(at(NOW + UNDOCK_RECEIPT_MAX_SKEW_MS), NOW), true);
  });

  test('a receipt past the window is stale, and one from beyond the skew is from the future', () => {
    assert.equal(isUndockReceiptFresh(at(NOW - UNDOCK_RECEIPT_TTL_MS - 1), NOW), false);
    assert.equal(isUndockReceiptFresh(at(NOW + UNDOCK_RECEIPT_MAX_SKEW_MS + 1), NOW), false);
  });

  test('a docking that completed after the cast-off is refused, one at the same instant is not', () => {
    assert.equal(isUndockReceiptFresh({ dockedAtMs: NOW, undockedAtMs: NOW }, NOW), true);
    assert.equal(isUndockReceiptFresh({ dockedAtMs: NOW + 1, undockedAtMs: NOW }, NOW), false);
  });

  test('the window and skew can be overridden', () => {
    assert.equal(isUndockReceiptFresh(at(NOW - 31_000), NOW, { ttlMs: 30_000 }), false);
    assert.equal(isUndockReceiptFresh(at(NOW - 30_000), NOW, { ttlMs: 30_000 }), true);
    assert.equal(isUndockReceiptFresh(at(NOW + 1), NOW, { maxSkewMs: 0 }), false);
  });
});

describe('undockReceiptSchema', () => {
  // Validated the way the route will: through Fastify's own compiler, which applies the faction default.
  const fastify = Fastify();
  fastify.post('/undock', { schema: { body: { type: 'object', required: ['undockReceipt'], properties: { undockReceipt: undockReceiptSchema } } } }, (request) => ({
    receipt: request.body.undockReceipt,
    verified: verifyUndockReceipt(request.body.undockReceipt, publicKey)
  }));
  const post = (undockReceipt) => fastify.inject({ method: 'POST', url: '/undock', payload: { undockReceipt } });
  const wire = (overrides = {}) => ({ ...vectorReceipt(), ...overrides });
  after(() => fastify.close());

  test('accepts the vector receipt, and defaults an omitted (independent) faction to the empty string', async () => {
    const ok = await post(wire());
    assert.equal(ok.statusCode, 200, ok.body);
    assert.equal(ok.json().verified, true);

    const independent = wire({ signature: INDEPENDENT_SIGNATURE });
    delete independent.controllingFactionId;
    const res = await post(independent);
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json().receipt.controllingFactionId, '');
    assert.equal(res.json().verified, true);
  });

  test('drops a field the receipt does not carry, which is never signed', async () => {
    const res = await post(wire({ extra: 1 }));
    assert.equal(res.statusCode, 200, res.body);
    assert.equal('extra' in res.json().receipt, false);
    assert.equal(res.json().verified, true);
  });

  test('rejects a missing required field and malformed values', async () => {
    for (const field of ['pilotId', 'stationEntityId', 'systemH3', 'dockedAtMs', 'undockedAtMs', 'nonce', 'signature']) {
      const receipt = wire();
      delete receipt[field];
      assert.equal((await post(receipt)).statusCode, 400, field);
    }
    for (const overrides of [
      { pilotId: '' },
      { stationEntityId: '0707070g-0707-4707-8707-070707070707' },
      { stationEntityId: 'abcdef01-0707-4707-8707-070707070707'.toUpperCase() },
      { systemH3: '8828308281FFFFF' },
      { systemH3: '8828308281' },
      { dockedAtMs: -1 },
      { undockedAtMs: 1.5 },
      { undockedAtMs: Number.MAX_SAFE_INTEGER + 1 },
      { nonce: Buffer.alloc(15).toString('base64') },
      { signature: 'AAAA' },
      { controllingFactionId: 'independent' }
    ]) {
      assert.equal((await post(wire(overrides))).statusCode, 400, JSON.stringify(overrides));
    }
  });
});
