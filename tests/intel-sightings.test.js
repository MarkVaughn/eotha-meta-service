import { test, describe, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { app, call, closeApp, json, newPilot, undockReceipt } from './helpers.js';
import { HOUR_MS, currentHour } from './intel-helpers.js';
import { sightingsForPool } from '../src/lib/sightings.js';

after(closeApp);

const stations = [];
const freshStation = () => { const id = randomUUID(); stations.push(id); return id; };
afterEach(async () => {
  await app.prisma.stationSightingRecord.deleteMany({ where: { stationEntityId: { in: stations.splice(0) } } });
});

const undock = (pilot, receipt) => call(pilot, 'POST', '/game/ship/undock', { undockReceipt: receipt });
const rows = (station) => app.prisma.stationSightingRecord.findMany({ where: { stationEntityId: station }, orderBy: { undockedAt: 'asc' } });
const setTier = async (pilot, type, tier) => {
  await call(pilot, 'GET', '/ship/loadout');
  const ship = await app.prisma.spaceship.findFirst({ where: { playerId: pilot.id, active: true } });
  await app.prisma.shipComponentRecord.update({ where: { spaceshipId_type: { spaceshipId: ship.id, type } }, data: { tier } });
};
const leave = async (pilot, station, at = Date.now() - 2000) => {
  const res = await undock(pilot, undockReceipt(pilot, { stationEntityId: station, undockedAtMs: at, dockedAtMs: at - 60_000 }));
  assert.equal(res.statusCode, 200, res.body);
};

describe('station sighting log', () => {
  test('records an undock with the ship\'s in-game names and tiers, and nothing about the account', async () => {
    const pilot = await newPilot('Sight');
    const station = freshStation();
    await setTier(pilot, 'WEAPONS', 3);
    await app.prisma.player.update({ where: { id: pilot.id }, data: { activeColorsFactionId: 'alpha' } });
    const at = Date.now() - 5000;
    await leave(pilot, station, at);
    const [record] = await rows(station);
    assert.equal(record.undockedAt.getTime(), at);
    assert.equal(record.weaponTier, 3);
    assert.equal(record.flyingColors, 'alpha');
    assert.equal(record.isStealthed, false);
    const ship = await app.prisma.spaceship.findFirst({ where: { playerId: pilot.id, active: true } });
    const captain = await app.prisma.captain.findUnique({ where: { playerId: pilot.id } });
    assert.equal(record.shipName, ship.callsign);
    assert.equal(record.captainName, captain.name);
    assert.ok(!Object.values(record).includes(pilot.id), 'no account id is stored');
    assert.ok(!('playerId' in record));
  });

  test('masks a ship with stealth rating 0.4 and logs nothing for one under a tier 5 cloak', async () => {
    const station = freshStation();
    const masked = await newPilot('Masked');
    await setTier(masked, 'STEALTH', 3);
    await leave(masked, station);
    const cloaked = await newPilot('Cloaked');
    await setTier(cloaked, 'STEALTH', 5);
    await leave(cloaked, station);
    const plain = await newPilot('Plain');
    await setTier(plain, 'STEALTH', 2);
    await leave(plain, station);
    const stored = await rows(station);
    assert.equal(stored.length, 2);
    assert.equal(stored.filter((row) => row.isStealthed).length, 1);
  });

  test('does not log a replayed receipt twice', async () => {
    const pilot = await newPilot('Replay');
    const station = freshStation();
    const receipt = undockReceipt(pilot, { stationEntityId: station });
    assert.equal((await undock(pilot, receipt)).statusCode, 200);
    const second = await undock(pilot, receipt);
    assert.equal(second.statusCode, 200);
    assert.equal((await rows(station)).length, 1);
  });

  test('keeps the newest ten departures of a station and prunes anything older than four hours', async () => {
    const station = freshStation();
    const now = Date.now();
    for (let i = 0; i < 12; i++) {
      const pilot = await newPilot(`Ring${i}`);
      await leave(pilot, station, now - (12 - i) * 60_000);
    }
    const kept = await rows(station);
    assert.equal(kept.length, 10);
    assert.equal(kept[0].undockedAt.getTime(), now - 10 * 60_000, 'the two oldest were dropped');

    await app.prisma.stationSightingRecord.updateMany({ where: { stationEntityId: station }, data: { undockedAt: new Date(now - 5 * HOUR_MS) } });
    const pilot = await newPilot('Prune');
    await leave(pilot, station, now - 1000);
    const left = await rows(station);
    assert.equal(left.length, 1);
    assert.equal(left[0].undockedAt.getTime(), now - 1000);
  });

  test('offers the engine only departures from 15 minutes to four hours before the hour began', async () => {
    const station = freshStation();
    const hour = currentHour();
    const start = hour * HOUR_MS;
    const mk = (offsetMs, name) => app.prisma.stationSightingRecord.create({
      data: { stationEntityId: station, shipName: name, captainName: 'Cap', hullTier: 1, weaponTier: 2, shieldTier: 3, flyingColors: null, isStealthed: true, undockedAt: new Date(start - offsetMs) }
    });
    await mk(5 * 60_000, 'too-fresh');
    await mk(20 * 60_000, 'in-window-new');
    await mk(3 * HOUR_MS, 'in-window-old');
    await mk(5 * HOUR_MS, 'too-old');
    const out = await sightingsForPool(app.prisma, station, hour);
    assert.deepEqual(out.map((s) => s.ship_name), ['in-window-new', 'in-window-old']);
    assert.equal(out[0].flying_colors, '');
    assert.equal(out[0].is_stealthed, true);
    assert.equal(out[0].undocked_at_ms, start - 20 * 60_000);
    // A departure after the hour began does not change the hour's snapshot.
    await mk(-60_000, 'after-hour-start');
    assert.equal((await sightingsForPool(app.prisma, station, hour)).length, 2);
  });
});
