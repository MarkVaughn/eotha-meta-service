import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { app, call, closeApp, credits, json, newPilot, setCredits } from './helpers.js';
import {
  computeShipAttributes,
  defaultComponents,
  COMPONENT_TYPES,
  OPTIONAL_COMPONENTS,
  hullBudget,
  totalSubsystemPoints,
  upgradeCost,
  TIER_UPGRADE_COST
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
      passenger_capacity: 50,
      sensor_range_m: 7500, sensor_cooldown_mult: 0.4, sensor_tier: 5
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
    assert.equal(hullBudget(1), 6);
    assert.equal(hullBudget(2), 10);
    assert.equal(hullBudget(3), 18);
    assert.equal(hullBudget(4), 27);
    assert.equal(hullBudget(5), 36);
  });

  test('sums non-hull component tiers for totalSubsystemPoints', () => {
    assert.equal(totalSubsystemPoints(defaultComponents()), 6);
    assert.equal(totalSubsystemPoints([{ type: 'HULL', tier: 5 }, { type: 'RADAR', tier: 3 }]), 3);
  });
});

describe('upgradeCost', () => {
  test('charges each tier step once, so multi-tier upgrades sum their steps', () => {
    assert.equal(upgradeCost(1, 2), TIER_UPGRADE_COST[2]);
    assert.equal(upgradeCost(0, 1), TIER_UPGRADE_COST[1]);
    assert.equal(upgradeCost(1, 3), TIER_UPGRADE_COST[2] + TIER_UPGRADE_COST[3]);
    assert.equal(upgradeCost(0, 5), Object.values(TIER_UPGRADE_COST).reduce((a, b) => a + b, 0));
    assert.equal(upgradeCost(3, 3), 0);
  });
});

