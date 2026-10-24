import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { addCrew, app, call, closeApp, credits, dockedReceipt, json, newPilot, receiptAtOrigin, setCredits, signedOffer } from './helpers.js';
import { computeShipAttributes, defaultComponents, freeBerths, hullBudget } from '../src/config/components.js';
import {
  CREW_BOARD_OFFER_COUNT,
  CREW_BOARD_WINDOW_MS,
  CREW_CLASS_IDS,
  CREW_REP_REQ_SCORE,
  CREW_SIGNING_BONUS_CREDITS,
  CREW_WAGE_SHARE_BP,
  HOME_FACTION_WEIGHTS,
  LIFE_SUPPORT_BERTHS_BY_TIER,
  MAX_CREW_BY_HULL_TIER,
  MAX_TOTAL_WAGE_BP,
  QUIRKS,
  QUIRK_IDS,
  QUIRK_WEIGHT_TOTAL,
  STANDARD_RANK_WEIGHTS,
  crewShipEffects,
  effectiveWageShareBp,
  maxActiveCrew,
  signingBonusCredits,
  startingMorale
} from '../src/config/crew.js';
import { candidateSeed, crewBoardWindow, generateCrewBoard } from '../src/lib/crew-generator.js';
import { deductCrewRevenueShare } from '../src/lib/crew.js';

before(async () => {
  await app.ready();
});
after(closeApp);

// A station id for index `i`, so a search over boards is repeatable.
const stationAt = (i) => `00000000-0000-4000-8000-${i.toString(16).padStart(12, '0')}`;
// The first station whose board now satisfies `matches(candidates)`, with that board.
function findStation(matches, from = 0) {
  for (let i = from; i < from + 20_000; i++) {
    const { candidates } = generateCrewBoard(stationAt(i), Date.now());
    if (matches(candidates)) return { stationId: stationAt(i), candidates, index: i };
  }
  throw new Error('no station with a suitable board');
}

const board = (pilot, stationId) => call(pilot, 'GET', `/game/crew/board?stationId=${stationId}`);
const hire = (pilot, stationId, candidateId, body = {}) =>
  call(pilot, 'POST', '/game/crew/hire', {
    candidateId,
    dockedReceipt: dockedReceipt(pilot, { dockedEntityId: stationId }),
    ...body
  });
const crewAction = (action) => (pilot, crewId, body = {}) =>
  call(pilot, 'POST', `/game/crew/${action}`, { crewId, dockedReceipt: dockedReceipt(pilot), ...body });
const dismiss = crewAction('dismiss');
const standby = crewAction('standby');
const activate = crewAction('activate');
const roster = async (pilot) => json(await call(pilot, 'GET', '/game/crew'));
const tokenAttributes = (res) => app.jwt.verify(json(res).token).ship_attributes;
const setStanding = (pilot, factionId, standing) =>
  app.prisma.playerReputation.upsert({
    where: { playerId_factionId: { playerId: pilot.id, factionId } },
    update: { standing },
    create: { playerId: pilot.id, factionId, standing }
  });
const setComponent = async (pilot, type, tier) => {
  const ship = await app.prisma.spaceship.findFirst({ where: { playerId: pilot.id, active: true } });
  await app.prisma.shipComponentRecord.update({ where: { spaceshipId_type: { spaceshipId: ship.id, type } }, data: { tier } });
};
const novice = (candidates) => candidates.filter((c) => c.rank === 'NOVICE');

