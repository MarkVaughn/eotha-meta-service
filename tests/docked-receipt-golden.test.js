import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createPublicKey } from 'node:crypto';
import { app, call, closeApp, dockedReceipt, json, newPilot, setCredits } from './helpers.js';
import {
  canonicalDockedReceiptPayload,
  dockedReceiptSchema,
  verifyDockedReceipt
} from '../src/lib/docked-receipt.js';

// The golden DockedReceipt V3 fixtures from eotha-contracts `testdata/` (1.17.0), vendored under
// tests/fixtures/contracts/ and kept identical to contracts main by scripts/check-contract-drift.sh. They are what
// every consumer of a DockedReceipt (engine, meta-service, dev client) tests against, so a consumer that falls out of
// step with the contract fails its own tests instead of a player's session. Per the contracts README the meta-service
// proves: its body schema requires exactly the schema file's `required` list, it accepts every `meta_service_body` and
// verifies it with `key.public_key_hex`, and it answers 400 to every `invalid_bodies` entry.
const fixtureUrl = (name) => new URL(`./fixtures/contracts/${name}`, import.meta.url);
const golden = JSON.parse(readFileSync(fixtureUrl('docked_receipt_v3_golden.json'), 'utf8'));
const bodySchema = JSON.parse(readFileSync(fixtureUrl('docked_receipt_body.schema.json'), 'utf8'));

// A raw 32-byte Ed25519 public key as the SPKI DER node:crypto wants.
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const publicKey = createPublicKey({
  key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(golden.key.public_key_hex, 'hex')]),
  format: 'der',
  type: 'spki'
});

const vectors = golden.vectors;
const clone = (value) => structuredClone(value);
const without = (body, field) => {
  const { [field]: _dropped, ...rest } = body;
  return rest;
};

describe('the contracts golden DockedReceipt fixtures', () => {
  test('are the V3 set this suite was written for', () => {
    assert.equal(golden.format, 'eotha.rtse.v1.docked-receipt-v3-golden');
    assert.equal(golden.signing_domain, 'EOTHA_DOCKED_RECEIPT_V3');
    assert.deepEqual(vectors.map((v) => v.name), ['full-v3', 'independent', 'empty-catalog']);
    assert.ok(golden.invalid_bodies.length > 0);
  });
});

describe('dockedReceiptSchema against the contracts body schema', () => {
  test('requires exactly the properties the contract requires', () => {
    assert.deepEqual([...dockedReceiptSchema.required].sort(), [...bodySchema.required].sort());
  });

  test('declares exactly the properties the contract declares', () => {
    assert.deepEqual(Object.keys(dockedReceiptSchema.properties).sort(), Object.keys(bodySchema.properties).sort());
  });

  test('requires the catalog entry fields the contract requires', () => {
    assert.deepEqual(
      [...dockedReceiptSchema.properties.outfittingStock.items.required].sort(),
      [...bodySchema.definitions.OutfittingStock.required].sort()
    );
  });

  test('agrees with the contract on each property\'s JSON type and enum', () => {
    for (const [name, contract] of Object.entries(bodySchema.properties)) {
      const own = dockedReceiptSchema.properties[name];
      assert.equal(own.type, contract.type, `${name} type`);
      if (contract.enum) assert.deepEqual(own.enum, contract.enum, `${name} enum`);
    }
  });
});

describe('verifyDockedReceipt on the golden signed receipts', () => {
  test('the golden key is the Ed25519 public key of the test seed the contract names', () => {
    assert.equal(golden.key.seed_hex, '07'.repeat(32));
    assert.equal(publicKey.asymmetricKeyType, 'ed25519');
  });

  for (const vector of vectors) {
    test(`${vector.name}: the signing bytes and signature match, and the receipt verifies`, () => {
      const receipt = clone(vector.meta_service_body);
      assert.equal(canonicalDockedReceiptPayload(receipt).toString('hex'), vector.signing_bytes_hex);
      assert.equal(canonicalDockedReceiptPayload(receipt).length, vector.signing_bytes_length);
      assert.equal(receipt.signature, vector.signature_base64);
      assert.equal(verifyDockedReceipt(receipt, publicKey), true);
    });

    test(`${vector.name}: a changed catalog entry does not verify`, () => {
      const body = vector.meta_service_body;
      const tampered = [];
      for (const [i, entry] of body.outfittingStock.entries()) {
        const higher = clone(body);
        higher.outfittingStock[i].maxTier = entry.maxTier + 1;
        tampered.push([`entry ${i} maxTier + 1`, higher]);
        const retyped = clone(body);
        retyped.outfittingStock[i].componentType = entry.componentType + 1;
        tampered.push([`entry ${i} componentType + 1`, retyped]);
      }
      tampered.push(['entry added', { ...clone(body), outfittingStock: [...clone(body.outfittingStock), { componentType: 30, maxTier: 1 }] }]);
      tampered.push(['quality mask changed', { ...clone(body), stockedQualityMask: body.stockedQualityMask ^ 0b10 }]);
      tampered.push(['artisan cap changed', { ...clone(body), artisanMaxTier: body.artisanMaxTier + 1 }]);
      for (const [what, receipt] of tampered) {
        assert.equal(verifyDockedReceipt(receipt, publicKey), false, what);
      }
    });

    test(`${vector.name}: a dropped entry does not verify`, () => {
      const body = vector.meta_service_body;
      for (let i = 0; i < body.outfittingStock.length; i++) {
        const dropped = { ...clone(body), outfittingStock: body.outfittingStock.filter((_, j) => j !== i) };
        assert.equal(verifyDockedReceipt(dropped, publicKey), false, `entry ${i} dropped`);
      }
    });

    test(`${vector.name}: a receipt missing any required field does not verify`, () => {
      for (const field of bodySchema.required) {
        assert.equal(verifyDockedReceipt(without(vector.meta_service_body, field), publicKey), false, `${field} dropped`);
      }
    });
  }

  test('a different key does not verify a golden receipt', () => {
    const other = createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.alloc(32, 8)]),
      format: 'der',
      type: 'spki'
    });
    for (const vector of vectors) assert.equal(verifyDockedReceipt(vector.meta_service_body, other), false, vector.name);
  });
});

