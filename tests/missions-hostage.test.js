import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, sign } from 'node:crypto';
import { addCrew, app, call, closeApp, dockedReceipt, json, newPilot, receiptAtOrigin, rtseKey, setCredits, signedOffer } from './helpers.js';
import {
  HOSTAGE_BASE_PENALTY, HOSTAGE_MINUTES_PER_POINT, HOSTAGE_TIME_PENALTY_CAP
} from '../src/config/missions.js';
import { LOYALIST_ABANDON_PENALTY, PERFECTIONIST_FAIL_PENALTY, QUIRKS } from '../src/config/crew.js';
import { abandonPenalty } from '../src/config/crew-morale.js';
import { generateCrewBoard } from '../src/lib/crew-generator.js';
import { canonicalClaimPayload } from '../src/lib/mission-claim.js';
import { missionOfferVersion } from '../src/lib/mission-offer.js';
import { accruedPenalty, basePenalty, disembarkPlace, hostageState } from '../src/lib/hostage.js';

before(async () => { await app.ready(); });
after(closeApp);

const MIN = 60_000;
const [LOYALIST, PERFECTIONIST, NEUTRAL] = ['Q16', 'Q15', 'Q08'];

const passage = (pilot, overrides = {}) => signedOffer(pilot, overrides);
const research = (pilot, overrides = {}) => signedOffer(pilot, { type: 'MISSION_TYPE_RESEARCH', required_berths: 0, ...overrides });
const accept = (pilot, offer) => call(pilot, 'POST', '/game/missions/accept', { offer, dockedReceipt: receiptAtOrigin(pilot, offer) });
async function hold(pilot, offer) {
  const res = await accept(pilot, offer);
  assert.equal(res.statusCode, 200, res.body);
  return json(res).active;
}
const abandon = (pilot, missionId, dockedReceipt) => call(pilot, 'POST', '/game/missions/abandon', { missionId, dockedReceipt });
const disembark = (pilot, missionId, receipt = dockedReceipt(pilot)) =>
  call(pilot, 'POST', '/game/missions/disembark', { missionId, dockedReceipt: receipt });
const aboard = async (pilot) => json(await call(pilot, 'GET', '/ship/loadout')).ship_attributes.passengers_aboard;
const tokenAboard = (res) => app.jwt.verify(json(res).token).ship_attributes.passengers_aboard;
const standingOf = async (pilot, factionId) =>
  (await app.prisma.playerReputation.findUnique({ where: { playerId_factionId: { playerId: pilot.id, factionId } } }))?.standing ?? 0;
const abandonedRow = (pilot, missionId) => app.prisma.abandonedMission.findUnique({ where: { playerId_missionId: { playerId: pilot.id, missionId } } });
const crewRow = (crew) => app.prisma.crewMember.findUnique({ where: { id: crew.id } });
const setMorale = (crew, morale) => app.prisma.crewMember.update({ where: { id: crew.id }, data: { morale } });
// Starts the hostage state `agoMs` in the past, so a disembark now owes that much time penalty.
const hostageSince = (pilot, missionId, agoMs) =>
  app.prisma.abandonedMission.update({
    where: { playerId_missionId: { playerId: pilot.id, missionId } },
    data: { abandonedAt: new Date(Date.now() - agoMs) }
  });
// Raises the pilot's hull and life support: tier 2 gives six berths and room for two crew.
async function setTier2(pilot) {
  await call(pilot, 'GET', '/ship/loadout');
  const ship = await app.prisma.spaceship.findFirst({ where: { playerId: pilot.id, active: true } });
  for (const type of ['HULL', 'LIFE_SUPPORT']) {
    await app.prisma.shipComponentRecord.update({ where: { spaceshipId_type: { spaceshipId: ship.id, type } }, data: { tier: 2 } });
  }
}

// Holds a passage, then abandons it in flight: the pilot is left with its passengers as hostages.
async function holdHostages(pilot, overrides = {}) {
  const offer = passage(pilot, overrides);
  const active = await hold(pilot, offer);
  const res = await abandon(pilot, active.mission_id);
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(json(res).outcome, 'MISSION_ABANDON_OUTCOME_HOSTAGE');
  return offer;
}

