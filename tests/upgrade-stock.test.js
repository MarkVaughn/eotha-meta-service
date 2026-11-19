import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { ALL_GRADES_MASK, app, call, closeApp, credits, dockedReceipt, json, newPilot, setCredits } from './helpers.js';
import { upgradeStockRefusal } from '../src/lib/outfitting-station.js';

before(async () => { await app.ready(); });
after(closeApp);

// ComponentType and QualityGrade enum numbers (eotha-contracts ship.proto), as the receipt signs them.
const HULL = 1;
const CARGO = 3;
const ENGINES = 9;
const CHEAP = 1 << 1;
const BASIC = 1 << 2;
const ARTISAN = 1 << 3;

// A dock's signed catalog for `dockedReceipt` (entries ascending by component type, as the engine signs them).
const catalog = (stock, stockedQualityMask = ALL_GRADES_MASK, artisanMaxTier = 0) => ({
  outfittingStock: stock.map(([componentType, maxTier]) => ({ componentType, maxTier })),
  stockedQualityMask,
  artisanMaxTier
});

describe('upgradeStockRefusal', () => {
  const receipt = (overrides) => ({ ...catalog([[HULL, 3], [CARGO, 2]], BASIC | ARTISAN), ...overrides });
  const refusal = (componentType, targetTier, qualityGrade, overrides) =>
    upgradeStockRefusal(receipt(overrides), { componentType, targetTier, qualityGrade });

  test('stocked type, tier and grade pass, up to the type\'s own max tier', () => {
    assert.equal(refusal('HULL', 3, 'BASIC'), null);
    assert.equal(refusal('HULL', 1, 'ARTISAN'), null);
    assert.equal(refusal('CARGO', 2, 'BASIC'), null);
  });

  test('a type with no entry is component_not_stocked', () => {
    assert.deepEqual(refusal('ENGINES', 1, 'BASIC'), {
      error: 'This dock does not stock ENGINES components.', code: 'component_not_stocked', componentType: 'ENGINES', maxTier: 0
    });
    assert.equal(refusal('HULL', 1, 'BASIC', { outfittingStock: [] }).code, 'component_not_stocked');
  });

  test('a tier above the type\'s max is tier_not_stocked, naming the max', () => {
    assert.deepEqual(refusal('CARGO', 3, 'BASIC'), {
      error: 'This dock stocks CARGO components up to tier 2.', code: 'tier_not_stocked', componentType: 'CARGO', maxTier: 2
    });
    assert.equal(refusal('HULL', 4, 'BASIC').code, 'tier_not_stocked');
  });

  test('a grade outside the signed mask is quality_not_stocked', () => {
    assert.deepEqual(refusal('HULL', 2, 'CHEAP'), {
      error: 'This dock does not stock CHEAP grade components.', code: 'quality_not_stocked', componentType: 'HULL', qualityGrade: 'CHEAP'
    });
    assert.equal(refusal('HULL', 2, 'BASIC', { stockedQualityMask: CHEAP }).code, 'quality_not_stocked');
    assert.equal(refusal('HULL', 2, 'BASIC', { stockedQualityMask: 0 }).code, 'quality_not_stocked');
  });

  test('Artisan work stops at the signed cap, below the type\'s max tier', () => {
    const capped = { ...catalog([[HULL, 4]], BASIC | ARTISAN, 3) };
    assert.equal(upgradeStockRefusal(capped, { componentType: 'HULL', targetTier: 3, qualityGrade: 'ARTISAN' }), null);
    assert.deepEqual(upgradeStockRefusal(capped, { componentType: 'HULL', targetTier: 4, qualityGrade: 'ARTISAN' }), {
      error: 'This dock stocks Artisan components up to tier 3.',
      code: 'quality_not_stocked',
      componentType: 'HULL',
      qualityGrade: 'ARTISAN',
      artisanMaxTier: 3
    });
    assert.equal(upgradeStockRefusal(capped, { componentType: 'HULL', targetTier: 4, qualityGrade: 'BASIC' }), null);
  });

  test('component first, then tier, then grade', () => {
    assert.equal(refusal('ENGINES', 5, 'CHEAP').code, 'component_not_stocked');
    assert.equal(refusal('CARGO', 5, 'CHEAP').code, 'tier_not_stocked');
  });

  test('the lander (outside the engine\'s catalog) and tier 0 (removing a part) are not checked here', () => {
    assert.equal(refusal('LANDER', 3, 'ARTISAN', { outfittingStock: [], stockedQualityMask: 0 }), null);
    assert.equal(refusal('CARGO', 0, 'CHEAP', { outfittingStock: [], stockedQualityMask: 0 }), null);
  });
});

