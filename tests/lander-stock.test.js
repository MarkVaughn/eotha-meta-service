import { after, afterEach, before, describe, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { app, call, closeApp, credits, dockedReceipt, json, newPilot, setCredits } from './helpers.js';
import { DockableKind, Wealth } from '../src/lib/contracts/penalty/eotha/common/v1/sector.js';
import { upgradeCost } from '../src/config/components.js';
import { landerStock, landerStockRefusal, stationServices } from '../src/lib/outfitting-station.js';

before(async () => { await app.ready(); });
after(closeApp);
// Every stub is restored after its test (restored explicitly, one by one).
let stubs = [];
const stub = (object, name, value) => { const m = mock.method(object, name, value); stubs.push(m); return m; };
const stubProp = (object, name, value) => { const m = mock.property(object, name, value); stubs.push(m); return m; };
const restore = () => { for (const m of stubs.splice(0).reverse()) m.mock.restore(); }; // newest first: stubs can stack
afterEach(restore);

const KINDS = {
  MINING: DockableKind.DOCKABLE_KIND_MINING,
  RESEARCH: DockableKind.DOCKABLE_KIND_RESEARCH,
  TRADING: DockableKind.DOCKABLE_KIND_TRADING,
  COLONY: DockableKind.DOCKABLE_KIND_COLONY
};
const WEALTHS = {
  THRIVING: Wealth.WEALTH_THRIVING,
  COMFORTABLE: Wealth.WEALTH_COMFORTABLE,
  STRUGGLING: Wealth.WEALTH_STRUGGLING,
  DESTITUTE: Wealth.WEALTH_DESTITUTE
};

// Docks the pilot at a station of `kind` and `wealth` (the receipt carries neither; the profile seam does).
function station({ kind, wealth, shipyard = false }) {
  if (kind !== undefined) stub(stationServices, 'dockableKind', () => kind);
  if (wealth !== undefined) stub(stationServices, 'wealth', () => wealth);
  if (shipyard) stub(stationServices, 'isMajorShipyard', () => true);
}

// A pilot with a Tier 5 hull (budget for any lander) and plenty of credits.
async function richPilot() {
  const pilot = await newPilot('Lander');
  await setCredits(pilot, 1_000_000);
  const hull = await call(pilot, 'POST', '/ship/upgrade', { componentType: 'HULL', targetTier: 5, dockedReceipt: dockedReceipt(pilot) });
  assert.equal(hull.statusCode, 200, hull.body);
  await setCredits(pilot, 1_000_000);
  return pilot;
}
const buy = (pilot, targetTier, qualityGrade, receiptOverrides = {}) => call(pilot, 'POST', '/ship/upgrade', {
  componentType: 'LANDER',
  targetTier,
  ...(qualityGrade && { qualityGrade }),
  dockedReceipt: dockedReceipt(pilot, receiptOverrides)
});
const lander = async (pilot) => json(await call(pilot, 'GET', '/ship/loadout')).components.find((c) => c.type === 'LANDER');

describe('lander stock profile', () => {
  test('an unknown dock is unrestricted (the seam defaults) until kinds are required', () => {
    const receipt = { controllingFactionId: '' };
    assert.deepEqual(landerStock(receipt), { known: false, maxTier: 3, artisan: true });
    assert.equal(landerStockRefusal(receipt, { targetTier: 3, qualityGrade: 'ARTISAN' }), null);
    stubProp(stationServices, 'requireKnownDockableKind', true);
    const refusal = landerStockRefusal(receipt, { targetTier: 1, qualityGrade: 'BASIC' });
    assert.equal(refusal.code, 'lander_not_stocked');
  });

  test('tier ceilings by kind: mining and research 2, trading 1, colony 3; a major shipyard 3', () => {
    const ceilings = { MINING: 2, RESEARCH: 2, TRADING: 1, COLONY: 3 };
    for (const [name, kind] of Object.entries(KINDS)) {
      stub(stationServices, 'dockableKind', () => kind);
      assert.equal(landerStock({ controllingFactionId: '' }).maxTier, ceilings[name], name);
    }
    for (const kind of [KINDS.MINING, KINDS.RESEARCH, KINDS.TRADING]) {
      stub(stationServices, 'dockableKind', () => kind);
      stub(stationServices, 'isMajorShipyard', () => true);
      assert.equal(landerStock({ controllingFactionId: '' }).maxTier, 3);
    }
  });
});

describe('POST /ship/upgrade for LANDER by station kind', () => {
  const LIMITS = [
    ['MINING', 2],
    ['RESEARCH', 2],
    ['TRADING', 1],
    ['COLONY', 3]
  ];
  for (const [name, max] of LIMITS) {
    test(`a ${name} dock fits a lander up to tier ${max}`, async () => {
      station({ kind: KINDS[name], wealth: Wealth.WEALTH_COMFORTABLE });
      const pilot = await richPilot();
      const res = await buy(pilot, max);
      assert.equal(res.statusCode, 200, res.body);
      assert.equal(json(res).cost, upgradeCost(0, max, 'LANDER'));
      assert.equal((await lander(pilot)).tier, max);
    });

    if (max < 3) {
      test(`a ${name} dock refuses tier ${max + 1} without charging`, async () => {
        station({ kind: KINDS[name], wealth: Wealth.WEALTH_COMFORTABLE });
        const pilot = await richPilot();
        const res = await buy(pilot, max + 1);
        assert.equal(res.statusCode, 403, res.body);
        assert.equal(json(res).code, 'lander_tier_not_stocked');
        assert.equal(json(res).maxTier, max);
        assert.equal(await credits(pilot), 1_000_000);
        assert.equal((await lander(pilot)).tier, 0);
      });
    }
  }

  test('a major shipyard of a lower-ceiling kind fits tier 3', async () => {
    station({ kind: KINDS.MINING, wealth: Wealth.WEALTH_COMFORTABLE, shipyard: true });
    const pilot = await richPilot();
    const res = await buy(pilot, 3);
    assert.equal(res.statusCode, 200, res.body);
    assert.equal((await lander(pilot)).tier, 3);
  });

  test('a faction citadel (a colony in faction space) fits tier 3', async () => {
    station({ kind: KINDS.COLONY, wealth: Wealth.WEALTH_THRIVING });
    const pilot = await richPilot();
    const res = await buy(pilot, 3, undefined, { controllingFactionId: 'alpha' });
    assert.equal(res.statusCode, 200, res.body);
  });

  test('the ceiling bounds a tier climbed in steps and the same dock still serves the lower ones', async () => {
    station({ kind: KINDS.RESEARCH, wealth: Wealth.WEALTH_COMFORTABLE });
    const pilot = await richPilot();
    assert.equal((await buy(pilot, 1)).statusCode, 200);
    assert.equal((await buy(pilot, 2)).statusCode, 200);
    const res = await buy(pilot, 3);
    assert.equal(res.statusCode, 403);
    assert.equal((await lander(pilot)).tier, 2);
  });

  test('a dock of unknown kind sells landers while kinds are not required, and none once they are', async () => {
    const pilot = await richPilot();
    const open = await buy(pilot, 1);
    assert.equal(open.statusCode, 200, open.body);
    stubProp(stationServices, 'requireKnownDockableKind', true);
    const closed = await buy(pilot, 2);
    assert.equal(closed.statusCode, 403);
    assert.equal(json(closed).code, 'lander_not_stocked');
  });

  test('other components are not subject to the lander stock', async () => {
    station({ kind: KINDS.TRADING, wealth: Wealth.WEALTH_COMFORTABLE });
    const pilot = await richPilot();
    const res = await call(pilot, 'POST', '/ship/upgrade', { componentType: 'CARGO', targetTier: 3, dockedReceipt: dockedReceipt(pilot) });
    assert.equal(res.statusCode, 200, res.body);
  });
});

describe('POST /ship/upgrade for an Artisan LANDER by wealth band', () => {
  const ARTISAN_T1 = 2.5 * upgradeCost(0, 1, 'LANDER');

  for (const [band, wealth] of Object.entries(WEALTHS)) {
    const stocks = band === 'THRIVING';
    test(`${band} independent free port ${stocks ? 'stocks' : 'does not stock'} Artisan landers at 2.5x`, async () => {
      station({ kind: KINDS.TRADING, wealth });
      const pilot = await richPilot();
      const res = await buy(pilot, 1, 'ARTISAN');
      if (stocks) {
        assert.equal(res.statusCode, 200, res.body);
        assert.equal(json(res).cost, ARTISAN_T1);
        assert.equal(json(res).qualityGrade, 'ARTISAN');
        assert.equal((await lander(pilot)).quality, 'ARTISAN');
      } else {
        assert.equal(res.statusCode, 403, res.body);
        assert.equal(json(res).code, 'lander_quality_not_stocked');
        assert.equal(await credits(pilot), 1_000_000);
      }
    });
  }

  test('every wealth band still stocks the Basic lander its kind allows', async () => {
    for (const wealth of Object.values(WEALTHS)) {
      restore();
      station({ kind: KINDS.TRADING, wealth });
      const pilot = await richPilot();
      assert.equal((await buy(pilot, 1, 'BASIC')).statusCode, 200, `${wealth}`);
    }
  });

  test('a thriving dock that is not an independent free port stocks no Artisan lander', async () => {
    // Faction-controlled trading dock, and thriving independent docks of the other kinds.
    station({ kind: KINDS.TRADING, wealth: Wealth.WEALTH_THRIVING });
    const factional = await richPilot();
    const f = await buy(factional, 1, 'ARTISAN', { controllingFactionId: 'beta' });
    assert.equal(f.statusCode, 403);
    assert.equal(json(f).code, 'lander_quality_not_stocked');
    for (const name of ['MINING', 'RESEARCH', 'COLONY']) {
      restore();
      station({ kind: KINDS[name], wealth: Wealth.WEALTH_THRIVING });
      const pilot = await richPilot();
      const res = await buy(pilot, 1, 'ARTISAN');
      assert.equal(res.statusCode, 403, name);
      assert.equal(json(res).code, 'lander_quality_not_stocked', name);
    }
  });

  test('a wealthy free port refuses an Artisan lander above its tier ceiling, by tier first', async () => {
    station({ kind: KINDS.TRADING, wealth: Wealth.WEALTH_THRIVING });
    const pilot = await richPilot();
    const res = await buy(pilot, 2, 'ARTISAN');
    assert.equal(res.statusCode, 403);
    assert.equal(json(res).code, 'lander_tier_not_stocked');
  });

  test('regrading a fitted lander to Artisan needs a free port too', async () => {
    station({ kind: KINDS.RESEARCH, wealth: Wealth.WEALTH_THRIVING });
    const pilot = await richPilot();
    assert.equal((await buy(pilot, 1)).statusCode, 200);
    const refused = await buy(pilot, 1, 'ARTISAN');
    assert.equal(refused.statusCode, 403);
    assert.equal(json(refused).code, 'lander_quality_not_stocked');
    restore();
    station({ kind: KINDS.TRADING, wealth: Wealth.WEALTH_THRIVING });
    const ok = await buy(pilot, 1, 'ARTISAN');
    assert.equal(ok.statusCode, 200, ok.body);
    assert.equal((await lander(pilot)).quality, 'ARTISAN');
  });
});
