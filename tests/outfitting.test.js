import { test, describe, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { app, call, closeApp, credits, dockedReceipt, json, newPilot, setCredits } from './helpers.js';
import { computeShipAttributes, upgradeCost } from '../src/config/components.js';
import {
  ADVANCED_MECHANICS_MIN_HEALTH_PCT,
  BLACK_MARKET_MAX_MULT,
  BLACK_MARKET_MIN_MULT,
  MAX_DISCOUNT,
  OUTFITTING_CAPABILITY_BITS,
  OUTFITTING_CAPABILITY_OWNERS,
  QUALITY_EFFECTIVENESS,
  QUALITY_PRICE_MULT,
  STANDING_BANDS,
  STANDING_DISCOUNT,
  blackMarketMultiplier,
  gateOutfittingCapabilities,
  normalizeQuality,
  outfitPrice,
  quoteOutfit,
  standingBand
} from '../src/config/outfitting.js';
import { stationServices } from '../src/lib/outfitting-station.js';

const quote = (from, to, extra = {}) => quoteOutfit({ from, to, tierCost: upgradeCost, floorTier: 1, ...extra });

describe('quality grades', () => {
  test('price and effectiveness multipliers: cheap 0.60x/0.85x, basic 1.0x, artisan 2.5x/1.18x', () => {
    assert.deepEqual({ ...QUALITY_PRICE_MULT }, { CHEAP: 0.6, BASIC: 1.0, ARTISAN: 2.5 });
    assert.deepEqual({ ...QUALITY_EFFECTIVENESS }, { CHEAP: 0.85, BASIC: 1.0, ARTISAN: 1.18 });
  });

  test('a missing or unknown grade is BASIC', () => {
    for (const bad of [undefined, null, '', 'basic', 'MASTERWORK', 2]) assert.equal(normalizeQuality(bad), 'BASIC');
    for (const good of ['CHEAP', 'BASIC', 'ARTISAN']) assert.equal(normalizeQuality(good), good);
  });
});

describe('outfitPrice (universal modifier order)', () => {
  test('rounds the quality-weighted price after the wealth, discount and hostile multipliers, then adds the surcharge', () => {
    assert.equal(outfitPrice({ qualityBase: 2000 }), 2000);
    assert.equal(outfitPrice({ qualityBase: 1000, wealthMult: 1.15 }), 1150);
    assert.equal(outfitPrice({ qualityBase: 1000, wealthMult: 1.15, discount: 0.1, hostileMult: 2 }), 2070);
    assert.equal(outfitPrice({ qualityBase: 1000, surcharge: 150, discount: 0.5 }), 650); // surcharge is not discounted
    assert.equal(outfitPrice({ qualityBase: 333, discount: 0.5 }), 167); // 166.5 rounds up
  });

  test('stacked discounts never cut more than 70%', () => {
    assert.equal(MAX_DISCOUNT, 0.7);
    assert.equal(outfitPrice({ qualityBase: 10_000, discount: 0.9 }), 3000);
    assert.equal(outfitPrice({ qualityBase: 10_000, discount: 0.7 }), 3000);
    assert.equal(outfitPrice({ qualityBase: 10_000, discount: 5 }), 3000);
  });

  test('a tariff (negative discount) raises the price', () => {
    assert.equal(outfitPrice({ qualityBase: 2000, discount: -0.3 }), 2600);
  });

  test('the price floor is the larger of 25 cr and 25% of the list price', () => {
    assert.equal(outfitPrice({ qualityBase: 40, discount: 0.7 }), 25);
    assert.equal(outfitPrice({ qualityBase: 1000, discount: 0.7 }), 300);
    // A cheap grade can fall to the floor of the list price: 0.6 x 0.3 = 18% < 25%.
    assert.equal(outfitPrice({ qualityBase: 600, basePrice: 1000, discount: 0.7 }), 250);
  });
});

describe('quoteOutfit', () => {
  const basic = (tier) => ({ tier, quality: 'BASIC' });

  test('a Basic tier step costs the flat table price, as before quality grades', () => {
    assert.equal(quote(basic(1), basic(2)).price, 750);
    assert.equal(quote(basic(1), basic(3)).price, 750 + 2000);
    assert.equal(quote({ tier: 0, quality: 'BASIC' }, basic(4), { floorTier: 0 }).price, upgradeCost(0, 4));
  });

  test('Cheap costs 0.60x and Artisan 2.5x', () => {
    assert.equal(quote(basic(1), { tier: 2, quality: 'CHEAP' }).price, 450);
    assert.equal(quote(basic(1), { tier: 2, quality: 'ARTISAN' }).price, 1875);
    // An unequipped optional component installed at a grade is priced from tier 0, with no regrade surcharge.
    assert.equal(quote({ tier: 0, quality: 'BASIC' }, { tier: 3, quality: 'ARTISAN' }, { floorTier: 0 }).price, 7500);
    assert.equal(quote({ tier: 0, quality: 'BASIC' }, { tier: 3, quality: 'ARTISAN' }, { floorTier: 0 }).surcharge, 0);
  });

  test('regrading Basic to Artisan costs the value difference plus a 15% labor surcharge', () => {
    const q = quote(basic(3), { tier: 3, quality: 'ARTISAN' });
    const basicValue = upgradeCost(1, 3); // 2750
    assert.equal(q.surcharge, Math.round(0.15 * basicValue));
    assert.equal(q.price, 2.5 * basicValue - basicValue + Math.round(0.15 * basicValue));
    assert.equal(q.price, 4538); // 412.5 rounds up to 413
  });

  test('the surcharge is 15% of the value of the part replaced, also for Cheap and when the tier rises too', () => {
    const cheapToBasic = quote({ tier: 2, quality: 'CHEAP' }, basic(2));
    assert.equal(cheapToBasic.surcharge, Math.round(0.15 * 0.6 * 750));
    assert.equal(cheapToBasic.price, Math.round(0.4 * 750) + cheapToBasic.surcharge);
    const both = quote(basic(2), { tier: 3, quality: 'ARTISAN' });
    assert.equal(both.price, 2.5 * upgradeCost(1, 3) - upgradeCost(1, 2) + Math.round(0.15 * 750));
  });

  test('keeping the grade while the tier rises charges no surcharge', () => {
    const q = quote({ tier: 2, quality: 'ARTISAN' }, { tier: 3, quality: 'ARTISAN' });
    assert.equal(q.surcharge, 0);
    assert.equal(q.price, 2.5 * 2000);
  });

  test('laddering up cheaply and then regrading never undercuts buying the grade outright', () => {
    for (const target of [2, 3, 4, 5]) {
      const direct = quote(basic(1), { tier: target, quality: 'ARTISAN' }).price;
      const cheap = quote(basic(1), { tier: target, quality: 'CHEAP' }).price;
      const regrade = quote({ tier: target, quality: 'CHEAP' }, { tier: target, quality: 'ARTISAN' }).price;
      assert.ok(cheap + regrade >= direct, `tier ${target}: ${cheap} + ${regrade} < ${direct}`);
      const stepBasic = quote(basic(1), basic(target - 1)).price;
      const ladder = stepBasic + quote(basic(target - 1), { tier: target, quality: 'ARTISAN' }).price;
      assert.ok(ladder >= direct, `tier ${target}: laddering ${ladder} < ${direct}`);
    }
  });

  test('applies the standing, wealth and hostile modifiers to the quality difference', () => {
    const q = quote(basic(2), { tier: 3, quality: 'BASIC' }, { wealthMult: 1.15, discount: 0.1, hostileMult: 2.5 });
    assert.equal(q.price, Math.round(2000 * 1.15 * 0.9 * 2.5));
  });
});

describe('standing bands and modifiers', () => {
  test('band boundaries', () => {
    const band = (standing, opts) => standingBand(standing, opts);
    assert.equal(band(-1000), STANDING_BANDS.HOSTILE);
    assert.equal(band(-750), STANDING_BANDS.HOSTILE);
    assert.equal(band(-500), STANDING_BANDS.HOSTILE);
    assert.equal(band(-499), STANDING_BANDS.UNFRIENDLY);
    assert.equal(band(-150), STANDING_BANDS.UNFRIENDLY);
    assert.equal(band(-149), STANDING_BANDS.NEUTRAL);
    assert.equal(band(0), STANDING_BANDS.NEUTRAL);
    assert.equal(band(149), STANDING_BANDS.NEUTRAL);
    assert.equal(band(150), STANDING_BANDS.FRIENDLY);
    assert.equal(band(449), STANDING_BANDS.FRIENDLY);
    assert.equal(band(450), STANDING_BANDS.TRUSTED);
    assert.equal(band(799), STANDING_BANDS.TRUSTED);
    assert.equal(band(800), STANDING_BANDS.PARAGON);
    assert.equal(band(1000), STANDING_BANDS.PARAGON);
  });

  test('flying the faction colors at 500+ outranks Trusted; Paragon outranks Flying Colors; below 500 it does nothing', () => {
    assert.equal(standingBand(500, { flyingColors: true }), STANDING_BANDS.FLYING_COLORS);
    assert.equal(standingBand(799, { flyingColors: true }), STANDING_BANDS.FLYING_COLORS);
    assert.equal(standingBand(800, { flyingColors: true }), STANDING_BANDS.PARAGON);
    assert.equal(standingBand(499, { flyingColors: true }), STANDING_BANDS.TRUSTED);
    assert.equal(standingBand(300, { flyingColors: true }), STANDING_BANDS.FRIENDLY);
    assert.equal(standingBand(600), STANDING_BANDS.TRUSTED);
  });

  test('Unfriendly +30% down to Friendly -10%, Trusted -15%, Flying Colors -25%, Paragon -35%', () => {
    const price = (band) => outfitPrice({ qualityBase: 2000, discount: STANDING_DISCOUNT[band] });
    assert.equal(price(STANDING_BANDS.UNFRIENDLY), 2600);
    assert.equal(price(STANDING_BANDS.NEUTRAL), 2000);
    assert.equal(price(STANDING_BANDS.FRIENDLY), 1800);
    assert.equal(price(STANDING_BANDS.TRUSTED), 1700);
    assert.equal(price(STANDING_BANDS.FLYING_COLORS), 1500);
    assert.equal(price(STANDING_BANDS.PARAGON), 1300);
  });
});

describe('black-market multiplier', () => {
  test('is fixed per dock and between 2.5x and 3.0x', () => {
    const seen = new Set();
    for (let n = 0; n < 200; n++) {
      const id = `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
      const mult = blackMarketMultiplier(id);
      assert.equal(blackMarketMultiplier(id), mult);
      assert.ok(mult >= BLACK_MARKET_MIN_MULT && mult <= BLACK_MARKET_MAX_MULT, `${mult}`);
      assert.equal(Math.round(mult * 100) / 100, mult);
      seen.add(mult);
    }
    assert.ok(seen.size > 10, 'the multiplier varies by dock');
  });
});

describe('computeShipAttributes: quality effectiveness', () => {
  const engines = (tier, quality, healthPct = 100) => [{ type: 'ENGINES', tier, quality, healthPct }];

  test('Basic is the baseline, and a component without a grade is Basic', () => {
    assert.equal(computeShipAttributes(engines(3, 'BASIC')).max_speed_mps, 85);
    assert.deepEqual(computeShipAttributes(engines(3, undefined)), computeShipAttributes(engines(3, 'BASIC')));
    assert.deepEqual(computeShipAttributes(engines(3, 'garbage')), computeShipAttributes(engines(3, 'BASIC')));
  });

  test('Cheap delivers 0.85x and Artisan 1.18x of a tier-3 drive', () => {
    assert.ok(Math.abs(computeShipAttributes(engines(3, 'CHEAP')).max_speed_mps - 72.25) < 1e-9);
    assert.ok(Math.abs(computeShipAttributes(engines(3, 'ARTISAN')).max_speed_mps - 100.3) < 1e-9);
  });

  test('an Artisan drive never passes Mach 1, and an Artisan tier is below the next Basic tier', () => {
    assert.equal(computeShipAttributes(engines(5, 'ARTISAN')).max_speed_mps, 343);
    assert.ok(computeShipAttributes(engines(3, 'ARTISAN')).max_speed_mps < computeShipAttributes(engines(4, 'BASIC')).max_speed_mps);
  });

  test('scales the performance attributes of each component and leaves structural ones alone', () => {
    const at = (type, tier, quality) => computeShipAttributes([{ type, tier, quality, healthPct: 100 }]);
    const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} !== ${b}`);
    near(at('HULL', 2, 'ARTISAN').max_hull_hp, 250 * 1.18);
    near(at('SHIELDS', 2, 'CHEAP').max_shield_hp, 120 * 0.85);
    near(at('RADAR', 3, 'ARTISAN').radar_range_m, 1800 * 1.18);
    near(at('CARGO', 2, 'ARTISAN').cargo_capacity_m3, 40 * 1.18);
    near(at('WEAPONS', 2, 'CHEAP').weapon_dps, 25 * 0.85);
    near(at('ENERGY', 2, 'ARTISAN').energy_capacity, 200 * 1.18);
    near(at('COMMS', 2, 'ARTISAN').comms_range_m, 2500 * 1.18);
    near(at('SENSORS', 3, 'ARTISAN').sensor_range_m, 4500 * 1.18);
    near(at('SENSORS', 3, 'ARTISAN').sensor_cooldown_mult, 0.7 / 1.18); // a cooldown is better lower
    near(at('SENSORS', 3, 'CHEAP').sensor_cooldown_mult, 0.7 / 0.85);
    near(at('STEALTH', 3, 'ARTISAN').stealth_rating, 0.4 * 1.18);
    assert.ok(at('STEALTH', 5, 'ARTISAN').stealth_rating < 1);
    // Structural values do not change.
    const artisan = at('HULL', 2, 'ARTISAN');
    assert.equal(artisan.hull_tier, 2);
    assert.equal(artisan.dry_mass_kg, 1500);
    assert.equal(at('SENSORS', 3, 'ARTISAN').sensor_tier, 3);
    assert.equal(at('LIFE_SUPPORT', 3, 'ARTISAN').passenger_capacity, at('LIFE_SUPPORT', 3, 'BASIC').passenger_capacity);
  });

  test('an unequipped (tier 0) optional component is unaffected by its stored grade', () => {
    const base = computeShipAttributes([{ type: 'SHIELDS', tier: 0, quality: 'BASIC', healthPct: 100 }]);
    assert.deepEqual(computeShipAttributes([{ type: 'SHIELDS', tier: 0, quality: 'ARTISAN', healthPct: 100 }]), base);
  });

  test('quality and health both apply: an Artisan drive at 60% health', () => {
    const speed = computeShipAttributes(engines(3, 'ARTISAN', 60)).max_speed_mps;
    assert.ok(Math.abs(speed - 85 * 1.18 * 0.6) < 1e-9);
  });
});

describe('computeShipAttributes: advanced mechanics switch off below 50% health', () => {
  const sensors = (healthPct, tier = 3) => computeShipAttributes([{ type: 'SENSORS', tier, quality: 'BASIC', healthPct }]);

  test('the sensor tier is capped at 1 at 49%, and whole at 50% and 51%', () => {
    assert.equal(ADVANCED_MECHANICS_MIN_HEALTH_PCT, 50);
    assert.equal(sensors(49).sensor_tier, 1);
    assert.equal(sensors(50).sensor_tier, 3);
    assert.equal(sensors(51).sensor_tier, 3);
    assert.equal(sensors(100).sensor_tier, 3);
    assert.equal(sensors(0).sensor_tier, 1);
  });

  test('a tier-1 sensor and a missing health are unaffected', () => {
    assert.equal(sensors(10, 1).sensor_tier, 1);
    assert.equal(computeShipAttributes([{ type: 'SENSORS', tier: 3 }]).sensor_tier, 3);
  });

  test('baseline stats keep scaling linearly with health, across the threshold', () => {
    assert.ok(Math.abs(sensors(49).sensor_range_m - 4500 * 0.49) < 1e-9);
    assert.ok(Math.abs(sensors(50).sensor_range_m - 4500 * 0.5) < 1e-9);
    assert.ok(Math.abs(sensors(51).sensor_range_m - 4500 * 0.51) < 1e-9);
  });

  test("another component's damage does not cap the sensor tier", () => {
    const attrs = computeShipAttributes([
      { type: 'SENSORS', tier: 3, healthPct: 100 },
      { type: 'RADAR', tier: 3, healthPct: 10 }
    ]);
    assert.equal(attrs.sensor_tier, 3);
  });

  test('the reserved outfitting capability bits are unassigned, so no damage clears anything today', () => {
    assert.deepEqual(Object.keys(OUTFITTING_CAPABILITY_OWNERS).map(Number).sort((a, b) => a - b), [0x20, 0x100, 0x200]);
    assert.deepEqual(Object.values(OUTFITTING_CAPABILITY_OWNERS), [null, null, null]);
    const everything = 0x3ff;
    assert.equal(gateOutfittingCapabilities(everything, { RADAR: 0, SENSORS: 0, STEALTH: 0 }), everything);
  });

  test('an owned bit clears below 50% and returns at 50%; crew bits and other bits never clear', () => {
    const owners = { [OUTFITTING_CAPABILITY_BITS.RESERVED_0x20]: 'RADAR', [OUTFITTING_CAPABILITY_BITS.RESERVED_0x100]: 'SENSORS', [OUTFITTING_CAPABILITY_BITS.RESERVED_0x200]: null };
    const crewBits = 0x01 | 0x02 | 0x04 | 0x40 | 0x80;
    const flags = crewBits | 0x20 | 0x100 | 0x200;
    for (const [pct, kept] of [[49, false], [50, true], [51, true]]) {
      const gated = gateOutfittingCapabilities(flags, { RADAR: pct, SENSORS: 100 }, owners);
      assert.equal((gated & 0x20) !== 0, kept, `0x20 at ${pct}%`);
      assert.equal((gated & 0x100) !== 0, true, '0x100 owner is healthy');
      assert.equal((gated & 0x200) !== 0, true, 'unassigned bit is untouched');
      assert.equal(gated & crewBits, crewBits, 'crew bits are never gated by damage');
    }
    assert.equal(gateOutfittingCapabilities(flags, {}, owners), flags, 'a component without a recorded health is whole');
  });
});

describe('POST /ship/upgrade with quality grades', () => {
  before(async () => { await app.ready(); });
  after(async () => { await closeApp(); });

  const upgrade = (pilot, componentType, targetTier, qualityGrade, receiptOverrides = {}) =>
    call(pilot, 'POST', '/ship/upgrade', {
      componentType,
      targetTier,
      ...(qualityGrade && { qualityGrade }),
      dockedReceipt: dockedReceipt(pilot, receiptOverrides)
    });
  const loadout = async (pilot) => json(await call(pilot, 'GET', '/ship/loadout'));
  const componentOf = (lo, type) => lo.components.find((c) => c.type === type);
  const rows = (pilot, type) => app.prisma.shipComponentRecord.findFirst({
    where: { type, spaceship: { playerId: pilot.id, active: true } }
  });
  // A pilot with a tier-5 hull (budget for anything) and `credits`, the components below it at tier 1.
  async function richPilot(prefix, balance = 1_000_000) {
    const pilot = await newPilot(prefix);
    await setCredits(pilot, balance);
    assert.equal((await upgrade(pilot, 'HULL', 5)).statusCode, 200);
    await setCredits(pilot, balance);
    return { pilot };
  }
  const standing = (pilot, factionId, value) => app.prisma.playerReputation.upsert({
    where: { playerId_factionId: { playerId: pilot.id, factionId } }, update: { standing: value },
    create: { playerId: pilot.id, factionId, standing: value }
  });

  test('components default to BASIC: new rows, the loadout and an upgrade without qualityGrade', async () => {
    const pilot = await newPilot('QualityDefault');
    assert.ok((await loadout(pilot)).components.every((c) => c.quality === 'BASIC'));
    await setCredits(pilot, 100_000);
    const res = json(await upgrade(pilot, 'HULL', 2));
    assert.equal(res.qualityGrade, 'BASIC');
    assert.equal(res.cost, upgradeCost(1, 2));
    assert.equal(componentOf(res, 'HULL').quality, 'BASIC');
    assert.equal((await rows(pilot, 'HULL')).quality, 'BASIC');
  });

  test('a ShipComponentRecord written without a quality (as every pre-existing row was) reads as BASIC', async () => {
    const pilot = await newPilot('Grandfather');
    await call(pilot, 'GET', '/ship/loadout');
    await app.prisma.$executeRaw`DELETE FROM "ShipComponentRecord" WHERE "type" = 'WEAPONS' AND "spaceshipId" IN (SELECT "id" FROM "Spaceship" WHERE "playerId" = ${pilot.id}::uuid)`;
    const [{ quality }] = await app.prisma.$queryRaw`
      INSERT INTO "ShipComponentRecord" ("id", "spaceshipId", "type", "tier", "updatedAt")
      SELECT gen_random_uuid(), s."id", 'WEAPONS', 2, now() FROM "Spaceship" s WHERE s."playerId" = ${pilot.id}::uuid
      RETURNING "quality"`;
    assert.equal(quality, 'BASIC');
    assert.equal(componentOf(await loadout(pilot), 'WEAPONS').quality, 'BASIC');
  });

  test('rejects a grade the contracts do not define', async () => {
    const pilot = await newPilot('QualityBad');
    await setCredits(pilot, 100_000);
    for (const bad of ['MASTERWORK', 'basic', 'UNSPECIFIED', 2]) {
      const res = await call(pilot, 'POST', '/ship/upgrade', {
        componentType: 'HULL', targetTier: 2, qualityGrade: bad, dockedReceipt: dockedReceipt(pilot)
      });
      assert.equal(res.statusCode, 400, `${bad}`);
    }
    assert.equal(await credits(pilot), 100_000);
  });

  test('CHEAP charges 0.60x, persists the grade and delivers 0.85x of the attributes in the response and token', async () => {
    const { pilot } = await richPilot('Cheap');
    const res = json(await upgrade(pilot, 'ENGINES', 3, 'CHEAP'));
    assert.equal(res.cost, Math.round(0.6 * upgradeCost(1, 3)));
    assert.equal(res.credits, 1_000_000 - res.cost);
    assert.equal(componentOf(res, 'ENGINES').quality, 'CHEAP');
    assert.ok(Math.abs(res.ship_attributes.max_speed_mps - 85 * 0.85) < 1e-9);
    assert.ok(Math.abs(app.jwt.verify(res.token).ship_attributes.max_speed_mps - 85 * 0.85) < 1e-9);
    assert.equal((await rows(pilot, 'ENGINES')).quality, 'CHEAP');
    assert.equal(componentOf(await loadout(pilot), 'ENGINES').quality, 'CHEAP');
  });

  test('ARTISAN charges 2.5x and delivers 1.18x; an unequipped optional part is priced from tier 0', async () => {
    const { pilot } = await richPilot('Artisan');
    const engines = json(await upgrade(pilot, 'ENGINES', 3, 'ARTISAN'));
    assert.equal(engines.cost, 2.5 * upgradeCost(1, 3));
    assert.ok(Math.abs(engines.ship_attributes.max_speed_mps - 85 * 1.18) < 1e-9);
    const stealth = json(await upgrade(pilot, 'STEALTH', 3, 'ARTISAN'));
    assert.equal(stealth.cost, 2.5 * upgradeCost(0, 3));
    assert.equal(componentOf(stealth, 'STEALTH').quality, 'ARTISAN');
    assert.equal((await rows(pilot, 'STEALTH')).quality, 'ARTISAN');
  });

  test('an Artisan purchase the pilot cannot afford is refused and changes nothing', async () => {
    const { pilot } = await richPilot('ArtisanBroke');
    await setCredits(pilot, 2.5 * upgradeCost(1, 3) - 1);
    const res = await upgrade(pilot, 'ENGINES', 3, 'ARTISAN');
    assert.equal(res.statusCode, 402);
    assert.equal(json(res).cost, 2.5 * upgradeCost(1, 3));
    assert.equal((await rows(pilot, 'ENGINES')).quality, 'BASIC');
    assert.equal((await rows(pilot, 'ENGINES')).tier, 1);
  });

  test('regrading Basic to Artisan at the same tier costs the difference plus the 15% labor surcharge', async () => {
    const { pilot } = await richPilot('Regrade');
    assert.equal((await upgrade(pilot, 'ENGINES', 3)).statusCode, 200);
    await setCredits(pilot, 50_000);
    const res = json(await upgrade(pilot, 'ENGINES', 3, 'ARTISAN'));
    const basicValue = upgradeCost(1, 3);
    assert.equal(res.cost, 1.5 * basicValue + Math.round(0.15 * basicValue));
    assert.equal(res.credits, 50_000 - res.cost);
    assert.equal(componentOf(res, 'ENGINES').tier, 3);
    assert.equal(componentOf(res, 'ENGINES').quality, 'ARTISAN');
    assert.ok(Math.abs(res.ship_attributes.max_speed_mps - 85 * 1.18) < 1e-9);
    assert.equal((await rows(pilot, 'ENGINES')).quality, 'ARTISAN');
  });

  test('raising the tier and the grade together is priced against the part replaced', async () => {
    const { pilot } = await richPilot('RegradeUp');
    assert.equal((await upgrade(pilot, 'ENGINES', 2)).statusCode, 200);
    await setCredits(pilot, 50_000);
    const res = json(await upgrade(pilot, 'ENGINES', 3, 'ARTISAN'));
    assert.equal(res.cost, 2.5 * upgradeCost(1, 3) - upgradeCost(1, 2) + Math.round(0.15 * upgradeCost(1, 2)));
  });

  test('a lower grade over a fitted part is refused, with or without a tier change, and an omitted grade is Basic', async () => {
    const { pilot } = await richPilot('Downgrade');
    assert.equal((await upgrade(pilot, 'ENGINES', 2, 'ARTISAN')).statusCode, 200);
    const before = await credits(pilot);
    for (const [tier, grade] of [[2, 'BASIC'], [2, 'CHEAP'], [3, 'CHEAP'], [3, 'BASIC'], [3, undefined]]) {
      const res = await upgrade(pilot, 'ENGINES', tier, grade);
      assert.equal(res.statusCode, 400, `${tier} ${grade}`);
      assert.equal(json(res).code, 'quality_downgrade_refused');
      assert.equal(json(res).currentQualityGrade, 'ARTISAN');
    }
    assert.equal(await credits(pilot), before);
    assert.equal((await rows(pilot, 'ENGINES')).quality, 'ARTISAN');
    assert.equal((await upgrade(pilot, 'ENGINES', 3, 'ARTISAN')).statusCode, 200); // keeping the grade is fine
  });

  test("an essential starter part's grade cannot change without its tier (it would otherwise be free)", async () => {
    const { pilot } = await richPilot('Starter');
    const before = await credits(pilot);
    for (const grade of [undefined, 'CHEAP', 'ARTISAN']) assert.equal((await upgrade(pilot, 'ENGINES', 1, grade)).statusCode, 400);
    assert.equal(await credits(pilot), before);
    // An optional part is bought, so its tier-1 grade can be regraded.
    assert.equal((await upgrade(pilot, 'STEALTH', 1, 'CHEAP')).statusCode, 200);
    assert.equal(json(await upgrade(pilot, 'STEALTH', 1, 'ARTISAN')).cost, 2.5 * 250 - 0.6 * 250 + Math.round(0.15 * 0.6 * 250));
  });

  test('the same tier and grade again is refused and not charged; a lower tier is refused', async () => {
    const { pilot } = await richPilot('Same');
    assert.equal((await upgrade(pilot, 'ENGINES', 2, 'CHEAP')).statusCode, 200);
    const before = await credits(pilot);
    assert.equal((await upgrade(pilot, 'ENGINES', 2, 'CHEAP')).statusCode, 400);
    assert.equal((await upgrade(pilot, 'ENGINES', 1, 'CHEAP')).statusCode, 400);
    assert.equal(await credits(pilot), before);
  });

  test('regrading Cheap to Basic pays the difference plus 15% of the cheap part', async () => {
    const { pilot } = await richPilot('CheapToBasic');
    assert.equal((await upgrade(pilot, 'ENGINES', 3, 'CHEAP')).statusCode, 200);
    const res = json(await upgrade(pilot, 'ENGINES', 3, 'BASIC'));
    const basicValue = upgradeCost(1, 3);
    assert.equal(res.cost, Math.round(0.4 * basicValue) + Math.round(0.15 * 0.6 * basicValue));
  });

  test('buying Cheap and regrading is no way around the price: Cheap then Artisan costs at least Artisan outright', async () => {
    const direct = (await richPilot('Direct')).pilot;
    const viaCheap = (await richPilot('ViaCheap')).pilot;
    const outright = json(await upgrade(direct, 'ENGINES', 4, 'ARTISAN')).cost;
    const cheap = json(await upgrade(viaCheap, 'ENGINES', 4, 'CHEAP')).cost;
    const regrade = json(await upgrade(viaCheap, 'ENGINES', 4, 'ARTISAN')).cost;
    assert.ok(cheap + regrade >= outright, `${cheap} + ${regrade} < ${outright}`);
  });

  describe('faction standing prices', () => {
    // ENGINES at tier 2 on a tier-5 hull, then 2 -> 3 (a 2,000 cr step) at an Alpha dock.
    async function atAlpha(prefix, alphaStanding, { colors = false, quality, first, receipt = { controllingFactionId: 'alpha' } } = {}) {
      const { pilot } = await richPilot(prefix);
      assert.equal((await upgrade(pilot, 'ENGINES', 2, first)).statusCode, 200);
      await setCredits(pilot, 100_000);
      if (alphaStanding !== null) await standing(pilot, 'alpha', alphaStanding);
      if (colors) await app.prisma.player.update({ where: { id: pilot.id }, data: { activeColorsFactionId: 'alpha' } });
      return { pilot, res: await upgrade(pilot, 'ENGINES', 3, quality, receipt) };
    }

    for (const [label, value, expected, band] of [
      ['Unfriendly', -200, 2600, 'UNFRIENDLY'],
      ['Neutral', 0, 2000, 'NEUTRAL'],
      ['Friendly', 200, 1800, 'FRIENDLY'],
      ['Trusted', 460, 1700, 'TRUSTED'],
      ['Paragon', 800, 1300, 'PARAGON']
    ]) {
      test(`${label} (${value}) pays ${expected} for a 2,000 cr step`, async () => {
        const { res } = await atAlpha(`Standing${label}`, value);
        assert.equal(res.statusCode, 200);
        assert.equal(json(res).cost, expected);
        assert.equal(json(res).standingBand, band);
        assert.equal(json(res).blackMarket, false);
      });
    }

    test('flying the dock faction colors at 500+ pays -25%; without the colors the pilot is only Trusted', async () => {
      const flying = await atAlpha('StandingColors', 520, { colors: true });
      assert.equal(json(flying.res).cost, 1500);
      assert.equal(json(flying.res).standingBand, 'FLYING_COLORS');
      const plain = await atAlpha('StandingNoColors', 520);
      assert.equal(json(plain.res).cost, 1700);
    });

    test("another faction's colors give no discount here", async () => {
      const { pilot } = await richPilot('StandingOtherColors');
      assert.equal((await upgrade(pilot, 'ENGINES', 2)).statusCode, 200);
      await setCredits(pilot, 100_000);
      await standing(pilot, 'alpha', 460);
      await standing(pilot, 'gamma', 520);
      await app.prisma.player.update({ where: { id: pilot.id }, data: { activeColorsFactionId: 'gamma' } });
      assert.equal(json(await upgrade(pilot, 'ENGINES', 3, undefined, { controllingFactionId: 'alpha' })).cost, 1700);
    });

    test('standing applies to quality too: an Artisan step at Friendly is 2.5 x 2,000 x 0.9', async () => {
      const { res } = await atAlpha('StandingArtisan', 200, { first: 'ARTISAN', quality: 'ARTISAN' });
      assert.equal(json(res).cost, 4500);
    });

    test('an independent dock applies no standing modifier, whatever the pilot holds elsewhere', async () => {
      const { res } = await atAlpha('StandingIndependent', -300, { receipt: { controllingFactionId: '' } });
      assert.equal(json(res).cost, 2000);
      assert.equal(json(res).standingBand, null);
    });

    test('only the standing with the faction governing the dock counts', async () => {
      const { pilot } = await richPilot('StandingGoverning');
      assert.equal((await upgrade(pilot, 'ENGINES', 2)).statusCode, 200);
      await setCredits(pilot, 100_000);
      await standing(pilot, 'alpha', -300);
      await standing(pilot, 'beta', 200);
      assert.equal(json(await upgrade(pilot, 'ENGINES', 3, undefined, { controllingFactionId: 'beta' })).cost, 1800);
    });
  });

  describe('Hostile pilots', () => {
    async function hostile(prefix, value) {
      const { pilot } = await richPilot(prefix);
      assert.equal((await upgrade(pilot, 'ENGINES', 2)).statusCode, 200);
      await setCredits(pilot, 100_000);
      await standing(pilot, 'alpha', value);
      return pilot;
    }

    for (const value of [-500, -749, -750, -1000]) {
      test(`standing ${value} is barred from a civilian terminal and nothing changes`, async () => {
        const pilot = await hostile(`Barred${-value}`, value);
        for (const grade of [undefined, 'CHEAP', 'ARTISAN']) {
          const res = await upgrade(pilot, 'ENGINES', 3, grade, { controllingFactionId: 'alpha' });
          assert.equal(res.statusCode, 403);
          assert.equal(json(res).code, 'terminal_barred_hostile');
        }
        assert.equal(await credits(pilot), 100_000);
        assert.equal((await rows(pilot, 'ENGINES')).tier, 2);
      });
    }

    test('Hostile is barred only at that faction\'s docks; elsewhere the pilot is served at the standard price', async () => {
      const pilot = await hostile('BarredElsewhere', -600);
      assert.equal(json(await upgrade(pilot, 'ENGINES', 3, undefined, { controllingFactionId: 'beta' })).cost, 2000);
    });

    test('Unfriendly (-499) is not barred', async () => {
      const pilot = await hostile('NotBarred', -499);
      assert.equal(json(await upgrade(pilot, 'ENGINES', 3, undefined, { controllingFactionId: 'alpha' })).cost, 2600);
    });

    test('at a low-sec dock a Hostile pilot buys a black-market refit at 2.5x to 3.0x', async () => {
      const lowSec = mock.method(stationServices, 'isLowSecDock', () => true);
      try {
        const pilot = await hostile('BlackMarket', -600);
        const receipt = dockedReceipt(pilot, { controllingFactionId: 'alpha' });
        const res = await call(pilot, 'POST', '/ship/upgrade', { componentType: 'ENGINES', targetTier: 3, dockedReceipt: receipt });
        assert.equal(res.statusCode, 200);
        const mult = blackMarketMultiplier(receipt.dockedEntityId);
        assert.ok(mult >= 2.5 && mult <= 3);
        assert.equal(json(res).cost, Math.round(2000 * mult));
        assert.equal(json(res).blackMarket, true);
        assert.equal(json(res).credits, 100_000 - Math.round(2000 * mult));
        assert.equal(lowSec.mock.calls.length, 1);
      } finally {
        lowSec.mock.restore();
      }
    });

    test('the black market applies to quality too, and a pilot who cannot afford it is refused', async () => {
      const lowSec = mock.method(stationServices, 'isLowSecDock', () => true);
      try {
        const pilot = await hostile('BlackMarketArtisan', -600);
        const receipt = dockedReceipt(pilot, { controllingFactionId: 'alpha' });
        const mult = blackMarketMultiplier(receipt.dockedEntityId);
        // ENGINES sit at Basic tier 2: the Artisan tier 3 part is worth 2.5 x 2,750, less the 750 part replaced, plus labor.
        const expected = Math.round((2.5 * upgradeCost(1, 3) - upgradeCost(1, 2)) * mult) + Math.round(0.15 * upgradeCost(1, 2));
        await setCredits(pilot, expected - 1);
        const poor = await call(pilot, 'POST', '/ship/upgrade', { componentType: 'ENGINES', targetTier: 3, qualityGrade: 'ARTISAN', dockedReceipt: receipt });
        assert.equal(poor.statusCode, 402);
        assert.equal(json(poor).cost, expected);
        await setCredits(pilot, 100_000);
        const ok = await call(pilot, 'POST', '/ship/upgrade', { componentType: 'ENGINES', targetTier: 3, qualityGrade: 'ARTISAN', dockedReceipt: receipt });
        assert.equal(json(ok).cost, expected);
      } finally {
        lowSec.mock.restore();
      }
    });

    test('a pilot who is not Hostile never pays the black-market multiplier, even at a low-sec dock', async () => {
      const lowSec = mock.method(stationServices, 'isLowSecDock', () => true);
      try {
        const pilot = await hostile('LowSecNeutral', 0);
        const res = json(await upgrade(pilot, 'ENGINES', 3, undefined, { controllingFactionId: 'alpha' }));
        assert.equal(res.cost, 2000);
        assert.equal(res.blackMarket, false);
      } finally {
        lowSec.mock.restore();
      }
    });
  });
});
