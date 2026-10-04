import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createPrivateKey, createHash, sign } from 'node:crypto';
import app from '../src/app.js';
import { computeShipAttributes } from '../src/config/components.js';
import {
  PLANET_CHART_DOMAIN,
  SYSTEM_CHART_DOMAIN,
  canonicalJson,
  canonicalPlanetChartPayload,
  canonicalSystemChartPayload
} from '../src/lib/chart-claim.js';

const SYSTEM = '8828308281fffff';
const hasKey = existsSync('keys/private.pem');
const rtseKey = hasKey ? createPrivateKey(readFileSync('keys/private.pem', 'utf8')) : null;
const skip = hasKey ? false : 'keys/private.pem not present';

const json = (res) => JSON.parse(res.body);

async function newPilot(callsign) {
  const { token, player } = json(await app.inject({ method: 'GET', url: `/auth/dev-login?callsign=${callsign}` }));
  return { id: player.id, headers: { authorization: `Bearer ${token}` } };
}

const call = (pilot, method, url, payload) => app.inject({ method, url, headers: pilot.headers, payload });

const survey = { planetId: 'planet-1', biome: 'ICE', resources: [{ kind: 'IRON', pct: 12 }, { kind: 'HELIUM', pct: 3 }] };

function planetKey(pilot, planetId = 'planet-1', s = survey) {
  const key = { planetId, pilotId: pilot.id, systemH3: SYSTEM, completedAtMs: Date.now() };
  const hash = createHash('sha256').update(Buffer.from(canonicalJson(s), 'utf8')).digest();
  key.signature = sign(null, canonicalPlanetChartPayload(key, hash), rtseKey).toString('base64');
  return key;
}

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
  after(async () => { await app.close(); });

  test('requires authentication', async () => {
    for (const [method, url] of [['GET', '/game/charts/inventory'], ['POST', '/game/charts/sell']]) {
      assert.equal((await app.inject({ method, url })).statusCode, 401);
    }
  });

  test('registers a signed planet chart and lists it', { skip }, async () => {
    const pilot = await newPilot('Cartographer');
    const res = await call(pilot, 'POST', '/game/charts/register-planet', { chartKey: planetKey(pilot), survey });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(json(res), { registered: true, planetId: 'planet-1' });

    const inv = json(await call(pilot, 'GET', '/game/charts/inventory'));
    assert.equal(inv.planetCharts.length, 1);
    assert.equal(inv.planetCharts[0].planetId, 'planet-1');
    assert.equal(inv.planetCharts[0].sold, false);
    assert.deepEqual(inv.systemCharts, []);

    const q = json(await call(pilot, 'GET', '/game/charts/query?planetId=planet-1'));
    assert.deepEqual(q.survey, survey);
    assert.equal((await call(pilot, 'GET', '/game/charts/query?planetId=nope')).statusCode, 404);
    assert.equal((await call(pilot, 'GET', '/game/charts/query')).statusCode, 400);
  });

  test('hashes surveyBytesBase64 when supplied', { skip }, async () => {
    const pilot = await newPilot('ByteHasher');
    const bytes = Buffer.from('raw-proto-bytes');
    const key = { planetId: 'p-bytes', pilotId: pilot.id, systemH3: SYSTEM, completedAtMs: Date.now() };
    key.signature = sign(null, canonicalPlanetChartPayload(key, createHash('sha256').update(bytes).digest()), rtseKey).toString('base64');
    const res = await call(pilot, 'POST', '/game/charts/register-planet', {
      chartKey: key, survey, surveyBytesBase64: bytes.toString('base64')
    });
    assert.equal(res.statusCode, 200);
  });

  test('rejects tampered signatures, surveys and foreign pilots', { skip }, async () => {
    const pilot = await newPilot('Forger');
    const other = await newPilot('Victim');
    const key = planetKey(pilot);

    const badSig = Buffer.from(key.signature, 'base64');
    badSig[0] ^= 0xff;
    let res = await call(pilot, 'POST', '/game/charts/register-planet', {
      chartKey: { ...key, signature: badSig.toString('base64') }, survey
    });
    assert.equal(res.statusCode, 403);

    // Survey altered after signing.
    res = await call(pilot, 'POST', '/game/charts/register-planet', {
      chartKey: key, survey: { ...survey, biome: 'LAVA' }
    });
    assert.equal(res.statusCode, 403);

    // Altered key field.
    res = await call(pilot, 'POST', '/game/charts/register-planet', {
      chartKey: { ...key, planetId: 'other-planet' }, survey
    });
    assert.equal(res.statusCode, 403);

    // Another pilot's chart.
    res = await call(other, 'POST', '/game/charts/register-planet', { chartKey: key, survey });
    assert.equal(res.statusCode, 403);

    // Malformed signature.
    res = await call(pilot, 'POST', '/game/charts/register-planet', { chartKey: { ...key, signature: 'AAAA' }, survey });
    assert.equal(res.statusCode, 403);

    const inv = json(await call(pilot, 'GET', '/game/charts/inventory'));
    assert.equal(inv.planetCharts.length, 0);
  });

  test('claims a system chart and rejects tampering', { skip }, async () => {
    const pilot = await newPilot('SystemClaimer');
    const key = systemKey(pilot);
    let res = await call(pilot, 'POST', '/game/charts/claim-system', { systemKey: { ...key, totalBodiesCharted: 99 } });
    assert.equal(res.statusCode, 403);
    res = await call(pilot, 'POST', '/game/charts/claim-system', { systemKey: key });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(json(res), { claimed: true, systemH3: SYSTEM });
    const inv = json(await call(pilot, 'GET', '/game/charts/inventory'));
    assert.equal(inv.systemCharts[0].totalBodiesCharted, 7);
  });

  test('sells charts once for credits', { skip }, async () => {
    const pilot = await newPilot('Merchant');
    await call(pilot, 'POST', '/game/charts/register-planet', { chartKey: planetKey(pilot), survey });
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

    assert.equal(json(await call(pilot, 'GET', '/game/credits')).credits, 3000);
    const inv = json(await call(pilot, 'GET', '/game/charts/inventory'));
    assert.equal(inv.planetCharts[0].sold, true);
  });
});
