import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { app, call, closeApp, dockedReceipt, json, newPilot, receiptAtOrigin, setCredits, signedOffer } from './helpers.js';
import { gatherBody } from './intel-helpers.js';

after(closeApp);

const accept = (pilot, offer) => call(pilot, 'POST', '/game/missions/accept', { offer, dockedReceipt: receiptAtOrigin(pilot, offer) });
const unlockRow = (pilot, intelId) => app.prisma.playerMissionUnlock.findUnique({ where: { playerId_intelId: { playerId: pilot.id, intelId } } });
const missionOf = () => randomUUID();

// A pilot who has gathered the lead of slot 4 at a dock, and the classified offer the engine would then sign when the
// pilot presents the voucher: the engine, not this service, knows the lead's mission, so the offer names one of its own.
async function leadFor(overrides = {}) {
  const pilot = await newPilot('Classified');
  await setCredits(pilot, 5000);
  const receipt = dockedReceipt(pilot);
  const res = await call(pilot, 'POST', '/game/intel/gather', gatherBody(receipt, 4, 250));
  assert.equal(res.statusCode, 200, res.body);
  const { voucher } = json(res);
  const missionId = missionOf();
  const offer = signedOffer(pilot, {
    mission_id: missionId, intel_lead_id: voucher.intel_id, unlock_voucher_nonce: voucher.nonce, ...overrides
  });
  return { pilot, voucher, offer, missionId: offer.mission_id };
}