describe('the hostage numbers', () => {
  test('pin the penalties', () => {
    assert.deepEqual({ ...HOSTAGE_BASE_PENALTY }, {
      DISEMBARK_PLACE_DESTINATION: 10, DISEMBARK_PLACE_ORIGIN: 12, DISEMBARK_PLACE_ELSEWHERE: 20
    });
    assert.deepEqual([HOSTAGE_MINUTES_PER_POINT, HOSTAGE_TIME_PENALTY_CAP], [2, 60]);
    assert.deepEqual([PERFECTIONIST_FAIL_PENALTY, LOYALIST_ABANDON_PENALTY], [8, 8]);
  });

  test('the time penalty is a point per two whole minutes, capped at 60', () => {
    assert.deepEqual([0, 1, 2, 3, 4, 59, 60, 119, 120, 121, 10_000].map(accruedPenalty), [0, 0, 1, 1, 2, 29, 30, 59, 60, 60, 60]);
  });

  test('the place is the destination first, then the origin, else elsewhere', () => {
    const row = { originStationId: 'o', originSystemH3: 'oh', destinationStationId: 'd', destinationSystemH3: 'dh' };
    assert.equal(disembarkPlace(row, { dockedEntityId: 'd', systemH3: 'dh' }), 'DISEMBARK_PLACE_DESTINATION');
    assert.equal(disembarkPlace(row, { dockedEntityId: 'o', systemH3: 'oh' }), 'DISEMBARK_PLACE_ORIGIN');
    assert.equal(disembarkPlace(row, { dockedEntityId: 'o', systemH3: 'dh' }), 'DISEMBARK_PLACE_ELSEWHERE');
    assert.equal(disembarkPlace(row, { dockedEntityId: 'x', systemH3: 'oh' }), 'DISEMBARK_PLACE_ELSEWHERE');
    // A station at both ends is the destination, and an unrecorded destination is never matched by ''.
    assert.equal(disembarkPlace({ ...row, originStationId: 'd', originSystemH3: 'dh' }, { dockedEntityId: 'd', systemH3: 'dh' }), 'DISEMBARK_PLACE_DESTINATION');
    assert.equal(disembarkPlace({ ...row, destinationStationId: null, destinationSystemH3: null }, { dockedEntityId: '', systemH3: '' }), 'DISEMBARK_PLACE_ELSEWHERE');
    assert.deepEqual(['DESTINATION', 'ORIGIN', 'ELSEWHERE'].map((p) => basePenalty(`DISEMBARK_PLACE_${p}`)), [10, 12, 20]);
  });

  test('the state reports the accrual as of a time', () => {
    const row = { missionId: 'm', abandonedAt: new Date(1_000_000), hostageBerths: 2 };
    assert.deepEqual(hostageState(row, 1_000_000 + 7 * MIN + 30_000), {
      mission_id: 'm', hostage_started_at_ms: 1_000_000, accrued_penalty: 3, as_of_ms: 1_000_000 + 7 * MIN + 30_000, required_berths: 2
    });
    assert.equal(hostageState(row, 1_000_000 - 5).accrued_penalty, 0);
  });

  test('only PERFECTIONIST and a LOYALIST of the sponsor lose morale on an abandon', () => {
    const member = (quirkId) => ({ quirkId, homeFactionId: 'alpha' });
    assert.deepEqual(abandonPenalty(member(PERFECTIONIST), 'beta'), { quirk: 'PERFECTIONIST', moraleLoss: 8 });
    assert.deepEqual(abandonPenalty(member(LOYALIST), 'alpha'), { quirk: 'LOYALIST', moraleLoss: 8 });
    assert.equal(abandonPenalty(member(LOYALIST), 'beta'), null);
    assert.equal(abandonPenalty(member(NEUTRAL), 'alpha'), null);
    assert.equal(QUIRKS[LOYALIST].betrayalPenalty, 12);
  });
});

