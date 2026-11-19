import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { app, call, closeApp, credits, dockedReceipt, json, loginKey, newPilot, rtseKey, setCredits } from './helpers.js';
import { DOCKED_RECEIPT_MAX_SKEW_MS, DOCKED_RECEIPT_TTL_MS } from '../src/config/docking.js';
import { upgradeCost } from '../src/config/components.js';
import {
  canonicalDockedReceiptPayload,
  isDockedReceiptFresh,
  verifyDockedReceipt
} from '../src/lib/docked-receipt.js';

// The fixed vectors from eotha-contracts `scripts/check-docked-receipt-vector.js` (V3: the V2 layout plus the signed
// outfitting catalog): Ed25519 seed [7; 32], the seed the RTSE verifier tests use.
const COMMON_HEX =
  '454f5448415f444f434b45445f524543454950545f563307000000' +
  '70696c6f742d31' +
  '07070707-0707-4707-8707-070707070707'.replaceAll('-', '') +
  '0f000000' +
  '383832383330383238316666666666' +
  'c0164230a1010000' +
  'f9464230a1010000' +
  'ab'.repeat(16);
// A receipt at a station governed by `beta` whose catalog is HULL 3, CARGO 3, ENGINES 5 in BASIC and ARTISAN (mask
// 0b1100, no Artisan cap); one in an independent system, whose empty faction id signs as a zero length prefix, with
// HULL 3 and ENGINES 4 and Artisan work capped at tier 3; and one at a station that stocks nothing.
const BETA_STOCK = [{ componentType: 1, maxTier: 3 }, { componentType: 3, maxTier: 3 }, { componentType: 9, maxTier: 5 }];
const INDEPENDENT_STOCK = [{ componentType: 1, maxTier: 3 }, { componentType: 9, maxTier: 4 }];
const VECTOR_HEX = COMMON_HEX + '04000000' + '62657461' + '03000000' + '0100000003000000' + '0300000003000000' + '0900000005000000' + '0c000000' + '00000000';
const VECTOR_SIGNATURE =
  'U3iPJWXZrYw1Rq83Aryoe+xjfOO7j+arD4uQIxE2VTg7daEg90XNC3JMdgbEv+mXI4DY9q9JXm1OgfCGVo3aDw==';
const INDEPENDENT_VECTOR_HEX = COMMON_HEX + '00000000' + '02000000' + '0100000003000000' + '0900000004000000' + '0c000000' + '03000000';
const INDEPENDENT_SIGNATURE =
  'g0ql3zzooOSc/X859oLeLIeC7Yq8BQBEDKIZLqZYFYK+h0h3Od8ISihuT9Y3ZfwquyZfrWC5WjIz2P1kPtAXAg==';
const EMPTY_VECTOR_HEX = COMMON_HEX + '04000000' + '62657461' + '00000000' + '00000000' + '00000000';
const EMPTY_SIGNATURE =
  'ean/jy1tu2wO9UBlpIHBVX50yYOkeXgWOdh3fbCKbRQBq3WsJt3lZrpVmVVcZtZlEmYjYZ720/jPanbVigaZCQ==';
const vectorReceipt = (overrides = {}) => ({
  pilotId: 'pilot-1',
  dockedEntityId: '07070707-0707-4707-8707-070707070707',
  systemH3: '8828308281fffff',
  dockedAtMs: 1791811000000,
  issuedAtMs: 1791811012345,
  nonce: Buffer.alloc(16, 0xab).toString('base64'),
  controllingFactionId: 'beta',
  outfittingStock: BETA_STOCK,
  stockedQualityMask: 0b1100,
  artisanMaxTier: 0,
  signature: VECTOR_SIGNATURE,
  ...overrides
});
const vectorKey = createPrivateKey({
  key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.alloc(32, 7)]),
  format: 'der',
  type: 'pkcs8'
});

