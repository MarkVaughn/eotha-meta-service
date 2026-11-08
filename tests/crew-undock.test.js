import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { addCrew, app, call, closeApp, credits, dockedReceipt, json, newPilot, receiptAtOrigin, setCredits, signedOffer, undockReceipt } from './helpers.js';
import { flakyDeparture } from '../src/lib/crew-docking.js';
import { UNDOCK_RECEIPT_MAX_SKEW_MS, UNDOCK_RECEIPT_TTL_MS } from '../src/config/docking.js';
import { undockReceiptNonceKey } from '../src/lib/undock-receipt.js';

before(async () => { await app.ready(); });
after(closeApp);

const MIN = 60_000;
const row = (id) => app.prisma.crewMember.findUnique({ where: { id } });
const shipOf = (p) => app.prisma.spaceship.findFirst({ where: { playerId: p.id, active: true } });
const undock = (p, receipt) => call(p, 'POST', '/game/ship/undock', { undockReceipt: receipt });
const records = (p) => app.prisma.undockRecord.findMany({ where: { playerId: p.id } });
const shore = (p, receipt) => call(p, 'POST', '/game/crew/shore-leave', { dockedReceipt: receipt });

// An id whose FLAKY roll at `station` departs in the 15-minute window of every time in `times`.
function flakyId(station, times, morale = 70) {
  let id;
  do { id = randomUUID(); } while (!times.every((at) => flakyDeparture({ id, quirkId: 'Q12', morale }, station, at)));
  return id;
}
// An id whose FLAKY roll at `station` stays aboard.
function steadyId(station, times, morale = 70) {
  const list = [].concat(times);
  let id;
  do { id = randomUUID(); } while (list.some((at) => flakyDeparture({ id, quirkId: 'Q12', morale }, station, at)));
  return id;
}

