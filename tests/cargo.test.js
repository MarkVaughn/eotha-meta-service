import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createPrivateKey, createPublicKey, randomBytes, randomUUID, sign } from 'node:crypto';
import { app, call, closeApp, credits, json, loginKey, newPilot, rtseKey, setCredits } from './helpers.js';
import {
  canonicalCargoManifestPayload,
  canonicalSaleRecordPayload,
  verifyCargoManifest,
  verifySaleRecord
} from '../src/lib/cargo.js';
import { MAX_REWARD_CREDITS } from '../src/config/missions.js';

// The fixed vectors from eotha-contracts `scripts/check-cargo-manifest-vector.js` and
// `scripts/check-sale-record-vector.js` (lease id 0x11 x16, session id 0x22 x16).
const MANIFEST_VECTOR =
  '454f5448415f434152474f5f4d414e49464553545f56310700000070696c6f742d311111111111111111111111111111111122222222222222222222222222222222070000000000000002000000070000004645525249544584030000010000008025000008000000544954414e49554dd430000004000000401f00000068e5cf8b010000';
const SALE_VECTOR =
  '454f5448415f53414c455f5245434f52445f56320700000070696c6f742d310900000073746174696f6e2d3102000000070000004645525249544584030000010000008025000008000000544954414e49554dc409000003000000922200003d000000000000000068e5cf8b010000abababababababababababababababab111111111111111111111111111111112222222222222222222222222222222208000000000000000100000008000000544954414e49554dd430000004000000401f0000';
const VECTOR_LEASE = '11111111-1111-1111-1111-111111111111';
const VECTOR_SESSION = '22222222-2222-2222-2222-222222222222';

const vectorManifest = () => ({
  pilotId: 'pilot-1',
  leaseId: VECTOR_LEASE,
  sessionId: VECTOR_SESSION,
  seq: 7,
  lots: [
    { resourceType: 'FERRITE', unitsMilli: 900, grade: 1, purityBp: 9600 },
    { resourceType: 'TITANIUM', unitsMilli: 12500, grade: 4, purityBp: 8000 }
  ],
  issuedAtMs: 1700000000000
});

const vectorSale = () => ({
  pilotId: 'pilot-1',
  stationId: 'station-1',
  items: [
    { resourceType: 'FERRITE', unitsMilli: 900, grade: 1, purityBp: 9600 },
    { resourceType: 'TITANIUM', unitsMilli: 2500, grade: 3, purityBp: 8850 }
  ],
  totalCredits: 61,
  soldAtMs: 1700000000000,
  nonce: Buffer.alloc(16, 0xab).toString('base64'),
  leaseId: VECTOR_LEASE,
  sessionId: VECTOR_SESSION,
  seq: 8,
  remaining: [{ resourceType: 'TITANIUM', unitsMilli: 12500, grade: 4, purityBp: 8000 }]
});

const vectorKey = createPrivateKey({
  key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.alloc(32, 7)]),
  format: 'der',
  type: 'pkcs8'
});

// The engine's encoders, written out here rather than imported from src/lib/cargo.js, so the
// verifier is checked against an independent implementation.
const u32 = (n) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
};
const u64 = (n) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
};
const str = (s) => Buffer.concat([u32(Buffer.byteLength(s)), Buffer.from(s, 'utf8')]);
const id = (uuid) => Buffer.from(uuid.replaceAll('-', ''), 'hex');
const lotBytes = (lots) => [
  u32(lots.length),
  ...lots.flatMap((lot) => [str(lot.resourceType), u32(lot.unitsMilli), u32(lot.grade), u32(lot.purityBp)])
];

const manifestBytes = (m) =>
  Buffer.concat([
    Buffer.from('EOTHA_CARGO_MANIFEST_V1', 'ascii'),
    str(m.pilotId), id(m.leaseId), id(m.sessionId), u64(m.seq), ...lotBytes(m.lots), u64(m.issuedAtMs)
  ]);

const saleBytes = (r) =>
  Buffer.concat([
    Buffer.from('EOTHA_SALE_RECORD_V2', 'ascii'),
    str(r.pilotId), str(r.stationId), ...lotBytes(r.items), u64(r.totalCredits), u64(r.soldAtMs),
    Buffer.from(r.nonce, 'base64'), id(r.leaseId), id(r.sessionId), u64(r.seq), ...lotBytes(r.remaining)
  ]);