describe('crew config', () => {
  test('pins the constants', () => {
    assert.deepEqual(LIFE_SUPPORT_BERTHS_BY_TIER, [3, 6, 12, 22, 50]);
    assert.deepEqual(MAX_CREW_BY_HULL_TIER, [1, 2, 3, 5, 7]);
    assert.deepEqual(CREW_WAGE_SHARE_BP, { NOVICE: 500, ADEPT: 800, MASTER: 1200 });
    assert.deepEqual(CREW_SIGNING_BONUS_CREDITS, { NOVICE: 500, ADEPT: 1500, MASTER: 4000 });
    assert.deepEqual(CREW_REP_REQ_SCORE, { NOVICE: -499, ADEPT: -149, MASTER: 450 });
    assert.equal(MAX_TOTAL_WAGE_BP, 5000);
    assert.equal(CREW_BOARD_OFFER_COUNT, 4);
    assert.equal(CREW_BOARD_WINDOW_MS, 30 * 60_000);
    assert.deepEqual(CREW_CLASS_IDS, ['PILOT', 'NAVIGATOR', 'SCIENCE', 'ENGINEER', 'CHEF', 'DOCTOR', 'GUNNER']);
  });

  test('the quirk catalog is Q01 to Q20 with weights summing to 1000', () => {
    assert.deepEqual(QUIRK_IDS, Array.from({ length: 20 }, (_, i) => `Q${String(i + 1).padStart(2, '0')}`));
    assert.equal(QUIRK_WEIGHT_TOTAL, 1000);
    assert.equal(QUIRK_IDS.reduce((sum, id) => sum + QUIRKS[id].weight, 0), 1000);
    for (const id of QUIRK_IDS) assert.ok(QUIRKS[id].summary.length > 10, id);
    for (const weights of [HOME_FACTION_WEIGHTS, STANDARD_RANK_WEIGHTS]) {
      assert.equal(weights.reduce((sum, [, weight]) => sum + weight, 0), 1000);
    }
  });

  test('wage shares and signing bonuses move with quirks and captain traits', () => {
    assert.equal(effectiveWageShareBp(500, 'Q01'), 500);
    assert.equal(effectiveWageShareBp(500, 'Q13'), 650); // CHARMING +1.5%
    assert.equal(effectiveWageShareBp(500, 'Q10'), 400); // LAZY -1.0%
    assert.equal(effectiveWageShareBp(500, 'Q01', ['C1_HARD_BARGAINER']), 425); // wage x0.85
    assert.equal(effectiveWageShareBp(500, 'Q10', ['C1_HARD_BARGAINER']), 340);
    assert.equal(effectiveWageShareBp(300, 'Q12', ['C1_HARD_BARGAINER']), 250); // floored
    assert.equal(signingBonusCredits('NOVICE', 'Q01'), 500);
    assert.equal(signingBonusCredits('MASTER', 'Q05'), 4600); // MERCENARY +15%
    assert.equal(signingBonusCredits('ADEPT', 'Q12'), 1050); // FLAKY -30%
    assert.equal(signingBonusCredits('NOVICE', 'Q01', ['C1_HARD_BARGAINER']), 375);
    assert.equal(startingMorale('Q01'), 75);
    assert.equal(startingMorale('Q06'), 70);
    assert.equal(startingMorale('Q01', ['C2_SHORE_CONTACTS']), 85);
    assert.equal(maxActiveCrew(1), 1);
    assert.equal(maxActiveCrew(1, ['H6_FLEET_CAPTAIN']), 2);
    assert.equal(maxActiveCrew(5), 7);
  });
});

describe('computeShipAttributes with crew', () => {
  const crew = (crewClass, rank, extra = {}) => ({ crewClass, rank, quirkId: 'Q01', morale: 75, ...extra });

  test('crew_aboard counts the active crew and takes their berths', () => {
    const base = computeShipAttributes(defaultComponents(), 0, [], []);
    assert.equal(base.crew_aboard, 0);
    assert.equal(base.passenger_capacity, 3);
    const one = computeShipAttributes(defaultComponents(), 0, [], [crew('CHEF', 'NOVICE')]);
    assert.equal(one.crew_aboard, 1);
    assert.equal(freeBerths(one), 2);
    assert.equal(one.passengers_aboard, 0);
    // Passengers are clamped to the berths crew leave free.
    assert.equal(computeShipAttributes(defaultComponents(), 3, [], [crew('CHEF', 'NOVICE')]).passengers_aboard, 2);
  });

  test('class stat bonuses scale with rank and morale', () => {
    const speed = (rank, morale = 75) => computeShipAttributes(defaultComponents(), 0, [], [crew('PILOT', rank, { morale })]).max_speed_mps;
    assert.equal(speed('NOVICE'), 21.6); // 20 x 1.08
    assert.equal(speed('ADEPT'), 23); // 20 x 1.15
    assert.equal(speed('MASTER'), 25); // 20 x 1.25
    assert.equal(speed('NOVICE', 90), 21.84); // Inspired scales the bonus by 1.15
    assert.equal(speed('NOVICE', 30), 20.96); // Disgruntled by 0.6
    assert.equal(speed('NOVICE', 10), 20); // Mutinous: no bonus
    assert.deepEqual(crewShipEffects([crew('CHEF', 'MASTER'), crew('DOCTOR', 'MASTER')]), []);
  });

  test('an Adept or Master Engineer adds hull budget', () => {
    assert.equal(hullBudget(1), 6);
    assert.equal(hullBudget(1, [], [crew('ENGINEER', 'NOVICE')]), 6);
    assert.equal(hullBudget(1, [], [crew('ENGINEER', 'ADEPT')]), 7);
    assert.equal(hullBudget(1, [], [crew('ENGINEER', 'MASTER')]), 8);
    assert.equal(hullBudget(1, ['H6_FLEET_CAPTAIN'], [crew('ENGINEER', 'MASTER')]), 9);
    assert.equal(hullBudget(1, [], [crew('ENGINEER', 'MASTER', { morale: 30 })]), 6); // Disgruntled: no jury-rig
  });
});

