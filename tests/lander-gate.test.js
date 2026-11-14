import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  app, attestationHeaders, call, closeApp, dockedReceipt, json, newPilot, setCredits, track
} from './helpers.js';

before(async () => { await app.ready(); });
after(async () => { await closeApp(); });

const upgradeLander = (session, targetTier = 1) => app.inject({
  method: 'POST', url: '/ship/upgrade', headers: { authorization: `Bearer ${session.token}` },
  payload: { componentType: 'LANDER', targetTier, dockedReceipt: dockedReceipt(session) }
});

async function newGuest() {
  const res = await app.inject({ method: 'POST', url: '/auth/guest', headers: attestationHeaders, payload: { deviceId: randomUUID() } });
  assert.equal(res.statusCode, 200, res.body);
  const session = json(res);
  track(session.player.id);
  return { ...session, id: session.player.id };
}

/** Sets the hull tier of the pilot's active ship directly, bypassing the upgrade route. */
async function setHullTier(session, tier) {
  const loadout = json(await call({ headers: { authorization: `Bearer ${session.token}` } }, 'GET', '/ship/loadout'));
  await app.prisma.shipComponentRecord.upsert({
    where: { spaceshipId_type: { spaceshipId: loadout.ship_id, type: 'HULL' } },
    update: { tier },
    create: { spaceshipId: loadout.ship_id, type: 'HULL', tier }
  });
  return loadout.ship_id;
}

// A new ship may carry an unequipped (tier 0) LANDER row; only a fitted lander has a tier above 0.
const landerTier = async (shipId) =>
  (await app.prisma.shipComponentRecord.findFirst({ where: { spaceshipId: shipId, type: 'LANDER' } }))?.tier ?? 0;
const creditsOf = async (id) => (await app.prisma.player.findUnique({ where: { id } })).credits;

describe('lander guest and Tier 1 hull gate', () => {
  test('a guest is refused even on a Tier 2 hull, and nothing is charged or fitted', async () => {
    const guest = await newGuest();
    await setCredits(guest, 100_000);
    const shipId = await setHullTier(guest, 2);
    const res = await upgradeLander(guest);
    assert.equal(res.statusCode, 403, res.body);
    assert.equal(json(res).code, 'lander_restricted_guest_or_t1');
    assert.equal(await creditsOf(guest.id), 100_000);
    assert.equal(await landerTier(shipId), 0);
  });

  test('a registered pilot on a Tier 1 hull is refused, and nothing is charged or fitted', async () => {
    const pilot = await newPilot('LanderT1');
    await setCredits(pilot, 100_000);
    const shipId = await setHullTier(pilot, 1);
    const res = await upgradeLander(pilot);
    assert.equal(res.statusCode, 403, res.body);
    assert.equal(json(res).code, 'lander_restricted_guest_or_t1');
    assert.equal(await creditsOf(pilot.id), 100_000);
    assert.equal(await landerTier(shipId), 0);
  });

  test('a registered pilot on a Tier 2 hull can buy a lander', async () => {
    const pilot = await newPilot('LanderT2');
    await setCredits(pilot, 100_000);
    const shipId = await setHullTier(pilot, 2);
    const res = await upgradeLander(pilot);
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(json(res).components.find((c) => c.type === 'LANDER').tier, 1);
    assert.equal(await landerTier(shipId), 1);
    assert.ok((await creditsOf(pilot.id)) < 100_000);
  });
});