describe('docked receipt verifier', () => {
  test('canonical payload and signature match the eotha-contracts vectors', () => {
    const publicKey = createPublicKey(vectorKey);
    const cases = [
      [vectorReceipt(), VECTOR_HEX, VECTOR_SIGNATURE, 145],
      [
        vectorReceipt({ controllingFactionId: '', outfittingStock: INDEPENDENT_STOCK, artisanMaxTier: 3, signature: INDEPENDENT_SIGNATURE }),
        INDEPENDENT_VECTOR_HEX, INDEPENDENT_SIGNATURE, 133
      ],
      [
        vectorReceipt({ outfittingStock: [], stockedQualityMask: 0, signature: EMPTY_SIGNATURE }),
        EMPTY_VECTOR_HEX, EMPTY_SIGNATURE, 121
      ]
    ];
    for (const [receipt, hex, signature, length] of cases) {
      const payload = canonicalDockedReceiptPayload(receipt);
      assert.equal(payload.length, length);
      assert.equal(payload.toString('hex'), hex);
      assert.equal(sign(null, payload, vectorKey).toString('base64'), signature);
      assert.equal(verifyDockedReceipt(receipt, publicKey), true);
    }
  });

  test('the catalog is signed: changing or dropping any part of it breaks the signature', () => {
    const publicKey = createPublicKey(vectorKey);
    const changes = {
      outfittingStock: [{ componentType: 1, maxTier: 4 }, ...BETA_STOCK.slice(1)],
      stockedQualityMask: 0b1110,
      artisanMaxTier: 3
    };
    for (const [field, value] of Object.entries(changes)) {
      assert.equal(verifyDockedReceipt(vectorReceipt({ [field]: value }), publicKey), false, field);
    }
    assert.equal(verifyDockedReceipt(vectorReceipt({ outfittingStock: BETA_STOCK.slice(0, 2) }), publicKey), false, 'entry dropped');
    assert.equal(verifyDockedReceipt(vectorReceipt({ outfittingStock: [...BETA_STOCK, { componentType: 10, maxTier: 1 }] }), publicKey), false, 'entry added');
    for (const field of ['outfittingStock', 'stockedQualityMask', 'artisanMaxTier']) {
      assert.equal(verifyDockedReceipt(vectorReceipt({ [field]: undefined }), publicKey), false, `${field} missing`);
    }
  });

  test('a catalog not in the one canonical form is rejected, even under a valid signature', () => {
    const [hull, cargo] = BETA_STOCK;
    const catalogs = {
      'out of order': { outfittingStock: [cargo, hull] },
      'duplicate type': { outfittingStock: [hull, { ...hull, maxTier: 2 }] },
      'UNSPECIFIED type': { outfittingStock: [{ componentType: 0, maxTier: 1 }, hull] },
      'tier 0': { outfittingStock: [{ componentType: 1, maxTier: 0 }] },
      'UNSPECIFIED quality bit': { stockedQualityMask: 0b1101 }
    };
    for (const [name, overrides] of Object.entries(catalogs)) {
      assert.equal(verifyDockedReceipt(dockedReceipt('pilot-1', overrides), app.claimKey.key), false, name);
    }
    for (const overrides of [{ stockedQualityMask: 2 ** 32 }, { artisanMaxTier: -1 }, { outfittingStock: [{ componentType: 1, maxTier: 1.5 }] }]) {
      assert.throws(() => canonicalDockedReceiptPayload(vectorReceipt(overrides)), /catalog/);
      assert.equal(verifyDockedReceipt(vectorReceipt(overrides), createPublicKey(vectorKey)), false);
    }
  });

  test('the governing faction is signed: swapping it, or dropping it to independent, breaks the signature', () => {
    const publicKey = createPublicKey(vectorKey);
    for (const controllingFactionId of ['', 'alpha', 'gamma']) {
      assert.equal(verifyDockedReceipt(vectorReceipt({ controllingFactionId }), publicKey), false, controllingFactionId);
    }
    assert.equal(verifyDockedReceipt(vectorReceipt({ controllingFactionId: undefined }), publicKey), false);
  });

  test('a faction id the engine never signs is rejected, even under a valid signature', () => {
    for (const controllingFactionId of ['independent', 'delta', 'BETA']) {
      const receipt = dockedReceipt('pilot-1', { controllingFactionId });
      assert.equal(verifyDockedReceipt(receipt, app.claimKey.key), false, controllingFactionId);
    }
  });

  test('a V1 or V2 receipt (older domain, no catalog) is rejected, never read as a dock that stocks everything', () => {
    const v3 = dockedReceipt('pilot-1');
    const v3Payload = canonicalDockedReceiptPayload(v3);
    const faction = v3.controllingFactionId.length;
    const v2Body = v3Payload.subarray(23, v3Payload.length - (4 + 8 * v3.outfittingStock.length + 8));
    const v1Body = v2Body.subarray(0, v2Body.length - 4 - faction);
    for (const [domain, body] of [['V2', v2Body], ['V1', v1Body]]) {
      const payload = Buffer.concat([Buffer.from(`EOTHA_DOCKED_RECEIPT_${domain}`, 'ascii'), body]);
      const older = { ...v3, signature: sign(null, payload, rtseKey).toString('base64') };
      assert.equal(verifyDockedReceipt(older, app.claimKey.key), false, domain);
      assert.equal(verifyDockedReceipt({ ...older, outfittingStock: [], stockedQualityMask: 0, artisanMaxTier: 0 }, app.claimKey.key), false, `${domain} as empty catalog`);
    }
  });

  test('flipping any signed field breaks verification', () => {
    const publicKey = createPublicKey(vectorKey);
    const changes = {
      pilotId: 'pilot-2',
      dockedEntityId: '07070707-0707-4707-8707-070707070708',
      systemH3: '8828308281ffffe',
      dockedAtMs: 1791811000001,
      issuedAtMs: 1791811012344,
      nonce: Buffer.alloc(16, 0xac).toString('base64')
    };
    for (const [field, value] of Object.entries(changes)) {
      assert.equal(verifyDockedReceipt({ ...vectorReceipt(), [field]: value }, publicKey), false, field);
    }
  });

  test('never throws on malformed input', () => {
    const publicKey = createPublicKey(vectorKey);
    const good = vectorReceipt();
    for (const bad of [
      undefined, null, {}, { ...good, signature: undefined }, { ...good, signature: 'AAAA' },
      { ...good, dockedEntityId: 'not-a-uuid' }, { ...good, nonce: 'AAAA' }, { ...good, pilotId: undefined },
      { ...good, issuedAtMs: -1 }, { ...good, issuedAtMs: 'soon' }
    ]) {
      assert.equal(verifyDockedReceipt(bad, publicKey), false);
    }
    assert.equal(verifyDockedReceipt(good, null), false);
  });

  test('a receipt signed by the login key never verifies against the claim key', () => {
    const receipt = dockedReceipt('pilot-1', {}, loginKey);
    assert.equal(verifyDockedReceipt(receipt, app.claimKey.key), false);
    assert.equal(verifyDockedReceipt(receipt, createPublicKey(loginKey)), true);
  });

  test('the test helper signs exactly what the verifier checks', () => {
    assert.equal(verifyDockedReceipt(dockedReceipt('pilot-1'), app.claimKey.key), true);
  });

  test('freshness: the full TTL of age and 5 s of skew are inclusive, one more millisecond is not', () => {
    assert.equal(DOCKED_RECEIPT_TTL_MS, 300_000);
    assert.equal(DOCKED_RECEIPT_MAX_SKEW_MS, 5_000);
    const now = 1_800_000_000_000;
    const at = (issuedAtMs, dockedAtMs = issuedAtMs - 1_000) => isDockedReceiptFresh({ issuedAtMs, dockedAtMs }, now);
    assert.equal(at(now), true);
    assert.equal(at(now - DOCKED_RECEIPT_TTL_MS), true);
    assert.equal(at(now - DOCKED_RECEIPT_TTL_MS - 1), false);
    assert.equal(at(now + 5_000), true);
    assert.equal(at(now + 5_001), false);
    assert.equal(at(now, now), true);
    assert.equal(at(now, now + 1), false);
  });
});