describe('crew board generator', () => {
  test('a board is four candidates, the same every time within a window', () => {
    const now = Date.UTC(2026, 0, 1, 12, 10);
    const stationId = randomUUID();
    const a = generateCrewBoard(stationId, now);
    const b = generateCrewBoard(stationId, now + 5 * 60_000);
    assert.equal(a.candidates.length, 4);
    assert.deepEqual(a, b);
    assert.deepEqual(a.window, { index: crewBoardWindow(now).index, startsAtMs: Date.UTC(2026, 0, 1, 12), expiresAtMs: Date.UTC(2026, 0, 1, 12, 30) });
    assert.equal(new Set(a.candidates.map((c) => c.candidateId)).size, 4);
    const next = generateCrewBoard(stationId, now + 25 * 60_000);
    assert.equal(next.window.index, a.window.index + 1);
    assert.notDeepEqual(next.candidates.map((c) => c.candidateId), a.candidates.map((c) => c.candidateId));
    assert.notDeepEqual(generateCrewBoard(randomUUID(), now).candidates.map((c) => c.candidateId), a.candidates.map((c) => c.candidateId));
  });

  test('is seeded by SHA-256 of the tag, station id, window and slot', () => {
    const seed = candidateSeed('station-x', 7, 2);
    assert.equal(seed.length, 32);
    assert.deepEqual(seed, candidateSeed('station-x', 7, 2));
    for (const other of [candidateSeed('station-y', 7, 2), candidateSeed('station-x', 8, 2), candidateSeed('station-x', 7, 3)]) {
      assert.notDeepEqual(seed, other);
    }
  });

  test('draws valid classes, ranks, factions and quirks; the hub slot is never a Novice', () => {
    const seen = { quirks: new Set(), ranks: new Set(), classes: new Set() };
    for (let i = 0; i < 400; i++) {
      generateCrewBoard(stationAt(i), 1_000_000).candidates.forEach((c, slot) => {
        assert.ok(CREW_CLASS_IDS.includes(c.crewClass));
        assert.ok(QUIRK_IDS.includes(c.quirkId));
        assert.ok(['alpha', 'beta', 'gamma', 'independent'].includes(c.homeFactionId));
        assert.equal(c.slotIndex, slot);
        if (slot === 3) assert.notEqual(c.rank, 'NOVICE');
        seen.quirks.add(c.quirkId);
        seen.ranks.add(c.rank);
        seen.classes.add(c.crewClass);
      });
    }
    assert.equal(seen.quirks.size, 20);
    assert.equal(seen.ranks.size, 3);
    assert.equal(seen.classes.size, 7);
  });
});

describe('GET /game/crew/board', () => {
  test('ASSERT-2.2.1: four candidates; an unaffordable Master is unavailable for rep and credits; a second Engineer for its class', async () => {
    const { stationId } = findStation((c) => c.some((x) => x.rank === 'MASTER') && c.some((x) => x.crewClass === 'ENGINEER' && x.rank !== 'MASTER'));
    const pilot = await newPilot('Board');
    await addCrew(pilot, { crewClass: 'ENGINEER', rank: 'NOVICE' });
    const res = await board(pilot, stationId);
    assert.equal(res.statusCode, 200, res.body);
    const body = json(res);
    assert.equal(body.candidates.length, 4);
    assert.equal(body.stationId, stationId);
    const master = body.candidates.find((c) => c.rank === 'MASTER');
    assert.equal(master.hireable, false);
    const codes = master.unavailableReasons.map((r) => r.code);
    assert.ok(codes.includes('INSUFFICIENT_FACTION_REP'));
    assert.ok(codes.includes('INSUFFICIENT_CREDITS'));
    const rep = master.unavailableReasons.find((r) => r.code === 'INSUFFICIENT_FACTION_REP');
    assert.equal(rep.requiredScore, 450);
    assert.equal(rep.currentScore, 0);
    assert.equal(rep.factionId, master.homeFactionId);
    const engineer = body.candidates.find((c) => c.crewClass === 'ENGINEER');
    assert.equal(engineer.hireable, false);
    assert.ok(engineer.unavailableReasons.some((r) => r.code === 'CLASS_ALREADY_ACTIVE'));
    for (const candidate of body.candidates) assert.ok(candidate.unavailableReasons.every((r) => typeof r.label === 'string'));
  });

  test('shows each quirk in full before hiring, with the terms', async () => {
    const { stationId, candidates } = findStation((c) => c.some((x) => x.rank === 'NOVICE'));
    const pilot = await newPilot('Quirks');
    const body = json(await board(pilot, stationId));
    body.candidates.forEach((view, i) => {
      assert.equal(view.candidateId, candidates[i].candidateId);
      assert.equal(view.quirk.id, candidates[i].quirkId);
      assert.ok(view.quirk.summary.length > 10);
      assert.ok(view.quirk.modifiers);
      assert.equal(view.baseWageShareBp, CREW_WAGE_SHARE_BP[view.rank]);
      assert.equal(view.signingBonusCredits, signingBonusCredits(view.rank, view.quirk.id));
      assert.ok(Array.isArray(view.effects));
    });
    assert.deepEqual(json(await board(pilot, stationId)).candidates, body.candidates);
  });

  test('is available once the pilot has the credits and standing', async () => {
    const { stationId } = findStation((c) => c.some((x) => x.rank === 'MASTER'));
    const pilot = await newPilot('Rich');
    await setCredits(pilot, 10_000);
    const first = json(await board(pilot, stationId));
    const master = first.candidates.find((c) => c.rank === 'MASTER');
    assert.deepEqual(master.unavailableReasons.map((r) => r.code), ['INSUFFICIENT_FACTION_REP']);
    await setStanding(pilot, master.homeFactionId, 450);
    const second = json(await board(pilot, stationId));
    assert.equal(second.candidates.find((c) => c.rank === 'MASTER').hireable, true);
    assert.equal(second.credits, 10_000);
  });

  test('rejects a missing or malformed station and an anonymous caller', async () => {
    const pilot = await newPilot('BadBoard');
    assert.equal((await call(pilot, 'GET', '/game/crew/board')).statusCode, 400);
    assert.equal((await call(pilot, 'GET', '/game/crew/board?stationId=nope')).statusCode, 400);
    assert.equal((await app.inject({ method: 'GET', url: `/game/crew/board?stationId=${randomUUID()}` })).statusCode, 401);
  });
});

