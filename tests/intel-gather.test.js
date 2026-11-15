import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { VOUCHER_KEY_ID, addCrew, app, call, closeApp, credits, dockedReceipt, json, newPilot, setCredits } from './helpers.js';
import {
  CATEGORY, HOUR_MS, currentHour, forgedOf, gatherBody, intelIdOf, poolItem, poolUrl, setStanding, signedIntelItem, voucherVerifies
} from './intel-helpers.js';

after(closeApp);

// Gathers `slot` of the dock's pool: the signed item as the engine sent it and the client relays it. `extra` replaces any
// field of the body, `item` included.
const gather = (pilot, receipt, slot, expectedCostCredits, extra = {}) =>
  call(pilot, 'POST', '/game/intel/gather', gatherBody(receipt, slot, expectedCostCredits, extra));
// The same slot's item with `patch` applied and signed again by the engine's key (or `signer`).
const resigned = (receipt, slot, patch, signer) => {
  const { signature: _signature, ...item } = poolItem(receipt, slot);
  return signedIntelItem({ ...item, ...patch }, signer);
};
const budgetRow = (pilot) => app.prisma.playerIntelBudget.findUnique({ where: { playerId_hourEpoch: { playerId: pilot.id, hourEpoch: BigInt(currentHour()) } } });
const richPilot = async (balance = 5000) => {
  const pilot = await newPilot('Intel');
  await setCredits(pilot, balance);
  return pilot;
};

