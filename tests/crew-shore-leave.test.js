import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { addCrew, app, call, closeApp, credits, dockedReceipt, json, newPilot, receiptAtOrigin, setCredits, signedOffer } from './helpers.js';
import { fatigueIntervals, flakyDeparture, shoreLeaveTerms } from '../src/lib/crew-docking.js';
import { FLIGHT_STIPEND_CREDITS, SHORE_LEAVE_GRACE_MS, SHORE_LEAVE_DECAY_INTERVAL_MS } from '../src/config/crew.js';

before(async () => { await app.ready(); });
after(closeApp);
const MIN = 60_000;
const NEUTRAL = 'Q08';
const row = (id) => app.prisma.crewMember.findUnique({ where: { id } });
const shipOf = (p) => app.prisma.spaceship.findFirst({ where: { playerId: p.id, active: true } });
const shore = (p, receipt, extra = {}) => call(p, 'POST', '/game/crew/shore-leave', { dockedReceipt: receipt, ...extra });
const makeReceipt = (p, station, at) => dockedReceipt(p, { dockedEntityId: station, dockedAtMs: at });
async function flight({ morale = 75, rank = 'NOVICE', balance = 1000, minutes = 90, crewClass = 'PILOT', quirkId = NEUTRAL } = {}) {
  const pilot = await newPilot('Leave');
  const crew = await addCrew(pilot, { crewClass, rank, quirkId, morale });
  await setCredits(pilot, balance);
  const station = randomUUID();
  const end = Date.now() - 2000;
  const start = end - minutes * MIN;
  const first = await shore(pilot, makeReceipt(pilot, station, start));
  assert.equal(first.statusCode, 200, first.body);
  await app.prisma.crewMember.update({ where: { id: crew.id }, data: { morale } });
  return { pilot, crew, station, end, start, receipt: makeReceipt(pilot, station, end) };
}

describe('shore leave and departure rules', () => {
  test('pins fatigue intervals and stipend amounts', () => {
    assert.equal(SHORE_LEAVE_GRACE_MS, 45 * MIN);
    assert.equal(SHORE_LEAVE_DECAY_INTERVAL_MS, 15 * MIN);
    assert.deepEqual([0, 45, 59, 60, 75, 90].map((m) => fatigueIntervals(m * MIN)), [0, 0, 0, 1, 2, 3]);
    assert.deepEqual(FLIGHT_STIPEND_CREDITS, { NOVICE: 40, ADEPT: 80, MASTER: 150 });
  });
  test('outpost recovery is +5/half flight, Adept Chef gives +15/reset, Master raises cap to 90', () => {
    const chef = { crewClass: 'CHEF', rank: 'ADEPT', morale: 50 };
    assert.deepEqual(shoreLeaveTerms([], 'OUTPOST'), { gain: 5, flightMult: 0.5, cap: 80 });
    assert.deepEqual(shoreLeaveTerms([chef], 'OUTPOST'), { gain: 15, flightMult: 0, cap: 80 });
    assert.deepEqual(shoreLeaveTerms([{ ...chef, rank: 'MASTER' }], 'OUTPOST'), { gain: 15, flightMult: 0, cap: 90 });
    assert.deepEqual(shoreLeaveTerms([{ ...chef, morale: 49 }], 'OUTPOST'), { gain: 5, flightMult: 0.5, cap: 80 });
  });
  test('Grouchy leave is 2 less; Spartan endurance is +50% and outpost recovery is 10', () => {
    assert.equal(shoreLeaveTerms([], 'STATION', { quirkId: 'Q06' }).gain, 13);
    assert.equal(shoreLeaveTerms([], 'OUTPOST', { quirkId: 'Q14' }).gain, 10);
    assert.equal(fatigueIntervals(75 * MIN, { quirkId: 'Q14' }), 0);
    assert.equal(fatigueIntervals(82.5 * MIN, { quirkId: 'Q14' }), 1);
  });
  test('ASSERT-3.2.5: FLAKY rolls repeat in a 15-minute window, with a roughly 10% distribution', () => {
    const station = '00000000-0000-4000-8000-000000000001';
    const at = 900_000 * 100;
    let departures = 0;
    for (let i = 0; i < 3000; i++) {
      const m = { id: `00000000-0000-4000-8000-${i.toString(16).padStart(12, '0')}`, morale: 70, quirkId: 'Q12' };
      const first = flakyDeparture(m, station, at);
      assert.equal(first, flakyDeparture(m, station, at + 899_999));
      assert.equal(flakyDeparture({ ...m, morale: 85 }, station, at), false);
      assert.equal(flakyDeparture({ ...m, quirkId: NEUTRAL }, station, at), false);
      if (first) departures++;
    }
    assert.ok(departures > 230 && departures < 370, String(departures));
  });
});

