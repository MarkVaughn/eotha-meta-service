import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import app from '../src/app.js';
import {
  computeShipAttributes,
  defaultComponents,
  COMPONENT_TYPES,
  OPTIONAL_COMPONENTS,
  hullBudget,
  totalSubsystemPoints
} from '../src/config/components.js';

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
    assert.equal(a.passenger_capacity, 2);
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
      comms_range_m: 25000, max_speed_mps: 100,
      passenger_capacity: 50
    });
  });

  test('maps every life support tier to its passenger capacity', () => {
    const expected = [2, 5, 10, 20, 50];
    expected.forEach((capacity, i) => {
      const a = computeShipAttributes([{ type: 'LIFE_SUPPORT', tier: i + 1 }]);
      assert.equal(a.passenger_capacity, capacity);
    });
  });

  test('Tier 0 optional components yield 0 stats (baseline nominal for rate multipliers)', () => {
    const zeroedAttrsByType = {
      SHIELDS: ['max_shield_hp', 'shield_regen_rate'],
      WEAPONS: ['weapon_dps', 'weapon_range_m'],
      CARGO: ['cargo_capacity_m3'],
      STEALTH: ['stealth_rating'],
      COMMS: ['comms_range_m']
    };
    assert.deepEqual(Object.keys(zeroedAttrsByType).sort(), [...OPTIONAL_COMPONENTS].sort());

    for (const [type, attrs] of Object.entries(zeroedAttrsByType)) {
      const a = computeShipAttributes([{ type, tier: 0 }]);
      for (const attr of attrs) assert.equal(a[attr], 0, `${type} tier 0 expected ${attr} to be 0`);
    }

    const stealthOff = computeShipAttributes([{ type: 'STEALTH', tier: 0 }]);
    assert.equal(stealthOff.stealth_rating, 0);
    assert.equal(stealthOff.signature_dissipation_rate, 1.0);
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

describe('hullBudget', () => {
  test('maps hull tiers 1-5 to their subsystem point budgets', () => {
    assert.equal(hullBudget(1), 5);
    assert.equal(hullBudget(2), 10);
    assert.equal(hullBudget(3), 18);
    assert.equal(hullBudget(4), 27);
    assert.equal(hullBudget(5), 36);
  });

  test('sums non-hull component tiers for totalSubsystemPoints', () => {
    assert.equal(totalSubsystemPoints(defaultComponents()), 5);
    assert.equal(totalSubsystemPoints([{ type: 'HULL', tier: 5 }, { type: 'RADAR', tier: 3 }]), 3);
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
    assert.equal(json.player.ship.components.length, 10);
    const tierOneTypes = ['HULL', 'RADAR', 'ENGINES', 'ENERGY', 'LIFE_SUPPORT', 'CARGO'];
    for (const c of json.player.ship.components) {
      assert.equal(c.tier, tierOneTypes.includes(c.type) ? 1 : 0, `${c.type} default tier`);
    }
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

  test('POST /ship/upgrade enforces hull budget and essential/optional tier 0 rules', async () => {
    const { token } = await login();
    const headers = { authorization: `Bearer ${token}` };

    // Default loadout uses exactly the Hull Tier 1 budget (5 points); any further
    // subsystem upgrade without first raising the hull tier must be rejected.
    const overBudget = await app.inject({
      method: 'POST', url: '/ship/upgrade', headers,
      payload: { componentType: 'RADAR', targetTier: 2 }
    });
    assert.equal(overBudget.statusCode, 400);
    assert.match(JSON.parse(overBudget.body).error, /Hull Tier 1 budget of 5 points/);

    // Essential components cannot be unequipped.
    const essentialToZero = await app.inject({
      method: 'POST', url: '/ship/upgrade', headers,
      payload: { componentType: 'LIFE_SUPPORT', targetTier: 0 }
    });
    assert.equal(essentialToZero.statusCode, 400);
    assert.match(JSON.parse(essentialToZero.body).error, /essential component and cannot be unequipped/);

    // Optional components may be explicitly set to Tier 0 (they already default there).
    const shieldsAlreadyZero = await app.inject({
      method: 'POST', url: '/ship/upgrade', headers,
      payload: { componentType: 'SHIELDS', targetTier: 0 }
    });
    assert.equal(shieldsAlreadyZero.statusCode, 400);
    assert.match(JSON.parse(shieldsAlreadyZero.body).error, /already at tier 0/);

    // Raising the hull tier first grows the budget so the same subsystem upgrade now fits.
    const hullUp = await app.inject({
      method: 'POST', url: '/ship/upgrade', headers,
      payload: { componentType: 'HULL', targetTier: 2 }
    });
    assert.equal(hullUp.statusCode, 200);

    const radarUp = await app.inject({
      method: 'POST', url: '/ship/upgrade', headers,
      payload: { componentType: 'RADAR', targetTier: 2 }
    });
    assert.equal(radarUp.statusCode, 200);

    // Equipping an optional component to a non-zero tier now consumes budget, and is permitted.
    const shieldsUp = await app.inject({
      method: 'POST', url: '/ship/upgrade', headers,
      payload: { componentType: 'SHIELDS', targetTier: 1 }
    });
    assert.equal(shieldsUp.statusCode, 200);
    assert.equal(JSON.parse(shieldsUp.body).ship_attributes.max_shield_hp, 50);
  });
});

describe('cargo capacity matrix', () => {
  test('maps every cargo tier to its capacity', () => {
    [20.0, 40.0, 80.0, 160.0, 320.0].forEach((cap, i) => {
      assert.equal(computeShipAttributes([{ type: 'CARGO', tier: i + 1 }]).cargo_capacity_m3, cap);
    });
  });
});