describe('POST /game/crew/hire', () => {
  test('pays the signing bonus, puts the hire aboard and reissues the token with crew_aboard', async () => {
    const { stationId, candidates } = findStation((c) => novice(c).length > 0);
    const candidate = novice(candidates)[0];
    const pilot = await newPilot('Hire');
    await setCredits(pilot, 2_000);
    const res = await hire(pilot, stationId, candidate.candidateId);
    assert.equal(res.statusCode, 200, res.body);
    const body = json(res);
    const bonus = signingBonusCredits('NOVICE', candidate.quirkId);
    assert.equal(body.credits, 2_000 - bonus);
    assert.equal(await credits(pilot), 2_000 - bonus);
    assert.equal(body.crew.name, candidate.name);
    assert.equal(body.crew.crewClass, candidate.crewClass);
    assert.equal(body.crew.status, 'ACTIVE');
    assert.equal(body.crew.morale, startingMorale(candidate.quirkId));
    assert.equal(body.crew.hiredAtStationId, stationId);
    assert.equal(body.ship_attributes.crew_aboard, 1);
    assert.equal(tokenAttributes(res).crew_aboard, 1);
    assert.equal(tokenAttributes(res).passenger_capacity, 3);

    const stored = await app.prisma.crewMember.findMany({ where: { playerId: pilot.id } });
    assert.equal(stored.length, 1);
    assert.equal(stored[0].wageShareBp, 500);
    assert.equal(stored[0].spaceshipId !== null, true);
    const state = await roster(pilot);
    assert.deepEqual(state.active.map((m) => m.id), [body.crew.id]);
    assert.deepEqual(state.standby, []);
    assert.equal(state.limits.freeBerths, 2);
    assert.equal(state.limits.maxActiveCrew, 1);
    assert.equal(json(await call(pilot, 'GET', '/ship/loadout')).ship_attributes.crew_aboard, 1);
  });

  test('needs a current docked receipt for the station that made the offer', async () => {
    const { stationId, candidates } = findStation((c) => novice(c).length > 0);
    const candidateId = novice(candidates)[0].candidateId;
    const pilot = await newPilot('Receipt');
    await setCredits(pilot, 2_000);
    const noReceipt = await call(pilot, 'POST', '/game/crew/hire', { candidateId });
    assert.equal(noReceipt.statusCode, 403);
    assert.equal(json(noReceipt).error, 'docked_receipt_required');
    const expired = await hire(pilot, stationId, candidateId, {
      dockedReceipt: dockedReceipt(pilot, { dockedEntityId: stationId, dockedAtMs: Date.now() - 60_000, issuedAtMs: Date.now() - 31_000 })
    });
    assert.equal(json(expired).error, 'docked_receipt_required');
    const elsewhere = await hire(pilot, stationId, candidateId, { stationId, dockedReceipt: dockedReceipt(pilot) });
    assert.equal(json(elsewhere).error, 'docked_receipt_wrong_station');
    const other = await newPilot('Other');
    const foreign = await hire(pilot, stationId, candidateId, { dockedReceipt: dockedReceipt(other, { dockedEntityId: stationId }) });
    assert.equal(json(foreign).error, 'docked_receipt_invalid');
    assert.equal(await app.prisma.crewMember.count({ where: { playerId: pilot.id } }), 0);
    assert.equal(await credits(pilot), 2_000);
  });

  test('a candidate the station is not offering is 404', async () => {
    const pilot = await newPilot('NoCand');
    await setCredits(pilot, 2_000);
    const res = await hire(pilot, randomUUID(), 'cand-0-deadbeef');
    assert.equal(res.statusCode, 404);
    assert.equal(json(res).error, 'candidate_not_found');
    assert.equal((await hire(pilot, randomUUID(), 'whoever')).statusCode, 400);
  });

  test('refuses an unaffordable bonus with 402 and a standing below the rank with 403, changing nothing', async () => {
    const { stationId, candidates } = findStation((c) => novice(c).length > 0 && c.some((x) => x.rank === 'MASTER'));
    const poor = await newPilot('Poor');
    await setCredits(poor, signingBonusCredits('NOVICE', novice(candidates)[0].quirkId) - 1);
    const broke = await hire(poor, stationId, novice(candidates)[0].candidateId);
    assert.equal(broke.statusCode, 402);
    assert.equal(json(broke).error, 'insufficient_credits');
    assert.deepEqual(json(broke).unavailableReasons.map((r) => r.code), ['INSUFFICIENT_CREDITS']);
    assert.equal(await app.prisma.crewMember.count({ where: { playerId: poor.id } }), 0);

    const master = candidates.find((c) => c.rank === 'MASTER');
    const rich = await newPilot('NoRep');
    await setCredits(rich, 10_000);
    const denied = await hire(rich, stationId, master.candidateId);
    assert.equal(denied.statusCode, 403);
    assert.equal(json(denied).error, 'insufficient_faction_rep');
    assert.equal(json(denied).requiredScore, 450);
    assert.equal(json(denied).currentScore, 0);
    assert.equal(await credits(rich), 10_000);

    await setStanding(rich, master.homeFactionId, 450);
    const ok = await hire(rich, stationId, master.candidateId);
    assert.equal(ok.statusCode, 200, ok.body);
    assert.equal(json(ok).credits, 10_000 - signingBonusCredits('MASTER', master.quirkId));
    assert.equal(json(ok).crew.baseWageShareBp, 1200);
  });

  test('ASSERT-2.2.2: a Hull Tier 1 ship takes one crew member; the second hire is refused with the hull cap', async () => {
    const { stationId, candidates } = findStation((c) => {
      const n = novice(c);
      return n.length >= 2 && n[0].crewClass !== n[1].crewClass;
    });
    const [first, second] = novice(candidates);
    const pilot = await newPilot('Cap');
    await setCredits(pilot, 5_000);
    assert.equal((await hire(pilot, stationId, first.candidateId)).statusCode, 200);
    const res = await hire(pilot, stationId, second.candidateId);
    assert.equal(res.statusCode, 400);
    assert.equal(json(res).error, 'hull_crew_cap_reached');
    assert.equal(json(res).maxCrew, 1);
    assert.equal(await app.prisma.crewMember.count({ where: { playerId: pilot.id } }), 1);
    assert.equal(await credits(pilot), 5_000 - signingBonusCredits('NOVICE', first.quirkId));
    // The board marks the second candidate unavailable for the same reason.
    const view = json(await board(pilot, stationId)).candidates.find((c) => c.candidateId === second.candidateId);
    assert.equal(view.hireable, false);
    assert.ok(view.unavailableReasons.some((r) => r.code === 'HULL_CREW_CAP_REACHED'));
  });

  test('a second crew member of a class already aboard is refused with 409', async () => {
    const { stationId, candidates } = findStation((c) => novice(c).length > 0);
    const candidate = novice(candidates)[0];
    const pilot = await newPilot('Dup');
    await setCredits(pilot, 5_000);
    // Tier 2 hull, so the class rule and not the hull cap is what refuses.
    await addCrew(pilot, { crewClass: candidate.crewClass });
    await setComponent(pilot, 'HULL', 2);
    const res = await hire(pilot, stationId, candidate.candidateId);
    assert.equal(res.statusCode, 409);
    assert.equal(json(res).error, 'class_already_active');
  });

  test('without a free berth the hire is refused with insufficient_free_berths, passengers included', async () => {
    const { stationId, candidates } = findStation((c) => novice(c).length > 0);
    const candidate = novice(candidates)[0];
    const pilot = await newPilot('Berths');
    await setCredits(pilot, 5_000);
    await call(pilot, 'GET', '/ship/loadout');
    await app.prisma.spaceship.updateMany({ where: { playerId: pilot.id }, data: { passengersAboard: 3 } });
    const res = await hire(pilot, stationId, candidate.candidateId);
    assert.equal(res.statusCode, 400);
    assert.equal(json(res).error, 'insufficient_free_berths');
    assert.equal(await app.prisma.crewMember.count({ where: { playerId: pilot.id } }), 0);
  });

  test('concurrent hires cannot over-book the hull or double-charge', async () => {
    const { stationId, candidates } = findStation((c) => {
      const n = novice(c);
      return n.length >= 2 && n[0].crewClass !== n[1].crewClass;
    });
    const [first, second] = novice(candidates);
    const pilot = await newPilot('Race');
    await setCredits(pilot, 5_000);
    const results = await Promise.all([hire(pilot, stationId, first.candidateId), hire(pilot, stationId, second.candidateId), hire(pilot, stationId, first.candidateId)]);
    assert.equal(results.filter((r) => r.statusCode === 200).length, 1, results.map((r) => r.body).join('\n'));
    assert.equal(await app.prisma.crewMember.count({ where: { playerId: pilot.id } }), 1);
    const hired = await app.prisma.crewMember.findFirst({ where: { playerId: pilot.id } });
    assert.equal(await credits(pilot), 5_000 - signingBonusCredits('NOVICE', hired.quirkId));
  });

  test('crew take berths from passage missions; a free berth count of 3 minus crew applies to accept', async () => {
    const pilot = await newPilot('Mission');
    await addCrew(pilot);
    const accept = (offer) => call(pilot, 'POST', '/game/missions/accept', { offer, dockedReceipt: receiptAtOrigin(pilot, offer) });
    const tooBig = await accept(signedOffer(pilot, { required_berths: 3 }));
    assert.equal(tooBig.statusCode, 400);
    assert.equal(json(tooBig).code, 'insufficient_berths');
    assert.equal(json(tooBig).available_berths, 2);
    const ok = await accept(signedOffer(pilot, { required_berths: 2 }));
    assert.equal(ok.statusCode, 200, ok.body);
    const attributes = tokenAttributes(ok);
    assert.equal(attributes.passengers_aboard, 2);
    assert.equal(attributes.crew_aboard, 1);
    assert.equal(attributes.passenger_capacity, 3);
  });

  test('the dev passenger count also leaves the crew their berths', async () => {
    const pilot = await newPilot('DevPaxCrew');
    await addCrew(pilot);
    assert.equal((await call(pilot, 'POST', '/ship/dev/passengers', { passengersAboard: 3 })).statusCode, 400);
    assert.equal((await call(pilot, 'POST', '/ship/dev/passengers', { passengersAboard: 2 })).statusCode, 200);
  });
});

