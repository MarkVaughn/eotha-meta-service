import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import app from '../src/app.js';
import { generateMissions, findMissionOffer, computePayout } from '../src/config/missions.js';

const FIXED_NOW = new Date('2026-01-01T12:00:00Z');

describe('procedural mission generation', () => {
  test('is deterministic for the same station/node/hour/capacity', () => {
    const params = { stationId: 'station-a', stationNode: '8828308281fffff', passengerCapacity: 4, now: FIXED_NOW };
    const first = generateMissions(params);
    const second = generateMissions(params);
    assert.deepEqual(first, second);
    assert.ok(first.length >= 1 && first.length <= 3);
  });

  test('differs across stations and across hours', () => {
    const base = { stationId: 'station-a', stationNode: '8828308281fffff', passengerCapacity: 4, now: FIXED_NOW };
    const otherStation = generateMissions({ ...base, stationId: 'station-b' });
    const otherHour = generateMissions({ ...base, now: new Date(FIXED_NOW.getTime() + 3_600_000) });
    const original = generateMissions(base);
    assert.notDeepEqual(original, otherStation);
    assert.notDeepEqual(original, otherHour);
  });

  test('zero passenger capacity yields no missions', () => {
    assert.deepEqual(generateMissions({ stationId: 'station-a', stationNode: 'node-1', passengerCapacity: 0, now: FIXED_NOW }), []);
    assert.deepEqual(generateMissions({ stationId: 'station-a', stationNode: 'node-1', passengerCapacity: -1, now: FIXED_NOW }), []);
  });

  test('party size never exceeds passenger capacity, distance stays in bounds', () => {
    for (const capacity of [1, 2, 5, 20]) {
      const missions = generateMissions({ stationId: 'station-x', stationNode: 'node-x', passengerCapacity: capacity, now: FIXED_NOW });
      for (const mission of missions) {
        assert.ok(mission.passengers >= 1 && mission.passengers <= capacity);
        const [min, max] = mission.type === 'ONE_WAY_PASSAGE' ? [2, 8] : [2, 6];
        assert.ok(mission.distanceHexes >= min && mission.distanceHexes <= max);
      }
    }
  });

  test('findMissionOffer re-derives the same mission by id', () => {
    const missions = generateMissions({ stationId: 'station-a', stationNode: 'node-1', passengerCapacity: 3, now: FIXED_NOW });
    const target = missions[0];
    const offer = findMissionOffer(target.missionId, 3);
    assert.deepEqual(offer, target);
  });
});

describe('computePayout', () => {
  test('awards no bonus when exactly on pace or slower', () => {
    assert.equal(computePayout({ basePayout: 100, expectedSeconds: 60, elapsedSeconds: 60 }).bonus, 0);
    assert.equal(computePayout({ basePayout: 100, expectedSeconds: 60, elapsedSeconds: 90 }).bonus, 0);
  });

  test('awards a bonus scaling with how far ahead of pace completion was', () => {
    const halfTime = computePayout({ basePayout: 100, expectedSeconds: 60, elapsedSeconds: 30 });
    assert.equal(halfTime.bonus, 25); // 100 * 0.5 * 0.5
    assert.equal(halfTime.payout, 125);
  });
});