describe('POST /game/crew/shore-leave', () => {
  test('requires an authentic current receipt belonging to this pilot before any write', async () => {
    const p = await newPilot('LeaveProof');
    const crew = await addCrew(p, { morale: 40, quirkId: NEUTRAL });
    assert.equal((await call(p, 'POST', '/game/crew/shore-leave', {})).statusCode, 403);
    for (const r of [dockedReceipt('another-pilot'), { ...dockedReceipt(p), dockedAtMs: 10 }, dockedReceipt(p, { issuedAtMs: Date.now() - 3600_000, dockedAtMs: 0 })]) {
      assert.equal((await shore(p, r)).statusCode, 403);
    }
    assert.equal((await row(crew.id)).morale, 40);
    assert.equal((await shipOf(p)).lastCrewDockedAtMs, null);
  });
  test('first dock establishes the baseline, recovers +15 to 80, and signs the new attributes', async () => {
    const p = await newPilot('FirstDock');
    const crew = await addCrew(p, { crewClass: 'PILOT', morale: 42, rank: 'ADEPT', quirkId: NEUTRAL });
    const receipt = dockedReceipt(p);
    const res = await shore(p, receipt);
    assert.equal(res.statusCode, 200, res.body);
    const body = json(res);
    assert.deepEqual([body.docking.flightMs, body.docking.recovery, body.crew[0].morale], [0, true, 57]);
    assert.equal(body.ship_attributes.crew_capability_flags & 1, 1);
    assert.deepEqual(app.jwt.verify(body.token).ship_attributes, body.ship_attributes);
    assert.equal((await shipOf(p)).lastCrewDockedAtMs, BigInt(receipt.dockedAtMs));
    assert.equal((await row(crew.id)).morale, 57);
  });
  test('freshly signed receipts for the same dock and out-of-order receipts are no-ops', async () => {
    const f = await flight({ minutes: 10, morale: 50 });
    const res = await shore(f.pilot, f.receipt);
    assert.equal(json(res).docking.recovery, false);
    const before = await row(f.crew.id);
    for (const at of [f.end, f.start, f.end - 1]) {
      const repeated = await shore(f.pilot, makeReceipt(f.pilot, f.station, at));
      assert.deepEqual(json(repeated).docking, { applied: false });
    }
    assert.equal((await row(f.crew.id)).morale, before.morale);
    assert.equal(await credits(f.pilot), 1000);
    assert.equal((await shipOf(f.pilot)).flightMsSinceLeave, 10 * MIN);
  });
  test('per-station cooldown survives A-B-A, but allows A after exactly 15 minutes', async () => {
    const f = await flight({ minutes: 30, morale: 20 });
    const b = randomUUID();
    assert.equal(json(await shore(f.pilot, makeReceipt(f.pilot, b, f.start + 5 * MIN))).docking.recovery, true);
    const back = json(await shore(f.pilot, makeReceipt(f.pilot, f.station, f.start + 10 * MIN)));
    assert.equal(back.docking.recovery, false);
    assert.equal((await row(f.crew.id)).morale, 35);
    const later = json(await shore(f.pilot, makeReceipt(f.pilot, f.station, f.start + 15 * MIN)));
    assert.equal(later.docking.recovery, true);
    assert.equal((await row(f.crew.id)).morale, 50);
    assert.equal((await shipOf(f.pilot)).flightMsSinceLeave, 0);
  });
  test('90 minutes applies three -5 fatigue intervals, pays a Novice stipend once, then station +15', async () => {
    const f = await flight();
    const res = await shore(f.pilot, f.receipt);
    assert.equal(res.statusCode, 200, res.body);
    const body = json(res);
    assert.deepEqual([body.docking.flightMs, body.docking.effects[0].fatigueIntervals, body.crew[0].morale], [90 * MIN, 3, 75]);
    assert.deepEqual([body.docking.effects[0].stipendCredits, body.docking.effects[0].stipendPaid, body.credits], [40, true, 960]);
    assert.equal((await shipOf(f.pilot)).flightMsSinceLeave, 0);
    await shore(f.pilot, f.receipt);
    assert.equal(await credits(f.pilot), 960);
  });
  test('stipend is strictly greater than 60 minutes; Adept/Master cost 80/150', async () => {
    const exact = await flight({ minutes: 60 });
    assert.equal(json(await shore(exact.pilot, exact.receipt)).docking.effects[0].stipendCredits, undefined);
    assert.equal(await credits(exact.pilot), 1000);
    for (const [rank, cost] of [['ADEPT', 80], ['MASTER', 150]]) {
      const f = await flight({ rank, minutes: 61 });
      assert.equal(json(await shore(f.pilot, f.receipt)).credits, 1000 - cost);
    }
  });
  test('unaffordable stipend creates arrears and -25, with fatigue and recovery in the same transaction', async () => {
    const f = await flight({ balance: 0 });
    const res = json(await shore(f.pilot, f.receipt));
    assert.equal(res.docking.effects[0].stipendPaid, false);
    assert.deepEqual([(await row(f.crew.id)).morale, (await row(f.crew.id)).unpaidArrearsCredits, res.credits], [50, 40, 0]);
  });
  test('Master Chef raises the station cap to 90, but cannot lower an already Inspired morale', async () => {
    const f = await flight({ crewClass: 'CHEF', rank: 'MASTER', morale: 82, minutes: 15 });
    assert.equal(json(await shore(f.pilot, f.receipt)).crew[0].morale, 90);
    await app.prisma.crewMember.update({ where: { id: f.crew.id }, data: { morale: 97 } });
    await shore(f.pilot, makeReceipt(f.pilot, randomUUID(), f.end + 1));
    assert.equal((await row(f.crew.id)).morale, 97);
  });
  test('morale-zero active and standby crew depart only through explicit leave', async () => {
    const f = await flight({ minutes: 10 });
    const doomed = await app.prisma.crewMember.update({ where: { id: f.crew.id }, data: { morale: 0 } });
    const standby = await addCrew(f.pilot, { morale: 0, status: 'STANDBY', spaceshipId: null });
    const body = json(await shore(f.pilot, f.receipt));
    assert.ok(body.docking.departed.includes(doomed.id));
    assert.equal(await row(doomed.id), null);
    assert.equal(await row(standby.id), null);
    assert.ok(body.docking.departed.includes(standby.id));
  });
  test('resignation rescue is explicit, costs twice debt, and clears arrears; insufficient funds means departure', async () => {
    for (const [balance, rescue, survives] of [[500, true, true], [199, true, false], [500, false, false]]) {
      const f = await flight({ minutes: 10, balance });
      await app.prisma.crewMember.update({ where: { id: f.crew.id }, data: { morale: 0, unpaidArrearsCredits: 100 } });
      const res = json(await shore(f.pilot, f.receipt, { payResignedArrears: rescue }));
      const member = await row(f.crew.id);
      if (survives) {
        assert.deepEqual([member.morale, member.unpaidArrearsCredits, res.credits], [15, 0, 300]);
      } else {
        assert.equal(member, null);
        assert.equal(res.credits, balance);
      }
    }
  });
  test('a prior chart payout suppresses the long-flight stipend, and replaying the chart cannot mark the next flight paid', async () => {
    const f = await flight();
    await app.prisma.planetChart.create({ data: {
      playerId: f.pilot.id, planetId: 'paid-flight', systemH3: '8828308283fffff', completedAtMs: BigInt(Date.now()), signature: 'x', surveyJson: {}
    } });
    const sale = await call(f.pilot, 'POST', '/game/charts/sell', { planetId: 'paid-flight', stationId: 'station-alpha' });
    assert.equal(sale.statusCode, 200, sale.body);
    assert.equal((await shipOf(f.pilot)).crewPayoutSinceDock, true);
    // The payout occurred before this arrival, not after the signed docking timestamp.
    const res = json(await shore(f.pilot, makeReceipt(f.pilot, f.station, Date.now())));
    assert.equal(res.docking.effects[0].stipendCredits, undefined);
    assert.equal(res.credits, 1475);
    assert.equal((await shipOf(f.pilot)).crewPayoutSinceDock, false);
    assert.equal((await call(f.pilot, 'POST', '/game/charts/sell', { planetId: 'paid-flight', stationId: 'station-alpha' })).statusCode, 409);
    assert.equal((await shipOf(f.pilot)).crewPayoutSinceDock, false);
  });
  test('concurrent same-dock requests cannot double-pay the stipend or grant recovery twice', async () => {
    const f = await flight();
    const responses = await Promise.all([shore(f.pilot, f.receipt), shore(f.pilot, f.receipt)]);
    assert.deepEqual(responses.map((r) => json(r).docking.applied).sort(), [false, true]);
    assert.equal(await credits(f.pilot), 960);
  });
  test('crew-less pilot keeps credits and attributes unchanged', async () => {
    const p = await newPilot('LeaveSolo');
    const first = json(await shore(p, dockedReceipt(p, { dockedAtMs: Date.now() - 120 * MIN })));
    const next = json(await shore(p, dockedReceipt(p)));
    assert.equal(next.credits, first.credits);
    assert.deepEqual(next.ship_attributes, first.ship_attributes);
    assert.deepEqual(next.crew, []);
  });
});