describe('POST /game/ship/undock', () => {
  test('a mining-only departure rolls FLAKY: the crew leaves, the token loses them and the record keeps who left', async () => {
    const p = await newPilot('Mining');
    const station = randomUUID();
    const at = Date.now() - 1000;
    const leaving = await addCrew(p, { id: flakyId(station, [at]), quirkId: 'Q12', morale: 70, crewClass: 'PILOT' });
    const staying = await addCrew(p, { id: steadyId(station, [at, Date.now()]), quirkId: 'Q12', morale: 70, crewClass: 'ENGINEER' });
    const res = await undock(p, undockReceipt(p, { stationEntityId: station, undockedAtMs: at, dockedAtMs: at - 60_000 }));
    assert.equal(res.statusCode, 200, res.body);
    assert.deepEqual(json(res).departed_crew, [leaving.id]);
    assert.equal(json(res).replayed, false);
    assert.equal(json(res).undocked_at_ms, at);
    assert.equal(await row(leaving.id), null);
    assert.notEqual(await row(staying.id), null);
    assert.equal(app.jwt.verify(json(res).token).ship_attributes.crew_aboard, 1);
    const [record] = await records(p);
    assert.deepEqual(record.departedCrewIds, [leaving.id]);
    assert.equal(record.stationId, station);
    assert.equal(record.undockedAtMs, BigInt(at));
    assert.equal((await shipOf(p)).lastCrewUndockedAtMs, BigInt(at));
  });

  test('crew at morale 85 or more, without the quirk, or already resigned never depart', async () => {
    const p = await newPilot('Steady');
    const station = randomUUID();
    const at = Date.now() - 1000;
    const crew = [
      await addCrew(p, { id: flakyId(station, [at], 84), quirkId: 'Q12', morale: 85, crewClass: 'PILOT' }),
      await addCrew(p, { id: flakyId(station, [at], 84), quirkId: 'Q08', morale: 60, crewClass: 'ENGINEER' }),
      await addCrew(p, { id: flakyId(station, [at], 84), quirkId: 'Q12', morale: 0, crewClass: 'CHEF' })
    ];
    const res = await undock(p, undockReceipt(p, { stationEntityId: station, undockedAtMs: at }));
    assert.equal(res.statusCode, 200, res.body);
    assert.deepEqual(json(res).departed_crew, []);
    for (const member of crew) assert.notEqual(await row(member.id), null);
    assert.equal((await records(p)).length, 1);
  });

  test('a replay answers the first result and rolls, charges and changes nothing', async () => {
    const p = await newPilot('Replay');
    const station = randomUUID();
    const at = Date.now() - 1000;
    const leaving = await addCrew(p, { id: flakyId(station, [at]), quirkId: 'Q12', morale: 70, crewClass: 'PILOT' });
    await setCredits(p, 500);
    const receipt = undockReceipt(p, { stationEntityId: station, undockedAtMs: at });
    const first = await undock(p, receipt);
    assert.equal(first.statusCode, 200, first.body);
    // Crew hired since cannot be taken by the replayed receipt.
    const hired = await addCrew(p, { id: flakyId(station, [at]), quirkId: 'Q12', morale: 70, crewClass: 'ENGINEER' });
    const second = await undock(p, receipt);
    assert.equal(second.statusCode, 200, second.body);
    assert.deepEqual(json(second).departed_crew, [leaving.id]);
    assert.equal(json(second).replayed, true);
    assert.equal(json(second).undocked_at_ms, at);
    assert.notEqual(await row(hired.id), null);
    assert.equal(app.jwt.verify(json(second).token).ship_attributes.crew_aboard, 1);
    assert.equal(await credits(p), 500);
    assert.equal((await records(p)).length, 1);
  });

  test('concurrent copies of one receipt apply once', async () => {
    const p = await newPilot('Race');
    const station = randomUUID();
    const at = Date.now() - 1000;
    await addCrew(p, { id: flakyId(station, [at]), quirkId: 'Q12', morale: 70, crewClass: 'PILOT' });
    const receipt = undockReceipt(p, { stationEntityId: station, undockedAtMs: at });
    const results = await Promise.all([undock(p, receipt), undock(p, receipt), undock(p, receipt)]);
    assert.deepEqual(results.map((r) => r.statusCode), [200, 200, 200]);
    assert.equal(results.filter((r) => json(r).replayed === false).length, 1);
    assert.equal((await records(p)).length, 1);
  });

  test('a replay is still answered once the receipt has aged out of its window', async () => {
    const p = await newPilot('Aged');
    const station = randomUUID();
    const at = Date.now() - UNDOCK_RECEIPT_TTL_MS - 60_000;
    const crewId = randomUUID();
    const receipt = undockReceipt(p, { stationEntityId: station, undockedAtMs: at, dockedAtMs: at - 1000 });
    assert.equal((await undock(p, receipt)).statusCode, 403);
    await app.prisma.undockRecord.create({ data: {
      playerId: p.id, stationId: station, systemH3: receipt.systemH3, controllingFactionId: '', dockedAtMs: BigInt(receipt.dockedAtMs),
      undockedAtMs: BigInt(at), nonce: undockReceiptNonceKey(receipt), departedCrewIds: [crewId]
    } });
    const res = await undock(p, receipt);
    assert.equal(res.statusCode, 200, res.body);
    assert.deepEqual(json(res).departed_crew, [crewId]);
    assert.equal(json(res).replayed, true);
  });

  test('a stale receipt is refused with 403 undock_receipt_expired and changes nothing', async () => {
    const p = await newPilot('Expired');
    const station = randomUUID();
    const at = Date.now() - UNDOCK_RECEIPT_TTL_MS - 5_000;
    const crew = await addCrew(p, { id: flakyId(station, [at]), quirkId: 'Q12', morale: 70, crewClass: 'PILOT' });
    const res = await undock(p, undockReceipt(p, { stationEntityId: station, undockedAtMs: at, dockedAtMs: at - 1000 }));
    assert.equal(res.statusCode, 403);
    assert.equal(json(res).code, 'undock_receipt_expired');
    assert.notEqual(await row(crew.id), null);
    assert.equal((await records(p)).length, 0);
    assert.equal((await shipOf(p))?.lastCrewUndockedAtMs ?? null, null);
  });

  test('a receipt from the future beyond the skew, or docked after it undocked, is refused', async () => {
    const p = await newPilot('Future');
    const future = Date.now() + UNDOCK_RECEIPT_MAX_SKEW_MS + 5_000;
    const ahead = await undock(p, undockReceipt(p, { undockedAtMs: future, dockedAtMs: future - 1000 }));
    assert.equal(ahead.statusCode, 403);
    assert.equal(json(ahead).code, 'undock_receipt_expired');
    const now = Date.now();
    const inverted = await undock(p, undockReceipt(p, { dockedAtMs: now, undockedAtMs: now - 1000 }));
    assert.equal(inverted.statusCode, 403);
    assert.equal(json(inverted).code, 'undock_receipt_expired');
    assert.equal((await records(p)).length, 0);
    // The edge of the window is still applied.
    const edge = await undock(p, undockReceipt(p, { undockedAtMs: Date.now() + UNDOCK_RECEIPT_MAX_SKEW_MS - 1000 }));
    assert.equal(edge.statusCode, 200, edge.body);
  });

  test('a receipt for another pilot, signed by another key or altered is refused with 403 undock_receipt_invalid', async () => {
    const p = await newPilot('Forged');
    const other = await newPilot('Other');
    const stranger = generateKeyPairSync('ed25519').privateKey;
    const station = randomUUID();
    const at = Date.now() - 1000;
    const crew = await addCrew(p, { id: flakyId(station, [at]), quirkId: 'Q12', morale: 70, crewClass: 'PILOT' });
    const cases = [
      undockReceipt(other, { stationEntityId: station, undockedAtMs: at }),
      undockReceipt(p, { stationEntityId: station, undockedAtMs: at }, stranger),
      { ...undockReceipt(p, { stationEntityId: station, undockedAtMs: at }), systemH3: '8828308283fffff' },
      { ...undockReceipt(p, { stationEntityId: station, undockedAtMs: at }), undockedAtMs: at + 1 },
      { ...undockReceipt(p, { stationEntityId: station, undockedAtMs: at, controllingFactionId: 'alpha' }), controllingFactionId: '' }
    ];
    for (const receipt of cases) {
      const res = await undock(p, receipt);
      assert.equal(res.statusCode, 403, res.body);
      assert.equal(json(res).code, 'undock_receipt_invalid');
    }
    assert.notEqual(await row(crew.id), null);
    assert.equal((await records(p)).length, 0);
    // Another pilot's receipt is not spent by the refusal either.
    assert.equal((await undock(other, undockReceipt(other, { undockedAtMs: at }))).statusCode, 200);
  });

  test('a malformed body is a 400 and an unauthenticated one a 401', async () => {
    const p = await newPilot('Malformed');
    assert.equal((await call(p, 'POST', '/game/ship/undock', {})).statusCode, 400);
    const bad = undockReceipt(p, { nonce: 'AAAA' });
    assert.equal((await undock(p, bad)).statusCode, 400);
    const anon = await app.inject({ method: 'POST', url: '/game/ship/undock', payload: { undockReceipt: undockReceipt(p) } });
    assert.equal(anon.statusCode, 401);
  });

  test('a fresh nonce for the same window cannot reroll: the roll is the deterministic one', async () => {
    const p = await newPilot('Window');
    const station = randomUUID();
    const times = [Date.now() - 3000, Date.now() - 2000, Date.now() - 1000];
    const staying = await addCrew(p, { id: steadyId(station, [...times, Date.now()]), quirkId: 'Q12', morale: 70, crewClass: 'PILOT' });
    for (const at of times) {
      const res = await undock(p, undockReceipt(p, { stationEntityId: station, undockedAtMs: at }));
      assert.equal(res.statusCode, 200, res.body);
      assert.deepEqual(json(res).departed_crew, []);
    }
    assert.notEqual(await row(staying.id), null);
    assert.equal((await records(p)).length, 3);
  });

  test('lastCrewUndockedAtMs never moves back when receipts arrive out of order', async () => {
    const p = await newPilot('Order');
    const late = Date.now() - 1000;
    const early = late - 5 * MIN;
    assert.equal((await undock(p, undockReceipt(p, { undockedAtMs: late, dockedAtMs: late - 1000 }))).statusCode, 200);
    assert.equal((await undock(p, undockReceipt(p, { undockedAtMs: early, dockedAtMs: early - 1000 }))).statusCode, 200);
    assert.equal((await shipOf(p)).lastCrewUndockedAtMs, BigInt(late));
  });

  test('the replay key is the hex of the nonce bytes', async () => {
    const p = await newPilot('Key');
    const receipt = undockReceipt(p);
    assert.equal((await undock(p, receipt)).statusCode, 200);
    const [record] = await records(p);
    assert.equal(record.nonce, undockReceiptNonceKey(receipt));
    assert.equal(record.controllingFactionId, '');
  });
});

