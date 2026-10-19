import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createPublicKey, sign } from 'node:crypto';
import { PlanetarySurvey } from '../src/lib/contracts/exploration.js';
import { app, call, closeApp, credits, json, loginKey, newPilot, rtseKey } from './helpers.js';
import { computeShipAttributes } from '../src/config/components.js';
import {
  PLANET_CHART_DOMAIN,
  SYSTEM_CHART_DOMAIN,
  canonicalPlanetChartPayload,
  canonicalSystemChartPayload,
  verifySystemChartSignature
} from '../src/lib/chart-claim.js';

const SYSTEM = '8828308281fffff';
const surveyMsg = {
  scanProgressPct: 100,
  metals: ['IRON', 'NICKEL'],
  gases: ['HELIUM'],
  isFullyCharted: true
};
const surveyBytes = (msg = surveyMsg) => Buffer.from(PlanetarySurvey.encode(PlanetarySurvey.fromPartial(msg)).finish());
const sha256 = (bytes) => createHash('sha256').update(bytes).digest();

function planetKey(pilot, planetId = 'planet-1', bytes = surveyBytes(), completedAtMs = Date.now(), signer = rtseKey) {
  const key = { planetId, pilotId: pilot.id, systemH3: SYSTEM, completedAtMs };
  key.signature = sign(null, canonicalPlanetChartPayload(key, sha256(bytes)), signer).toString('base64');
  return key;
}

// Request body for register-planet.
// The pilot's stored captain XP (0 before the captain exists).
const captainXp = async (pilot) => (await app.prisma.captain.findUnique({ where: { playerId: pilot.id } }))?.xp ?? 0;

const register = (pilot, key, bytes = surveyBytes()) =>
  call(pilot, 'POST', '/game/charts/register-planet', { chartKey: key, surveyBytesBase64: bytes.toString('base64') });

// The RTSE's system digest: SHA-256 over every planet's survey hash, ordered by planet id.
const systemDigest = sha256(Buffer.concat([sha256(surveyBytes()), sha256(surveyBytes({ ...surveyMsg, gases: [] }))]));

function systemKey(pilot, signer = rtseKey, digest = systemDigest) {
  const key = { systemH3: SYSTEM, pilotId: pilot.id, totalBodiesCharted: 7, chartedAtMs: Date.now() };
  key.signature = sign(null, canonicalSystemChartPayload(key, digest), signer).toString('base64');
  key.systemDigest = digest.toString('base64');
  return key;
}

describe('SENSORS component', () => {
  test('domain tags are 21 bytes', () => {
    assert.equal(PLANET_CHART_DOMAIN.length, 21);
    assert.equal(SYSTEM_CHART_DOMAIN.length, 21);
    assert.equal(SYSTEM_CHART_DOMAIN.toString('utf8'), 'EOTHA_SYSTEM_CHART_V2');
  });

  // Known answers copied from eotha-rtse src/simulation/exploration/charts.rs
  // (signing_payloads_are_length_prefixed_and_domain_separated).
  test('signing payloads match the engine byte for byte', () => {
    const planet = canonicalPlanetChartPayload(
      { pilotId: 'p', planetId: 'ab', systemH3: '', completedAtMs: 0x0102 },
      Buffer.alloc(32, 9)
    );
    assert.deepEqual(planet, Buffer.concat([
      Buffer.from('EOTHA_PLANET_CHART_V1'),
      Buffer.from([1, 0, 0, 0, 0x70, 2, 0, 0, 0, 0x61, 0x62, 0, 0, 0, 0]),
      Buffer.from([2, 1, 0, 0, 0, 0, 0, 0]),
      Buffer.alloc(32, 9)
    ]));

    const system = canonicalSystemChartPayload(
      { pilotId: 'p', systemH3: 'ab', totalBodiesCharted: 3, chartedAtMs: 4 },
      Buffer.alloc(32, 8)
    );
    assert.deepEqual(system, Buffer.concat([
      Buffer.from('EOTHA_SYSTEM_CHART_V2'),
      Buffer.from([1, 0, 0, 0, 0x70, 2, 0, 0, 0, 0x61, 0x62]),
      Buffer.from([3, 0, 0, 0, 4, 0, 0, 0, 0, 0, 0, 0]),
      Buffer.alloc(32, 8)
    ]));
  });

  test('a system chart verifies only with the exact 32-byte digest', () => {
    const key = { pilotId: 'p', systemH3: SYSTEM, totalBodiesCharted: 3, chartedAtMs: 4 };
    key.signature = sign(null, canonicalSystemChartPayload(key, systemDigest), rtseKey).toString('base64');
    const pub = createPublicKey(rtseKey);
    assert.equal(verifySystemChartSignature(key, systemDigest, pub), true);
    const flipped = Buffer.from(systemDigest);
    flipped[31] ^= 1;
    assert.equal(verifySystemChartSignature(key, flipped, pub), false);
    assert.equal(verifySystemChartSignature(key, systemDigest.subarray(0, 31), pub), false);
    assert.equal(verifySystemChartSignature(key, undefined, pub), false);
  });

  test('computeShipAttributes maps every SENSORS tier', () => {
    const range = [1500, 3000, 4500, 6000, 7500];
    const mult = [1.0, 0.85, 0.7, 0.55, 0.4];
    range.forEach((r, i) => {
      const a = computeShipAttributes([{ type: 'SENSORS', tier: i + 1 }]);
      assert.equal(a.sensor_range_m, r);
      assert.equal(a.sensor_cooldown_mult, mult[i]);
      assert.equal(a.sensor_tier, i + 1);
    });
    const def = computeShipAttributes();
    assert.equal(def.sensor_range_m, 1500);
    assert.equal(def.sensor_tier, 1);
  });
});

