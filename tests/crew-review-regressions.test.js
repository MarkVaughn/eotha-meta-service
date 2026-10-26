import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID, sign } from 'node:crypto';
import { addCrew, app, call, closeApp, credits, dockedReceipt, json, newPilot, receiptAtOrigin, rtseKey, setCredits, signedOffer } from './helpers.js';
import { generateCrewBoard } from '../src/lib/crew-generator.js';
import { canonicalClaimPayload } from '../src/lib/mission-claim.js';
import { canonicalSaleRecordPayload } from '../src/lib/cargo.js';
import { flakyDeparture } from '../src/lib/crew-docking.js';

before(async () => { await app.ready(); });
after(closeApp);
const MIN = 60_000;
const NEUTRAL = 'Q08';
const row = (id) => app.prisma.crewMember.findUnique({ where: { id } });
const shipOf = (p) => app.prisma.spaceship.findFirst({ where: { playerId: p.id, active: true } });
const receipt = (p, at = Date.now(), station = randomUUID()) => dockedReceipt(p, { dockedAtMs: at, dockedEntityId: station });
const shore = (p, proof, extra = {}) => call(p, 'POST', '/game/crew/shore-leave', { dockedReceipt: proof, ...extra });
async function baseline({ morale = 75, balance = 1000, withCrew = true, minutes = 360 } = {}) {
  const pilot = await newPilot('Review');
  let crew;
  if (withCrew) crew = await addCrew(pilot, { crewClass: 'PILOT', quirkId: NEUTRAL, morale: 75 });
  await setCredits(pilot, balance);
  const at = Date.now() - minutes * MIN;
  const initial = await shore(pilot, receipt(pilot, at));
  assert.equal(initial.statusCode, 200, initial.body);
  if (crew) crew = await app.prisma.crewMember.update({ where: { id: crew.id }, data: { morale } });
  return { pilot, crew, at };
}
async function chartSale(pilot, extra = {}) {
  const planetId = randomUUID();
  await app.prisma.planetChart.create({ data: {
    playerId: pilot.id, planetId, systemH3: '8828308283fffff', completedAtMs: BigInt(Date.now()), signature: 'x', surveyJson: {}
  } });
  return call(pilot, 'POST', '/game/charts/sell', { planetId, stationId: 'station-review', ...extra });
}
async function accept(pilot, proofAt = Date.now(), extraOffer = {}) {
  const offer = signedOffer(pilot, { required_berths: 0, ...extraOffer });
  const proof = receiptAtOrigin(pilot, offer, { dockedAtMs: proofAt });
  const res = await call(pilot, 'POST', '/game/missions/accept', { offer, dockedReceipt: proof });
  assert.equal(res.statusCode, 200, res.body);
  return { body: json(res), proof };
}