describe('a hired candidate and the board', () => {
  const ids = (res) => json(res).candidates.map((c) => c.candidateId);

  test('records the candidate on the hire and leaves them off the pilot\'s board, the others unmoved', async () => {
    const { stationId, candidates } = findStation((c) => novice(c).length > 0);
    const candidate = novice(candidates)[0];
    const pilot = await newPilot('BoardHired');
    const other = await newPilot('BoardOther');
    await setCredits(pilot, 2_000);
    assert.deepEqual(ids(await board(pilot, stationId)), candidates.map((c) => c.candidateId));
    assert.equal((await hire(pilot, stationId, candidate.candidateId)).statusCode, 200);

    const stored = await app.prisma.crewMember.findFirst({ where: { playerId: pilot.id } });
    assert.equal(stored.sourceCandidateId, candidate.candidateId);
    const after = await board(pilot, stationId);
    assert.deepEqual(ids(after), candidates.map((c) => c.candidateId).filter((id) => id !== candidate.candidateId));
    assert.equal(json(after).candidates.length, candidates.length - 1);
    // The remaining cards are exactly what the same pilot would have seen with the hire out of the way.
    assert.deepEqual(json(after).candidates.map((c) => c.slotIndex), candidates.map((c) => c.slotIndex).filter((slot) => slot !== candidate.slotIndex));
    // Only the pilot who hired is affected: the board is still the same for everyone else.
    assert.deepEqual(ids(await board(other, stationId)), candidates.map((c) => c.candidateId));
    assert.deepEqual(generateCrewBoard(stationId, Date.now()).candidates, candidates);
  });

  test('a second hire of the same candidate is refused with 409 and changes nothing', async () => {
    const { stationId, candidates } = findStation((c) => novice(c).length > 0);
    const candidate = novice(candidates)[0];
    const pilot = await newPilot('HireTwice');
    await setCredits(pilot, 5_000);
    assert.equal((await hire(pilot, stationId, candidate.candidateId)).statusCode, 200);
    const balance = await credits(pilot);
    const res = await hire(pilot, stationId, candidate.candidateId);
    assert.equal(res.statusCode, 409, res.body);
    assert.equal(json(res).error, 'candidate_already_hired');
    assert.equal(await credits(pilot), balance);
    assert.equal(await app.prisma.crewMember.count({ where: { playerId: pilot.id } }), 1);
  });

  test('the same candidate hired by two requests at once is hired once', async () => {
    const { stationId, candidates } = findStation((c) => novice(c).length > 0);
    const candidate = novice(candidates)[0];
    const pilot = await newPilot('HireRace');
    await setCredits(pilot, 5_000);
    const results = await Promise.all([1, 2, 3].map(() => hire(pilot, stationId, candidate.candidateId)));
    assert.equal(results.filter((r) => r.statusCode === 200).length, 1, results.map((r) => r.body).join('\n'));
    for (const res of results.filter((r) => r.statusCode !== 200)) assert.equal(json(res).error, 'candidate_already_hired');
    assert.equal(await app.prisma.crewMember.count({ where: { playerId: pilot.id } }), 1);
    assert.equal(await credits(pilot), 5_000 - signingBonusCredits('NOVICE', candidate.quirkId));
  });

  test('a crew member on standby is still off the board; a dismissed one may be offered again', async () => {
    const { stationId, candidates } = findStation((c) => novice(c).length > 0);
    const candidate = novice(candidates)[0];
    const pilot = await newPilot('HireCycle');
    await setCredits(pilot, 5_000);
    const hired = json(await hire(pilot, stationId, candidate.candidateId)).crew;
    assert.equal((await standby(pilot, hired.id)).statusCode, 200);
    assert.equal(ids(await board(pilot, stationId)).includes(candidate.candidateId), false);
    const again = await hire(pilot, stationId, candidate.candidateId);
    assert.equal(again.statusCode, 409);
    assert.equal(json(again).error, 'candidate_already_hired');

    assert.equal((await dismiss(pilot, hired.id)).statusCode, 200);
    assert.deepEqual(ids(await board(pilot, stationId)), candidates.map((c) => c.candidateId));
    assert.equal((await hire(pilot, stationId, candidate.candidateId)).statusCode, 200);
  });

  test('crew hired before the candidate was recorded never match one', async () => {
    const { stationId, candidates } = findStation((c) => novice(c).length > 0);
    const candidate = novice(candidates)[0];
    const pilot = await newPilot('HireLegacy');
    await setCredits(pilot, 5_000);
    await addCrew(pilot, { name: candidate.name, crewClass: candidate.crewClass, quirkId: candidate.quirkId, hiredAtStationId: stationId });
    assert.deepEqual(ids(await board(pilot, stationId)), candidates.map((c) => c.candidateId));
  });
});

