import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import {
  PASSWORD, app, attestationHeaders, call, closeApp, credits, dockedReceipt, json, keysDir, newPilot, setCredits
} from './helpers.js';
import env from '../src/config/env.js';
import { devPassengersEnabled } from '../src/config/dev.js';
import prismaPlugin from '../src/plugins/prisma.js';
import securityPlugin from '../src/plugins/security.js';
import claimKeyPlugin from '../src/plugins/claim-key.js';
import shipRoutes from '../src/routes/ship/index.js';
import {
  computeShipAttributes,
  defaultComponents,
  COMPONENT_TYPES,
  OPTIONAL_COMPONENTS,
  clampPassengers,
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
    assert.equal(a.passenger_capacity, 3);
    assert.equal(a.crew_aboard, 0);
    assert.deepEqual(computeShipAttributes(), a);
  });

  test('computes Tier 5 values for every component', () => {
    const a = computeShipAttributes(COMPONENT_TYPES.map((type) => ({ type, tier: 5 })));
    assert.deepEqual(a, {
      max_hull_hp: 2000, dry_mass_kg: 4000, hull_tier: 5,
      max_shield_hp: 1000, shield_regen_rate: 50,
      radar_range_m: 4000, identification_range_m: 2000, cargo_capacity_m3: 320, stealth_rating: 0.8,
      signature_dissipation_rate: 2.2,
      weapon_dps: 200, weapon_range_m: 1000,
      energy_capacity: 1500, energy_regen_rate: 75,
      comms_range_m: 25000, max_speed_mps: 343,
      passenger_capacity: 50,
      sensor_range_m: 7500, sensor_cooldown_mult: 0.4, sensor_tier: 5,
      docking_time_mult: 1, extraction_rate_mult: 1, tuning_tolerance_hz: 100,
      ion_fog_shield_resist: 0, node_interference_resist: 0, crew_capability_flags: 0, covert_exposure_mult: 1,
      crew_aboard: 0, passengers_aboard: 0
    });
  });

  test('reports the HULL component tier as hull_tier for tiers 1 to 5', () => {
    for (let tier = 1; tier <= 5; tier++) {
      assert.equal(computeShipAttributes([{ type: 'HULL', tier }]).hull_tier, tier);
    }
    assert.equal(computeShipAttributes([]).hull_tier, 1);
  });

  test('passengers_aboard defaults to 0 and is clamped to the passenger capacity', () => {
    assert.equal(computeShipAttributes([]).passengers_aboard, 0);
    assert.equal(computeShipAttributes(defaultComponents()).passengers_aboard, 0);
    assert.equal(computeShipAttributes([], 2).passengers_aboard, 2);
    assert.equal(computeShipAttributes([], 40).passengers_aboard, 3);
    assert.equal(computeShipAttributes([{ type: 'LIFE_SUPPORT', tier: 4 }], 15).passengers_aboard, 15);
    assert.equal(computeShipAttributes([{ type: 'LIFE_SUPPORT', tier: 4 }], 23).passengers_aboard, 22);
    for (const bad of [-1, 1.5, NaN, null, undefined, '3']) {
      assert.equal(clampPassengers(bad, 10), 0, `${bad}`);
    }
  });

  test('maps every life support tier to its passenger capacity', () => {
    const expected = [3, 6, 12, 22, 50];
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
    assert.equal(a.max_speed_mps, 40);
    assert.equal(a.radar_range_m, 500);
    assert.equal(a.identification_range_m, 150);
    assert.deepEqual(computeShipAttributes(comps), a);
  });

  test('maps every engine tier to its speed in m/s', () => {
    const expected = [20, 40, 85, 170, 343];
    expected.forEach((speed, i) => {
      const a = computeShipAttributes([{ type: 'ENGINES', tier: i + 1 }]);
      assert.equal(a.max_speed_mps, speed);
    });
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
    call(pilot, 'POST', '/ship/upgrade', { componentType, targetTier, dockedReceipt: dockedReceipt(pilot) });
  const loadout = async (pilot) => json(await call(pilot, 'GET', '/ship/loadout'));
  const tierOf = (lo, type) => lo.components.find((c) => c.type === type).tier;

  test('login embeds default ship attributes in the JWT', async () => {
    const pilot = await newPilot('Shipper');
    const decoded = app.jwt.verify(pilot.token);
    assert.deepEqual(decoded.ship_attributes, computeShipAttributes(defaultComponents()));
    assert.equal(decoded.ship_attributes.identification_range_m, 150);
    assert.equal(decoded.ship_attributes.signature_dissipation_rate, 1.0);
    assert.equal(decoded.ship_attributes.hull_tier, 1);
  });

  test('hull_tier 1 to 5 appears in the token, and upgrade reissues carry the new tier', async () => {
    const pilot = await newPilot('HullTier');
    await setCredits(pilot, 100_000);
    for (let tier = 2; tier <= 5; tier++) {
      const up = await upgrade(pilot, 'HULL', tier);
      assert.equal(up.statusCode, 200);
      const body = json(up);
      assert.equal(body.ship_attributes.hull_tier, tier);
      assert.equal(app.jwt.verify(body.token).ship_attributes.hull_tier, tier);
    }
    const current = await call(pilot, 'GET', '/ship/loadout');
    assert.equal(json(current).ship_attributes.hull_tier, 5);
  });

  test('a new ship has no passengers aboard, in the loadout and in the token', async () => {
    const pilot = await newPilot('NoPax');
    assert.equal(app.jwt.verify(pilot.token).ship_attributes.passengers_aboard, 0);
    const lo = await loadout(pilot);
    assert.equal(lo.ship_attributes.passengers_aboard, 0);
    assert.equal(
      (await app.prisma.spaceship.findFirst({ where: { playerId: pilot.id } })).passengersAboard,
      0
    );
  });

  test('persisted passengers_aboard is in the loadout, the login token and upgrade tokens', async () => {
    const pilot = await newPilot('Pax');
    await setCredits(pilot, 100_000);
    await loadout(pilot);
    await app.prisma.spaceship.updateMany({ where: { playerId: pilot.id }, data: { passengersAboard: 2 } });
    assert.equal((await loadout(pilot)).ship_attributes.passengers_aboard, 2);

    const login = await app.inject({
      method: 'POST',
      url: '/auth/login',
      headers: attestationHeaders,
      payload: { email: pilot.email, password: PASSWORD, deviceId: 'login-test-device-id' }
    });
    assert.equal(app.jwt.verify(json(login).token).ship_attributes.passengers_aboard, 2);

    assert.equal((await upgrade(pilot, 'HULL', 2)).statusCode, 200); // Tier 1 hull budget is full
    const up = json(await upgrade(pilot, 'RADAR', 2));
    assert.equal(up.ship_attributes.passengers_aboard, 2);
    assert.equal(app.jwt.verify(up.token).ship_attributes.passengers_aboard, 2);
  });

  test('a count above the passenger capacity is clamped in the loadout and persisted by a component change', async () => {
    const pilot = await newPilot('PaxClamp');
    await setCredits(pilot, 100_000);
    await loadout(pilot);
    // Capacity is 3 at life support Tier 1; 40 is the state left behind if capacity ever drops.
    await app.prisma.spaceship.updateMany({ where: { playerId: pilot.id }, data: { passengersAboard: 40 } });
    assert.equal((await loadout(pilot)).ship_attributes.passengers_aboard, 3);
    // The loadout only clamps what it reports; the stored count is untouched until a component changes.
    assert.equal((await app.prisma.spaceship.findFirst({ where: { playerId: pilot.id } })).passengersAboard, 40);

    assert.equal((await upgrade(pilot, 'HULL', 2)).statusCode, 200); // Tier 1 hull budget is full
    const up = json(await upgrade(pilot, 'RADAR', 2));
    assert.equal(up.ship_attributes.passengers_aboard, 3);
    assert.equal(app.jwt.verify(up.token).ship_attributes.passengers_aboard, 3);
    const stored = await app.prisma.spaceship.findFirst({ where: { playerId: pilot.id } });
    assert.equal(stored.passengersAboard, 3);
  });

  test('POST /ship/dev/passengers sets the count within capacity and reissues the token', async () => {
    const pilot = await newPilot('DevPax');
    await setCredits(pilot, 100_000);
    const set = (n) => call(pilot, 'POST', '/ship/dev/passengers', { passengersAboard: n });

    const ok = await set(3);
    assert.equal(ok.statusCode, 200);
    assert.equal(json(ok).ship_attributes.passengers_aboard, 3);
    assert.equal(app.jwt.verify(json(ok).token).ship_attributes.passengers_aboard, 3);
    assert.equal((await loadout(pilot)).ship_attributes.passengers_aboard, 3);

    const over = await set(4);
    assert.equal(over.statusCode, 400);
    assert.equal(json(over).code, 'passengers_exceed_capacity');
    assert.equal((await loadout(pilot)).ship_attributes.passengers_aboard, 3);

    assert.equal((await set(-1)).statusCode, 400);
    assert.equal((await set(1.5)).statusCode, 400);
    assert.equal((await call(pilot, 'POST', '/ship/dev/passengers', {})).statusCode, 400);

    // Capacity grows with life support, so a larger count becomes valid.
    assert.equal((await upgrade(pilot, 'HULL', 2)).statusCode, 200);
    assert.equal((await upgrade(pilot, 'LIFE_SUPPORT', 2)).statusCode, 200);
    assert.equal(json(await set(5)).ship_attributes.passengers_aboard, 5);
    assert.equal(json(await set(0)).ship_attributes.passengers_aboard, 0);

    const anon = await app.inject({ method: 'POST', url: '/ship/dev/passengers', payload: { passengersAboard: 1 } });
    assert.equal(anon.statusCode, 401);
  });

  test('POST /ship/dev/passengers is not registered in production', async () => {
    const buildShipApp = async (opts) => {
      const server = Fastify();
      await server.register(prismaPlugin);
      await server.register(securityPlugin, { keysDir });
      await server.register(claimKeyPlugin);
      await server.register(shipRoutes, { prefix: '/ship', ...opts });
      await server.ready();
      return server;
    };
    const pilot = await newPilot('ProdPax');
    const send = (server) => server.inject({
      method: 'POST',
      url: '/ship/dev/passengers',
      headers: pilot.headers,
      payload: { passengersAboard: 1 }
    });

    // No override: the gate reads NODE_ENV when the routes register, as it does at startup.
    const nodeEnv = env.NODE_ENV;
    let production;
    let enabled;
    try {
      env.NODE_ENV = 'production';
      production = await buildShipApp({});
      env.NODE_ENV = 'test';
      enabled = await buildShipApp({});
    } finally {
      env.NODE_ENV = nodeEnv;
    }
    try {
      assert.equal((await send(production)).statusCode, 404);
      assert.equal((await send(enabled)).statusCode, 200);
    } finally {
      await production?.close();
      await enabled?.close();
    }
  });

  test('the dev passenger route is enabled by default everywhere but production', () => {
    assert.equal(devPassengersEnabled('production'), false);
    assert.equal(devPassengersEnabled('development'), true);
    assert.equal(devPassengersEnabled('test'), true);
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
