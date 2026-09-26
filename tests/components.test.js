import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import app from '../src/app.js';
import { computeShipAttributes, defaultComponents, COMPONENT_TYPES } from '../src/config/components.js';

describe('computeShipAttributes', () => {
  test('defaults missing components to Tier 1', () => {
    const a = computeShipAttributes([]);
    assert.equal(a.max_hull_hp, 100);
    assert.equal(a.dry_mass_kg, 1000);
    assert.equal(a.max_shield_hp, 50);
    assert.equal(a.shield_regen_rate, 5);
    assert.equal(a.radar_range_m, 500);
    assert.equal(a.identification_range_m, 150);
    assert.equal(a.cargo_capacity_m3, 20);
    assert.equal(a.stealth_rating, 0.0);
    assert.equal(a.signature_dissipation_rate, 1.0);
    assert.equal(a.weapon_dps, 10);
    assert.equal(a.weapon_range_m, 300);
    assert.equal(a.energy_capacity, 100);
    assert.equal(a.energy_regen_rate, 10);
    assert.equal(a.comms_range_m, 1000);
    assert.equal(a.max_speed_mps, 20);
    assert.deepEqual(computeShipAttributes(), a);
  });

  test('computes Tier 5 values for every component', () => {
    const a = computeShipAttributes(COMPONENT_TYPES.map((type) => ({ type, tier: 5 })));
    assert.deepEqual(a, {
      max_hull_hp: 2000, dry_mass_kg: 4000,
      max_shield_hp: 1000, shield_regen_rate: 50,
      radar_range_m: 4000, identification_range_m: 2000, cargo_capacity_m3: 320, stealth_rating: 0.8,
      signature_dissipation_rate: 2.2,
      weapon_dps: 200, weapon_range_m: 1000,
      energy_capacity: 1500, energy_regen_rate: 75,
      comms_range_m: 25000, max_speed_mps: 100
    });
  });

  test('mixes tiers and is deterministic', () => {
    const comps = [{ type: 'HULL', tier: 3 }, { type: 'ENGINES', tier: 2 }];
    const a = computeShipAttributes(comps);
    assert.equal(a.max_hull_hp, 500);
    assert.equal(a.dry_mass_kg, 2200);
    assert.equal(a.max_speed_mps, 35);
    assert.equal(a.radar_range_m, 500);
    assert.equal(a.identification_range_m, 150);
    assert.deepEqual(computeShipAttributes(comps), a);
  });

  test('maps every radar tier to its identification range', () => {
    const expected = [150, 350, 700, 1100, 2000];
    expected.forEach((range, i) => {
      const a = computeShipAttributes([{ type: 'RADAR', tier: i + 1 }]);
      assert.equal(a.identification_range_m, range);
    });
  });

  test('maps every stealth tier to its signature dissipation rate', () => {
    const expected = [1.0, 1.25, 1.5, 1.8, 2.2];
    expected.forEach((rate, i) => {
      const a = computeShipAttributes([{ type: 'STEALTH', tier: i + 1 }]);
      assert.equal(a.signature_dissipation_rate, rate);
    });
  });

  test('falls back to Tier 1 signature dissipation rate for invalid tiers', () => {
    for (const tier of [0, 6, 2.5, null, undefined, 'x']) {
      const a = computeShipAttributes([{ type: 'STEALTH', tier }]);
      assert.equal(a.signature_dissipation_rate, 1.0);
    }
  });

  test('falls back to Tier 1 identification range for invalid tiers', () => {
    for (const tier of [0, 6, 2.5, null, undefined, 'x']) {
      const a = computeShipAttributes([{ type: 'RADAR', tier }]);
      assert.equal(a.identification_range_m, 150);
    }
  });
});

describe('ship components over HTTP', () => {
  before(async () => { await app.ready(); });
  after(async () => { await app.close(); });

  async function login() {
    const res = await app.inject({ method: 'GET', url: '/auth/dev-login?callsign=Shipper' });
    return JSON.parse(res.body);
  }

  test('GET /auth/dev-login includes ship and JWT ship_attributes', async () => {
    const json = await login();
    assert.equal(json.player.ship.components.length, 9);
    assert.ok(json.player.ship.components.every((c) => c.tier === 1));
    assert.deepEqual(json.player.ship.ship_attributes, computeShipAttributes(defaultComponents()));
    const decoded = app.jwt.verify(json.token);
    assert.equal(decoded.ship_attributes.identification_range_m, 150);
    assert.equal(decoded.ship_attributes.signature_dissipation_rate, 1.0);
    assert.deepEqual(decoded.ship_attributes, json.player.ship.ship_attributes);
  });

  test('GET /ship/loadout and POST /ship/upgrade for dev pilot', async () => {
    const { token } = await login();
    const headers = { authorization: `Bearer ${token}` };

    const unauth = await app.inject({ method: 'GET', url: '/ship/loadout' });
    assert.equal(unauth.statusCode, 401);

    const loadout = await app.inject({ method: 'GET', url: '/ship/loadout', headers });
    assert.equal(loadout.statusCode, 200);
    assert.equal(JSON.parse(loadout.body).ship_attributes.max_hull_hp, 100);

    const up = await app.inject({
      method: 'POST', url: '/ship/upgrade', headers,
      payload: { componentType: 'HULL', targetTier: 3 }
    });
    assert.equal(up.statusCode, 200);
    assert.equal(JSON.parse(up.body).ship_attributes.max_hull_hp, 500);
    const reissued = app.jwt.verify(JSON.parse(up.body).token);
    assert.equal(reissued.sub, app.jwt.verify(token).sub);
    assert.equal(reissued.mock, true);
    assert.equal(reissued.ship_attributes.max_hull_hp, 500);

    const radarUp = await app.inject({
      method: 'POST', url: '/ship/upgrade', headers,
      payload: { componentType: 'RADAR', targetTier: 3 }
    });
    assert.equal(radarUp.statusCode, 200);
    const radarBody = JSON.parse(radarUp.body);
    assert.equal(radarBody.ship_attributes.identification_range_m, 700);
    assert.equal(app.jwt.verify(radarBody.token).ship_attributes.identification_range_m, 700);

    const stealthUp = await app.inject({
      method: 'POST', url: '/ship/upgrade', headers,
      payload: { componentType: 'STEALTH', targetTier: 4 }
    });
    assert.equal(stealthUp.statusCode, 200);
    const stealthBody = JSON.parse(stealthUp.body);
    assert.equal(stealthBody.ship_attributes.signature_dissipation_rate, 1.8);
    assert.equal(app.jwt.verify(stealthBody.token).ship_attributes.signature_dissipation_rate, 1.8);

    for (const payload of [
      { componentType: 'HULL', targetTier: 6 },
      { componentType: 'HULL', targetTier: 0 },
      { componentType: 'BOGUS', targetTier: 2 },
      { componentType: 'HULL', targetTier: 2 }
    ]) {
      const bad = await app.inject({ method: 'POST', url: '/ship/upgrade', headers, payload });
      assert.equal(bad.statusCode, 400);
    }
  });
});

describe('cargo capacity matrix', () => {
  test('maps every cargo tier to its capacity', () => {
    [20.0, 40.0, 80.0, 160.0, 320.0].forEach((cap, i) => {
      assert.equal(computeShipAttributes([{ type: 'CARGO', tier: i + 1 }]).cargo_capacity_m3, cap);
    });
  });
});