describe('dismiss and standby', () => {
  test('dismiss removes the crew member for good, frees the berth and refunds nothing', async () => {
    const pilot = await newPilot('Dismiss');
    await setCredits(pilot, 100);
    const member = await addCrew(pilot);
    const res = await dismiss(pilot, member.id);
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(tokenAttributes(res).crew_aboard, 0);
    assert.equal(await app.prisma.crewMember.count({ where: { playerId: pilot.id } }), 0);
    assert.equal(await credits(pilot), 100);
    assert.equal((await dismiss(pilot, member.id)).statusCode, 404);
    assert.equal((await dismiss(pilot, randomUUID())).statusCode, 404);
  });

  test('another pilot\'s crew cannot be dismissed', async () => {
    const owner = await newPilot('Owner');
    const member = await addCrew(owner);
    const thief = await newPilot('Thief');
    assert.equal((await dismiss(thief, member.id)).statusCode, 404);
    assert.equal(await app.prisma.crewMember.count({ where: { playerId: owner.id } }), 1);
  });

  test('needs a docked receipt', async () => {
    const pilot = await newPilot('NoReceipt');
    const member = await addCrew(pilot);
    for (const action of ['dismiss', 'standby', 'activate']) {
      const res = await call(pilot, 'POST', `/game/crew/${action}`, { crewId: member.id });
      assert.equal(res.statusCode, 403, action);
      assert.equal(json(res).error, 'docked_receipt_required');
    }
    assert.equal(await app.prisma.crewMember.count({ where: { playerId: pilot.id } }), 1);
  });

  test('ASSERT-2.2.4: dismiss and standby are refused with 409 while the pilot holds a mission', async () => {
    const pilot = await newPilot('Locked');
    await setCredits(pilot, 500);
    const member = await addCrew(pilot);
    const offer = signedOffer(pilot, { type: 'MISSION_TYPE_RESEARCH', required_berths: 0 });
    const accepted = await call(pilot, 'POST', '/game/missions/accept', { offer, dockedReceipt: receiptAtOrigin(pilot, offer) });
    assert.equal(accepted.statusCode, 200, accepted.body);
    for (const act of [dismiss, standby]) {
      const res = await act(pilot, member.id);
      assert.equal(res.statusCode, 409);
      assert.equal(json(res).error, 'crew_locked_by_active_mission');
    }
    assert.equal(await credits(pilot), 500);
    assert.equal((await roster(pilot)).active.length, 1);
    // Abandoning the mission frees the crew.
    assert.equal((await call(pilot, 'POST', '/game/missions/abandon', { missionId: offer.mission_id })).statusCode, 200);
    assert.equal((await dismiss(pilot, member.id)).statusCode, 200);
  });

  test('ASSERT-2.2.5: an Engineer cannot go while the installed components need the budget they provide', async () => {
    const pilot = await newPilot('Budget');
    await setCredits(pilot, 500);
    const engineer = await addCrew(pilot, { crewClass: 'ENGINEER', rank: 'ADEPT', wageShareBp: 800 });
    await setComponent(pilot, 'RADAR', 2); // 7 points against a Tier 1 budget of 6 (7 with the Engineer)
    const loadout = json(await call(pilot, 'GET', '/ship/loadout'));
    assert.equal(loadout.ship_attributes.crew_aboard, 1);
    for (const act of [dismiss, standby]) {
      const res = await act(pilot, engineer.id);
      assert.equal(res.statusCode, 409);
      assert.deepEqual({ error: json(res).error, requiredBudget: json(res).requiredBudget, baseBudget: json(res).baseBudget }, {
        error: 'engineer_required_for_loadout', requiredBudget: 7, baseBudget: 6
      });
    }
    assert.equal(await credits(pilot), 500);
    // Stepping the component back down lets the Engineer go.
    await setComponent(pilot, 'RADAR', 1);
    assert.equal((await dismiss(pilot, engineer.id)).statusCode, 200);
  });

  test('standby charges 50 cr, frees the berth and keeps the crew member on the roster; activate brings them back', async () => {
    const pilot = await newPilot('Standby');
    await setCredits(pilot, 200);
    const member = await addCrew(pilot);
    const res = await standby(pilot, member.id);
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(json(res).credits, 150);
    assert.equal(json(res).feeCredits, 50);
    assert.equal(json(res).crew.status, 'STANDBY');
    assert.equal(tokenAttributes(res).crew_aboard, 0);
    assert.equal(await credits(pilot), 150);
    const parked = await roster(pilot);
    assert.deepEqual([parked.active.length, parked.standby.length], [0, 1]);
    assert.equal(parked.limits.freeBerths, 3);
    assert.equal((await standby(pilot, member.id)).statusCode, 409); // not aboard any more

    const back = await activate(pilot, member.id);
    assert.equal(back.statusCode, 200, back.body);
    assert.equal(tokenAttributes(back).crew_aboard, 1);
    assert.equal(await credits(pilot), 150); // no fee on the way back
    assert.equal((await activate(pilot, member.id)).statusCode, 409);
  });

  test('standby is refused without the fee, and holds at most two', async () => {
    const pilot = await newPilot('StandbyCap');
    await setCredits(pilot, 49);
    const a = await addCrew(pilot, { crewClass: 'CHEF' });
    const res = await standby(pilot, a.id);
    assert.equal(res.statusCode, 402);
    assert.equal(json(res).error, 'insufficient_credits');
    await setCredits(pilot, 500);
    await setComponent(pilot, 'HULL', 3); // three crew
    const b = await addCrew(pilot, { crewClass: 'DOCTOR' });
    const c = await addCrew(pilot, { crewClass: 'GUNNER' });
    assert.equal((await standby(pilot, a.id)).statusCode, 200);
    assert.equal((await standby(pilot, b.id)).statusCode, 200);
    const full = await standby(pilot, c.id);
    assert.equal(full.statusCode, 409);
    assert.equal(json(full).error, 'standby_full');
    assert.equal(await credits(pilot), 400);
  });

  test('activate obeys the class, hull and berth limits', async () => {
    const pilot = await newPilot('Activate');
    const parked = await addCrew(pilot, { crewClass: 'CHEF', status: 'STANDBY', spaceshipId: null });
    await addCrew(pilot, { crewClass: 'CHEF' });
    await setComponent(pilot, 'HULL', 2);
    const sameClass = await activate(pilot, parked.id);
    assert.equal(sameClass.statusCode, 409);
    assert.equal(json(sameClass).error, 'class_already_active');

    const other = await newPilot('ActivateCap');
    const second = await addCrew(other, { crewClass: 'DOCTOR', status: 'STANDBY', spaceshipId: null });
    await addCrew(other, { crewClass: 'GUNNER' });
    const capped = await activate(other, second.id);
    assert.equal(capped.statusCode, 400);
    assert.equal(json(capped).error, 'hull_crew_cap_reached');
    assert.equal(json(capped).maxCrew, 1);
  });
});

