import { test, describe, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { addCrew, app, call, closeApp, dockedReceipt, json, newPilot } from './helpers.js';
import {
  CATEGORY, HOUR_MS, currentHour, poolUrl, secretOf, setStanding, signedIntelItem, signedPool, useEngine, useStationEngine
} from './intel-helpers.js';
import { stationServices } from '../src/lib/outfitting-station.js';

after(closeApp);
afterEach(() => app.intelEngine.reset());

const pool = (pilot, receipt, extra) => call(pilot, 'GET', poolUrl(receipt, extra));
const categories = (body) => body.items.map((item) => item.category);

describe('GET /game/intel/pool: the docked receipt', () => {
  test('refuses a request without a receipt, with a forged or another pilot\'s, and with an expired one', async () => {
    useStationEngine();
    const pilot = await newPilot('Intel');
    const other = await newPilot('Other');
    const noReceipt = await call(pilot, 'GET', '/game/intel/pool');
    assert.equal(noReceipt.statusCode, 403);
    assert.equal(json(noReceipt).code, 'docked_receipt_required');

    const unreadable = await call(pilot, 'GET', '/game/intel/pool?receipt=not-json');
    assert.equal(json(unreadable).code, 'docked_receipt_invalid');
    const forged = await pool(pilot, dockedReceipt(pilot, {}, generateKeyPairSync('ed25519').privateKey));
    assert.equal(json(forged).code, 'docked_receipt_invalid');
    const someoneElses = await pool(pilot, dockedReceipt(other));
    assert.equal(json(someoneElses).code, 'docked_receipt_invalid');
    const stale = await pool(pilot, dockedReceipt(pilot, { issuedAtMs: Date.now() - 10 * 60_000, dockedAtMs: Date.now() - 11 * 60_000 }));
    assert.equal(json(stale).code, 'docked_receipt_expired');
  });

  test('refuses a stationId that is not the receipt\'s dock, and a customs lockout there', async () => {
    useStationEngine();
    const pilot = await newPilot('Intel');
    const receipt = dockedReceipt(pilot);
    const mismatch = await pool(pilot, receipt, `&stationId=${randomUUID()}`);
    assert.equal(mismatch.statusCode, 403);
    assert.equal(json(mismatch).code, 'docked_receipt_station_mismatch');
    assert.equal((await pool(pilot, receipt, `&stationId=${receipt.dockedEntityId}`)).statusCode, 200);

    await app.prisma.stationLockout.create({ data: { playerId: pilot.id, stationId: receipt.dockedEntityId, until: new Date(Date.now() + 600_000), tier: 1 } });
    const locked = await pool(pilot, receipt);
    assert.equal(locked.statusCode, 403);
    assert.equal(json(locked).code, 'station_locked_out');
  });
});

describe('GET /game/intel/pool: the pool and its redaction', () => {
  test('shows the station\'s ten items for this hour with a full hourly budget', async () => {
    const requests = useStationEngine();
    const pilot = await newPilot('Intel');
    const receipt = dockedReceipt(pilot, { controllingFactionId: '' });
    const res = await pool(pilot, receipt);
    assert.equal(res.statusCode, 200);
    const body = json(res);
    assert.equal(body.station_entity_id, receipt.dockedEntityId);
    assert.equal(body.hour_epoch, currentHour());
    assert.equal(body.next_refresh_at_ms, (currentHour() + 1) * HOUR_MS);
    assert.equal(body.budget_total, 3);
    assert.equal(body.budget_remaining, 3);
    assert.equal(body.clearance, 'INTEL_CLEARANCE_CIVILIAN');
    assert.equal(body.clearance_banner, '[CIVILIAN TIER GUEST TERMINAL]');
    // An independent civilian terminal reads no faction recruitment calls and no tier 5 tip.
    assert.equal(body.items.length, 8);
    assert.ok(!categories(body).includes('INTEL_CATEGORY_FACTION_RECRUITMENT'));
    assert.equal(body.items.filter((item) => item.is_free_ambient).length, 2);
    // The engine is asked about this dock and hour, with no pilot identity.
    assert.equal(requests.length, 1);
    assert.deepEqual({ ...requests[0], sightings: undefined }, {
      stationEntityId: receipt.dockedEntityId, systemH3: receipt.systemH3, controllingFactionId: '', hourEpoch: currentHour(), sightings: undefined
    });
    assert.ok(!JSON.stringify(requests[0]).includes(pilot.id));
  });

  test('sends a paid item redacted until it is gathered: a generic headline, no body, no detail, no target anywhere', async () => {
    useStationEngine();
    const pilot = await newPilot('Intel');
    const res = await pool(pilot, dockedReceipt(pilot));
    const body = json(res);
    const paid = body.items.filter((item) => !item.is_free_ambient);
    assert.ok(paid.length > 0);
    for (const item of paid) {
      assert.equal(item.is_redacted, true, item.intel_id);
      assert.match(item.headline, /^\[(ENCRYPTED|CLASSIFIED|RESTRICTED)/);
      assert.equal(item.body, '');
      assert.equal(item.is_gathered, false);
      for (const key of ['outfitter_tip', 'mission_lead', 'faction_recruitment', 'away_team_site', 'player_sighting']) assert.ok(!(key in item), key);
      assert.ok(item.cost_credits > 0);
      assert.equal(item.budget_cost, 1);
      assert.equal(item.veracity, 'INTEL_VERACITY_UNSPECIFIED');
    }
    // Nothing the engine knows about a target is on the wire for a card the pilot has not gathered, free or paid.
    for (let slot = 0; slot < 10; slot++) assert.ok(!res.body.includes(secretOf(slot)), `slot ${slot} leaked`);
    assert.ok(!res.body.includes('somethingTheEngineAdded'));
  });

  test('sends a free ambient item as a coarse rumor at no credit cost, its exact detail withheld until it is gathered', async () => {
    useStationEngine();
    const pilot = await newPilot('Intel');
    const body = json(await pool(pilot, dockedReceipt(pilot)));
    const free = body.items.filter((item) => item.is_free_ambient);
    assert.equal(free.length, 2);
    for (const item of free) {
      assert.equal(item.is_redacted, false);
      assert.match(item.body, /^Coarse rumor/);
      assert.equal(item.cost_credits, 0);
      assert.equal(item.is_gathered, false);
      assert.ok(!('outfitter_tip' in item) && !('away_team_site' in item));
    }
  });

  test('is the same pool for the whole hour, and a different one for another dock', async () => {
    const requests = useStationEngine();
    const pilot = await newPilot('Intel');
    const receipt = dockedReceipt(pilot);
    const first = json(await pool(pilot, receipt));
    const second = json(await pool(pilot, dockedReceipt(pilot, { dockedEntityId: receipt.dockedEntityId })));
    assert.deepEqual(second.items.map((item) => item.intel_id), first.items.map((item) => item.intel_id));
    const elsewhere = json(await pool(pilot, dockedReceipt(pilot)));
    assert.notDeepEqual(elsewhere.items.map((item) => item.intel_id), first.items.map((item) => item.intel_id));
    assert.deepEqual(requests.map((request) => request.hourEpoch), [currentHour(), currentHour(), currentHour()]);
  });

  test('reports the unlocked state of an item whose standing the pilot does not meet', async () => {
    useStationEngine();
    const pilot = await newPilot('Intel');
    const receipt = dockedReceipt(pilot, { controllingFactionId: 'alpha' });
    await setStanding(pilot, 'alpha', 200);
    const low = json(await pool(pilot, receipt));
    const call3 = low.items.find((item) => item.category === 'INTEL_CATEGORY_FACTION_RECRUITMENT');
    assert.equal(call3.is_locked, true);
    await setStanding(pilot, 'alpha', 450);
    const high = json(await pool(pilot, receipt));
    assert.equal(high.items.find((item) => item.category === 'INTEL_CATEGORY_FACTION_RECRUITMENT').is_locked, false);
  });
});

describe('GET /game/intel/pool: standing gates what the terminal shows', () => {
  const atFaction = async (standing, { colors = false, factionId = 'alpha' } = {}) => {
    useStationEngine();
    const pilot = await newPilot('Intel');
    await setStanding(pilot, factionId, standing);
    if (colors) await app.prisma.player.update({ where: { id: pilot.id }, data: { activeColorsFactionId: factionId } });
    const res = await pool(pilot, dockedReceipt(pilot, { controllingFactionId: factionId }));
    return { res, body: json(res), pilot };
  };

  test('locks a Nemesis (-750 and below) out of the terminal', async () => {
    const { res, body } = await atFaction(-800);
    assert.equal(res.statusCode, 403);
    assert.equal(body.code, 'intel_access_refused');
    assert.equal(body.banner, '[ACCESS REFUSED: HOSTILE COMBATANT]');
    assert.equal(body.clearance, 'INTEL_CLEARANCE_ACCESS_REFUSED');
  });

  test('locks a Hostile pilot out of a secure dock, and gives them only the underworld backchannel at a low-security one', async () => {
    const refused = await atFaction(-600);
    assert.equal(refused.res.statusCode, 403);
    assert.equal(refused.body.code, 'intel_access_refused');

    const original = stationServices.isLowSecDock;
    stationServices.isLowSecDock = () => true;
    try {
      const { res, body } = await atFaction(-600);
      assert.equal(res.statusCode, 200);
      assert.equal(body.clearance, 'INTEL_CLEARANCE_SYNDICATE_TAP');
      assert.equal(body.clearance_banner, '[UNREGISTERED SYNDICATE TAP]');
      assert.deepEqual([...new Set(categories(body))].sort(), ['INTEL_CATEGORY_MISSION_LEAD', 'INTEL_CATEGORY_OUTFITTER_TIP']);
    } finally {
      stationServices.isLowSecDock = original;
    }
  });

  test('shows an Unfriendly pilot outfitter tips only, up to tier 3, and charges paid dossiers 25% more', async () => {
    const { body } = await atFaction(-300);
    assert.equal(body.clearance, 'INTEL_CLEARANCE_PROBATIONARY');
    assert.deepEqual([...new Set(categories(body))], ['INTEL_CATEGORY_OUTFITTER_TIP']);
    // The tier 5 tip (slot 3) is above the band; the tier 2 tip (slot 2) costs its 100 plus 25%.
    assert.deepEqual(body.items.map((item) => item.slot_index), [0, 2]);
    assert.equal(body.items.find((item) => item.slot_index === 2).cost_credits, 125);
    assert.equal(body.items.find((item) => item.slot_index === 0).cost_credits, 0);
  });

  test('shows a Neutral pilot the civilian market, a Friendly one faction calls too, and a Trusted one tier 5 tips', async () => {
    const neutral = (await atFaction(0)).body;
    assert.equal(neutral.clearance, 'INTEL_CLEARANCE_CIVILIAN');
    assert.ok(!categories(neutral).includes('INTEL_CATEGORY_FACTION_RECRUITMENT'));
    assert.ok(!neutral.items.some((item) => item.slot_index === 3), 'a tier 5 tip is above a civilian terminal');

    const friendly = (await atFaction(200)).body;
    assert.equal(friendly.clearance, 'INTEL_CLEARANCE_REGISTERED_OPERATIVE');
    assert.equal(friendly.clearance_banner, '[CLEARANCE: REGISTERED OPERATIVE]');
    assert.ok(categories(friendly).includes('INTEL_CATEGORY_FACTION_RECRUITMENT'));
    assert.ok(!friendly.items.some((item) => item.slot_index === 3), 'a tier 5 tip is above a registered operative');

    const trusted = (await atFaction(450)).body;
    assert.equal(trusted.clearance, 'INTEL_CLEARANCE_SECURITY_LEVEL_3');
    assert.equal(trusted.items.length, 10);
  });

  test('gives a Paragon, and a pilot flying the faction\'s colors, admiralty access', async () => {
    const paragon = (await atFaction(800)).body;
    assert.equal(paragon.clearance, 'INTEL_CLEARANCE_ADMIRALTY');
    assert.equal(paragon.clearance_banner, '[CLEARED: ADMIRALTY PRIVILEGED ACCESS]');
    const colors = (await atFaction(500, { colors: true })).body;
    assert.equal(colors.clearance, 'INTEL_CLEARANCE_ADMIRALTY');
    assert.equal((await atFaction(500)).body.clearance, 'INTEL_CLEARANCE_SECURITY_LEVEL_3');
  });

  test('bands by the governing faction\'s standing only: an independent dock is always civilian', async () => {
    useStationEngine();
    const pilot = await newPilot('Intel');
    await setStanding(pilot, 'alpha', -900);
    const body = json(await pool(pilot, dockedReceipt(pilot, { controllingFactionId: '' })));
    assert.equal(body.clearance, 'INTEL_CLEARANCE_CIVILIAN');
  });
});

describe('GET /game/intel/pool: the hourly budget', () => {
  test('is 3 for a pilot with no Comms Officer, and a Comms Officer raises it by rank, never past 6', async () => {
    useStationEngine();
    const read = async (pilot) => json(await pool(pilot, dockedReceipt(pilot)));
    const bare = await newPilot('Intel');
    assert.equal((await read(bare)).budget_total, 3);

    const adept = await newPilot('Intel');
    await addCrew(adept, { crewClass: 'COMMS_OFFICER', rank: 'ADEPT' });
    assert.equal((await read(adept)).budget_total, 4);

    const master = await newPilot('Intel');
    await addCrew(master, { crewClass: 'COMMS_OFFICER', rank: 'MASTER' });
    assert.equal((await read(master)).budget_total, 5);
    assert.ok((await read(master)).budget_total <= 6);
  });

  test('reveals a rumor\'s veracity only to a Master Comms Officer, and only on a card that is not redacted', async () => {
    useStationEngine();
    const master = await newPilot('Intel');
    await addCrew(master, { crewClass: 'COMMS_OFFICER', rank: 'MASTER' });
    const body = json(await pool(master, dockedReceipt(master)));
    for (const item of body.items) {
      assert.equal(item.veracity, item.is_redacted ? 'INTEL_VERACITY_UNSPECIFIED' : 'INTEL_VERACITY_EXAGGERATED', item.intel_id);
    }
  });

  test('does not count a mutinous Comms Officer', async () => {
    useStationEngine();
    const pilot = await newPilot('Intel');
    await addCrew(pilot, { crewClass: 'COMMS_OFFICER', rank: 'MASTER', morale: 0 });
    assert.equal(json(await pool(pilot, dockedReceipt(pilot))).budget_total, 3);
  });
});

describe('GET /game/intel/pool: the engine', () => {
  test('answers 503 when no engine is reachable, and 502 when the pool it sends is not valid', async () => {
    const pilot = await newPilot('Intel');
    const receipt = dockedReceipt(pilot);
    // No engine configured in the test environment.
    const none = await pool(pilot, receipt);
    assert.equal(none.statusCode, 503);
    assert.equal(json(none).code, 'intel_engine_unavailable');

    const bad = async (build) => {
      useEngine((request) => build(signedPool({ stationEntityId: request.stationEntityId, systemH3: request.systemH3, hourEpoch: request.hourEpoch }), request));
      const res = await pool(pilot, receipt);
      assert.equal(res.statusCode, 502);
      assert.equal(json(res).code, 'intel_pool_invalid');
    };
    const resign = (item, patch, key) => signedIntelItem({ ...item, ...patch, signature: undefined }, key);
    const at = (index, change) => (items) => items.map((item, i) => (i === index ? change(item) : item));
    await bad((items) => items.slice(0, 7));
    await bad((items) => [...items, items[2]]);
    await bad(at(4, (item) => ({ ...item, signature: Buffer.alloc(64).toString('base64') })));
    await bad(at(4, (item) => resign(item, { baseCostCredits: 1 })));
    await bad(at(4, (item) => resign(item, { isFreeAmbient: true, baseCostCredits: 0 })));
    await bad(at(4, (item) => resign(item, { stationEntityId: randomUUID() })));
    await bad(at(4, (item) => resign(item, { hourEpoch: item.hourEpoch - 1, expiresAtMs: item.expiresAtMs - HOUR_MS })));
    await bad(at(4, (item) => ({ ...item, detail: undefined })));
    // Signed by a key that is not the engine's claim key.
    await bad((items) => items.map((item) => resign(item, {}, generateKeyPairSync('ed25519').privateKey)));
  });

  test('passes the engine the dock\'s departures as the hour began, 15 minutes to 4 hours old, newest first', async () => {
    const requests = useStationEngine();
    const pilot = await newPilot('Intel');
    const receipt = dockedReceipt(pilot);
    const hourStart = currentHour() * HOUR_MS;
    const at = (ms) => ({ stationEntityId: receipt.dockedEntityId, shipName: `Ship-${ms}`, captainName: 'Capt', hullTier: 3, weaponTier: 4, shieldTier: 2, undockedAt: new Date(hourStart - ms) });
    const minutes = (m) => m * 60_000;
    await app.prisma.stationSightingRecord.createMany({
      data: [
        at(minutes(10)), // too fresh when the hour began
        at(minutes(20)), at(minutes(120)),
        at(minutes(250)), // too old
        { ...at(minutes(30)), stationEntityId: randomUUID() } // another dock
      ]
    });
    await pool(pilot, receipt);
    assert.deepEqual(requests[0].sightings.map((s) => s.ship_name), [`Ship-${minutes(20)}`, `Ship-${minutes(120)}`]);
    assert.deepEqual(Object.keys(requests[0].sightings[0]).sort(), [
      'captain_name', 'flying_colors', 'hull_tier', 'is_stealthed', 'shield_tier', 'ship_name', 'sighting_id', 'undocked_at_ms', 'weapon_tier'
    ]);
    await app.prisma.stationSightingRecord.deleteMany({ where: { stationEntityId: receipt.dockedEntityId } });
  });
});