describe('flight time from the signed undock', () => {
  // A pilot docked `dwellMin` before casting off, then docking again `flightMin` after the cast-off. The undock is
  // relayed through the route when `undockMode` is 'route' (it must be inside its 15-minute window), or written to the
  // ship row when 'row', standing for an older receipt relayed at the time; 'none' relays nothing. Returns the second dock's `docking`.
  async function leg({ dwellMin, flightMin, undockMode }) {
    const p = await newPilot('Flight');
    await addCrew(p, { crewClass: 'PILOT', quirkId: 'Q08', morale: 75 });
    await setCredits(p, 1000);
    const end = Date.now() - 2000;
    const undockedAt = end - flightMin * MIN;
    const dockedAt = undockedAt - dwellMin * MIN;
    const home = randomUUID();
    assert.equal((await shore(p, dockedReceipt(p, { dockedEntityId: home, dockedAtMs: dockedAt }))).statusCode, 200);
    if (undockMode === 'route') {
      const res = await undock(p, undockReceipt(p, { stationEntityId: home, dockedAtMs: dockedAt, undockedAtMs: undockedAt }));
      assert.equal(res.statusCode, 200, res.body);
    } else if (undockMode === 'row') {
      await app.prisma.spaceship.update({ where: { id: (await shipOf(p)).id }, data: { lastCrewUndockedAtMs: BigInt(undockedAt) } });
    }
    const next = await shore(p, dockedReceipt(p, { dockedAtMs: end }));
    assert.equal(next.statusCode, 200, next.body);
    return json(next).docking;
  }

  test('station dwell no longer counts: flight is the undock-to-dock gap', async () => {
    const docking = await leg({ dwellMin: 120, flightMin: 30, undockMode: 'row' });
    assert.equal(docking.flightMs, 30 * MIN);
    assert.equal(docking.effects[0].stipendCredits, undefined);
  });

  test('without a relayed undock the dock-to-dock gap approximates flight, capped at two hours', async () => {
    const docking = await leg({ dwellMin: 120, flightMin: 30, undockMode: 'none' });
    assert.equal(docking.flightMs, 120 * MIN);
    assert.equal(docking.effects[0].stipendCredits, 40);
  });

  test('an undock applied through the route starts the flight', async () => {
    const docking = await leg({ dwellMin: 20, flightMin: 10, undockMode: 'route' });
    assert.equal(docking.flightMs, 10 * MIN);
  });

  test('an undock from before the previous dock does not shorten the new leg', async () => {
    const p = await newPilot('Stale');
    await addCrew(p, { crewClass: 'PILOT', quirkId: 'Q08', morale: 75 });
    const first = Date.now() - 100 * MIN;
    assert.equal((await shore(p, dockedReceipt(p, { dockedAtMs: first - 60 * MIN }))).statusCode, 200);
    await app.prisma.spaceship.update({ where: { id: (await shipOf(p)).id }, data: { lastCrewUndockedAtMs: BigInt(first - 50 * MIN) } });
    assert.equal((await shore(p, dockedReceipt(p, { dockedAtMs: first }))).statusCode, 200);
    // The cast-off at first - 50 min predates the dock at `first`; this leg has none relayed.
    const res = await shore(p, dockedReceipt(p, { dockedAtMs: first + 40 * MIN }));
    assert.equal(json(res).docking.flightMs, 40 * MIN);
  });
});

describe('mission acceptance does not roll FLAKY a second time', () => {
  test('accepting then undocking at the same station rolls once, at the undock', async () => {
    const p = await newPilot('Once');
    const offer = signedOffer(p, { required_berths: 0 });
    const at = Date.now() - 1000;
    const crew = await addCrew(p, { id: flakyId(offer.origin_station_id, [at, Date.now()]), quirkId: 'Q12', morale: 70, crewClass: 'PILOT' });
    const accepted = await call(p, 'POST', '/game/missions/accept', { offer, dockedReceipt: receiptAtOrigin(p, offer) });
    assert.equal(accepted.statusCode, 200, accepted.body);
    assert.equal(json(accepted).departed_crew, undefined);
    assert.notEqual(await row(crew.id), null);
    const res = await undock(p, undockReceipt(p, { stationEntityId: offer.origin_station_id, undockedAtMs: at }));
    assert.equal(res.statusCode, 200, res.body);
    assert.deepEqual(json(res).departed_crew, [crew.id]);
    assert.equal(await row(crew.id), null);
  });
});