describe('cartography', () => {
  before(async () => { await app.ready(); });
  after(async () => { await closeApp(); });

  test('requires authentication', async () => {
    for (const [method, url] of [['GET', '/game/charts/inventory'], ['POST', '/game/charts/sell']]) {
      assert.equal((await app.inject({ method, url })).statusCode, 401);
    }
  });

  test('chart keys signed with the login key are rejected; only the claim key verifies them', async () => {
    const pilot = await newPilot('Forger');
    const planet = planetKey(pilot, 'planet-login', surveyBytes(), Date.now(), loginKey);
    assert.equal((await register(pilot, planet)).statusCode, 403);
    const system = systemKey(pilot, loginKey);
    assert.equal((await call(pilot, 'POST', '/game/charts/claim-system', { systemKey: system })).statusCode, 403);

    const inv = json(await call(pilot, 'GET', '/game/charts/inventory'));
    assert.deepEqual([inv.planetCharts.length, inv.systemCharts.length], [0, 0]);
    assert.equal(await credits(pilot), 0);

    assert.equal((await register(pilot, planetKey(pilot, 'planet-login'))).statusCode, 200);
    assert.equal((await call(pilot, 'POST', '/game/charts/claim-system', { systemKey: systemKey(pilot) })).statusCode, 200);
  });

  test('chart registration refuses with a stable error when no claim key is configured', async () => {
    const pilot = await newPilot('Keyless');
    const planet = planetKey(pilot);
    const system = systemKey(pilot);
    const configured = app.claimKey;
    app.claimKey = null;
    try {
      for (const res of [
        await register(pilot, planet),
        await call(pilot, 'POST', '/game/charts/claim-system', { systemKey: system })
      ]) {
        assert.equal(res.statusCode, 503);
        assert.equal(json(res).error, 'CLAIM_KEY_NOT_CONFIGURED');
      }
    } finally {
      app.claimKey = configured;
    }
    assert.equal((await register(pilot, planet)).statusCode, 200);
  });

  test('registers a signed planet chart, deriving the survey from the signed bytes', async () => {
    const pilot = await newPilot('Cartographer');
    const res = await register(pilot, planetKey(pilot));
    assert.equal(res.statusCode, 200);
    assert.deepEqual(json(res), { registered: true, planetId: 'planet-1', xpGained: 35, currentLevel: 1, traitPointsAvailable: 0 });

    const inv = json(await call(pilot, 'GET', '/game/charts/inventory'));
    assert.equal(inv.planetCharts.length, 1);
    assert.equal(inv.planetCharts[0].planetId, 'planet-1');
    assert.equal(inv.planetCharts[0].sold, false);
    assert.deepEqual(inv.systemCharts, []);

    const q = json(await call(pilot, 'GET', '/game/charts/query?planetId=planet-1'));
    assert.deepEqual(q.survey, { scanProgressPct: 100, metals: ['IRON', 'NICKEL'], gases: ['HELIUM'], isFullyCharted: true });
    assert.equal((await call(pilot, 'GET', '/game/charts/query?planetId=nope')).statusCode, 404);
    assert.equal((await call(pilot, 'GET', '/game/charts/query')).statusCode, 400);
  });

  test('requires surveyBytesBase64 and ignores a client-supplied survey object', async () => {
    const pilot = await newPilot('NoBytes');
    const key = planetKey(pilot);
    let res = await call(pilot, 'POST', '/game/charts/register-planet', { chartKey: key, survey: { forged: true } });
    assert.equal(res.statusCode, 400);
    res = await call(pilot, 'POST', '/game/charts/register-planet', {
      chartKey: key, surveyBytesBase64: surveyBytes().toString('base64'), survey: { forged: true }
    });
    assert.equal(res.statusCode, 200);
    const q = json(await call(pilot, 'GET', '/game/charts/query?planetId=planet-1'));
    assert.equal(q.survey.forged, undefined);
  });

  test('rejects tampered signatures, forged surveys and foreign pilots', async () => {
    const pilot = await newPilot('Forger');
    const other = await newPilot('Victim');
    const key = planetKey(pilot);

    const badSig = Buffer.from(key.signature, 'base64');
    badSig[0] ^= 0xff;
    assert.equal((await register(pilot, { ...key, signature: badSig.toString('base64') })).statusCode, 403);

    // Survey bytes swapped after signing (e.g. richer resources).
    const forged = surveyBytes({ ...surveyMsg, metals: ['IRON', 'NICKEL', 'PLATINUM', 'GOLD'] });
    assert.equal((await register(pilot, key, forged)).statusCode, 403);

    // Altered key fields.
    assert.equal((await register(pilot, { ...key, planetId: 'other-planet' })).statusCode, 403);
    assert.equal((await register(pilot, { ...key, completedAtMs: key.completedAtMs + 1 })).statusCode, 403);

    // Another pilot's chart.
    assert.equal((await register(other, key)).statusCode, 403);

    // Malformed signature.
    assert.equal((await register(pilot, { ...key, signature: 'AAAA' })).statusCode, 403);

    const inv = json(await call(pilot, 'GET', '/game/charts/inventory'));
    assert.equal(inv.planetCharts.length, 0);
    assert.equal(await captainXp(pilot), 0);
    assert.equal(await captainXp(other), 0);
  });

  test('rejects signed bytes that are not a valid PlanetarySurvey', async () => {
    const pilot = await newPilot('Garbage');
    const garbage = Buffer.from([0xff, 0xff, 0xff, 0xff]);
    assert.equal((await register(pilot, planetKey(pilot, 'planet-g', garbage), garbage)).statusCode, 400);
  });

  test('prevents stale-key replay and overwriting sold charts', async () => {
    const pilot = await newPilot('Replayer');
    const t0 = Date.now() - 10_000;
    const first = planetKey(pilot, 'planet-r', surveyBytes(), t0);
    assert.equal((await register(pilot, first)).statusCode, 200);

    // Identical and older timestamps are stale.
    let res = await register(pilot, first);
    assert.equal(res.statusCode, 409);
    assert.deepEqual(json(res), { error: 'STALE_CHART_KEY', message: 'Existing chart has newer or identical timestamp' });
    assert.equal((await register(pilot, planetKey(pilot, 'planet-r', surveyBytes(), t0 - 1))).statusCode, 409);

    // A newer key supersedes.
    const richer = surveyBytes({ ...surveyMsg, metals: ['IRON'] });
    assert.equal((await register(pilot, planetKey(pilot, 'planet-r', richer, t0 + 1), richer)).statusCode, 200);

    // Once sold, even a newer key cannot overwrite it.
    assert.equal((await call(pilot, 'POST', '/game/charts/sell', { planetId: 'planet-r', stationId: 'station-alpha' })).statusCode, 200);
    res = await register(pilot, planetKey(pilot, 'planet-r', surveyBytes(), t0 + 2));
    assert.equal(res.statusCode, 409);
    assert.equal(json(res).error, 'CHART_ALREADY_SOLD');

    // Captain XP was earned once, by the first registration; replays and newer keys earn none.
    assert.equal(await captainXp(pilot), 35);
  });

  test('concurrent registrations of one planet award its captain XP once', async () => {
    const pilot = await newPilot('Racer');
    const keys = [0, 1, 2].map((i) => planetKey(pilot, 'planet-race', surveyBytes(), Date.now() - 1000 + i));
    const results = await Promise.all(keys.map((key) => register(pilot, key)));
    assert.equal(results.filter((r) => json(r).xpGained === 35).length, 1);
    assert.equal(await captainXp(pilot), 35);
  });

  test('claims a system chart and rejects tampering', async () => {
    const pilot = await newPilot('SystemClaimer');
    const key = systemKey(pilot);
    let res = await call(pilot, 'POST', '/game/charts/claim-system', { systemKey: { ...key, totalBodiesCharted: 99 } });
    assert.equal(res.statusCode, 403);
    res = await call(pilot, 'POST', '/game/charts/claim-system', { systemKey: key });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(json(res), { claimed: true, systemH3: SYSTEM, xpGained: 150, currentLevel: 1, traitPointsAvailable: 0 });
    const inv = json(await call(pilot, 'GET', '/game/charts/inventory'));
    assert.equal(inv.systemCharts[0].totalBodiesCharted, 7);
    assert.equal(inv.systemCharts[0].systemDigest, systemDigest.toString('base64'));

    // Duplicate claims (even with a fresh valid signature) are rejected.
    res = await call(pilot, 'POST', '/game/charts/claim-system', { systemKey: systemKey(pilot) });
    assert.equal(res.statusCode, 409);
    assert.deepEqual(json(res), { error: 'SYSTEM_ALREADY_CLAIMED' });
    assert.equal(await captainXp(pilot), 150);
  });

  test('concurrent claims of one system award its captain XP once', async () => {
    const pilot = await newPilot('SystemRacer');
    const results = await Promise.all([0, 1, 2].map(() => call(pilot, 'POST', '/game/charts/claim-system', { systemKey: systemKey(pilot) })));
    assert.deepEqual(results.map((r) => r.statusCode).sort(), [200, 409, 409]);
    assert.equal(await captainXp(pilot), 150);
  });

  test('rejects V1 system chart keys and keys whose digest does not match the signature', async () => {
    const pilot = await newPilot('LegacyClaimer');
    const claim = (systemKey) => call(pilot, 'POST', '/game/charts/claim-system', { systemKey });

    // A V1 key: signed over the payload without a digest, and submitted without one.
    const v1 = { systemH3: SYSTEM, pilotId: pilot.id, totalBodiesCharted: 7, chartedAtMs: Date.now() };
    const v1Payload = Buffer.concat([
      Buffer.from('EOTHA_SYSTEM_CHART_V1'),
      canonicalSystemChartPayload(v1, Buffer.alloc(0)).subarray(SYSTEM_CHART_DOMAIN.length)
    ]);
    v1.signature = sign(null, v1Payload, rtseKey).toString('base64');
    assert.equal((await claim(v1)).statusCode, 400);
    assert.equal((await claim({ ...v1, systemDigest: systemDigest.toString('base64') })).statusCode, 403);

    // A V2 key whose digest is swapped, truncated or not base64.
    const key = systemKey(pilot);
    const other = sha256(Buffer.from('another system'));
    assert.equal((await claim({ ...key, systemDigest: other.toString('base64') })).statusCode, 403);
    assert.equal((await claim({ ...key, systemDigest: systemDigest.subarray(0, 31).toString('base64') })).statusCode, 400);
    assert.equal((await claim({ ...key, systemDigest: '!'.repeat(43) + '=' })).statusCode, 400);

    const inv = json(await call(pilot, 'GET', '/game/charts/inventory'));
    assert.deepEqual(inv.systemCharts, []);
    assert.equal((await claim(key)).statusCode, 200);
  });

  test('sells charts once for credits', async () => {
    const pilot = await newPilot('Merchant');
    await register(pilot, planetKey(pilot));
    await call(pilot, 'POST', '/game/charts/claim-system', { systemKey: systemKey(pilot) });

    let res = await call(pilot, 'POST', '/game/charts/sell', { planetId: 'planet-1', stationId: 'station-alpha' });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(json(res), { sold: true, rewardCredits: 500, newBalance: 500 });

    res = await call(pilot, 'POST', '/game/charts/sell', { systemH3: SYSTEM, stationId: 'station-alpha' });
    assert.deepEqual(json(res), { sold: true, rewardCredits: 2500, newBalance: 3000 });

    // No double payout, no unknown charts, exactly one target.
    res = await call(pilot, 'POST', '/game/charts/sell', { planetId: 'planet-1', stationId: 'station-alpha' });
    assert.equal(res.statusCode, 409);
    res = await call(pilot, 'POST', '/game/charts/sell', { planetId: 'ghost', stationId: 'station-alpha' });
    assert.equal(res.statusCode, 404);
    res = await call(pilot, 'POST', '/game/charts/sell', { planetId: 'planet-1', systemH3: SYSTEM, stationId: 'station-alpha' });
    assert.equal(res.statusCode, 400);

    assert.equal(await credits(pilot), 3000);
    const inv = json(await call(pilot, 'GET', '/game/charts/inventory'));
    assert.equal(inv.planetCharts[0].sold, true);
  });
});