const signed = (fields, bytes, key) => ({ ...fields, signature: sign(null, bytes(fields), key).toString('base64') });

const ORE = { resourceType: 'TITANIUM', unitsMilli: 12500, grade: 4, purityBp: 8000 };
const ROCK = { resourceType: 'FERRITE', unitsMilli: 900, grade: 1, purityBp: 9600 };
const stored = (lot) => ({ resource_type: lot.resourceType, units_milli: lot.unitsMilli, grade: lot.grade, purity_bp: lot.purityBp });

/** A manifest the engine would sign for `pilot` in (`leaseId`, `sessionId`) at `seq`. */
const manifestFor = (pilot, leaseId, sessionId, seq, lots, key = rtseKey) =>
  signed({ pilotId: pilot.id, leaseId, sessionId, seq, lots, issuedAtMs: Date.now() }, manifestBytes, key);

/** A sale of `items` the engine would sign; the whole hold is sold, so `remaining` defaults to empty. */
const saleFor = (pilot, leaseId, sessionId, seq, items, overrides = {}, key = rtseKey) =>
  signed(
    {
      pilotId: pilot.id,
      stationId: randomUUID(),
      items,
      totalCredits: 61,
      soldAtMs: Date.now(),
      nonce: randomBytes(16).toString('base64'),
      leaseId,
      sessionId,
      seq,
      remaining: [],
      ...overrides
    },
    saleBytes,
    key
  );

const lease = async (pilot) => {
  const res = await call(pilot, 'POST', '/game/cargo/lease');
  assert.equal(res.statusCode, 200, res.body);
  return json(res);
};
const hold = async (pilot) => json(await call(pilot, 'GET', '/game/cargo'));
const relay = (pilot, manifest) => call(pilot, 'POST', '/game/cargo/manifest', { manifest });
const sell = (pilot, saleRecord) => call(pilot, 'POST', '/game/cargo/sell', { saleRecord });

describe('cargo record verifiers', () => {
  test('canonical payloads match the eotha-contracts vectors', () => {
    assert.equal(canonicalCargoManifestPayload(vectorManifest()).toString('hex'), MANIFEST_VECTOR);
    assert.equal(canonicalSaleRecordPayload(vectorSale()).toString('hex'), SALE_VECTOR);
    // The test encoders agree, so the route tests below sign the same bytes.
    assert.equal(manifestBytes(vectorManifest()).toString('hex'), MANIFEST_VECTOR);
    assert.equal(saleBytes(vectorSale()).toString('hex'), SALE_VECTOR);
  });

  test('signatures over the vectors verify, and changing any signed field breaks them', () => {
    const publicKey = createPublicKey(vectorKey);
    const manifest = signed(vectorManifest(), manifestBytes, vectorKey);
    assert.equal(verifyCargoManifest(manifest, publicKey), true);
    for (const change of [
      { pilotId: 'pilot-2' }, { leaseId: '11111111-1111-1111-1111-111111111112' },
      { sessionId: '22222222-2222-2222-2222-222222222223' }, { seq: 8 }, { lots: manifest.lots.slice(1) },
      { lots: [{ ...ROCK, unitsMilli: 901 }, ORE] }, { issuedAtMs: 1700000000001 }
    ]) {
      assert.equal(verifyCargoManifest({ ...manifest, ...change }, publicKey), false, JSON.stringify(change));
    }

    const sale = signed(vectorSale(), saleBytes, vectorKey);
    assert.equal(verifySaleRecord(sale, publicKey), true);
    for (const change of [
      { pilotId: 'pilot-2' }, { stationId: 'station-2' }, { items: sale.items.slice(1) },
      { items: [{ ...ROCK, grade: 2 }, sale.items[1]] }, { totalCredits: 62 }, { soldAtMs: 1 },
      { nonce: Buffer.alloc(16, 0xac).toString('base64') }, { leaseId: '11111111-1111-1111-1111-111111111112' },
      { sessionId: '22222222-2222-2222-2222-222222222223' }, { seq: 9 }, { remaining: [] }
    ]) {
      assert.equal(verifySaleRecord({ ...sale, ...change }, publicKey), false, JSON.stringify(change));
    }
  });

  test('never throws on malformed input', () => {
    const publicKey = createPublicKey(vectorKey);
    const manifest = signed(vectorManifest(), manifestBytes, vectorKey);
    const sale = signed(vectorSale(), saleBytes, vectorKey);
    for (const bad of [
      undefined, null, {}, { ...manifest, signature: 'AAAA' },
      { ...manifest, sessionId: 'not-a-uuid' }, { ...manifest, lots: undefined }, { ...manifest, seq: -1 }
    ]) {
      assert.equal(verifyCargoManifest(bad, publicKey), false);
    }
    for (const bad of [
      undefined, {}, { ...sale, nonce: 'AAAA' }, { ...sale, remaining: undefined }, { ...sale, totalCredits: 'lots' }
    ]) {
      assert.equal(verifySaleRecord(bad, publicKey), false);
    }
    assert.equal(verifyCargoManifest(manifest, null), false);

    // Only the lowercase spelling of an id is accepted, even where the bytes would match.
    const lettered = signed({ ...vectorManifest(), leaseId: 'abababab-abab-4bab-8bab-abababababab' }, manifestBytes, vectorKey);
    assert.equal(verifyCargoManifest(lettered, publicKey), true);
    assert.equal(verifyCargoManifest({ ...lettered, leaseId: lettered.leaseId.toUpperCase() }, publicKey), false);
  });

  test('a record signed by the login key never verifies against the claim key', () => {
    assert.equal(verifyCargoManifest(signed(vectorManifest(), manifestBytes, loginKey), app.claimKey.key), false);
    assert.equal(verifySaleRecord(signed(vectorSale(), saleBytes, loginKey), app.claimKey.key), false);
  });
});