describe('POST /game/intel/gather: budget and price', () => {
  test('gathers a free item for one budget point and no credits, and sends back only its signed terms', async () => {
    const pilot = await richPilot(1000);
    const receipt = dockedReceipt(pilot);
    const res = await gather(pilot, receipt, 0, 0);
    assert.equal(res.statusCode, 200);
    const body = json(res);
    assert.equal(body.result, 'GATHER_INTEL_ITEM_RESULT_SUCCESS');
    assert.equal(body.credits_charged, 0);
    assert.equal(body.budget_remaining, 2);
    assert.equal(body.budget_total, 3);
    const signed = poolItem(receipt, 0);
    assert.equal(body.item.intel_id, signed.intelId);
    assert.equal(body.item.category, 'INTEL_CATEGORY_OUTFITTER_TIP');
    assert.equal(body.item.station_entity_id, receipt.dockedEntityId);
    assert.equal(body.item.signature, signed.signature);
    assert.equal(body.item.is_gathered, true);
    assert.ok(!('voucher' in body));
    assert.equal(await credits(pilot), 1000);
    assert.equal((await budgetRow(pilot)).gatheredCount, 1);

    // The terminal now counts it gathered and the budget spent.
    const pool = json(await call(pilot, 'GET', poolUrl(receipt)));
    assert.equal(pool.budget_remaining, 2);
    assert.deepEqual(pool.gathered_intel_ids, [signed.intelId]);
  });

  test('charges a paid item its price, spends one point, and keeps the unlock four hours', async () => {
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
    assert.ok(body.unlock_expires_at_ms >= before + 4 * HOUR_MS && body.unlock_expires_at_ms <= Date.now() + 4 * HOUR_MS);
  });

  test('never reads or returns anything the client attaches to the item unsigned', async () => {
    const pilot = await richPilot(1000);
    const receipt = dockedReceipt(pilot);
    const item = { ...poolItem(receipt, 4), headline: 'forged headline', body: 'forged body', veracity: 1, dossier: { text: 'forged' } };
    // The detail of the lead names a mission; neither it nor any other unsigned field may reach the response or a voucher.
    assert.ok(JSON.stringify(item).includes(forgedOf(4)));
    const res = await gather(pilot, receipt, 4, 250, { item });
    assert.equal(res.statusCode, 200);
    for (const text of [forgedOf(4), 'forged headline', 'forged body', 'forged']) assert.ok(!res.body.includes(text), text);
    const body = json(res);
    for (const key of ['headline', 'body', 'veracity', 'is_redacted', 'mission_lead', 'outfitter_tip', 'dossier']) {
      assert.ok(!(key in body.item), key);
    }
    assert.equal(body.voucher.mission_id, '');
    const mission = item.detail.missionLead.missionId;
    assert.ok(!JSON.stringify(await app.prisma.playerMissionUnlock.findMany({ where: { playerId: pilot.id } })).includes(mission));
  });

  test('accepts the item as the engine\'s proto-JSON gives it: camelCase or snake_case, the station as base64 bytes', async () => {
    const pilot = await richPilot(1000);
    const receipt = dockedReceipt(pilot);
    const signed = poolItem(receipt, 2);
    const snake = {
      intel_id: signed.intelId, category: 'INTEL_CATEGORY_OUTFITTER_TIP', station_entity_id: Buffer.from(receipt.dockedEntityId.replaceAll('-', ''), 'hex').toString('base64'),
      system_h3: signed.systemH3, hour_epoch: String(signed.hourEpoch), slot_index: signed.slotIndex, is_free_ambient: false,
      base_cost_credits: String(signed.baseCostCredits), required_standing: 0, required_standing_faction_id: '',
      issued_at_ms: String(signed.issuedAtMs), expires_at_ms: String(signed.expiresAtMs), signature: signed.signature
    };
    const res = await gather(pilot, receipt, 2, 100, { item: snake });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(json(res).item.station_entity_id, receipt.dockedEntityId);
  });

  test('refuses a changed price, a short purse and a rotated hour, charging and spending nothing', async () => {
    const pilot = await richPilot(90);
    const receipt = dockedReceipt(pilot);
    const wrongPrice = await gather(pilot, receipt, 2, 80);
    assert.equal(wrongPrice.statusCode, 409);
    assert.deepEqual([json(wrongPrice).code, json(wrongPrice).cost_credits], ['price_changed', 100]);

    const broke = await gather(pilot, receipt, 2, 100);
    assert.equal(broke.statusCode, 402);
    assert.equal(json(broke).code, 'insufficient_credits');

    const rotated = await gather(pilot, receipt, 2, 100, { item: poolItem(receipt, 2, { hourEpoch: currentHour() - 1 }) });
    assert.equal(rotated.statusCode, 409);
    assert.equal(json(rotated).code, 'intel_pool_expired');
    assert.equal(json(rotated).hour_epoch, currentHour());

    assert.equal(await credits(pilot), 90);
    assert.equal(await budgetRow(pilot), null);
  });

  test('stops at the hourly budget, across every dock the pilot visits that hour', async () => {
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
    const pilot = await richPilot(10_000);
    await addCrew(pilot, { crewClass: 'COMMS_OFFICER', rank: 'MASTER' });
    const receipt = dockedReceipt(pilot);
    for (const slot of [0, 1, 2, 4, 5]) assert.equal((await gather(pilot, receipt, slot, slot < 2 ? 0 : (slot === 2 ? 100 : 250))).statusCode, 200, `slot ${slot}`);
    const sixth = await gather(pilot, receipt, 7, 250);
    assert.equal(sixth.statusCode, 409);
    assert.deepEqual([json(sixth).code, json(sixth).budget_total], ['budget_exhausted', 5]);
  });

  test('repeats a gathered item for nothing, even with the budget spent', async () => {
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
    assert.equal(body.item.intel_id, intelIdOf(receipt.dockedEntityId, 2));
    assert.equal(await credits(pilot), 900);
    assert.equal((await budgetRow(pilot)).gatheredCount, 3);
  });

  test('spends the budget once when two gathers race for the last point', async () => {
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

describe('POST /game/intel/gather: the relayed item', () => {
  const refusedCode = async (pilot, receipt, item, status = 403) => {
    const res = await gather(pilot, receipt, 2, 100, { item });
    assert.equal(res.statusCode, status, res.body);
    return json(res).code;
  };

  test('refuses an item the engine did not sign, one with a tampered term, and a malformed one, charging nothing', async () => {
    const pilot = await richPilot(1000);
    const receipt = dockedReceipt(pilot);
    const signed = poolItem(receipt, 2);
    const wrongKey = resigned(receipt, 2, {}, generateKeyPairSync('ed25519').privateKey);
    assert.equal(await refusedCode(pilot, receipt, wrongKey), 'intel_item_invalid');
    // A client cannot cheapen, relabel or move a signed item: any signed field it changes breaks the signature.
    for (const patch of [{ baseCostCredits: 0, isFreeAmbient: true }, { baseCostCredits: 250 }, { requiredStanding: -5 }, { slotIndex: 9 }, { intelId: 'intel-other' },
      { category: CATEGORY.SIGHTING }, { issuedAtMs: signed.issuedAtMs - 1 }]) {
      assert.equal(await refusedCode(pilot, receipt, { ...signed, ...patch }), 'intel_item_invalid', JSON.stringify(patch));
    }
    assert.equal(await refusedCode(pilot, receipt, { ...signed, signature: Buffer.alloc(64).toString('base64') }), 'intel_item_invalid');
    assert.equal(await refusedCode(pilot, receipt, { ...signed, signature: 'AAAA' }), 'intel_item_invalid');
    assert.equal(await refusedCode(pilot, receipt, { ...signed, signature: undefined }), 'intel_item_invalid');
    assert.equal(await refusedCode(pilot, receipt, { ...signed, category: 99 }), 'intel_item_invalid');
    assert.equal(await refusedCode(pilot, receipt, {}), 'intel_item_invalid');
    assert.equal((await call(pilot, 'POST', '/game/intel/gather', { item: 'not an object', expectedCostCredits: 100, dockedReceipt: receipt })).statusCode, 400);
    assert.equal(await credits(pilot), 1000);
    assert.equal(await budgetRow(pilot), null);
  });

  test('refuses an item signed for another dock or system, however validly signed', async () => {
    const pilot = await richPilot(1000);
    const receipt = dockedReceipt(pilot);
    const elsewhere = dockedReceipt(pilot);
    assert.equal(await refusedCode(pilot, receipt, poolItem(elsewhere, 2)), 'intel_item_invalid');
    assert.equal(await refusedCode(pilot, receipt, resigned(receipt, 2, { systemH3: '88283082a9fffff' })), 'intel_item_invalid');
    assert.equal(await credits(pilot), 1000);
    assert.equal(await budgetRow(pilot), null);
  });

  test('refuses engine-signed terms the engine does not issue, an unexpected expiry and an item from the future', async () => {
    const pilot = await richPilot(1000);
    const receipt = dockedReceipt(pilot);
    assert.equal(await refusedCode(pilot, receipt, resigned(receipt, 2, { baseCostCredits: 1 })), 'intel_item_invalid');
    assert.equal(await refusedCode(pilot, receipt, resigned(receipt, 2, { isFreeAmbient: true })), 'intel_item_invalid');
    assert.equal(await refusedCode(pilot, receipt, resigned(receipt, 2, { slotIndex: 12 })), 'intel_item_invalid');
    assert.equal(await refusedCode(pilot, receipt, resigned(receipt, 2, { expiresAtMs: poolItem(receipt, 2).expiresAtMs + HOUR_MS })), 'intel_item_invalid');
    assert.equal(await refusedCode(pilot, receipt, resigned(receipt, 2, { issuedAtMs: Date.now() + 10 * 60_000 })), 'intel_item_invalid');
    assert.equal(await budgetRow(pilot), null);
  });

  test('answers 409 for a pool of another hour, past or future, once it is proven to be the engine\'s', async () => {
    const pilot = await richPilot(1000);
    const receipt = dockedReceipt(pilot);
    for (const hourEpoch of [currentHour() - 1, currentHour() + 1]) {
      const res = await gather(pilot, receipt, 2, 100, { item: poolItem(receipt, 2, { hourEpoch }) });
      assert.equal(res.statusCode, 409, `hour ${hourEpoch}`);
      assert.equal(json(res).code, 'intel_pool_expired');
    }
    // An unsigned item for another hour is not told apart from garbage.
    assert.equal(await refusedCode(pilot, receipt, { ...poolItem(receipt, 2, { hourEpoch: currentHour() - 1 }), signature: 'AAAA' }), 'intel_item_invalid');
    assert.equal(await budgetRow(pilot), null);
  });
});

describe('POST /game/intel/gather: standing and the dock', () => {
  test('refuses an item whose standing requirement the pilot does not meet, and gathers it once they do', async () => {
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
  });

  test('treats an item the terminal does not read as nonexistent, and a Nemesis as refused', async () => {
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
    const pilot = await richPilot(1000);
    const other = await newPilot('Other');
    const receipt = dockedReceipt(pilot);
    const body = { item: poolItem(receipt, 0), expectedCostCredits: 0 };
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
});

describe('POST /game/intel/gather: vouchers for mission leads', () => {
  const unlockOf = (pilot, intelId) => app.prisma.playerMissionUnlock.findUnique({ where: { playerId_intelId: { playerId: pilot.id, intelId } } });

  test('issues a signed voucher bound to the pilot and the intel item, with no mission, and stores the unlock for four hours', async () => {
    const pilot = await richPilot(1000);
    const receipt = dockedReceipt(pilot);
    const res = await gather(pilot, receipt, 4, 250);
    assert.equal(res.statusCode, 200);
    const { item, voucher } = json(res);
    assert.equal(voucher.issuer_key_id, VOUCHER_KEY_ID);
    assert.equal(voucher.pilot_id, pilot.id);
    // The mission is the engine's to resolve from the item when the voucher is presented: the voucher never names one.
    assert.equal(voucher.mission_id, '');
    assert.equal(voucher.intel_id, item.intel_id);
    assert.equal(voucher.intel_id, intelIdOf(receipt.dockedEntityId, 4));
    assert.equal(voucher.category, CATEGORY.LEAD);
    assert.equal(voucher.station_entity_id, receipt.dockedEntityId);
    assert.equal(voucher.system_h3, receipt.systemH3);
    assert.equal(voucher.expires_at_ms - voucher.issued_at_ms, 4 * HOUR_MS);
    assert.equal(Buffer.from(voucher.nonce, 'base64').length, 16);
    assert.deepEqual(Object.keys(voucher).sort(), [
      'category', 'expires_at_ms', 'intel_id', 'issued_at_ms', 'issuer_key_id', 'mission_id', 'nonce', 'pilot_id', 'signature', 'station_entity_id', 'system_h3'
    ]);
    assert.equal(voucherVerifies(voucher), true);
    assert.equal(voucherVerifies({ ...voucher, pilot_id: randomUUID() }), false);
    assert.equal(voucherVerifies({ ...voucher, intel_id: 'intel-other' }), false);
    assert.equal(voucherVerifies({ ...voucher, mission_id: randomUUID() }), false);

    const row = await unlockOf(pilot, item.intel_id);
    assert.equal(row.isAccepted, false);
    assert.equal(row.missionId, null);
    assert.equal(row.expiresAt.getTime(), voucher.expires_at_ms);
    assert.equal(Buffer.from(row.voucherNonce).toString('base64'), voucher.nonce);

    // Gathering it again hands back the same voucher.
    const again = json(await gather(pilot, receipt, 4, 250));
    assert.equal(again.result, 'GATHER_INTEL_ITEM_RESULT_ALREADY_GATHERED');
    assert.deepEqual(again.voucher, voucher);
  });

  test('issues no voucher for a tip or a site, and one for a faction call', async () => {
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

  test('holds a live or used unlock against a second gather of the same intel id, and renews an expired one', async () => {
    const pilot = await richPilot(2000);
    const receipt = dockedReceipt(pilot);
    const first = json(await gather(pilot, receipt, 4, 250));
    const intelId = first.voucher.intel_id;

    // The hour's budget row forgets it (as a new hour would) while the unlock lives: the same lead is not sold twice.
    await app.prisma.playerIntelBudget.deleteMany({ where: { playerId: pilot.id } });
    const duplicate = await gather(pilot, receipt, 4, 250);
    assert.equal(duplicate.statusCode, 409);
    assert.equal(json(duplicate).code, 'intel_already_unlocked');
    assert.equal(await credits(pilot), 1750);
    assert.equal(await budgetRow(pilot), null);

    await app.prisma.playerMissionUnlock.update({ where: { playerId_intelId: { playerId: pilot.id, intelId } }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const renewed = await gather(pilot, receipt, 4, 250);
    assert.equal(renewed.statusCode, 200);
    assert.notEqual(json(renewed).voucher.nonce, first.voucher.nonce);
    assert.equal(await app.prisma.playerMissionUnlock.count({ where: { playerId: pilot.id } }), 1);

    // Once it has been accepted it can never be unlocked again.
    await app.prisma.playerIntelBudget.deleteMany({ where: { playerId: pilot.id } });
    await app.prisma.playerMissionUnlock.update({ where: { playerId_intelId: { playerId: pilot.id, intelId } }, data: { isAccepted: true, expiresAt: new Date(Date.now() - 1000) } });
    assert.equal(json(await gather(pilot, receipt, 4, 250)).code, 'intel_already_unlocked');
    const other = await richPilot(2000);
    assert.equal((await gather(other, dockedReceipt(other, { dockedEntityId: receipt.dockedEntityId }), 4, 250)).statusCode, 200, 'another pilot may unlock the same lead');
  });

  test('refuses a lead before charging anything when the service has no voucher key', async () => {
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
