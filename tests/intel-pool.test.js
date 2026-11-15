import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { addCrew, app, call, closeApp, dockedReceipt, json, newPilot, setCredits } from './helpers.js';
import { HOUR_MS, currentHour, gatherBody, intelIdOf, poolUrl, setStanding, voucherVerifies } from './intel-helpers.js';
import { stationServices } from '../src/lib/outfitting-station.js';

after(closeApp);

const pool = (pilot, receipt, extra) => call(pilot, 'GET', poolUrl(receipt, extra));

describe('GET /game/intel/pool: the docked receipt', () => {
  test('refuses a request without a receipt, with a forged or another pilot\'s, and with an expired one', async () => {
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

describe('GET /game/intel/pool: the pilot\'s side of the terminal', () => {
  test('answers with this hour, a full budget and the clearance, and holds no pool of its own', async () => {
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
    assert.deepEqual(body.gathered_intel_ids, []);
    assert.deepEqual(body.unlocks, []);
    assert.deepEqual(body.sightings, []);
    // The engine's pool reaches the client over the game connection, never through this service.
    assert.ok(!('items' in body));
    assert.ok(!res.body.includes(pilot.id));
  });

  test('reports what the pilot gathered this hour and the vouchers they still hold, at any dock', async () => {
    const pilot = await newPilot('Intel');
    await setCredits(pilot, 2000);
    const dockA = dockedReceipt(pilot);
    const dockB = dockedReceipt(pilot);
    assert.equal((await call(pilot, 'POST', '/game/intel/gather', gatherBody(dockA, 2, 100))).statusCode, 200);
    const lead = json(await call(pilot, 'POST', '/game/intel/gather', gatherBody(dockA, 4, 250)));

    const body = json(await pool(pilot, dockB));
    assert.equal(body.budget_remaining, 1);
    assert.deepEqual([...body.gathered_intel_ids].sort(), [intelIdOf(dockA.dockedEntityId, 2), intelIdOf(dockA.dockedEntityId, 4)].sort());
    assert.equal(body.unlocks.length, 1);
    const [unlock] = body.unlocks;
    assert.equal(unlock.intel_id, lead.voucher.intel_id);
    assert.equal(unlock.station_entity_id, dockA.dockedEntityId);
    assert.equal(unlock.is_accepted, false);
    assert.equal(unlock.unlock_expires_at_ms, lead.voucher.expires_at_ms);
    assert.deepEqual(unlock.voucher, lead.voucher);
    assert.equal(voucherVerifies(unlock.voucher), true);

    // An expired unlock is no longer listed.
    await app.prisma.playerMissionUnlock.updateMany({ where: { playerId: pilot.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    assert.deepEqual(json(await pool(pilot, dockB)).unlocks, []);
  });

  test('does not list another pilot\'s gathers', async () => {
    const pilot = await newPilot('Intel');
    await setCredits(pilot, 1000);
    const receipt = dockedReceipt(pilot);
    await call(pilot, 'POST', '/game/intel/gather', gatherBody(receipt, 4, 250));
    const other = await newPilot('Other');
    const body = json(await pool(other, dockedReceipt(other, { dockedEntityId: receipt.dockedEntityId })));
    assert.equal(body.budget_remaining, 3);
    assert.deepEqual([body.gathered_intel_ids, body.unlocks], [[], []]);
  });

  test('refuses a Nemesis the terminal', async () => {
    const pilot = await newPilot('Intel');
    await setStanding(pilot, 'beta', -900);
    const res = await pool(pilot, dockedReceipt(pilot, { controllingFactionId: 'beta' }));
    assert.equal(res.statusCode, 403);
    assert.equal(json(res).code, 'intel_access_refused');
  });
});

describe('GET /game/intel/pool: standing sets the clearance band', () => {
  const atFaction = async (standing, { colors = false, factionId = 'alpha' } = {}) => {
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
    } finally {
      stationServices.isLowSecDock = original;
    }
  });

  test('bands each standing: Unfriendly, Neutral, Friendly, Trusted and Paragon', async () => {
    const expected = [
      [-300, 'INTEL_CLEARANCE_PROBATIONARY', '[PROBATIONARY MONITORING ACTIVE]'],
      [0, 'INTEL_CLEARANCE_CIVILIAN', '[CIVILIAN TIER GUEST TERMINAL]'],
      [200, 'INTEL_CLEARANCE_REGISTERED_OPERATIVE', '[CLEARANCE: REGISTERED OPERATIVE]'],
      [450, 'INTEL_CLEARANCE_SECURITY_LEVEL_3', '[SECURITY CLEARANCE: LEVEL 3 AUTHORIZED]'],
      [800, 'INTEL_CLEARANCE_ADMIRALTY', '[CLEARED: ADMIRALTY PRIVILEGED ACCESS]']
    ];
    for (const [standing, clearance, banner] of expected) {
      const { body } = await atFaction(standing);
      assert.deepEqual([body.clearance, body.clearance_banner], [clearance, banner], `standing ${standing}`);
    }
  });

  test('gives a pilot flying the faction\'s colors admiralty access at 500, and only security level 3 without them', async () => {
    assert.equal((await atFaction(500, { colors: true })).body.clearance, 'INTEL_CLEARANCE_ADMIRALTY');
    assert.equal((await atFaction(500)).body.clearance, 'INTEL_CLEARANCE_SECURITY_LEVEL_3');
  });

  test('bands by the governing faction\'s standing only: an independent dock is always civilian', async () => {
    const pilot = await newPilot('Intel');
    await setStanding(pilot, 'alpha', -900);
    const body = json(await pool(pilot, dockedReceipt(pilot, { controllingFactionId: '' })));
    assert.equal(body.clearance, 'INTEL_CLEARANCE_CIVILIAN');
  });
});

describe('GET /game/intel/pool: the hourly budget', () => {
  test('is 3 for a pilot with no Comms Officer, and a Comms Officer raises it by rank, never past 6', async () => {
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

  test('does not count a mutinous Comms Officer', async () => {
    const pilot = await newPilot('Intel');
    await addCrew(pilot, { crewClass: 'COMMS_OFFICER', rank: 'MASTER', morale: 0 });
    assert.equal(json(await pool(pilot, dockedReceipt(pilot))).budget_total, 3);
  });
});

describe('GET /game/intel/pool: the dock\'s sightings', () => {
  test('lists the dock\'s departures as the hour began, 15 minutes to 4 hours old, newest first', async () => {
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
    const { sightings } = json(await pool(pilot, receipt));
    assert.deepEqual(sightings.map((s) => s.ship_name), [`Ship-${minutes(20)}`, `Ship-${minutes(120)}`]);
    assert.deepEqual(Object.keys(sightings[0]).sort(), [
      'captain_name', 'flying_colors', 'hull_tier', 'is_stealthed', 'shield_tier', 'ship_name', 'sighting_id', 'undocked_at_ms', 'weapon_tier'
    ]);
    assert.ok(!JSON.stringify(sightings).includes(pilot.id));
    await app.prisma.stationSightingRecord.deleteMany({ where: { stationEntityId: receipt.dockedEntityId } });
  });
});