describe('abandon morale', () => {
  const abandonWith = async (quirkId, factionId, { abandonReceipt } = {}) => {
    const pilot = await newPilot('Quitter');
    const crew = await addCrew(pilot, { crewClass: 'PILOT', quirkId, homeFactionId: 'alpha' });
    const active = await hold(pilot, research(pilot, { faction_id: factionId }));
    await setMorale(crew, 75);
    const res = await abandon(pilot, active.mission_id, abandonReceipt?.(pilot));
    assert.equal(res.statusCode, 200, res.body);
    return { body: json(res), morale: (await crewRow(crew)).morale, crew };
  };

  test('a PERFECTIONIST loses 8 on any abandoned mission', async () => {
    for (const factionId of ['alpha', 'beta']) {
      const { body, morale, crew } = await abandonWith(PERFECTIONIST, factionId);
      assert.equal(morale, 67);
      assert.deepEqual(body.crew_morale, [{
        crewId: crew.id, crewClass: 'PILOT', moraleBefore: 75, morale: 67, moraleBand: body.crew_morale[0].moraleBand,
        quirkEffects: [{ quirk: 'PERFECTIONIST', effect: 'MISSION_ABANDONED', moraleLoss: 8 }]
      }]);
    }
  });

  test('a LOYALIST loses 8 when the mission was sponsored by its home faction, and nothing otherwise', async () => {
    const home = await abandonWith(LOYALIST, 'alpha');
    assert.equal(home.morale, 67);
    assert.deepEqual(home.body.crew_morale[0].quirkEffects, [{ quirk: 'LOYALIST', effect: 'MISSION_ABANDONED', moraleLoss: 8 }]);
    const other = await abandonWith(LOYALIST, 'beta');
    assert.equal(other.morale, 75);
    assert.equal(other.body.crew_morale, undefined);
  });

  test('other crew keep their morale, and a resigned member is not charged', async () => {
    const plain = await abandonWith(NEUTRAL, 'alpha');
    assert.equal(plain.morale, 75);
    assert.equal(plain.body.crew_morale, undefined);

    const pilot = await newPilot('Resigned');
    const resigned = await addCrew(pilot, { crewClass: 'PILOT', quirkId: PERFECTIONIST, morale: 0 });
    const active = await hold(pilot, research(pilot));
    await setMorale(resigned, 0);
    assert.equal((await abandon(pilot, active.mission_id)).statusCode, 200);
    assert.equal((await crewRow(resigned)).morale, 0);
  });

  test('a hostage abandon and an abandon in port charge the same morale', async () => {
    const pilot = await newPilot('Hostager');
    const crew = await addCrew(pilot, { crewClass: 'PILOT', quirkId: PERFECTIONIST });
    const active = await hold(pilot, passage(pilot));
    await setMorale(crew, 75);
    const res = await abandon(pilot, active.mission_id);
    assert.equal(json(res).outcome, 'MISSION_ABANDON_OUTCOME_HOSTAGE');
    assert.equal((await crewRow(crew)).morale, 67);
  });
});