describe('cargo persistence and sales', () => {
  before(async () => { await app.ready(); });
  after(async () => { await closeApp(); });

  test('requires authentication', async () => {
    for (const [method, url] of [['GET', '/game/cargo'], ['POST', '/game/cargo/lease'], ['POST', '/game/cargo/manifest'], ['POST', '/game/cargo/sell']]) {
      assert.equal((await app.inject({ method, url })).statusCode, 401, url);
    }
  });

  describe('lease', () => {
    test('a new pilot holds nothing; the first lease is generation 1 with an empty hold', async () => {
      const pilot = await newPilot();
      assert.deepEqual(await hold(pilot), { lease_id: null, generation: 0, lots: [], used_m3: 0 });

      const { token, cargo } = await lease(pilot);
      assert.equal(cargo.generation, 1);
      assert.deepEqual(cargo.lots, []);
      const claims = app.jwt.verify(token);
      assert.deepEqual(claims.cargo, { lease_id: cargo.lease_id, lots: [] });
      assert.equal(claims.sub, pilot.id);
      assert.equal(typeof claims.ship_attributes.cargo_capacity_m3, 'number');
      // The expiry is carried over from the presented token, as for every reissued token.
      assert.equal(claims.exp, app.jwt.decode(pilot.token).exp);
      assert.deepEqual(await hold(pilot), { lease_id: cargo.lease_id, generation: 1, lots: [], used_m3: 0 });
    });

    test('a new lease copies the stored hold and fences the earlier one', async () => {
      const pilot = await newPilot();
      const first = (await lease(pilot)).cargo;
      const session = randomUUID();
      assert.equal((await relay(pilot, manifestFor(pilot, first.lease_id, session, 1, [ORE, ROCK]))).statusCode, 200);

      const { token, cargo: second } = await lease(pilot);
      assert.equal(second.generation, 2);
      assert.notEqual(second.lease_id, first.lease_id);
      assert.deepEqual(second.lots, [stored(ORE), stored(ROCK)]);
      assert.equal(second.used_m3, 13.4);
      assert.deepEqual(app.jwt.verify(token).cargo.lots, second.lots);

      // The fenced session can no longer write.
      const res = await relay(pilot, manifestFor(pilot, first.lease_id, session, 2, [ORE]));
      assert.equal(res.statusCode, 409);
      assert.equal(json(res).code, 'cargo_superseded');
      assert.deepEqual((await hold(pilot)).lots, [stored(ORE), stored(ROCK)]);
    });

    test('prunes leases older than the retention window, keeping the newest', async () => {
      const pilot = await newPilot();
      const old = (await lease(pilot)).cargo;
      const recent = (await lease(pilot)).cargo;
      await app.prisma.cargoLease.update({ where: { id: old.lease_id }, data: { issuedAt: new Date(Date.now() - 31 * 86_400_000) } });
      const newest = (await lease(pilot)).cargo;
      const ids = (await app.prisma.cargoLease.findMany({ where: { playerId: pilot.id } })).map((row) => row.id).sort();
      assert.deepEqual(ids, [recent.lease_id, newest.lease_id].sort());
    });

    test('tokens reissued for other reasons never carry the lease', async () => {
      const pilot = await newPilot();
      const { token } = await lease(pilot);
      const res = await app.inject({
        method: 'POST',
        url: '/ship/dev/passengers',
        headers: { authorization: `Bearer ${token}` },
        payload: { passengersAboard: 0 }
      });
      assert.equal(res.statusCode, 200, res.body);
      const claims = app.jwt.verify(json(res).token);
      assert.equal(claims.sub, pilot.id);
      assert.equal('cargo' in claims, false);
    });
  });

  describe('manifest', () => {
    test('a newer snapshot applies; an older or repeated one changes nothing', async () => {
      const pilot = await newPilot();
      const { lease_id: leaseId } = (await lease(pilot)).cargo;
      const session = randomUUID();

      const second = manifestFor(pilot, leaseId, session, 2, [ORE]);
      assert.deepEqual(json(await relay(pilot, second)), { applied: true });
      assert.deepEqual(json(await relay(pilot, manifestFor(pilot, leaseId, session, 1, [ROCK]))), { applied: false });
      assert.deepEqual(json(await relay(pilot, second)), { applied: false });
      assert.deepEqual((await hold(pilot)).lots, [stored(ORE)]);

      // Proto-JSON spells a uint64 as a decimal string.
      const third = manifestFor(pilot, leaseId, session, 3, [ORE, ROCK]);
      assert.deepEqual(json(await relay(pilot, { ...third, seq: '3', issuedAtMs: String(third.issuedAtMs) })), { applied: true });
      assert.deepEqual((await hold(pilot)).lots, [stored(ORE), stored(ROCK)]);
    });

    test('a second engine session on the same lease is refused', async () => {
      const pilot = await newPilot();
      const { lease_id: leaseId } = (await lease(pilot)).cargo;
      assert.equal((await relay(pilot, manifestFor(pilot, leaseId, randomUUID(), 1, [ORE]))).statusCode, 200);
      const res = await relay(pilot, manifestFor(pilot, leaseId, randomUUID(), 5, [ORE, ROCK]));
      assert.equal(res.statusCode, 409);
      assert.equal(json(res).code, 'cargo_superseded');
      assert.deepEqual((await hold(pilot)).lots, [stored(ORE)]);
    });

    test('a forged pilot, a tampered lot or seq, or the login key is refused with 403', async () => {
      const pilot = await newPilot();
      const other = await newPilot();
      const { lease_id: leaseId } = (await lease(pilot)).cargo;
      const session = randomUUID();
      const good = manifestFor(pilot, leaseId, session, 1, [ORE]);
      for (const bad of [
        manifestFor(other, leaseId, session, 1, [ORE]),
        { ...good, lots: [{ ...ORE, unitsMilli: ORE.unitsMilli + 1 }] },
        { ...good, lots: [{ ...ORE, grade: 5 }] },
        { ...good, seq: 2 },
        manifestFor(pilot, leaseId, session, 1, [ORE], loginKey)
      ]) {
        const res = await relay(pilot, bad);
        assert.equal(res.statusCode, 403);
        assert.equal(json(res).code, 'cargo_manifest_invalid');
      }
      assert.deepEqual((await hold(pilot)).lots, []);
    });

    test("a lease the pilot does not hold is refused with 409 cargo_lease_unknown", async () => {
      const pilot = await newPilot();
      const other = await newPilot();
      await lease(pilot);
      const { lease_id: othersLease } = (await lease(other)).cargo;
      for (const leaseId of [randomUUID(), othersLease]) {
        const res = await relay(pilot, manifestFor(pilot, leaseId, randomUUID(), 1, [ORE]));
        assert.equal(res.statusCode, 409);
        assert.equal(json(res).code, 'cargo_lease_unknown');
      }
      assert.deepEqual((await hold(other)).lots, []);
    });

    test('a malformed manifest is a schema 400', async () => {
      const pilot = await newPilot();
      const { lease_id: leaseId } = (await lease(pilot)).cargo;
      const session = randomUUID();
      for (const lots of [Array.from({ length: 33 }, () => ORE), [{ ...ORE, grade: 6 }], [{ ...ORE, purityBp: 10_001 }], [{ ...ORE, resourceType: '' }]]) {
        assert.equal((await relay(pilot, manifestFor(pilot, leaseId, session, 1, lots))).statusCode, 400);
      }
      assert.equal((await relay(pilot, { ...manifestFor(pilot, leaseId, session, 1, [ORE]), leaseId: 'lease-1' })).statusCode, 400);
    });
  });

  describe('sell', () => {
    test('credits the signed total and stores the remaining hold', async () => {
      const pilot = await newPilot();
      const { lease_id: leaseId } = (await lease(pilot)).cargo;
      const session = randomUUID();
      await relay(pilot, manifestFor(pilot, leaseId, session, 1, [ORE, ROCK]));

      const res = await sell(pilot, saleFor(pilot, leaseId, session, 2, [ORE, ROCK], { totalCredits: 720 }));
      assert.equal(res.statusCode, 200, res.body);
      assert.deepEqual(json(res), { credits: 720, total_credits: 720, lots: [], replayed: false });
      assert.equal(await credits(pilot), 720);
      assert.deepEqual((await hold(pilot)).lots, []);
      const sales = await app.prisma.cargoSale.findMany({ where: { playerId: pilot.id } });
      assert.equal(sales.length, 1);
      assert.deepEqual(sales[0].items, [stored(ORE), stored(ROCK)]);
    });

    test('a sale relayed after a later snapshot of its session is credited without a store', async () => {
      const pilot = await newPilot();
      const { lease_id: leaseId } = (await lease(pilot)).cargo;
      const session = randomUUID();
      await relay(pilot, manifestFor(pilot, leaseId, session, 1, [ORE]));
      const sale = saleFor(pilot, leaseId, session, 2, [ORE]);
      // Mined again after the sale; that snapshot overtook the sale on the way.
      assert.deepEqual(json(await relay(pilot, manifestFor(pilot, leaseId, session, 3, [ROCK]))), { applied: true });

      const res = await sell(pilot, sale);
      assert.equal(res.statusCode, 200, res.body);
      assert.deepEqual(json(res), { credits: 61, total_credits: 61, lots: [stored(ROCK)], replayed: false });
      assert.deepEqual((await hold(pilot)).lots, [stored(ROCK)]);
    });

    test('a replay answers with the first sale and credits once', async () => {
      const pilot = await newPilot();
      const { lease_id: leaseId } = (await lease(pilot)).cargo;
      const session = randomUUID();
      const sale = saleFor(pilot, leaseId, session, 1, [ORE]);
      assert.equal((await sell(pilot, sale)).statusCode, 200);
      // A later lease must not let the replay pay again either.
      await lease(pilot);
      const res = await sell(pilot, sale);
      assert.equal(res.statusCode, 200, res.body);
      assert.deepEqual(json(res), { credits: 61, total_credits: 61, lots: [], replayed: true });
      assert.equal(await credits(pilot), 61);
    });

    test('two concurrent relays of one sale credit once', async () => {
      const pilot = await newPilot();
      const { lease_id: leaseId } = (await lease(pilot)).cargo;
      const sale = saleFor(pilot, leaseId, randomUUID(), 1, [ORE]);
      const results = await Promise.all([sell(pilot, sale), sell(pilot, sale), sell(pilot, sale)]);
      assert.deepEqual(results.map((r) => r.statusCode), [200, 200, 200]);
      assert.equal(results.filter((r) => !json(r).replayed).length, 1);
      assert.equal(await credits(pilot), 61);
      assert.equal(await app.prisma.cargoSale.count({ where: { playerId: pilot.id } }), 1);
    });

    test('a sale from a fenced lease is refused and the ore stays stored', async () => {
      const pilot = await newPilot();
      const { lease_id: leaseId } = (await lease(pilot)).cargo;
      const session = randomUUID();
      await relay(pilot, manifestFor(pilot, leaseId, session, 1, [ORE]));
      await lease(pilot);

      const res = await sell(pilot, saleFor(pilot, leaseId, session, 2, [ORE]));
      assert.equal(res.statusCode, 409);
      assert.equal(json(res).code, 'cargo_superseded');
      assert.equal(await credits(pilot), 0);
      assert.deepEqual((await hold(pilot)).lots, [stored(ORE)]);
    });

    test('a sale already reached by its fenced lineage is still credited', async () => {
      const pilot = await newPilot();
      const { lease_id: leaseId } = (await lease(pilot)).cargo;
      const session = randomUUID();
      const sale = saleFor(pilot, leaseId, session, 1, [ORE]);
      await relay(pilot, manifestFor(pilot, leaseId, session, 2, [ROCK]));
      const next = (await lease(pilot)).cargo;
      assert.deepEqual(next.lots, [stored(ROCK)]);

      const res = await sell(pilot, sale);
      assert.equal(res.statusCode, 200, res.body);
      assert.equal(await credits(pilot), 61);
      assert.deepEqual((await hold(pilot)).lots, [stored(ROCK)]);
    });

    test('an overflowing sale changes nothing and stays creditable', async () => {
      const pilot = await newPilot();
      const { lease_id: leaseId } = (await lease(pilot)).cargo;
      const session = randomUUID();
      await relay(pilot, manifestFor(pilot, leaseId, session, 1, [ORE]));
      await setCredits(pilot, MAX_REWARD_CREDITS - 10);
      const sale = saleFor(pilot, leaseId, session, 2, [ORE]);

      const res = await sell(pilot, sale);
      assert.equal(res.statusCode, 409);
      assert.equal(json(res).code, 'credit_overflow');
      assert.equal(await credits(pilot), MAX_REWARD_CREDITS - 10);
      assert.deepEqual((await hold(pilot)).lots, [stored(ORE)]);

      await setCredits(pilot, 0);
      assert.equal((await sell(pilot, sale)).statusCode, 200);
      assert.equal(await credits(pilot), 61);
      assert.deepEqual((await hold(pilot)).lots, []);
    });

    test('a forged pilot, tampered total, lot or seq, or the login key is refused with 403', async () => {
      const pilot = await newPilot();
      const other = await newPilot();
      const { lease_id: leaseId } = (await lease(pilot)).cargo;
      const session = randomUUID();
      const good = saleFor(pilot, leaseId, session, 1, [ORE]);
      for (const bad of [
        saleFor(other, leaseId, session, 1, [ORE]),
        { ...good, totalCredits: 6100 },
        { ...good, items: [{ ...ORE, purityBp: 9000 }] },
        { ...good, remaining: [ROCK] },
        { ...good, seq: 2 },
        saleFor(pilot, leaseId, session, 1, [ORE], {}, loginKey)
      ]) {
        const res = await sell(pilot, bad);
        assert.equal(res.statusCode, 403);
        assert.equal(json(res).code, 'sale_record_invalid');
      }
      assert.equal(await credits(pilot), 0);
    });

    test('without a claim key manifests and sales are refused with 503', async () => {
      const pilot = await newPilot();
      const { lease_id: leaseId } = (await lease(pilot)).cargo;
      const session = randomUUID();
      const configured = app.claimKey;
      app.claimKey = null;
      try {
        for (const res of [
          await relay(pilot, manifestFor(pilot, leaseId, session, 1, [ORE])),
          await sell(pilot, saleFor(pilot, leaseId, session, 1, [ORE]))
        ]) {
          assert.equal(res.statusCode, 503);
          assert.equal(json(res).error, 'CLAIM_KEY_NOT_CONFIGURED');
        }
      } finally {
        app.claimKey = configured;
      }
      assert.equal(await credits(pilot), 0);
    });
  });
});
