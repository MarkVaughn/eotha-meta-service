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
    assert.equal(a.cargo_capacity_m3, 10);
    assert.equal(a.stealth_rating, 0.0);
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
      radar_range_m: 4000, cargo_capacity_m3: 200, stealth_rating: 0.8,
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
    assert.deepEqual(computeShipAttributes(comps), a);
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