describe('abandoning a passage away from its origin', () => {
  test('keeps the passengers aboard as hostages and charges nothing yet', async () => {
    const pilot = await newPilot('Hostage');
    const offer = passage(pilot);
    const active = await hold(pilot, offer);
    const before = Date.now();
    const res = await abandon(pilot, active.mission_id);
    assert.equal(res.statusCode, 200, res.body);
    const body = json(res);
    assert.equal(body.outcome, 'MISSION_ABANDON_OUTCOME_HOSTAGE');
    assert.equal(body.reputation_change, 0);
    assert.deepEqual(body.standings, {});
    assert.equal(body.hostage.mission_id, offer.mission_id);
    assert.equal(body.hostage.required_berths, 2);
    assert.equal(body.hostage.accrued_penalty, 0);
    assert.ok(body.hostage.hostage_started_at_ms >= before && body.hostage.hostage_started_at_ms <= body.hostage.as_of_ms);
    assert.equal(tokenAboard(res), 2);
    assert.equal(await aboard(pilot), 2);
    assert.equal((await call(pilot, 'GET', `/game/missions/cooldown?originId=${offer.origin_station_id}`).then(json)).active, false);

    const row = await abandonedRow(pilot, offer.mission_id);
    assert.equal(row.reason, 'in_flight');
    assert.equal(row.hostageBerths, 2);
    assert.equal(row.reputationLoss, 0);
    assert.equal(row.originSystemH3, offer.origin_system_h3);
    assert.equal(row.destinationStationId, offer.destination_station_id);
    assert.equal(row.destinationSystemH3, offer.destination_system_h3);
    assert.equal(row.abandonedAt.getTime(), body.hostage.hostage_started_at_ms);
  });

  test('docked at another station it is a hostage state too, and at its origin it is not', async () => {
    const pilot = await newPilot('Dockers');
    const offer = passage(pilot, { required_berths: 1 });
    const active = await hold(pilot, offer);
    const elsewhere = await abandon(pilot, active.mission_id, dockedReceipt(pilot));
    assert.equal(json(elsewhere).outcome, 'MISSION_ABANDON_OUTCOME_HOSTAGE');
    assert.equal((await abandonedRow(pilot, offer.mission_id)).reason, 'in_port_dock');
    assert.equal(await aboard(pilot), 1);

    const home = passage(pilot, { required_berths: 1 });
    const held = await hold(pilot, home);
    const res = await abandon(pilot, held.mission_id, receiptAtOrigin(pilot, home));
    assert.equal(json(res).outcome, 'MISSION_ABANDON_OUTCOME_CANCELLED');
    assert.equal(json(res).hostage, undefined);
    assert.equal(json(res).reputation_change, -2);
    assert.equal((await abandonedRow(pilot, home.mission_id)).hostageBerths, 0);
    assert.equal(await aboard(pilot), 1);
  });

  test('a research or gather abandon still unboards, and no other type is ever a hostage', async () => {
    const pilot = await newPilot('Surveyor');
    const active = await hold(pilot, research(pilot, { required_berths: 1 }));
    assert.equal(await aboard(pilot), 1);
    const res = await abandon(pilot, active.mission_id);
    assert.equal(json(res).outcome, 'MISSION_ABANDON_OUTCOME_CANCELLED');
    assert.equal(tokenAboard(res), 0);
  });

  test('the hostages are listed on the active missions with their accrued penalty, until dropped', async () => {
    const pilot = await newPilot('Lister');
    assert.equal(json(await call(pilot, 'GET', '/game/missions/active')).hostages, undefined);
    const offer = await holdHostages(pilot);
    await hostageSince(pilot, offer.mission_id, 11 * MIN + 5_000);
    const [state] = json(await call(pilot, 'GET', '/game/missions/active')).hostages;
    assert.equal(state.mission_id, offer.mission_id);
    assert.equal(state.accrued_penalty, 5);
    assert.equal(state.required_berths, 2);
    assert.ok(state.as_of_ms - state.hostage_started_at_ms >= 11 * MIN);
    assert.equal((await disembark(pilot, offer.mission_id)).statusCode, 200);
    assert.equal(json(await call(pilot, 'GET', '/game/missions/active')).hostages, undefined);
  });

  test('other missions come and go around the hostages without freeing their berths', async () => {
    const pilot = await newPilot('Around');
    await setTier2(pilot);
    const first = await holdHostages(pilot, { required_berths: 2 });
    const second = passage(pilot, { required_berths: 1 });
    const active = await hold(pilot, second);
    assert.equal(await aboard(pilot), 3);
    const res = await abandon(pilot, active.mission_id, receiptAtOrigin(pilot, second));
    assert.equal(tokenAboard(res), 2);
    assert.equal(await aboard(pilot), 2);
    assert.equal((await abandonedRow(pilot, first.mission_id)).hostageBerths, 2);
  });

  test('the hostages cannot be abandoned twice, and the mission cannot be taken again', async () => {
    const pilot = await newPilot('Twice');
    const offer = await holdHostages(pilot);
    assert.equal((await abandon(pilot, offer.mission_id)).statusCode, 404);
    const again = await accept(pilot, offer);
    assert.equal(again.statusCode, 409);
    assert.equal(json(again).code, 'mission_abandoned');
  });
});