describe('POST /game/missions/accept: classified offers', () => {
  test('accepts a classified offer the pilot holds the unlock for, and spends the unlock', async () => {
    const { pilot, voucher, offer, missionId } = await leadFor();
    const res = await accept(pilot, offer);
    assert.equal(res.statusCode, 200, res.body);
    const active = json(res).active;
    assert.equal(active.mission_id, missionId);
    // The unlock learns its mission only now, from the offer the engine signed for the voucher.
    const row = await unlockRow(pilot, voucher.intel_id);
    assert.deepEqual([row.isAccepted, row.missionId], [true, missionId]);

    // The held mission keeps the signed offer as the pilot was given it, the nonce still base64.
    const held = json(await call(pilot, 'GET', '/game/missions/active')).missions;
    assert.equal(held.length, 1);
    assert.deepEqual(held[0].offer, offer);
  });

  test('carries a covert classified offer into the engine JWT with its nonce as bytes', async () => {
    const { pilot, voucher, offer } = await leadFor({
      visibility: 'MISSION_VISIBILITY_COVERT', archetype: 'MISSION_ARCHETYPE_SABOTEUR_INSERTION', faction_id: 'alpha',
      reputation_change: 25, opposed_faction_id: 'beta', opposed_reputation_change: -15, clandestine_bonus_credits: 625,
      carries_contraband_or_operative: true
    });
    const res = await accept(pilot, offer);
    assert.equal(res.statusCode, 200, res.body);
    const claim = app.jwt.verify(json(res).token).active_mission;
    assert.equal(claim.offer.intel_lead_id, voucher.intel_id);
    assert.deepEqual(claim.offer.unlock_voucher_nonce, [...Buffer.from(voucher.nonce, 'base64')]);
  });

  test('refuses an unlock that has already been spent on an accepted mission', async () => {
    const { pilot, voucher, offer } = await leadFor();
    await app.prisma.playerMissionUnlock.update({
      where: { playerId_intelId: { playerId: pilot.id, intelId: voucher.intel_id } }, data: { isAccepted: true }
    });
    const res = await accept(pilot, offer);
    assert.equal(res.statusCode, 409);
    assert.equal(json(res).code, 'intel_unlock_used');
    assert.equal(json(await call(pilot, 'GET', '/game/missions/active')).missions.length, 0);
  });

  test('refuses an offer without an unlock, with another pilot\'s unlock, with the wrong lead or nonce', async () => {
    const { pilot, voucher } = await leadFor();
    const stranger = await newPilot('Stranger');
    const strangerOffer = signedOffer(stranger, { mission_id: randomUUID(), intel_lead_id: voucher.intel_id, unlock_voucher_nonce: voucher.nonce });
    const noUnlock = await accept(stranger, strangerOffer);
    assert.equal(noUnlock.statusCode, 403);
    assert.equal(json(noUnlock).code, 'intel_unlock_required');

    const wrongNonce = signedOffer(pilot, { mission_id: randomUUID(), intel_lead_id: voucher.intel_id, unlock_voucher_nonce: randomBytes(16).toString('base64') });
    assert.equal(json(await accept(pilot, wrongNonce)).code, 'intel_unlock_required');
    const wrongLead = signedOffer(pilot, { mission_id: randomUUID(), intel_lead_id: 'intel-someone-else', unlock_voucher_nonce: voucher.nonce });
    assert.equal(json(await accept(pilot, wrongLead)).code, 'intel_unlock_required');
    assert.equal((await unlockRow(pilot, voucher.intel_id)).isAccepted, false);
  });

  test('refuses an expired unlock with 410 and leaves it unspent', async () => {
    const { pilot, voucher, offer } = await leadFor();
    await app.prisma.playerMissionUnlock.update({
      where: { playerId_intelId: { playerId: pilot.id, intelId: voucher.intel_id } }, data: { expiresAt: new Date(Date.now() - 1000) }
    });
    const res = await accept(pilot, offer);
    assert.equal(res.statusCode, 410);
    assert.equal(json(res).code, 'intel_unlock_expired');
    assert.equal((await unlockRow(pilot, voucher.intel_id)).isAccepted, false);
  });

  test('treats a lead without a signed nonce, a stripped suffix, or a nonce without a lead as an invalid offer', async () => {
    const { pilot, voucher, offer } = await leadFor();
    // Stripping the classified fields from a signed classified offer breaks its signature.
    const { intel_lead_id: _lead, unlock_voucher_nonce: _nonce, ...stripped } = offer;
    assert.equal(json(await accept(pilot, stripped)).code, 'mission_offer_invalid');
    // Swapping the nonce for another 16 bytes after signing does too.
    assert.equal(json(await accept(pilot, { ...offer, unlock_voucher_nonce: randomBytes(16).toString('base64') })).code, 'mission_offer_invalid');
    // A lead with no nonce, and a nonce with no lead, can never carry a valid signature.
    assert.equal(json(await accept(pilot, { ...offer, unlock_voucher_nonce: '' })).code, 'mission_offer_invalid');
    assert.equal(json(await accept(pilot, { ...offer, intel_lead_id: '' })).code, 'mission_offer_invalid');
    // A nonce that is not 16 bytes is refused before it reaches the signature.
    assert.equal((await accept(pilot, { ...offer, unlock_voucher_nonce: 'AAAA' })).statusCode, 400);
    assert.equal((await unlockRow(pilot, voucher.intel_id)).isAccepted, false);
  });

  test('refuses the unlock of a tip, which no classified offer can redeem', async () => {
    const { pilot } = await leadFor();
    const receipt = dockedReceipt(pilot);
    const tip = json(await call(pilot, 'POST', '/game/intel/gather', gatherBody(receipt, 2, 100))).voucher;
    const offer = signedOffer(pilot, { mission_id: randomUUID(), intel_lead_id: tip.intel_id, unlock_voucher_nonce: tip.nonce });
    const res = await accept(pilot, offer);
    assert.equal(res.statusCode, 403);
    assert.equal(json(res).code, 'intel_unlock_required');
    assert.equal((await unlockRow(pilot, tip.intel_id)).isAccepted, false);
  });

  test('redeems a mission through one unlock only, however many leads the pilot gathered for it', async () => {
    const first = await leadFor();
    assert.equal((await accept(first.pilot, first.offer)).statusCode, 200);
    // The mission is finished with, and a second lead gathered at the same dock names it again.
    await app.prisma.playerMission.deleteMany({ where: { playerId: first.pilot.id, missionId: first.missionId } });
    const receipt = dockedReceipt(first.pilot);
    const second = json(await call(first.pilot, 'POST', '/game/intel/gather', gatherBody(receipt, 5, 250))).voucher;
    const offer = signedOffer(first.pilot, { mission_id: first.missionId, intel_lead_id: second.intel_id, unlock_voucher_nonce: second.nonce });
    const res = await accept(first.pilot, offer);
    assert.equal(res.statusCode, 409);
    assert.equal(json(res).code, 'mission_already_unlocked');
    const row = await unlockRow(first.pilot, second.intel_id);
    assert.deepEqual([row.isAccepted, row.missionId], [false, null]);
  });

  test('leaves public offers untouched', async () => {
    const pilot = await newPilot('Public');
    const offer = signedOffer(pilot);
    const res = await accept(pilot, offer);
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(await app.prisma.playerMissionUnlock.count({ where: { playerId: pilot.id } }), 0);
    const held = json(await call(pilot, 'GET', '/game/missions/active')).missions;
    assert.ok(!('unlock_voucher_nonce' in held[0].offer));
  });
});