describe('POST /ship/upgrade requires a docked receipt', () => {
  before(async () => { await app.ready(); });
  after(async () => { await closeApp(); });

  const COST = upgradeCost(1, 2);
  const funded = async (prefix) => {
    const pilot = await newPilot(prefix);
    await setCredits(pilot, 10_000);
    return pilot;
  };
  const upgrade = (pilot, dockedReceiptBody, body = { componentType: 'HULL', targetTier: 2 }) =>
    call(pilot, 'POST', '/ship/upgrade', dockedReceiptBody === undefined ? body : { ...body, dockedReceipt: dockedReceiptBody });
  const hullTier = async (pilot) =>
    json(await call(pilot, 'GET', '/ship/loadout')).components.find((c) => c.type === 'HULL').tier;

  // A refusal must leave the pilot exactly as it was.
  async function assertRefused(pilot, res, code) {
    assert.equal(res.statusCode, 403, res.body);
    assert.equal(json(res).code, code);
    assert.equal(await credits(pilot), 10_000);
    assert.equal(await hullTier(pilot), 1);
  }

  test('a fresh receipt for this pilot lets the upgrade through', async () => {
    const pilot = await funded('Docked');
    const res = await upgrade(pilot, dockedReceipt(pilot));
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(json(res).credits, 10_000 - COST);
    assert.equal(await hullTier(pilot), 2);
  });

  test('a missing receipt is refused with docked_receipt_required', async () => {
    const pilot = await funded('NoReceipt');
    await assertRefused(pilot, await upgrade(pilot, undefined), 'docked_receipt_required');
  });

  test('the docked check runs before the request is otherwise judged', async () => {
    const pilot = await funded('Undocked');
    const res = await upgrade(pilot, undefined, { componentType: 'LIFE_SUPPORT', targetTier: 0 });
    assert.equal(res.statusCode, 403);
    assert.equal(json(res).code, 'docked_receipt_required');
  });

  test('a receipt for another pilot is refused with docked_receipt_invalid, even if genuinely signed', async () => {
    const pilot = await funded('Thief');
    const other = await newPilot('Victim');
    await assertRefused(pilot, await upgrade(pilot, dockedReceipt(other)), 'docked_receipt_invalid');
  });

  test('a tampered receipt is refused with docked_receipt_invalid', async () => {
    const pilot = await funded('Tamper');
    for (const change of [
      { systemH3: '8828308283fffff' },
      { dockedEntityId: '07070707-0707-4707-8707-070707070707' },
      { nonce: Buffer.alloc(16, 1).toString('base64') },
      { dockedAtMs: Date.now() - 5_000 }
    ]) {
      const receipt = { ...dockedReceipt(pilot), ...change };
      await assertRefused(pilot, await upgrade(pilot, receipt), 'docked_receipt_invalid');
    }
    // Pushing the issue time forward to dodge expiry also breaks the signature.
    const stale = dockedReceipt(pilot, { issuedAtMs: Date.now() - DOCKED_RECEIPT_TTL_MS - 120_000, dockedAtMs: Date.now() - DOCKED_RECEIPT_TTL_MS - 130_000 });
    await assertRefused(pilot, await upgrade(pilot, { ...stale, issuedAtMs: Date.now() }), 'docked_receipt_invalid');
  });

  test('a signature that is not valid is refused with docked_receipt_invalid', async () => {
    const pilot = await funded('BadSig');
    const zeros = Buffer.alloc(64).toString('base64');
    await assertRefused(pilot, await upgrade(pilot, dockedReceipt(pilot, { signature: zeros })), 'docked_receipt_invalid');
  });

  test('a receipt signed by the login key is refused with docked_receipt_invalid', async () => {
    const pilot = await funded('LoginKey');
    await assertRefused(pilot, await upgrade(pilot, dockedReceipt(pilot, {}, loginKey)), 'docked_receipt_invalid');
  });

  test('an expired receipt is refused with docked_receipt_expired, and a fresh one then works', async () => {
    const pilot = await funded('Expired');
    const issuedAtMs = Date.now() - DOCKED_RECEIPT_TTL_MS - 1_000;
    const old = dockedReceipt(pilot, { issuedAtMs, dockedAtMs: issuedAtMs - 5_000 });
    await assertRefused(pilot, await upgrade(pilot, old), 'docked_receipt_expired');
    assert.equal((await upgrade(pilot, dockedReceipt(pilot))).statusCode, 200);
  });

  test('a receipt issued too far in the future is refused with docked_receipt_expired', async () => {
    const pilot = await funded('Future');
    const issuedAtMs = Date.now() + DOCKED_RECEIPT_MAX_SKEW_MS + 1_000;
    const early = dockedReceipt(pilot, { issuedAtMs, dockedAtMs: issuedAtMs - 5_000 });
    await assertRefused(pilot, await upgrade(pilot, early), 'docked_receipt_expired');
  });

  test('a little clock skew is tolerated', async () => {
    const pilot = await funded('Skewed');
    const issuedAtMs = Date.now() + 2_000;
    const res = await upgrade(pilot, dockedReceipt(pilot, { issuedAtMs, dockedAtMs: issuedAtMs - 5_000 }));
    assert.equal(res.statusCode, 200, res.body);
  });

  test('a receipt claiming a docking after its own issue time is refused with docked_receipt_expired', async () => {
    const pilot = await funded('TimeTravel');
    const now = Date.now();
    const odd = dockedReceipt(pilot, { issuedAtMs: now - 1_000, dockedAtMs: now });
    await assertRefused(pilot, await upgrade(pilot, odd), 'docked_receipt_expired');
  });

  test('a receipt is not single-use: it serves several upgrades inside its window', async () => {
    const pilot = await funded('Reuse');
    const receipt = dockedReceipt(pilot);
    assert.equal((await upgrade(pilot, receipt, { componentType: 'HULL', targetTier: 2 })).statusCode, 200);
    assert.equal((await upgrade(pilot, receipt, { componentType: 'RADAR', targetTier: 2 })).statusCode, 200);
  });

  test('a malformed receipt is a schema error, not a charge', async () => {
    const pilot = await funded('Malformed');
    const good = dockedReceipt(pilot);
    for (const bad of [
      { ...good, dockedEntityId: good.dockedEntityId.toUpperCase() },
      { ...good, dockedEntityId: good.dockedEntityId.replaceAll('-', '') },
      { ...good, nonce: Buffer.alloc(8).toString('base64') },
      { ...good, signature: 'c2ln' },
      { ...good, systemH3: 'xyz' },
      { ...good, issuedAtMs: -1 },
      { ...good, signature: undefined },
      'docked'
    ]) {
      assert.equal((await upgrade(pilot, bad)).statusCode, 400);
    }
    assert.equal(await credits(pilot), 10_000);
  });

  test('without a claim key the route refuses with 503 CLAIM_KEY_NOT_CONFIGURED and charges nothing', async () => {
    const pilot = await funded('Keyless');
    const receipt = dockedReceipt(pilot);
    const configured = app.claimKey;
    app.claimKey = null;
    try {
      const res = await upgrade(pilot, receipt);
      assert.equal(res.statusCode, 503);
      assert.equal(json(res).error, 'CLAIM_KEY_NOT_CONFIGURED');
    } finally {
      app.claimKey = configured;
    }
    assert.equal(await credits(pilot), 10_000);
    assert.equal((await upgrade(pilot, receipt)).statusCode, 200);
  });

  test('GET /ship/loadout needs no receipt', async () => {
    const pilot = await newPilot('Reader');
    assert.equal((await call(pilot, 'GET', '/ship/loadout')).statusCode, 200);
  });
});