describe('hostage berths block new crew', () => {
  const stationAt = (i) => `00000000-0000-4000-8000-${i.toString(16).padStart(12, '0')}`;
  const novice = (candidates) => candidates.filter((c) => c.rank === 'NOVICE');
  function findStation() {
    for (let i = 0; i < 20_000; i++) {
      const { candidates } = generateCrewBoard(stationAt(i), Date.now());
      const n = novice(candidates);
      if (n.length >= 2 && n[0].crewClass !== n[1].crewClass) return { stationId: stationAt(i), candidates: n };
    }
    throw new Error('no station with a suitable board');
  }
  const hire = (pilot, stationId, candidateId) =>
    call(pilot, 'POST', '/game/crew/hire', { candidateId, dockedReceipt: dockedReceipt(pilot, { dockedEntityId: stationId }) });

  test('hostages hold their berths until the disembark frees them (ASSERT-5.2.3)', async () => {
    const { stationId, candidates: [first, second] } = findStation();
    const pilot = await newPilot('Berthed');
    await setCredits(pilot, 20_000);
    // A six-berth ship with five hostages aboard has one berth left for the crew.
    await setTier2(pilot);
    const offer = await holdHostages(pilot, { required_berths: 5 });
    assert.equal(await aboard(pilot), 5);

    assert.equal((await hire(pilot, stationId, first.candidateId)).statusCode, 200);
    const refused = await hire(pilot, stationId, second.candidateId);
    assert.equal(refused.statusCode, 400);
    assert.equal(json(refused).error, 'insufficient_free_berths');
    assert.equal(await app.prisma.crewMember.count({ where: { playerId: pilot.id } }), 1);

    assert.equal((await disembark(pilot, offer.mission_id)).statusCode, 200);
    assert.equal((await hire(pilot, stationId, second.candidateId)).statusCode, 200);
    assert.equal(await app.prisma.crewMember.count({ where: { playerId: pilot.id } }), 2);
  });

  test('they also block accepting a mission that needs the berths', async () => {
    const pilot = await newPilot('Full');
    await holdHostages(pilot, { required_berths: 2 });
    const next = passage(pilot, { required_berths: 2 });
    const res = await accept(pilot, next);
    assert.equal(res.statusCode, 400);
    assert.equal(json(res).code, 'insufficient_berths');
  });
});