// Repro A/A2 and the captain's A+C ruling: bounded gap, explicit resignation, route-independent rescue.
describe('AGY H1/M2: implicit docks never silently delete resigned crew', () => {
  test('a six-hour/offline gap counts at most two hours, advances the signed baseline and reports the dock', async () => {
    const f = await baseline();
    const { body, proof } = await accept(f.pilot);
    assert.equal(body.docking.applied, true);
    assert.equal(body.docking.flightMs, 120 * MIN);
    assert.ok(body.docking.receiptGapMs >= 360 * MIN);
    assert.equal(body.docking.effects[0].fatigueIntervals, 5);
    assert.equal((await row(f.crew.id)).morale, 65); // 75 - 25 + 15
    assert.equal(await credits(f.pilot), 960);
    assert.equal((await shipOf(f.pilot)).lastCrewDockedAtMs, BigInt(proof.dockedAtMs));
  });
  test('low-morale crew remain at zero and cost no stipend until explicit shore leave resolves them at the same dock', async () => {
    const f = await baseline({ morale: 20 });
    const { body, proof } = await accept(f.pilot);
    assert.equal(body.docking.effects[0].resignationPending, true);
    assert.deepEqual(body.docking.departed, []);
    assert.equal((await row(f.crew.id)).morale, 0);
    assert.equal((await row(f.crew.id)).pendingStipendCredits, 40);
    assert.equal(await credits(f.pilot), 1000);
    const explicit = json(await shore(f.pilot, proof));
    assert.deepEqual(explicit.docking.departed, [f.crew.id]);
    assert.equal(await row(f.crew.id), null);
    assert.equal(await credits(f.pilot), 1000); // no stipend charged to a departing member
    assert.deepEqual(json(await shore(f.pilot, proof)).docking, { applied: false });
  });
  test('rescue costs and the single +15 gain are identical whether shore leave or mission acceptance consumed the dock first', async () => {
    for (const implicitFirst of [false, true]) {
      const f = await baseline({ morale: 20 });
      await app.prisma.crewMember.update({ where: { id: f.crew.id }, data: { unpaidArrearsCredits: 100 } });
      const proof = implicitFirst ? (await accept(f.pilot)).proof : receipt(f.pilot);
      const res = await shore(f.pilot, proof, { payResignedArrears: true });
      assert.equal(res.statusCode, 200, res.body);
      assert.deepEqual([(await row(f.crew.id)).morale, (await row(f.crew.id)).unpaidArrearsCredits,
        (await row(f.crew.id)).pendingStipendCredits, await credits(f.pilot)], [15, 0, 0, 760]);
      assert.equal(json(res).docking.effects[0].rescueCredits, 200);
      assert.equal(json(res).docking.effects[0].stipendCredits, 40);
      await shore(f.pilot, proof, { payResignedArrears: true });
      assert.equal(await credits(f.pilot), 760);
      assert.equal((await row(f.crew.id)).morale, 15);
    }
  });
  test('a working FLAKY departure refunds the stipend charged by that acceptance dock', async () => {
    const { pilot, crew } = await baseline();
    await app.prisma.crewMember.update({ where: { id: crew.id }, data: { quirkId: 'Q12' } });
    const now = Date.now();
    let station;
    do { station = randomUUID(); } while (![now, now + 900_000].every((at) => flakyDeparture({ id: crew.id, quirkId: 'Q12', morale: 65 }, station, at)));
    const offer = signedOffer(pilot, { required_berths: 0, origin_station_id: station });
    const res = await call(pilot, 'POST', '/game/missions/accept', { offer, dockedReceipt: receiptAtOrigin(pilot, offer) });
    assert.equal(res.statusCode, 200, res.body);
    assert.deepEqual(json(res).departed_crew, [crew.id]);
    assert.equal(json(res).docking.effects[0].stipendRefundedCredits, 40);
    assert.equal(await row(crew.id), null);
    assert.equal(await credits(pilot), 1000);
  });
  test('a FLAKY Engineer whose budget backs the loadout stays aboard through the acceptance roll', async () => {
    const { pilot } = await baseline({ withCrew: false, minutes: 10 });
    const now = Date.now();
    const offer = signedOffer(pilot, { required_berths: 0 });
    let id;
    do { id = randomUUID(); } while (![now, now + 900_000].every((at) => flakyDeparture({ id, quirkId: 'Q12', morale: 65 }, offer.origin_station_id, at)));
    const engineer = await addCrew(pilot, { id, crewClass: 'ENGINEER', rank: 'ADEPT', wageShareBp: 800, quirkId: 'Q12', morale: 65 });
    const ship = await shipOf(pilot);
    await app.prisma.shipComponentRecord.update({ where: { spaceshipId_type: { spaceshipId: ship.id, type: 'RADAR' } }, data: { tier: 2 } });
    const res = await call(pilot, 'POST', '/game/missions/accept', { offer, dockedReceipt: receiptAtOrigin(pilot, offer) });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(json(res).departed_crew, undefined);
    assert.ok(await row(engineer.id));
  });
  test('an already resigned FLAKY member cannot bypass explicit shore-leave resolution on acceptance', async () => {
    const { pilot } = await baseline({ withCrew: false });
    const offer = signedOffer(pilot, { required_berths: 0 });
    const now = Date.now();
    let id;
    do { id = randomUUID(); } while (![now, now + 900_000].every((at) => flakyDeparture({ id, quirkId: 'Q12', morale: 0 }, offer.origin_station_id, at)));
    const member = await addCrew(pilot, { id, crewClass: 'PILOT', quirkId: 'Q12', morale: 0 });
    const res = await call(pilot, 'POST', '/game/missions/accept', { offer, dockedReceipt: receiptAtOrigin(pilot, offer) });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal((await row(member.id)).morale, 0);
    assert.equal(json(res).docking.effects[0].resignationPending, true);
    assert.equal(json(res).departed_crew, undefined);
  });
  test('an unaffordable rescue never charges a stipend before departure', async () => {
    const f = await baseline({ morale: 20, balance: 100 });
    await app.prisma.crewMember.update({ where: { id: f.crew.id }, data: { unpaidArrearsCredits: 100 } });
    const res = json(await shore(f.pilot, receipt(f.pilot), { payResignedArrears: true }));
    assert.deepEqual(res.docking.departed, [f.crew.id]);
    assert.equal(await credits(f.pilot), 100);
  });
  test('abandon reports fatigue, stipend and pending resignation without deleting anyone', async () => {
    const pilot = await newPilot('AbandonDock');
    const crew = await addCrew(pilot, { crewClass: 'PILOT', quirkId: NEUTRAL });
    await setCredits(pilot, 1000);
    const { body } = await accept(pilot, Date.now() - 360 * MIN);
    await app.prisma.crewMember.update({ where: { id: crew.id }, data: { morale: 20 } });
    const res = await call(pilot, 'POST', '/game/missions/abandon', { missionId: body.active.mission_id, dockedReceipt: receipt(pilot) });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(json(res).docking.applied, true);
    assert.equal(json(res).docking.effects[0].resignationPending, true);
    assert.equal((await row(crew.id)).morale, 0);
    assert.equal(await credits(pilot), 1000);
  });
  test('complete reports its dock and retains morale-zero crew with zero wage share', async () => {
    const pilot = await newPilot('CompleteDock');
    const crew = await addCrew(pilot, { crewClass: 'PILOT', quirkId: NEUTRAL });
    const { body } = await accept(pilot, Date.now() - 360 * MIN);
    await app.prisma.crewMember.update({ where: { id: crew.id }, data: { morale: 0 } });
    const active = body.active;
    const claim = {
      missionId: active.mission_id, playerShipId: pilot.id, destinationStationId: active.offer.destination_station_id,
      acceptedAtMs: active.accepted_at_ms, completedAtMs: Date.now(), rewardCredits: 1000, reputationChange: 5
    };
    claim.durationTakenMs = claim.completedAtMs - claim.acceptedAtMs;
    claim.signature = sign(null, canonicalClaimPayload(claim), rtseKey).toString('base64');
    const res = await call(pilot, 'POST', '/game/missions/complete', { claim, dockedReceipt: receipt(pilot) });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(json(res).docking.applied, true);
    assert.equal(json(res).crewShareCredits, 0);
    assert.deepEqual(json(res).crewPayouts, []);
    assert.equal((await row(crew.id)).morale, 0);
  });
});

