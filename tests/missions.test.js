import { test, describe, before, after, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import app from '../src/app.js';
import { generateMissions, findMissionOffer, computePayout, parseMissionId } from '../src/config/missions.js';

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

  test('findMissionOffer rejects arbitrary, future and stale epoch hours', () => {
    const current = generateMissions({ stationId: 'station-a', stationNode: 'node-1', passengerCapacity: 3, now: FIXED_NOW })[0];
    const previous = generateMissions({ stationId: 'station-a', stationNode: 'node-1', passengerCapacity: 3, now: new Date(FIXED_NOW.getTime() - 3_600_000) })[0];
    const future = generateMissions({ stationId: 'station-a', stationNode: 'node-1', passengerCapacity: 3, now: new Date(FIXED_NOW.getTime() + 3_600_000) })[0];
    const stale = generateMissions({ stationId: 'station-a', stationNode: 'node-1', passengerCapacity: 3, now: new Date(FIXED_NOW.getTime() - 5 * 3_600_000) })[0];

    assert.ok(findMissionOffer(current.missionId, 3, FIXED_NOW));
    assert.ok(findMissionOffer(previous.missionId, 3, FIXED_NOW));
    assert.equal(findMissionOffer(future.missionId, 3, FIXED_NOW), null);
    assert.equal(findMissionOffer(stale.missionId, 3, FIXED_NOW), null);
  });

  test('parseMissionId rejects malformed ids and delimiter-bearing station tokens', () => {
    assert.equal(parseMissionId('a::b::1::0')?.stationId, 'a');
    assert.equal(parseMissionId('a::b::::0'), null);
    assert.equal(parseMissionId('a::b::1.5::0'), null);
    assert.equal(parseMissionId('a:::b::1::0'), null);
    assert.equal(parseMissionId('a::b::1::0::x'), null);
    assert.equal(parseMissionId(undefined), null);
  });

  test('findMissionOffer re-derives the same mission by id', () => {
    const missions = generateMissions({ stationId: 'station-a', stationNode: 'node-1', passengerCapacity: 3, now: FIXED_NOW });
    const target = missions[0];
    const offer = findMissionOffer(target.missionId, 3, FIXED_NOW);
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

// Shifts Date.now() forward so tests can simulate time passing without waiting.
let clockOffsetMs = 0;
function advanceClock(ms) {
  if (!Date.now.mock) {
    const realNow = Date.now.bind(Date);
    mock.method(Date, 'now', () => realNow() + clockOffsetMs);
  }
  clockOffsetMs += ms;
}
function resetClock() {
  clockOffsetMs = 0;
  mock.restoreAll();
}

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
  afterEach(resetClock);

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

    // Round-trip expeditions need real time underway before they can complete.
    if (accepted.roundTrip) advanceClock(accepted.expectedSeconds * 1000);

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

  // --- Remediation coverage (PR #6 review) ---

  const post = (url, payload) => app.inject({ method: 'POST', url: `/game/missions/${url}`, headers, payload });
  const json = (res) => JSON.parse(res.body);

  async function boardAt(stationId, stationNode) {
    const res = await app.inject({ method: 'GET', url: `/game/missions/available?stationId=${stationId}&stationNode=${stationNode}`, headers });
    return json(res);
  }

  // Scans distinct stations until an offer of the requested type turns up.
  async function acceptOfferOfType(type, prefix) {
    for (let i = 0; i < 200; i++) {
      const stationId = `${prefix}-${i}`;
      const board = await boardAt(stationId, `${prefix}-node-${i}`);
      const offer = board.missions.find((m) => m.type === type);
      if (offer) {
        const res = await post('accept', { missionId: offer.missionId });
        assert.equal(res.statusCode, 200);
        return json(res);
      }
    }
    throw new Error(`no ${type} offer found`);
  }

  const destinationOf = (m) => (m.roundTrip
    ? { currentStationId: m.originStationId, currentStationNode: m.originStationNode }
    : { currentStationId: m.destination.stationId, currentStationNode: m.destination.node });

  test('cannot complete a mission without accepting it first', async () => {
    const board = await boardAt('unaccepted-1', 'unaccepted-node-1');
    const offer = board.missions[0];
    const res = await post('complete', {
      missionId: offer.missionId,
      currentStationId: offer.originStationId,
      currentStationNode: offer.originStationNode,
      elapsedSeconds: 9999
    });
    assert.equal(res.statusCode, 404);
  });

  test('cannot complete with a missionId that differs from the active mission', async () => {
    const accepted = await acceptOfferOfType('ONE_WAY_PASSAGE', 'mismatch');
    const res = await post('complete', { missionId: `${accepted.missionId}x`, ...destinationOf(accepted), elapsedSeconds: 9999 });
    assert.equal(res.statusCode, 404);
    await post('abandon');
  });

  test('cannot complete a one-way passage at the wrong destination', async () => {
    const accepted = await acceptOfferOfType('ONE_WAY_PASSAGE', 'wrongdest');
    const creditsBefore = json(await app.inject({ method: 'GET', url: '/game/credits', headers })).credits;

    // Right node, wrong station; and right station, wrong node.
    for (const wrong of [
      { currentStationId: accepted.originStationId, currentStationNode: accepted.destination.node },
      { currentStationId: accepted.destination.stationId, currentStationNode: accepted.originStationNode }
    ]) {
      const res = await post('complete', { missionId: accepted.missionId, ...wrong, elapsedSeconds: 9999 });
      assert.equal(res.statusCode, 400);
    }

    const creditsAfter = json(await app.inject({ method: 'GET', url: '/game/credits', headers })).credits;
    assert.equal(creditsAfter, creditsBefore);
    assert.equal(json(await app.inject({ method: 'GET', url: '/game/missions/active', headers })).mission.missionId, accepted.missionId);
    await post('abandon');
  });

  test('a round-trip expedition cannot complete immediately without time underway', async () => {
    const accepted = await acceptOfferOfType('RESEARCH_EXPEDITION', 'roundtrip');
    const payload = { missionId: accepted.missionId, ...destinationOf(accepted), elapsedSeconds: 9999 };

    // Spawn-and-return: at the origin the instant it was accepted.
    const instant = await post('complete', payload);
    assert.equal(instant.statusCode, 400);

    // Still too early: under the minimum fraction of the expected duration.
    advanceClock(accepted.expectedSeconds * 0.25 * 1000);
    assert.equal((await post('complete', payload)).statusCode, 400);

    // After enough time underway it completes.
    advanceClock(accepted.expectedSeconds * 0.5 * 1000);
    const done = await post('complete', payload);
    assert.equal(done.statusCode, 200);
  });

  test('client-claimed elapsedSeconds cannot fake an expedited bonus', async () => {
    const accepted = await acceptOfferOfType('ONE_WAY_PASSAGE', 'fastclaim');
    advanceClock(accepted.expectedSeconds * 1000); // took exactly the expected time
    const res = await post('complete', { missionId: accepted.missionId, ...destinationOf(accepted), elapsedSeconds: 0 });
    assert.equal(res.statusCode, 200);
    assert.equal(json(res).bonus, 0);
    assert.equal(json(res).payout, accepted.basePayout);
  });

  test('completion is atomic: concurrent and repeated completions credit exactly once', async () => {
    const accepted = await acceptOfferOfType('ONE_WAY_PASSAGE', 'atomic');
    const creditsBefore = json(await app.inject({ method: 'GET', url: '/game/credits', headers })).credits;
    advanceClock(accepted.expectedSeconds * 1000);
    const payload = { missionId: accepted.missionId, ...destinationOf(accepted), elapsedSeconds: 9999 };

    const results = await Promise.all([post('complete', payload), post('complete', payload), post('complete', payload)]);
    // Losers see either no active mission (404) or lose the claim race (409).
    const statuses = results.map((r) => r.statusCode);
    assert.equal(statuses.filter((c) => c === 200).length, 1);
    assert.ok(statuses.filter((c) => c !== 200).every((c) => c === 404 || c === 409));

    const creditsAfter = json(await app.inject({ method: 'GET', url: '/game/credits', headers })).credits;
    assert.equal(creditsAfter, creditsBefore + accepted.basePayout);

    // Replaying after completion is rejected and pays nothing more.
    assert.equal((await post('complete', payload)).statusCode, 404);
    assert.equal(json(await app.inject({ method: 'GET', url: '/game/credits', headers })).credits, creditsAfter);
  });

  test('concurrent accepts for the same pilot yield one mission and a 409', async () => {
    const board = await boardAt('race-1', 'race-node-1');
    const [a, b] = [board.missions[0], board.missions[board.missions.length - 1]];
    const results = await Promise.all([post('accept', { missionId: a.missionId }), post('accept', { missionId: b.missionId })]);
    assert.deepEqual(results.map((r) => r.statusCode).sort(), [200, 409]);
    await post('abandon');
  });

  test('rejects accepting offers from future or long-past epoch hours', async () => {
    const board = await boardAt('epoch-1', 'epoch-node-1');
    const { missionId } = board.missions[0];
    const [stationId, stationNode, epochHour, index] = missionId.split('::');

    for (const shifted of [Number(epochHour) + 1, Number(epochHour) + 1000, Number(epochHour) - 2, 0]) {
      const res = await post('accept', { missionId: [stationId, stationNode, shifted, index].join('::') });
      assert.equal(res.statusCode, 404);
    }
  });

  test('rejects station ids/nodes containing the id delimiter', async () => {
    for (const query of ['stationId=a::b&stationNode=n1', 'stationId=a&stationNode=n:1']) {
      const res = await app.inject({ method: 'GET', url: `/game/missions/available?${query}`, headers });
      assert.equal(res.statusCode, 400);
    }
  });
});