describe('revenue share', () => {
  test('deductCrewRevenueShare splits a payout by wage share, rounding the crew\'s part down', () => {
    const member = (rank, quirkId = 'Q01', id = rank) => ({ id, name: id, crewClass: 'CHEF', rank, quirkId, wageShareBp: CREW_WAGE_SHARE_BP[rank] });
    assert.deepEqual(deductCrewRevenueShare([], [], 1000), { grossCredits: 1000, crewShareCredits: 0, netCredits: 1000, crewPayouts: [] });
    const novice5 = deductCrewRevenueShare([member('NOVICE')], [], 1000);
    assert.deepEqual([novice5.grossCredits, novice5.crewShareCredits, novice5.netCredits], [1000, 50, 950]);
    assert.equal(deductCrewRevenueShare([member('NOVICE')], [], 999).crewShareCredits, 49);
    assert.equal(deductCrewRevenueShare([member('NOVICE')], [], 1).crewShareCredits, 0);
    const two = deductCrewRevenueShare([member('ADEPT'), member('MASTER')], [], 10_000);
    assert.deepEqual(two.crewPayouts.map((p) => p.shareCredits), [800, 1200]);
    assert.equal(two.netCredits, 8000);
    assert.equal(deductCrewRevenueShare([member('NOVICE')], ['C1_HARD_BARGAINER'], 10_000).crewShareCredits, 425);
  });

  test('the crew take at most MAX_TOTAL_WAGE_BP of a payout together', () => {
    const masters = Array.from({ length: 5 }, (_, i) => ({ id: `m${i}`, name: `m${i}`, crewClass: 'CHEF', rank: 'MASTER', quirkId: 'Q05', wageShareBp: 1200 }));
    // 5 x 12.5% = 62.5% asked for; capped at 50%.
    const split = deductCrewRevenueShare(masters, [], 10_000);
    assert.equal(split.crewShareCredits, MAX_TOTAL_WAGE_BP * 10_000 / 10_000);
    assert.equal(split.netCredits, 5000);
    assert.ok(split.crewPayouts.every((p) => p.shareCredits === 1000));
    assert.equal(split.crewShareCredits + split.netCredits, 10_000);
  });
});