describe('AGY H2: joining crew start at the current receipt baseline', () => {
  test('hire after a three-hour leg, then shore leave: no fatigue/stipend for the new hire', async () => {
    const { pilot } = await baseline({ withCrew: false, balance: 10_000, minutes: 180 });
    let station, candidate;
    do {
      station = randomUUID();
      candidate = generateCrewBoard(station, Date.now()).candidates.find((c) => c.rank === 'NOVICE');
    } while (!candidate);
    const proof = receipt(pilot, Date.now(), station);
    const res = await call(pilot, 'POST', '/game/crew/hire', { candidateId: candidate.candidateId, dockedReceipt: proof });
    assert.equal(res.statusCode, 200, res.body);
    const body = json(res);
    assert.equal(body.docking.applied, true);
    assert.deepEqual(body.docking.effects, []);
    const after = await shore(pilot, proof);
    assert.equal(after.statusCode, 200, after.body);
    assert.equal((await row(body.crew.id)).morale, body.crew.morale);
    assert.equal((await row(body.crew.id)).pendingStipendCredits, 0);
    assert.equal(await credits(pilot), body.credits);
  });
  test('activation settles the previous leg before boarding; morale-zero activation is refused', async () => {
    const { pilot } = await baseline({ withCrew: false, minutes: 180 });
    const member = await addCrew(pilot, { crewClass: 'PILOT', quirkId: NEUTRAL, morale: 75, status: 'STANDBY', spaceshipId: null });
    const proof = receipt(pilot);
    const res = await call(pilot, 'POST', '/game/crew/activate', { crewId: member.id, dockedReceipt: proof });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(json(res).docking.applied, true);
    await shore(pilot, proof);
    assert.equal((await row(member.id)).morale, 75);
    assert.equal(await credits(pilot), 1000);
    const zero = await addCrew(pilot, { morale: 0, status: 'STANDBY', spaceshipId: null });
    const refused = await call(pilot, 'POST', '/game/crew/activate', { crewId: zero.id, dockedReceipt: proof });
    assert.equal(refused.statusCode, 409, refused.body);
    assert.equal(json(refused).error, 'crew_resigned');
  });
});