describe('ship components over HTTP', () => {
  before(async () => { await app.ready(); });
  after(async () => { await closeApp(); });

  const upgrade = (pilot, componentType, targetTier) =>
    call(pilot, 'POST', '/ship/upgrade', { componentType, targetTier });
  const loadout = async (pilot) => json(await call(pilot, 'GET', '/ship/loadout'));
  const tierOf = (lo, type) => lo.components.find((c) => c.type === type).tier;

  test('login embeds default ship attributes in the JWT', async () => {
    const pilot = await newPilot('Shipper');
    const decoded = app.jwt.verify(pilot.token);
    assert.deepEqual(decoded.ship_attributes, computeShipAttributes(defaultComponents()));
    assert.equal(decoded.ship_attributes.identification_range_m, 150);
    assert.equal(decoded.ship_attributes.signature_dissipation_rate, 1.0);
  });

  test('GET /ship/loadout creates one default ship per pilot, even under concurrency', async () => {
    const pilot = await newPilot('Loadout');
    assert.equal((await app.inject({ method: 'GET', url: '/ship/loadout' })).statusCode, 401);

    const results = await Promise.all([1, 2, 3, 4].map(() => call(pilot, 'GET', '/ship/loadout')));
    for (const res of results) assert.equal(res.statusCode, 200);
    assert.equal(new Set(results.map((r) => json(r).ship_id)).size, 1);
    assert.equal(await app.prisma.spaceship.count({ where: { playerId: pilot.id } }), 1);

    const lo = json(results[0]);
    assert.equal(lo.components.length, 11);
    const tierOneTypes = ['HULL', 'RADAR', 'ENGINES', 'ENERGY', 'LIFE_SUPPORT', 'SENSORS', 'CARGO'];
    for (const c of lo.components) assert.equal(c.tier, tierOneTypes.includes(c.type) ? 1 : 0, `${c.type} default tier`);
    assert.equal(lo.ship_attributes.max_hull_hp, 100);
  });

  test('POST /ship/upgrade charges credits, persists the tier and reissues the token', async () => {
    const pilot = await newPilot('Upgrader');
    await setCredits(pilot, 100_000);

    const hullCost = upgradeCost(1, 3);
    const up = await upgrade(pilot, 'HULL', 3);
    assert.equal(up.statusCode, 200);
    const body = json(up);
    assert.equal(body.ship_attributes.max_hull_hp, 500);
    assert.equal(body.cost, hullCost);
    assert.equal(body.credits, 100_000 - hullCost);
    const reissued = app.jwt.verify(body.token);
    assert.equal(reissued.sub, pilot.id);
    assert.equal(reissued.ship_attributes.max_hull_hp, 500);
    assert.equal(reissued.mock, undefined);
    assert.equal(await credits(pilot), 100_000 - hullCost);
    assert.equal(tierOf(await loadout(pilot), 'HULL'), 3);

    const radarUp = json(await upgrade(pilot, 'RADAR', 3));
    assert.equal(radarUp.ship_attributes.identification_range_m, 700);
    assert.equal(radarUp.cost, upgradeCost(1, 3));
    assert.equal(app.jwt.verify(radarUp.token).ship_attributes.identification_range_m, 700);

    // An unequipped optional component is priced from tier 0.
    const stealthUp = json(await upgrade(pilot, 'STEALTH', 4));
    assert.equal(stealthUp.ship_attributes.signature_dissipation_rate, 1.8);
    assert.equal(stealthUp.cost, upgradeCost(0, 4));
    assert.equal(await credits(pilot), 100_000 - hullCost - upgradeCost(1, 3) - upgradeCost(0, 4));

    for (const [componentType, targetTier] of [['HULL', 6], ['HULL', 0], ['BOGUS', 2], ['HULL', 2]]) {
      assert.equal((await upgrade(pilot, componentType, targetTier)).statusCode, 400);
    }
  });

  test('POST /ship/upgrade without enough credits is refused and changes nothing', async () => {
    const pilot = await newPilot('Broke');
    const cost = upgradeCost(1, 2);
    assert.equal(await credits(pilot), 0);

    let res = await upgrade(pilot, 'HULL', 2);
    assert.equal(res.statusCode, 402);
    assert.deepEqual(json(res), {
      error: `Insufficient credits: upgrade costs ${cost}, balance is 0.`, cost, credits: 0
    });
    assert.equal(tierOf(await loadout(pilot), 'HULL'), 1);

    await setCredits(pilot, cost - 1);
    assert.equal((await upgrade(pilot, 'HULL', 2)).statusCode, 402);
    assert.equal(await credits(pilot), cost - 1);

    await setCredits(pilot, cost);
    res = await upgrade(pilot, 'HULL', 2);
    assert.equal(res.statusCode, 200);
    assert.equal(await credits(pilot), 0);
    assert.equal(tierOf(await loadout(pilot), 'HULL'), 2);
  });

  test('rejected upgrades (budget, already at tier) are not charged', async () => {
    const pilot = await newPilot('NoCharge');
    await setCredits(pilot, 50_000);
    await loadout(pilot);

    assert.equal((await upgrade(pilot, 'RADAR', 2)).statusCode, 400); // over the Hull Tier 1 budget
    assert.equal((await upgrade(pilot, 'HULL', 1)).statusCode, 400); // already at tier 1
    assert.equal(await credits(pilot), 50_000);
  });

  test('concurrent upgrades cannot spend the same credits twice', async () => {
    const pilot = await newPilot('DoubleSpend');
    await loadout(pilot);
    await setCredits(pilot, upgradeCost(1, 2)); // enough for exactly one hull upgrade
    const results = await Promise.all([1, 2, 3].map(() => upgrade(pilot, 'HULL', 2)));
    assert.equal(results.filter((r) => r.statusCode === 200).length, 1);
    assert.equal(await credits(pilot), 0);
    assert.equal(tierOf(await loadout(pilot), 'HULL'), 2);
  });

  test('POST /ship/upgrade enforces hull budget and essential/optional tier 0 rules', async () => {
    const pilot = await newPilot('Budget');
    await setCredits(pilot, 100_000);

    // Default loadout uses exactly the Hull Tier 1 budget (6 points); any further
    // subsystem upgrade without first raising the hull tier must be rejected.
    const overBudget = await upgrade(pilot, 'RADAR', 2);
    assert.equal(overBudget.statusCode, 400);
    assert.match(json(overBudget).error, /Hull Tier 1 budget of 6 points/);

    // Essential components cannot be unequipped.
    const essentialToZero = await upgrade(pilot, 'LIFE_SUPPORT', 0);
    assert.equal(essentialToZero.statusCode, 400);
    assert.match(json(essentialToZero).error, /essential component and cannot be unequipped/);

    // Optional components may be explicitly set to Tier 0 (they already default there).
    const shieldsAlreadyZero = await upgrade(pilot, 'SHIELDS', 0);
    assert.equal(shieldsAlreadyZero.statusCode, 400);
    assert.match(json(shieldsAlreadyZero).error, /already at tier 0/);

    // Raising the hull tier first grows the budget so the same subsystem upgrade now fits.
    assert.equal((await upgrade(pilot, 'HULL', 2)).statusCode, 200);
    assert.equal((await upgrade(pilot, 'RADAR', 2)).statusCode, 200);

    // Equipping an optional component to a non-zero tier now consumes budget, and is permitted.
    const shieldsUp = await upgrade(pilot, 'SHIELDS', 1);
    assert.equal(shieldsUp.statusCode, 200);
    assert.equal(json(shieldsUp).ship_attributes.max_shield_hp, 50);
  });
});

describe('cargo capacity matrix', () => {
  test('maps every cargo tier to its capacity', () => {
    [20.0, 40.0, 80.0, 160.0, 320.0].forEach((cap, i) => {
      assert.equal(computeShipAttributes([{ type: 'CARGO', tier: i + 1 }]).cargo_capacity_m3, cap);
    });
  });
});
