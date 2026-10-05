import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, sign } from 'node:crypto';
import { PlanetarySurvey } from '../src/lib/contracts/exploration.js';
import { app, call, closeApp, credits, json, newPilot, rtseKey } from './helpers.js';
import { computeShipAttributes } from '../src/config/components.js';
import {
  PLANET_CHART_DOMAIN,
  SYSTEM_CHART_DOMAIN,
  canonicalPlanetChartPayload,
  canonicalSystemChartPayload
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

function planetKey(pilot, planetId = 'planet-1', bytes = surveyBytes(), completedAtMs = Date.now()) {
  const key = { planetId, pilotId: pilot.id, systemH3: SYSTEM, completedAtMs };
  key.signature = sign(null, canonicalPlanetChartPayload(key, sha256(bytes)), rtseKey).toString('base64');
  return key;
}

// Request body for register-planet.
const register = (pilot, key, bytes = surveyBytes()) =>
  call(pilot, 'POST', '/game/charts/register-planet', { chartKey: key, surveyBytesBase64: bytes.toString('base64') });

function systemKey(pilot) {
  const key = { systemH3: SYSTEM, pilotId: pilot.id, totalBodiesCharted: 7, chartedAtMs: Date.now() };
  key.signature = sign(null, canonicalSystemChartPayload(key), rtseKey).toString('base64');
  return key;
}

describe('SENSORS component', () => {
  test('domain tags are 21 bytes', () => {
    assert.equal(PLANET_CHART_DOMAIN.length, 21);
    assert.equal(SYSTEM_CHART_DOMAIN.length, 21);
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

  test('registers a signed planet chart, deriving the survey from the signed bytes', async () => {
    const pilot = await newPilot('Cartographer');
    const res = await register(pilot, planetKey(pilot));
    assert.equal(res.statusCode, 200);
    assert.deepEqual(json(res), { registered: true, planetId: 'planet-1' });

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
  });

  test('claims a system chart and rejects tampering', async () => {
    const pilot = await newPilot('SystemClaimer');
    const key = systemKey(pilot);
    let res = await call(pilot, 'POST', '/game/charts/claim-system', { systemKey: { ...key, totalBodiesCharted: 99 } });
    assert.equal(res.statusCode, 403);
    res = await call(pilot, 'POST', '/game/charts/claim-system', { systemKey: key });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(json(res), { claimed: true, systemH3: SYSTEM });
    const inv = json(await call(pilot, 'GET', '/game/charts/inventory'));
    assert.equal(inv.systemCharts[0].totalBodiesCharted, 7);

    // Duplicate claims (even with a fresh valid signature) are rejected.
    res = await call(pilot, 'POST', '/game/charts/claim-system', { systemKey: systemKey(pilot) });
    assert.equal(res.statusCode, 409);
    assert.deepEqual(json(res), { error: 'SYSTEM_ALREADY_CLAIMED' });
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