describe('POST /game/crew/pay-arrears resignation recovery', () => {
  test('requires a new dock for morale-zero crew, charges twice debt, and concurrent retries cannot charge twice', async () => {
    const f = await flight({ minutes: 10, balance: 500 });
    await app.prisma.crewMember.update({ where: { id: f.crew.id }, data: { morale: 0, unpaidArrearsCredits: 100 } });
    const pay = (extra = {}) => call(f.pilot, 'POST', '/game/crew/pay-arrears', { crewId: f.crew.id, ...extra });
    assert.equal(json(await pay()).error, 'resignation_requires_new_dock');
    assert.equal(json(await pay({ dockedReceipt: makeReceipt(f.pilot, f.station, f.start) })).error, 'resignation_requires_new_dock');
    const res = await Promise.all([pay({ dockedReceipt: f.receipt }), pay({ dockedReceipt: f.receipt })]);
    assert.deepEqual(res.map((r) => r.statusCode).sort(), [200, 409]);
    assert.equal(await credits(f.pilot), 300);
    assert.deepEqual([(await row(f.crew.id)).morale, (await row(f.crew.id)).unpaidArrearsCredits], [15, 0]);
    await shore(f.pilot, f.receipt);
    assert.notEqual(await row(f.crew.id), null);
  });
});