// The same bodies through the real route's request validation (Fastify's own validator, as configured by the app),
// since a schema object that matches on paper can still be refused or coerced by the route. POST /ship/upgrade
// validates `dockedReceipt` before it looks at the receipt: a body that passes validation is then refused 403
// because the golden receipt names `pilot-1`, not this pilot, while a body that fails validation is a 400.
// A numeric-string timestamp is such a body, as the contract says.
describe('POST /ship/upgrade request validation of the golden bodies', () => {
  before(async () => { await app.ready(); });
  after(async () => { await closeApp(); });

  const upgrade = (pilot, dockedReceipt) =>
    call(pilot, 'POST', '/ship/upgrade', { componentType: 'HULL', targetTier: 2, dockedReceipt });

  test('every golden meta_service_body passes validation', async () => {
    const pilot = await newPilot('GoldenAccept');
    await setCredits(pilot, 10_000);
    for (const vector of vectors) {
      const res = await upgrade(pilot, clone(vector.meta_service_body));
      assert.equal(res.statusCode, 403, `${vector.name}: ${res.body}`);
      assert.equal(json(res).code, 'docked_receipt_invalid', vector.name);
    }
  });

  test('every golden invalid body is a 400', async () => {
    const pilot = await newPilot('GoldenReject');
    await setCredits(pilot, 10_000);
    for (const invalid of golden.invalid_bodies) {
      const res = await upgrade(pilot, clone(invalid.body));
      assert.equal(res.statusCode, 400, `${invalid.name}: ${res.body}`);
    }
  });

  // The contract sends the timestamps as JSON numbers; Fastify's default validator would coerce a numeric string, so
  // the app rejects a `dockedReceipt` whose JSON types differ from the schema's before validation.
  test('a numeric-string timestamp is a 400 while the same receipt with numeric timestamps is accepted', async () => {
    const pilot = await newPilot('StringTimestamps');
    await setCredits(pilot, 10_000);
    const receipt = dockedReceipt(pilot);
    const accepted = await upgrade(pilot, receipt);
    assert.equal(accepted.statusCode, 200, accepted.body);
    for (const field of ['dockedAtMs', 'issuedAtMs']) {
      const res = await upgrade(pilot, { ...receipt, [field]: String(receipt[field]) });
      assert.equal(res.statusCode, 400, `${field}: ${res.body}`);
      assert.match(json(res).message, new RegExp(`dockedReceipt/${field} must be integer`), field);
    }
  });

  test('other JSON types the validator would coerce are a 400 too', async () => {
    const pilot = await newPilot('CoercedTypes');
    await setCredits(pilot, 10_000);
    const receipt = dockedReceipt(pilot);
    const retyped = [
      ['a boolean timestamp', { dockedAtMs: true }],
      ['a null timestamp', { issuedAtMs: null }],
      ['an array timestamp', { issuedAtMs: [receipt.issuedAtMs] }],
      ['a numeric-string quality mask', { stockedQualityMask: String(receipt.stockedQualityMask) }],
      ['a numeric-string catalog tier', { outfittingStock: receipt.outfittingStock.map((entry) => ({ ...entry, maxTier: String(entry.maxTier) })) }],
      ['a numeric pilot id', { pilotId: 7 }]
    ];
    for (const [what, overrides] of retyped) {
      const res = await upgrade(pilot, { ...receipt, ...overrides });
      assert.equal(res.statusCode, 400, `${what}: ${res.body}`);
    }
  });

  test('a golden body missing any required field is a 400', async () => {
    const pilot = await newPilot('GoldenDropped');
    await setCredits(pilot, 10_000);
    for (const field of bodySchema.required) {
      const res = await upgrade(pilot, without(vectors[0].meta_service_body, field));
      assert.equal(res.statusCode, 400, `${field}: ${res.body}`);
    }
  });
});