describe('POST /game/missions/disembark', () => {
  const at = (pilot, stationId, systemH3) => dockedReceipt(pilot, { dockedEntityId: stationId, systemH3 });

  test('requires authentication and a mission id', async () => {
    assert.equal((await app.inject({ method: 'POST', url: '/game/missions/disembark', payload: { missionId: randomUUID() } })).statusCode, 401);
    const pilot = await newPilot('NoId');
    assert.equal((await call(pilot, 'POST', '/game/missions/disembark', { dockedReceipt: dockedReceipt(pilot) })).statusCode, 400);
    assert.equal((await disembark(pilot, 'not-an-id')).statusCode, 400);
  });

  test('at the destination: base 10, the sponsor pays, the berths free and the receipt docks the crew', async () => {
    const pilot = await newPilot('Dest');
    await addCrew(pilot, { crewClass: 'PILOT' });
    const offer = await holdHostages(pilot);
    const res = await disembark(pilot, offer.mission_id, at(pilot, offer.destination_station_id, offer.destination_system_h3));
    assert.equal(res.statusCode, 200, res.body);
    const body = json(res);
    assert.equal(body.result, 'DISEMBARK_RESULT_SUCCESS');
    assert.equal(body.mission_id, offer.mission_id);
    assert.equal(body.place, 'DISEMBARK_PLACE_DESTINATION');
    assert.equal(body.base_penalty, 10);
    assert.equal(body.time_penalty, 0);
    assert.equal(body.reputation_change, -10);
    assert.deepEqual(body.standings, { 'faction-high': -10 });
    assert.equal(body.docking.applied, true);
    assert.equal(tokenAboard(res), 0);
    assert.equal(await aboard(pilot), 0);
    assert.equal(await standingOf(pilot, 'faction-high'), -10);

    const row = await abandonedRow(pilot, offer.mission_id);
    assert.deepEqual([row.hostageBerths, row.reputationLoss, row.reason, row.hostageMinutes], [0, -10, 'hostage_returned', 0]);
    const ledger = await app.prisma.reputationLedger.findMany({ where: { playerId: pilot.id, reason: 'HOSTAGE_DISEMBARKED' } });
    assert.deepEqual(ledger.map((e) => [e.missionId, e.factionId, e.factionDelta]), [[offer.mission_id, 'faction-high', -10]]);
  });

  test('at the origin the base is 12, anywhere else 20', async () => {
    const pilot = await newPilot('Places');
    const origin = await holdHostages(pilot, { required_berths: 1 });
    const res = await disembark(pilot, origin.mission_id, receiptAtOrigin(pilot, origin));
    assert.equal(json(res).place, 'DISEMBARK_PLACE_ORIGIN');
    assert.equal(json(res).base_penalty, 12);
    assert.equal(json(res).reputation_change, -12);

    const away = await holdHostages(pilot, { required_berths: 1 });
    const there = await disembark(pilot, away.mission_id);
    assert.equal(json(there).place, 'DISEMBARK_PLACE_ELSEWHERE');
    assert.equal(json(there).reputation_change, -20);
    // The right station in another system is another dock.
    const other = await holdHostages(pilot, { required_berths: 1 });
    const wrongSystem = await disembark(pilot, other.mission_id, at(pilot, other.destination_station_id, '8828308281fffff'));
    assert.equal(json(wrongSystem).place, 'DISEMBARK_PLACE_ELSEWHERE');
    assert.equal(await standingOf(pilot, 'faction-high'), -12 - 20 - 20);
  });

  test('the time penalty is 0.5 a minute since the abandon, capped at 60', async () => {
    const cases = [[0, 0], [1 * MIN + 30_000, 0], [10 * MIN, 5], [59 * MIN + 59_000, 29], [120 * MIN, 60], [24 * 60 * MIN, 60]];
    for (const [agoMs, time] of cases) {
      const pilot = await newPilot('Clock');
      const offer = await holdHostages(pilot, { required_berths: 1 });
      await hostageSince(pilot, offer.mission_id, agoMs);
      const res = await disembark(pilot, offer.mission_id, at(pilot, offer.destination_station_id, offer.destination_system_h3));
      assert.equal(res.statusCode, 200, res.body);
      assert.equal(json(res).time_penalty, time, `${agoMs} ms`);
      assert.equal(json(res).reputation_change, -(10 + time));
      assert.equal(json(res).hostage_minutes, Math.floor(agoMs / MIN));
      assert.equal(await standingOf(pilot, 'faction-high'), -(10 + time));
      const row = await abandonedRow(pilot, offer.mission_id);
      assert.deepEqual([row.reputationLoss, row.hostageMinutes], [-(10 + time), Math.floor(agoMs / MIN)]);
    }
  });

  test('drops only the hostages and the passengers of other missions stay aboard', async () => {
    const pilot = await newPilot('Mixed');
    await setTier2(pilot);
    const hostages = await holdHostages(pilot, { required_berths: 2 });
    await hold(pilot, passage(pilot, { required_berths: 3 }));
    assert.equal(await aboard(pilot), 5);
    const res = await disembark(pilot, hostages.mission_id);
    assert.equal(tokenAboard(res), 3);
    assert.equal(await aboard(pilot), 3);
  });

  describe('on a faction sponsor', () => {
    const colorsOf = async (pilot) => (await app.prisma.player.findUnique({ where: { id: pilot.id } })).activeColorsFactionId;
    const setStanding = (pilot, factionId, standing) =>
      app.prisma.playerReputation.upsert({
        where: { playerId_factionId: { playerId: pilot.id, factionId } }, update: { standing }, create: { playerId: pilot.id, factionId, standing }
      });

    test('the loss lowers the standing and the ledger records it', async () => {
      const pilot = await newPilot('Faction');
      await setStanding(pilot, 'alpha', 100);
      const offer = await holdHostages(pilot, { faction_id: 'alpha', required_berths: 1 });
      const res = await disembark(pilot, offer.mission_id);
      assert.equal(res.statusCode, 200, res.body);
      assert.equal(await standingOf(pilot, 'alpha'), 80);
      assert.equal(json(res).standings.alpha, 80);
    });

    test('a standing that falls below 500 stops the Flying Colors, in the database and in the reissued token', async () => {
      const pilot = await newPilot('Colors');
      await setStanding(pilot, 'alpha', 505);
      await app.prisma.player.update({ where: { id: pilot.id }, data: { activeColorsFactionId: 'alpha' } });
      const offer = await holdHostages(pilot, { faction_id: 'alpha', required_berths: 1 });
      assert.equal(await colorsOf(pilot), 'alpha');
      const res = await disembark(pilot, offer.mission_id);
      assert.equal(res.statusCode, 200, res.body);
      assert.equal(json(res).reputation_change, -20);
      assert.equal(await standingOf(pilot, 'alpha'), 485);
      assert.equal(await colorsOf(pilot), null);
      assert.deepEqual(app.jwt.verify(json(res).token).factions, { alpha: 485, beta: 0, gamma: 0, active_colors: null });
    });

    test('the standing never falls below -1000', async () => {
      const pilot = await newPilot('Floor');
      await setStanding(pilot, 'alpha', -990);
      const offer = await holdHostages(pilot, { faction_id: 'alpha', required_berths: 1 });
      const res = await disembark(pilot, offer.mission_id);
      assert.equal(res.statusCode, 200, res.body);
      assert.equal(await standingOf(pilot, 'alpha'), -1000);
      assert.equal(json(res).standings.alpha, -1000);
      assert.equal(app.jwt.verify(json(res).token).factions.alpha, -1000);
    });
  });

  describe('with a receipt for a dock already recorded', () => {
    // A receipt's `dockedAtMs` is fixed for a docking session, so a second action at that dock reuses it.
    const claimFor = (pilot, active) => {
      const claim = {
        missionId: active.mission_id, playerShipId: pilot.id, destinationStationId: active.offer.destination_station_id,
        acceptedAtMs: active.accepted_at_ms, completedAtMs: active.accepted_at_ms + 60_000, durationTakenMs: 60_000,
        rewardCredits: active.offer.reward_credits, reputationChange: active.offer.reputation_change,
        wasDetected: false, exposureScoreMilli: 0, opposedReputationChange: 0, bribePaidCredits: 0
      };
      claim.signature = sign(null, canonicalClaimPayload(claim, false, missionOfferVersion(active.offer)), rtseKey).toString('base64');
      return claim;
    };

    test('disembarking at the dock where the passage was abandoned answers instead of failing after it committed', async () => {
      const pilot = await newPilot('Samedock');
      const offer = passage(pilot, { required_berths: 1 });
      const active = await hold(pilot, offer);
      const receipt = dockedReceipt(pilot);
      const abandoned = await abandon(pilot, active.mission_id, receipt);
      assert.equal(abandoned.statusCode, 200, abandoned.body);
      assert.equal(json(abandoned).docking.applied, true);

      const res = await disembark(pilot, offer.mission_id, receipt);
      assert.equal(res.statusCode, 200, res.body);
      assert.equal(json(res).docking, undefined);
      assert.equal(json(res).departed_crew, undefined);
      assert.equal(json(res).reputation_change, -20);
      assert.equal(tokenAboard(res), 0);
      assert.equal((await abandonedRow(pilot, offer.mission_id)).reason, 'hostage_returned');
    });

    test('cancelling a passage at the origin it was accepted at answers too', async () => {
      const pilot = await newPilot('Samehome');
      const offer = passage(pilot, { required_berths: 1 });
      const receipt = receiptAtOrigin(pilot, offer);
      const accepted = await call(pilot, 'POST', '/game/missions/accept', { offer, dockedReceipt: receipt });
      assert.equal(accepted.statusCode, 200, accepted.body);
      const res = await abandon(pilot, offer.mission_id, receipt);
      assert.equal(res.statusCode, 200, res.body);
      assert.equal(json(res).outcome, 'MISSION_ABANDON_OUTCOME_CANCELLED');
      assert.equal(json(res).docking, undefined);
      assert.equal(tokenAboard(res), 0);
    });

    test('completing a mission at the dock it was accepted at answers too', async () => {
      const pilot = await newPilot('Samedone');
      const offer = research(pilot);
      const receipt = receiptAtOrigin(pilot, offer);
      const accepted = await call(pilot, 'POST', '/game/missions/accept', { offer, dockedReceipt: receipt });
      assert.equal(accepted.statusCode, 200, accepted.body);
      const res = await call(pilot, 'POST', '/game/missions/complete', { claim: claimFor(pilot, json(accepted).active), dockedReceipt: receipt });
      assert.equal(res.statusCode, 200, res.body);
      assert.equal(json(res).docking, undefined);
      assert.equal(json(res).success, true);
    });
  });

  test('a second disembark, a held mission and a mission cancelled in port are NOT_HOSTAGE', async () => {
    const pilot = await newPilot('Replay');
    const offer = await holdHostages(pilot, { required_berths: 1 });
    assert.equal((await disembark(pilot, offer.mission_id)).statusCode, 200);
    const replay = await disembark(pilot, offer.mission_id);
    assert.equal(replay.statusCode, 409);
    assert.equal(json(replay).result, 'DISEMBARK_RESULT_NOT_HOSTAGE');
    assert.equal(await standingOf(pilot, 'faction-high'), -20);

    const held = await hold(pilot, research(pilot));
    assert.equal(json(await disembark(pilot, held.mission_id)).result, 'DISEMBARK_RESULT_NOT_HOSTAGE');
    assert.equal((await disembark(pilot, held.mission_id)).statusCode, 409);

    const home = passage(pilot, { required_berths: 1 });
    const cancelled = await hold(pilot, home);
    await abandon(pilot, cancelled.mission_id, receiptAtOrigin(pilot, home));
    assert.equal(json(await disembark(pilot, home.mission_id)).result, 'DISEMBARK_RESULT_NOT_HOSTAGE');
  });

  test('an unknown mission, or another pilot\'s, is UNKNOWN_MISSION', async () => {
    const pilot = await newPilot('Owner');
    const offer = await holdHostages(pilot);
    const stranger = await newPilot('Stranger');
    for (const [who, id] of [[pilot, randomUUID()], [stranger, offer.mission_id]]) {
      const res = await disembark(who, id);
      assert.equal(res.statusCode, 404);
      assert.equal(json(res).result, 'DISEMBARK_RESULT_UNKNOWN_MISSION');
    }
    assert.equal(await aboard(pilot), 2);
  });

  test('a signed receipt is required, and a refused one changes nothing', async () => {
    const pilot = await newPilot('Receipt');
    const offer = await holdHostages(pilot);
    const other = await newPilot('Forger');
    const missing = await call(pilot, 'POST', '/game/missions/disembark', { missionId: offer.mission_id });
    assert.equal(missing.statusCode, 403);
    assert.equal(json(missing).code, 'docked_receipt_required');
    assert.equal(json(missing).result, 'DISEMBARK_RESULT_RECEIPT_INVALID');

    for (const [receipt, code, result] of [
      [dockedReceipt(other), 'docked_receipt_invalid', 'DISEMBARK_RESULT_RECEIPT_INVALID'],
      [dockedReceipt(pilot, { signature: Buffer.alloc(64, 7).toString('base64') }), 'docked_receipt_invalid', 'DISEMBARK_RESULT_RECEIPT_INVALID'],
      [dockedReceipt(pilot, { issuedAtMs: Date.now() - 10 * MIN, dockedAtMs: Date.now() - 11 * MIN }), 'docked_receipt_expired', 'DISEMBARK_RESULT_RECEIPT_EXPIRED']
    ]) {
      const res = await disembark(pilot, offer.mission_id, receipt);
      assert.equal(res.statusCode, 403, res.body);
      assert.equal(json(res).code, code);
      assert.equal(json(res).result, result);
    }
    assert.equal(await aboard(pilot), 2);
    assert.equal(await standingOf(pilot, 'faction-high'), 0);
    assert.equal((await abandonedRow(pilot, offer.mission_id)).hostageBerths, 2);

    const configured = app.claimKey;
    app.claimKey = null;
    try {
      const res = await disembark(pilot, offer.mission_id);
      assert.equal(res.statusCode, 503);
      assert.equal(json(res).error, 'CLAIM_KEY_NOT_CONFIGURED');
    } finally {
      app.claimKey = configured;
    }
    assert.equal(await aboard(pilot), 2);
  });
});