describe('AGY M1/L3/L4: zero-morale roster and recovery', () => {
  test('zero active/standby members take no wage or deferred arrears; explicit leave settles standby too', async () => {
    const { pilot } = await baseline({ withCrew: false });
    const active = await addCrew(pilot, { morale: 0, quirkId: NEUTRAL });
    const standby = await addCrew(pilot, { morale: 0, status: 'STANDBY', spaceshipId: null, quirkId: NEUTRAL });
    const sale = await chartSale(pilot, { deferCrewPay: true, dockedReceipt: receipt(pilot) });
    assert.equal(sale.statusCode, 200, sale.body);
    assert.equal(json(sale).crewShareCredits, 0);
    assert.deepEqual(json(sale).crewPayouts, []);
    assert.equal((await row(active.id)).unpaidArrearsCredits, 0);
    assert.equal((await row(standby.id)).unpaidArrearsCredits, 0);
    assert.equal(json(sale).docking.applied, true);
    const proof = receipt(pilot);
    const leave = json(await shore(pilot, proof));
    assert.deepEqual(new Set(leave.docking.departed), new Set([active.id, standby.id]));
    assert.equal(await row(standby.id), null);
  });
  test('cargo sales retain zero crew, report docking and pay them no wages', async () => {
    const { pilot } = await baseline({ withCrew: false });
    const crew = await addCrew(pilot, { morale: 0, quirkId: NEUTRAL });
    const { cargo } = json(await call(pilot, 'POST', '/game/cargo/lease'));
    const fields = {
      pilotId: pilot.id, stationId: randomUUID(), items: [{ resourceType: 'TITANIUM', unitsMilli: 12500, grade: 4, purityBp: 8000 }],
      totalCredits: 1000, soldAtMs: Date.now(), nonce: randomBytes(16).toString('base64'),
      leaseId: cargo.lease_id, sessionId: randomUUID(), seq: 1, remaining: []
    };
    const saleRecord = { ...fields, signature: sign(null, canonicalSaleRecordPayload(fields), rtseKey).toString('base64') };
    const res = await call(pilot, 'POST', '/game/cargo/sell', { saleRecord, dockedReceipt: receipt(pilot), deferCrewPay: true });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(json(res).docking.applied, true);
    assert.deepEqual(json(res).crewPayouts, []);
    assert.equal((await row(crew.id)).morale, 0);
    assert.equal((await row(crew.id)).unpaidArrearsCredits, 0);
  });
  test('standby rescue restores exactly 15 once and clears twice-paid debt', async () => {
    const { pilot } = await baseline({ withCrew: false, minutes: 10 });
    const member = await addCrew(pilot, { morale: 0, unpaidArrearsCredits: 100, quirkId: NEUTRAL, status: 'STANDBY', spaceshipId: null });
    const proof = receipt(pilot);
    const res = await shore(pilot, proof, { payResignedArrears: true });
    assert.equal(res.statusCode, 200, res.body);
    assert.deepEqual([(await row(member.id)).morale, (await row(member.id)).unpaidArrearsCredits, await credits(pilot)], [15, 0, 800]);
    await shore(pilot, proof, { payResignedArrears: true });
    assert.equal((await row(member.id)).morale, 15);
  });
  test('Chef override uses the post-fatigue, pre-recovery snapshot, not hiring order', async () => {
    const { pilot, crew } = await baseline({ morale: 90, minutes: 90 });
    const chef = await addCrew(pilot, { crewClass: 'CHEF', rank: 'MASTER', morale: 50, quirkId: NEUTRAL });
    await shore(pilot, receipt(pilot));
    assert.equal((await row(crew.id)).morale, 80); // Chef is below 50 after fatigue, even though leave revives it
    assert.equal((await row(chef.id)).morale, 50);
  });
  test('bulk pay-arrears pays healthy members and lists resignations skipped without a new dock', async () => {
    const { pilot, crew } = await baseline({ morale: 60, minutes: 10 });
    await app.prisma.crewMember.update({ where: { id: crew.id }, data: { unpaidArrearsCredits: 100 } });
    const zero = await addCrew(pilot, { morale: 0, unpaidArrearsCredits: 100, status: 'STANDBY', spaceshipId: null, quirkId: NEUTRAL });
    const res = await call(pilot, 'POST', '/game/crew/pay-arrears', {});
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(json(res).paidCredits, 100);
    assert.deepEqual(json(res).skipped, [{ crewId: zero.id, reason: 'resignation_requires_new_dock' }]);
    assert.equal((await row(crew.id)).morale, 75);
    assert.equal((await row(zero.id)).unpaidArrearsCredits, 100);
    assert.equal(await credits(pilot), 900);
    const again = await call(pilot, 'POST', '/game/crew/pay-arrears', {});
    assert.equal(again.statusCode, 200, again.body);
    assert.deepEqual(json(again).paid, []);
    assert.equal(await credits(pilot), 900);
  });
});