describe('POST /ship/upgrade against the docked station\'s catalog', () => {
  const funded = async () => {
    const pilot = await newPilot('Stock');
    await setCredits(pilot, 1_000_000);
    return pilot;
  };
  const buy = (pilot, componentType, targetTier, qualityGrade, receiptOverrides) => call(pilot, 'POST', '/ship/upgrade', {
    componentType,
    targetTier,
    ...(qualityGrade && { qualityGrade }),
    dockedReceipt: dockedReceipt(pilot, receiptOverrides)
  });
  const tierOf = async (pilot, type) => json(await call(pilot, 'GET', '/ship/loadout')).components.find((c) => c.type === type)?.tier ?? 0;

  const STARTING_TIER = { HULL: 1, ENGINES: 1 }; // the other types start unfitted (tier 0)
  // A refusal is a 403 with the code, and charges and changes nothing.
  async function assertRefused(pilot, res, code, type) {
    assert.equal(res.statusCode, 403, res.body);
    assert.equal(json(res).code, code);
    assert.equal(await credits(pilot), 1_000_000);
    assert.equal(await tierOf(pilot, type), STARTING_TIER[type] ?? 0);
  }

  test('a hull or component the station stocks is sold', async () => {
    const pilot = await funded();
    const stock = catalog([[HULL, 3], [CARGO, 2], [ENGINES, 2]], BASIC);
    assert.equal((await buy(pilot, 'HULL', 3, 'BASIC', stock)).statusCode, 200);
    assert.equal((await buy(pilot, 'CARGO', 2, undefined, stock)).statusCode, 200);
    assert.equal(await tierOf(pilot, 'HULL'), 3);
    assert.equal(await tierOf(pilot, 'CARGO'), 2);
  });

  test('a hull the station does not stock is component_not_stocked', async () => {
    const pilot = await funded();
    const res = await buy(pilot, 'HULL', 2, 'BASIC', catalog([[CARGO, 3]]));
    await assertRefused(pilot, res, 'component_not_stocked', 'HULL');
    assert.equal(json(res).maxTier, 0);
  });

  test('a component type the station does not stock is component_not_stocked', async () => {
    const pilot = await funded();
    await assertRefused(pilot, await buy(pilot, 'ENGINES', 2, 'BASIC', catalog([[HULL, 3]])), 'component_not_stocked', 'ENGINES');
    await assertRefused(pilot, await buy(pilot, 'ENGINES', 2, 'BASIC', catalog([])), 'component_not_stocked', 'ENGINES');
  });

  test('a tier above the station\'s max for the type is tier_not_stocked, with the max', async () => {
    const pilot = await funded();
    const res = await buy(pilot, 'HULL', 3, 'BASIC', catalog([[HULL, 2]]));
    await assertRefused(pilot, res, 'tier_not_stocked', 'HULL');
    assert.equal(json(res).maxTier, 2);
  });

  test('a grade the station does not stock is quality_not_stocked', async () => {
    const pilot = await funded();
    assert.equal((await buy(pilot, 'HULL', 3)).statusCode, 200); // the hull's budget has room for the engines
    await setCredits(pilot, 1_000_000);
    const stock = catalog([[HULL, 3], [ENGINES, 3]], BASIC);
    const res = await buy(pilot, 'ENGINES', 2, 'ARTISAN', stock);
    await assertRefused(pilot, res, 'quality_not_stocked', 'ENGINES');
    assert.equal(json(res).qualityGrade, 'ARTISAN');
    await assertRefused(pilot, await buy(pilot, 'ENGINES', 2, 'CHEAP', stock), 'quality_not_stocked', 'ENGINES');
    // BASIC is the default grade, so a station that stocks no grade at all refuses an upgrade that names none.
    const other = await funded();
    await assertRefused(other, await buy(other, 'HULL', 2, undefined, catalog([[HULL, 3]], 0)), 'quality_not_stocked', 'HULL');
    assert.equal((await buy(pilot, 'ENGINES', 2, undefined, stock)).statusCode, 200);
  });

  test('Artisan work above the station\'s Artisan cap is quality_not_stocked', async () => {
    const pilot = await funded();
    const stock = catalog([[HULL, 4]], BASIC | ARTISAN, 3);
    const res = await buy(pilot, 'HULL', 4, 'ARTISAN', stock);
    await assertRefused(pilot, res, 'quality_not_stocked', 'HULL');
    assert.equal(json(res).artisanMaxTier, 3);
    assert.equal((await buy(pilot, 'HULL', 3, 'ARTISAN', stock)).statusCode, 200);
  });

  test('the catalog cannot be edited: a different catalog under the same signature is docked_receipt_invalid', async () => {
    const pilot = await funded();
    const receipt = dockedReceipt(pilot, catalog([[HULL, 1]]));
    const widened = { ...receipt, outfittingStock: [{ componentType: HULL, maxTier: 5 }], stockedQualityMask: ALL_GRADES_MASK };
    const res = await call(pilot, 'POST', '/ship/upgrade', { componentType: 'HULL', targetTier: 5, dockedReceipt: widened });
    assert.equal(res.statusCode, 403, res.body);
    assert.equal(json(res).code, 'docked_receipt_invalid');
    assert.equal(await credits(pilot), 1_000_000);
  });

  test('a receipt without the catalog (V2) is refused by the schema and sells nothing', async () => {
    const pilot = await funded();
    const { outfittingStock, stockedQualityMask, artisanMaxTier, ...v2 } = dockedReceipt(pilot); // eslint-disable-line no-unused-vars
    const res = await call(pilot, 'POST', '/ship/upgrade', { componentType: 'HULL', targetTier: 2, dockedReceipt: v2 });
    assert.equal(res.statusCode, 400, res.body);
    assert.equal(await credits(pilot), 1_000_000);
  });

  test('the lander keeps its own stock rules: the catalog does not list it', async () => {
    const pilot = await funded();
    assert.equal((await buy(pilot, 'HULL', 3, 'BASIC')).statusCode, 200);
    const res = await buy(pilot, 'LANDER', 1, 'BASIC', catalog([[HULL, 3]], BASIC));
    assert.equal(res.statusCode, 200, res.body);
  });
});