describe('missions API', () => {
  let token;
  let headers;

  before(async () => {
    await app.ready();
    const res = await app.inject({ method: 'GET', url: '/auth/dev-login?callsign=Courier' });
    token = JSON.parse(res.body).token;
    headers = { authorization: `Bearer ${token}` };
  });
  after(async () => { await app.close(); });

  test('requires auth', async () => {
    const res = await app.inject({ method: 'GET', url: '/game/missions/available?stationId=s1&stationNode=n1' });
    assert.equal(res.statusCode, 401);
  });

  test('rejects available requests missing query params', async () => {
    const res = await app.inject({ method: 'GET', url: '/game/missions/available', headers });
    assert.equal(res.statusCode, 400);
  });

  test('full charter lifecycle: available -> accept -> active -> complete -> cooldown', async () => {
    const stationId = 'outpost-7';
    const stationNode = 'node-42';

    const availableRes = await app.inject({ method: 'GET', url: `/game/missions/available?stationId=${stationId}&stationNode=${stationNode}`, headers });
    assert.equal(availableRes.statusCode, 200);
    const board = JSON.parse(availableRes.body);
    assert.equal(board.cooldown.active, false);
    assert.ok(board.passengerCapacity > 0);
    assert.ok(board.missions.length >= 1 && board.missions.length <= 3);

    const offer = board.missions[0];

    // A second mission is rejected once one is already active.
    const acceptRes = await app.inject({ method: 'POST', url: '/game/missions/accept', headers, payload: { missionId: offer.missionId } });
    assert.equal(acceptRes.statusCode, 200);
    const accepted = JSON.parse(acceptRes.body);
    assert.equal(accepted.missionId, offer.missionId);

    const secondOffer = board.missions[board.missions.length - 1];
    const secondAcceptRes = await app.inject({ method: 'POST', url: '/game/missions/accept', headers, payload: { missionId: secondOffer.missionId } });
    assert.equal(secondAcceptRes.statusCode, 409);

    const activeRes = await app.inject({ method: 'GET', url: '/game/missions/active', headers });
    assert.equal(JSON.parse(activeRes.body).mission.missionId, offer.missionId);

    // Completing at the wrong location is rejected.
    const badCompleteRes = await app.inject({
      method: 'POST',
      url: '/game/missions/complete',
      headers,
      payload: { missionId: offer.missionId, currentStationId: 'nowhere', currentStationNode: 'nowhere-node', elapsedSeconds: 10 }
    });
    assert.equal(badCompleteRes.statusCode, 400);

    const destinationStationId = accepted.roundTrip ? accepted.originStationId : accepted.destination.stationId;
    const destinationStationNode = accepted.roundTrip ? accepted.originStationNode : accepted.destination.node;

    const creditsBefore = JSON.parse((await app.inject({ method: 'GET', url: '/game/credits', headers })).body).credits;

    const completeRes = await app.inject({
      method: 'POST',
      url: '/game/missions/complete',
      headers,
      payload: {
        missionId: offer.missionId,
        currentStationId: destinationStationId,
        currentStationNode: destinationStationNode,
        elapsedSeconds: 1
      }
    });
    assert.equal(completeRes.statusCode, 200);
    const completion = JSON.parse(completeRes.body);
    assert.ok(completion.payout >= accepted.basePayout);

    const creditsAfter = JSON.parse((await app.inject({ method: 'GET', url: '/game/credits', headers })).body).credits;
    assert.equal(creditsAfter, creditsBefore + completion.payout);

    // Active mission is cleared.
    const activeAfter = JSON.parse((await app.inject({ method: 'GET', url: '/game/missions/active', headers })).body);
    assert.equal(activeAfter.mission, null);

    // Station is now on cooldown; no offers until it lapses.
    const cooldownBoardRes = await app.inject({ method: 'GET', url: `/game/missions/available?stationId=${stationId}&stationNode=${stationNode}`, headers });
    const cooldownBoard = JSON.parse(cooldownBoardRes.body);
    assert.equal(cooldownBoard.cooldown.active, true);
    assert.deepEqual(cooldownBoard.missions, []);
  });

  test('abandoning an active mission frees the slot without a cooldown', async () => {
    const stationId = 'outpost-9';
    const stationNode = 'node-99';

    const board = JSON.parse((await app.inject({ method: 'GET', url: `/game/missions/available?stationId=${stationId}&stationNode=${stationNode}`, headers })).body);
    const offer = board.missions[0];

    await app.inject({ method: 'POST', url: '/game/missions/accept', headers, payload: { missionId: offer.missionId } });

    const abandonRes = await app.inject({ method: 'POST', url: '/game/missions/abandon', headers });
    assert.equal(abandonRes.statusCode, 200);
    assert.equal(JSON.parse(abandonRes.body).missionId, offer.missionId);

    const activeAfter = JSON.parse((await app.inject({ method: 'GET', url: '/game/missions/active', headers })).body);
    assert.equal(activeAfter.mission, null);

    const boardAfter = JSON.parse((await app.inject({ method: 'GET', url: `/game/missions/available?stationId=${stationId}&stationNode=${stationNode}`, headers })).body);
    assert.equal(boardAfter.cooldown.active, false);

    // Accepting again works immediately.
    const reacceptRes = await app.inject({ method: 'POST', url: '/game/missions/accept', headers, payload: { missionId: offer.missionId } });
    assert.equal(reacceptRes.statusCode, 200);

    // Clean up so the next test starts with no active mission.
    await app.inject({ method: 'POST', url: '/game/missions/abandon', headers });
  });

  test('rejects accepting an unknown mission id', async () => {
    const res = await app.inject({ method: 'POST', url: '/game/missions/accept', headers, payload: { missionId: 'not-a-real-id' } });
    assert.equal(res.statusCode, 404);
  });
});