describe('AGY L1: payout timestamps bound the eligible receipt interval', () => {
  test('a legacy true flag cannot waive a stipend when the last payout predates the old signed dock', async () => {
    const { pilot, at } = await baseline({ minutes: 90 });
    const ship = await shipOf(pilot);
    await app.prisma.spaceship.update({ where: { id: ship.id }, data: { crewPayoutSinceDock: true, lastCrewPayoutAtMs: BigInt(at - 1) } });
    const res = json(await shore(pilot, receipt(pilot)));
    assert.equal(res.docking.effects[0].stipendCredits, 40);
    assert.equal(await credits(pilot), 960);
    assert.equal((await shipOf(pilot)).lastCrewPayoutAtMs, BigInt(at - 1));
  });
  test('a payout settled between the old and new docking timestamps waives the stipend and survives dock consumption', async () => {
    const { pilot } = await baseline({ minutes: 90 });
    const sale = await chartSale(pilot);
    assert.equal(sale.statusCode, 200, sale.body);
    const payoutAt = (await shipOf(pilot)).lastCrewPayoutAtMs;
    assert.ok(payoutAt > 0n);
    const res = json(await shore(pilot, receipt(pilot)));
    assert.equal(res.docking.effects[0].stipendCredits, undefined);
    assert.equal(await credits(pilot), 1475);
    assert.equal((await shipOf(pilot)).lastCrewPayoutAtMs, payoutAt);
  });
});