describe('FLAKY mission-acceptance-only departure', () => {
  test('a deterministic departure removes the crew and reissues attributes; retry cannot restore them', async () => {
    const p = await newPilot('Flaky');
    const offer = signedOffer(p, { required_berths: 0 });
    const at = Date.now();
    let id;
    do { id = randomUUID(); } while (![at, at + 900_000].every((time) => flakyDeparture({ id, quirkId: 'Q12', morale: 80 }, offer.origin_station_id, time)));
    const crew = await addCrew(p, { id, quirkId: 'Q12', morale: 70, rank: 'ADEPT' });
    const receipt = receiptAtOrigin(p, offer);
    const res = await call(p, 'POST', '/game/missions/accept', { offer, dockedReceipt: receipt });
    assert.equal(res.statusCode, 200, res.body);
    assert.deepEqual(json(res).departed_crew, [crew.id]);
    assert.equal(await row(crew.id), null);
    assert.equal(app.jwt.verify(json(res).token).ship_attributes.crew_aboard, 0);
    assert.equal((await call(p, 'POST', '/game/missions/accept', { offer, dockedReceipt: receipt })).statusCode, 409);
  });
  test('shore leave itself does not roll a departure (mining-only signed-undock followup remains separate)', async () => {
    const p = await newPilot('NoUndock');
    const station = randomUUID();
    let id;
    do { id = randomUUID(); } while (!flakyDeparture({ id, quirkId: 'Q12', morale: 80 }, station, Date.now()));
    const crew = await addCrew(p, { id, quirkId: 'Q12', morale: 70 });
    await shore(p, dockedReceipt(p, { dockedEntityId: station }));
    assert.notEqual(await row(crew.id), null);
  });
});
