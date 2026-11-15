import { test, describe, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { VOUCHER_KEY_ID, addCrew, app, call, closeApp, credits, dockedReceipt, json, newPilot, setCredits } from './helpers.js';
import {
  CATEGORY, HOUR_MS, currentHour, intelIdOf, poolUrl, secretOf, setStanding, signedPool, useEngine, useStationEngine, voucherVerifies
} from './intel-helpers.js';

after(closeApp);
afterEach(() => app.intelEngine.reset());

const gather = (pilot, receipt, slot, expectedCostCredits, extra = {}) => call(pilot, 'POST', '/game/intel/gather', {
  intelId: intelIdOf(receipt.dockedEntityId, slot),
  hourEpoch: currentHour(),
  expectedCostCredits,
  dockedReceipt: receipt,
  ...extra
});
const budgetRow = (pilot) => app.prisma.playerIntelBudget.findUnique({ where: { playerId_hourEpoch: { playerId: pilot.id, hourEpoch: BigInt(currentHour()) } } });
const richPilot = async (balance = 5000) => {
  const pilot = await newPilot('Intel');
  await setCredits(pilot, balance);
  return pilot;
};

describe('POST /game/intel/gather: budget and price', () => {
  test('gathers a free item for one budget point and no credits, and unredacts its detail', async () => {
    useStationEngine();
    const pilot = await richPilot(1000);
    const receipt = dockedReceipt(pilot);
    const res = await gather(pilot, receipt, 0, 0);
    assert.equal(res.statusCode, 200);
    const body = json(res);
    assert.equal(body.result, 'GATHER_INTEL_ITEM_RESULT_SUCCESS');
    assert.equal(body.credits_charged, 0);
    assert.equal(body.budget_remaining, 2);
    assert.equal(body.budget_total, 3);
    assert.equal(body.item.is_gathered, true);
    assert.equal(body.item.is_redacted, false);
    assert.equal(body.item.outfitter_tip.target_station_name, secretOf(0));
    assert.equal(body.item.outfitter_tip.tier, 2);
    assert.ok(!('voucher' in body));
    assert.equal(await credits(pilot), 1000);
    assert.equal((await budgetRow(pilot)).gatheredCount, 1);

    // The terminal now shows it gathered, with its detail, and the budget spent.
    const pool = json(await call(pilot, 'GET', poolUrl(receipt)));
    assert.equal(pool.budget_remaining, 2);
    const shown = pool.items.find((item) => item.slot_index === 0);
    assert.equal(shown.is_gathered, true);
    assert.equal(shown.outfitter_tip.target_station_name, secretOf(0));
  });

  test('charges a paid item its price, spends one point, and keeps the dossier four hours', async () => {
    useStationEngine();
    const pilot = await richPilot(1000);
    const receipt = dockedReceipt(pilot);
    const before = Date.now();
    const res = await gather(pilot, receipt, 2, 100);
    assert.equal(res.statusCode, 200);
    const body = json(res);
    assert.equal(body.credits_charged, 100);
    assert.equal(body.credits, 900);
    assert.equal(await credits(pilot), 900);
    assert.equal(body.budget_remaining, 2);
    assert.equal(body.item.is_redacted, false);
    assert.equal(body.item.headline, 'Rumor 2');
    assert.equal(body.item.outfitter_tip.target_station_name, secretOf(2));
    assert.ok(body.unlock_expires_at_ms >= before + 4 * HOUR_MS && body.unlock_expires_at_ms <= Date.now() + 4 * HOUR_MS);
    // The detail carries only the contract's fields.
    const away = json(await gather(pilot, receipt, 4, 250)).item.mission_lead;
    assert.ok(!('some_thing_the_engine_added' in away) && !('somethingTheEngineAdded' in away));
    assert.equal(away.reward_credits, 4000);
  });

  test('refuses a changed price, a short purse and an unknown or rotated item, charging and spending nothing', async () => {
    useStationEngine();
    const pilot = await richPilot(90);
    const receipt = dockedReceipt(pilot);
    const wrongPrice = await gather(pilot, receipt, 2, 80);
    assert.equal(wrongPrice.statusCode, 409);
    assert.deepEqual([json(wrongPrice).code, json(wrongPrice).cost_credits], ['price_changed', 100]);

    const broke = await gather(pilot, receipt, 2, 100);
    assert.equal(broke.statusCode, 402);
    assert.equal(json(broke).code, 'insufficient_credits');

    const unknown = await gather(pilot, receipt, 2, 100, { intelId: 'intel-from-another-dock' });
    assert.equal(unknown.statusCode, 404);
    assert.equal(json(unknown).code, 'unknown_intel_item');

    const rotated = await gather(pilot, receipt, 2, 100, { hourEpoch: currentHour() - 1 });
    assert.equal(rotated.statusCode, 409);
    assert.equal(json(rotated).code, 'intel_pool_expired');
    assert.equal(json(rotated).hour_epoch, currentHour());

    assert.equal(await credits(pilot), 90);
    assert.equal(await budgetRow(pilot), null);
  });

  test('stops at the hourly budget, across every dock the pilot visits that hour', async () => {
    useStationEngine();
    const pilot = await richPilot(10_000);
    const dockA = dockedReceipt(pilot);
    const dockB = dockedReceipt(pilot);
    assert.equal((await gather(pilot, dockA, 0, 0)).statusCode, 200);
    assert.equal((await gather(pilot, dockA, 1, 0)).statusCode, 200);
    // Moving on to another dock inside the hour neither resets nor doubles the budget.
    const third = await gather(pilot, dockB, 2, 100);
    assert.equal(third.statusCode, 200);
    assert.equal(json(third).budget_remaining, 0);

    const fourth = await gather(pilot, dockB, 4, 250);
    assert.equal(fourth.statusCode, 409);
    assert.deepEqual([json(fourth).code, json(fourth).budget_remaining, json(fourth).budget_total], ['budget_exhausted', 0, 3]);
    assert.equal((await gather(pilot, dockA, 2, 100)).statusCode, 409);
    assert.equal(await credits(pilot), 9900);
    assert.equal((await budgetRow(pilot)).gatheredCount, 3);

    const pool = json(await call(pilot, 'GET', poolUrl(dockB)));
    assert.equal(pool.budget_remaining, 0);
  });

  test('gives a Master Comms Officer\'s pilot five points and no more', async () => {
    useStationEngine();
    const pilot = await richPilot(10_000);
    await addCrew(pilot, { crewClass: 'COMMS_OFFICER', rank: 'MASTER' });
    const receipt = dockedReceipt(pilot);
    for (const slot of [0, 1, 2, 4, 5]) assert.equal((await gather(pilot, receipt, slot, slot < 2 ? 0 : (slot === 2 ? 100 : 250))).statusCode, 200, `slot ${slot}`);
    const sixth = await gather(pilot, receipt, 7, 250);
    assert.equal(sixth.statusCode, 409);
    assert.deepEqual([json(sixth).code, json(sixth).budget_total], ['budget_exhausted', 5]);
  });

  test('repeats a gathered item for nothing, even with the budget spent', async () => {
    useStationEngine();
    const pilot = await richPilot(1000);
    const receipt = dockedReceipt(pilot);
    await gather(pilot, receipt, 2, 100);
    await gather(pilot, receipt, 0, 0);
    await gather(pilot, receipt, 1, 0);
    const again = await gather(pilot, receipt, 2, 100);
    assert.equal(again.statusCode, 200);
    const body = json(again);
    assert.equal(body.result, 'GATHER_INTEL_ITEM_RESULT_ALREADY_GATHERED');
    assert.equal(body.credits_charged, 0);
    assert.equal(body.budget_remaining, 0);
    assert.equal(body.item.outfitter_tip.target_station_name, secretOf(2));
    assert.equal(await credits(pilot), 900);
    assert.equal((await budgetRow(pilot)).gatheredCount, 3);
  });

  test('spends the budget once when two gathers race for the last point', async () => {
    useStationEngine();
    const pilot = await richPilot(10_000);
    const receipt = dockedReceipt(pilot);
    await gather(pilot, receipt, 0, 0);
    await gather(pilot, receipt, 1, 0);
    const results = await Promise.all([gather(pilot, receipt, 2, 100), gather(pilot, receipt, 7, 250)]);
    assert.deepEqual(results.map((res) => res.statusCode).sort(), [200, 409]);
    assert.equal((await budgetRow(pilot)).gatheredCount, 3);
    const spent = 10_000 - await credits(pilot);
    assert.ok(spent === 100 || spent === 250, `spent ${spent}`);
  });

  test('charges an Unfriendly pilot the 25% informant surcharge, and refuses the list price', async () => {
    useStationEngine();
    const pilot = await richPilot(1000);
    await setStanding(pilot, 'alpha', -300);
    const receipt = dockedReceipt(pilot, { controllingFactionId: 'alpha' });
    const list = await gather(pilot, receipt, 2, 100);
    assert.equal(json(list).code, 'price_changed');
    const res = await gather(pilot, receipt, 2, 125);
    assert.equal(res.statusCode, 200);
    assert.equal(json(res).credits_charged, 125);
    assert.equal(await credits(pilot), 875);
  });
});

describe('POST /game/intel/gather: standing and the dock', () => {
  test('refuses an item whose standing requirement the pilot does not meet, and gathers it once they do', async () => {
    useStationEngine();
    const pilot = await richPilot(1000);
    await setStanding(pilot, 'alpha', 200);
    const receipt = dockedReceipt(pilot, { controllingFactionId: 'alpha' });
    const refused = await gather(pilot, receipt, 6, 500);
    assert.equal(refused.statusCode, 403);
    assert.deepEqual([json(refused).code, json(refused).required_standing, json(refused).required_standing_faction_id], ['clearance_too_low', 450, 'alpha']);
    assert.equal(await credits(pilot), 1000);
    assert.equal(await budgetRow(pilot), null);

    await setStanding(pilot, 'alpha', 450);
    const ok = await gather(pilot, receipt, 6, 500);
    assert.equal(ok.statusCode, 200);
    assert.equal(json(ok).voucher.category, CATEGORY.RECRUIT);
    assert.equal(json(ok).item.faction_recruitment.call_sign, secretOf(6));
  });

  test('treats an item the terminal does not show as nonexistent, and a Nemesis as refused', async () => {
    useStationEngine();
    const pilot = await richPilot(1000);
    // A civilian terminal reads no faction calls, whatever the item's own standing gate says.
    const hidden = await gather(pilot, dockedReceipt(pilot), 6, 500);
    assert.equal(hidden.statusCode, 404);
    assert.equal(json(hidden).code, 'unknown_intel_item');

    await setStanding(pilot, 'beta', -900);
    const refused = await gather(pilot, dockedReceipt(pilot, { controllingFactionId: 'beta' }), 2, 100);
    assert.equal(refused.statusCode, 403);
    assert.equal(json(refused).code, 'intel_access_refused');
    assert.equal(await credits(pilot), 1000);
    assert.equal(await budgetRow(pilot), null);
  });

  test('requires a docked receipt for this pilot and dock, and no customs lockout', async () => {
    useStationEngine();
    const pilot = await richPilot(1000);
    const other = await newPilot('Other');
    const receipt = dockedReceipt(pilot);
    const intelId = intelIdOf(receipt.dockedEntityId, 0);
    const body = { intelId, hourEpoch: currentHour(), expectedCostCredits: 0 };
    assert.equal(json(await call(pilot, 'POST', '/game/intel/gather', body)).code, 'docked_receipt_required');
    assert.equal(json(await call(pilot, 'POST', '/game/intel/gather', { ...body, dockedReceipt: dockedReceipt(other) })).code, 'docked_receipt_invalid');
    assert.equal(json(await call(pilot, 'POST', '/game/intel/gather', { ...body, dockedReceipt: { ...receipt, systemH3: '88283082a9fffff' } })).code, 'docked_receipt_invalid');
    const expired = dockedReceipt(pilot, { issuedAtMs: Date.now() - 600_000, dockedAtMs: Date.now() - 601_000 });
    assert.equal(json(await call(pilot, 'POST', '/game/intel/gather', { ...body, dockedReceipt: expired })).code, 'docked_receipt_expired');
    assert.equal(json(await call(pilot, 'POST', '/game/intel/gather', { ...body, dockedReceipt: receipt, stationId: randomUUID() })).code, 'docked_receipt_station_mismatch');
    await app.prisma.stationLockout.create({ data: { playerId: pilot.id, stationId: receipt.dockedEntityId, until: new Date(Date.now() + 600_000), tier: 1 } });
    assert.equal(json(await call(pilot, 'POST', '/game/intel/gather', { ...body, dockedReceipt: receipt })).code, 'station_locked_out');
    assert.equal(await budgetRow(pilot), null);
  });

  test('answers 503 without an engine and 502 for a bad pool, charging nothing', async () => {
    const pilot = await richPilot(1000);
    const receipt = dockedReceipt(pilot);
    assert.equal((await gather(pilot, receipt, 0, 0)).statusCode, 503);
    useEngine((request) => signedPool({ stationEntityId: request.stationEntityId, systemH3: request.systemH3, hourEpoch: request.hourEpoch }).slice(0, 5));
    const res = await gather(pilot, receipt, 0, 0);
    assert.equal(res.statusCode, 502);
    assert.equal(json(res).code, 'intel_pool_invalid');
    assert.equal(await budgetRow(pilot), null);
  });
});

describe('POST /game/intel/gather: vouchers for mission leads', () => {
  const unlockOf = (pilot, missionId) => app.prisma.playerMissionUnlock.findUnique({ where: { playerId_missionId: { playerId: pilot.id, missionId } } });

  test('issues a signed, pilot-bound voucher with the lead and stores the unlock for four hours', async () => {
    useStationEngine();
    const pilot = await richPilot(1000);
    const receipt = dockedReceipt(pilot);
    const res = await gather(pilot, receipt, 4, 250);
    assert.equal(res.statusCode, 200);
    const { item, voucher } = json(res);
    assert.equal(voucher.issuer_key_id, VOUCHER_KEY_ID);
    assert.equal(voucher.pilot_id, pilot.id);
    assert.equal(voucher.mission_id, item.mission_lead.mission_id);
    assert.equal(voucher.intel_id, item.intel_id);
    assert.equal(voucher.category, CATEGORY.LEAD);
    assert.equal(voucher.station_entity_id, receipt.dockedEntityId);
    assert.equal(voucher.system_h3, receipt.systemH3);
    assert.equal(voucher.expires_at_ms - voucher.issued_at_ms, 4 * HOUR_MS);
    assert.equal(Buffer.from(voucher.nonce, 'base64').length, 16);
    assert.equal(voucherVerifies(voucher), true);
    assert.equal(voucherVerifies({ ...voucher, pilot_id: randomUUID() }), false);
    assert.equal(voucherVerifies({ ...voucher, mission_id: randomUUID() }), false);

    const row = await unlockOf(pilot, voucher.mission_id);
    assert.equal(row.isAccepted, false);
    assert.equal(row.intelId, item.intel_id);
    assert.equal(row.expiresAt.getTime(), voucher.expires_at_ms);
    assert.equal(Buffer.from(row.voucherNonce).toString('base64'), voucher.nonce);

    // Gathering it again hands back the same voucher.
    const again = json(await gather(pilot, receipt, 4, 250));
    assert.equal(again.result, 'GATHER_INTEL_ITEM_RESULT_ALREADY_GATHERED');
    assert.deepEqual(again.voucher, voucher);
  });

  test('issues no voucher for a tip or a site, and one for a faction call', async () => {
    useStationEngine();
    const pilot = await richPilot(2000);
    await setStanding(pilot, 'alpha', 600);
    const receipt = dockedReceipt(pilot, { controllingFactionId: 'alpha' });
    assert.ok(!('voucher' in json(await gather(pilot, receipt, 2, 100))));
    assert.ok(!('voucher' in json(await gather(pilot, receipt, 7, 250))));
    const call3 = json(await gather(pilot, receipt, 6, 500));
    assert.equal(call3.voucher.category, CATEGORY.RECRUIT);
    assert.equal(voucherVerifies(call3.voucher), true);
    assert.equal(await app.prisma.playerMissionUnlock.count({ where: { playerId: pilot.id } }), 1);
  });

  test('unlocks a mission once: a live unlock refuses another lead for it, an expired one is renewed', async () => {
    const sharedMission = randomUUID();
    useEngine((request) => signedPool({ stationEntityId: request.stationEntityId, systemH3: request.systemH3, hourEpoch: request.hourEpoch })
      .map((item) => (item.slotIndex === 5 ? { ...item, detail: { missionLead: { ...item.detail.missionLead, missionId: sharedMission } } } : item.slotIndex === 4 ? { ...item, detail: { missionLead: { ...item.detail.missionLead, missionId: sharedMission } } } : item)));
    const pilot = await richPilot(2000);
    const receipt = dockedReceipt(pilot);
    const first = json(await gather(pilot, receipt, 4, 250));
    const duplicate = await gather(pilot, receipt, 5, 250);
    assert.equal(duplicate.statusCode, 409);
    assert.equal(json(duplicate).code, 'mission_already_unlocked');
    assert.equal(await credits(pilot), 1750);
    assert.equal((await budgetRow(pilot)).gatheredCount, 1);

    await app.prisma.playerMissionUnlock.update({ where: { playerId_missionId: { playerId: pilot.id, missionId: sharedMission } }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const renewed = await gather(pilot, receipt, 5, 250);
    assert.equal(renewed.statusCode, 200);
    assert.notEqual(json(renewed).voucher.nonce, first.voucher.nonce);
    assert.equal(await app.prisma.playerMissionUnlock.count({ where: { playerId: pilot.id } }), 1);

    // Once it has been accepted it can never be unlocked again.
    await app.prisma.playerMissionUnlock.update({ where: { playerId_missionId: { playerId: pilot.id, missionId: sharedMission } }, data: { isAccepted: true, expiresAt: new Date(Date.now() - 1000) } });
    const other = await richPilot(2000);
    assert.equal((await gather(other, dockedReceipt(other), 4, 250)).statusCode, 200, 'another pilot may unlock the same mission');
  });

  test('refuses a lead before charging anything when the service has no voucher key', async () => {
    useStationEngine();
    const pilot = await richPilot(1000);
    const receipt = dockedReceipt(pilot);
    const key = app.intelVoucherKey;
    app.intelVoucherKey = null;
    try {
      const res = await gather(pilot, receipt, 4, 250);
      assert.equal(res.statusCode, 503);
      assert.equal(json(res).code, 'intel_voucher_key_not_configured');
      assert.equal(await credits(pilot), 1000);
      assert.equal(await budgetRow(pilot), null);
      // Items that issue no voucher are unaffected.
      assert.equal((await gather(pilot, receipt, 2, 100)).statusCode, 200);
    } finally {
      app.intelVoucherKey = key;
    }
  });
});
