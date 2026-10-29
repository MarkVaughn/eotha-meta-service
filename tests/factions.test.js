import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { sign } from 'node:crypto';
import { app, call, closeApp, dockedReceipt, json, newPilot, receiptAtOrigin, rtseKey, signedOffer } from './helpers.js';
import { clampStandingsWithCaps, withColorsBonus } from '../src/config/factions.js';
import { canonicalClaimPayload } from '../src/lib/mission-claim.js';

const F5_EMPTY = { mining_permits: {}, active_lockouts: [], customs_flagged: null };
const setStanding = (pilot, factionId, standing) =>
  app.prisma.playerReputation.upsert({
    where: { playerId_factionId: { playerId: pilot.id, factionId } },
    update: { standing },
    create: { playerId: pilot.id, factionId, standing }
  });
const setStandings = (pilot, standings) => Promise.all(Object.entries(standings).map(([id, value]) => setStanding(pilot, id, value)));
const setColors = (pilot, activeColorsFactionId) => app.prisma.player.update({ where: { id: pilot.id }, data: { activeColorsFactionId } });
const colorsOf = async (pilot) => (await app.prisma.player.findUnique({ where: { id: pilot.id } })).activeColorsFactionId;
const standings = async (pilot) => json(await call(pilot, 'GET', '/game/missions/active')).standings;
const ledger = (pilot) => app.prisma.reputationLedger.findMany({ where: { playerId: pilot.id }, orderBy: { createdAt: 'asc' } });
const tokenFactions = (res) => app.jwt.verify(json(res).token).factions;

const colors = (pilot, body) => call(pilot, 'POST', '/game/factions/colors', body);
const renounce = (pilot, body) => call(pilot, 'POST', '/game/factions/renounce-paragon', body);

// Accepts a research mission for `factionId` gaining up to `reputation`, and returns the held mission.
async function hold(pilot, factionId, reputation) {
  const offer = signedOffer(pilot, { type: 'MISSION_TYPE_RESEARCH', required_berths: 0, faction_id: factionId, reputation_change: reputation });
  const res = await call(pilot, 'POST', '/game/missions/accept', { offer, dockedReceipt: receiptAtOrigin(pilot, offer) });
  assert.equal(res.statusCode, 200, res.body);
  return json(res).active;
}

function signedClaim(pilot, active) {
  const claim = {
    missionId: active.mission_id,
    playerShipId: pilot.id,
    destinationStationId: active.offer.destination_station_id,
    acceptedAtMs: active.accepted_at_ms,
    completedAtMs: active.accepted_at_ms + 60_000,
    rewardCredits: active.offer.reward_credits,
    reputationChange: active.offer.reputation_change
  };
  claim.durationTakenMs = claim.completedAtMs - claim.acceptedAtMs;
  claim.signature = sign(null, canonicalClaimPayload(claim), rtseKey).toString('base64');
  return claim;
}

// Settles a mission for `factionId` gaining `reputation`, as the engine signs it.
async function settleMission(pilot, factionId, reputation) {
  const active = await hold(pilot, factionId, reputation);
  return call(pilot, 'POST', '/game/missions/complete', { claim: signedClaim(pilot, active) });
}

describe('faction standing caps (clampStandingsWithCaps)', () => {
  test('bounds every standing to [-1000, 1000]', () => {
    assert.deepEqual(clampStandingsWithCaps(-1200, 0, 0), { alpha: -1000, beta: 0, gamma: 0 });
    assert.deepEqual(clampStandingsWithCaps(0, 0, 1500, { alpha: 0, beta: 0, gamma: 0 }), { alpha: 0, beta: 0, gamma: 1000 });
  });

  test('a faction at 450 or above caps its rival at 449; gamma has no rival', () => {
    assert.deepEqual(clampStandingsWithCaps(470, 440, 0, { alpha: 440, beta: 440, gamma: 0 }), { alpha: 470, beta: 440, gamma: 0 });
    assert.deepEqual(clampStandingsWithCaps(470, 460, 0, { alpha: 440, beta: 460, gamma: 0 }), { alpha: 449, beta: 460, gamma: 0 });
    assert.deepEqual(clampStandingsWithCaps(600, 449, 700, { alpha: 600, beta: 449, gamma: 700 }), { alpha: 600, beta: 449, gamma: 700 });
  });

  test('a faction at 800 or above caps the others at 799, and the standing Paragon keeps it', () => {
    assert.deepEqual(clampStandingsWithCaps(820, 0, 850, { alpha: 780, beta: 0, gamma: 850 }), { alpha: 799, beta: 0, gamma: 850 });
    assert.deepEqual(clampStandingsWithCaps(829, 0, 799, { alpha: 799, beta: 0, gamma: 799 }), { alpha: 829, beta: 0, gamma: 799 });
  });

  test('the Flying Colors bonus multiplies a gain for the flown faction by 1.20 and never a loss', () => {
    assert.equal(withColorsBonus(30, 'alpha', 'alpha'), 36);
    assert.equal(withColorsBonus(30, 'alpha', 'beta'), 30);
    assert.equal(withColorsBonus(30, 'alpha', null), 30);
    assert.equal(withColorsBonus(-30, 'alpha', 'alpha'), -30);
  });
});

describe('faction routes and settlement', () => {
  before(async () => { await app.ready(); });
  after(async () => { await closeApp(); });

  test('requires authentication', async () => {
    assert.equal((await app.inject({ method: 'POST', url: '/game/factions/colors', payload: { factionId: 'alpha' } })).statusCode, 401);
    assert.equal((await app.inject({ method: 'POST', url: '/game/factions/renounce-paragon', payload: { currentParagonFactionId: 'alpha' } })).statusCode, 401);
  });

  test('login embeds the factions claim, neutral for a new pilot', async () => {
    const pilot = await newPilot();
    assert.deepEqual(app.jwt.verify(pilot.token).factions, { alpha: 0, beta: 0, gamma: 0, active_colors: null, ...F5_EMPTY });
  });

  test('TEST-2.1-META-CLAMP-RIVAL: an alpha gain to 470 holds beta at 449 or below', async () => {
    const pilot = await newPilot();
    await setStandings(pilot, { alpha: 440, beta: 440 });
    const res = await settleMission(pilot, 'alpha', 30);
    assert.equal(res.statusCode, 200, res.body);
    assert.deepEqual(json(res).standings, { alpha: 470, beta: 440 });
    assert.deepEqual(tokenFactions(res), { alpha: 470, beta: 440, gamma: 0, active_colors: null, ...F5_EMPTY });

    // Beta can no longer rise past the rival cap while alpha leads.
    const capped = await settleMission(pilot, 'beta', 30);
    assert.deepEqual(json(capped).standings, { alpha: 470, beta: 449 });
  });

  test('TEST-2.2-META-CLAMP-PARAGON: with gamma at 850, an alpha +40 from 780 is clamped to 799', async () => {
    const pilot = await newPilot();
    await setStandings(pilot, { gamma: 850, alpha: 780 });
    const res = await settleMission(pilot, 'alpha', 40);
    assert.equal(res.statusCode, 200, res.body);
    assert.deepEqual(json(res).standings, { alpha: 799, gamma: 850 });
    const [row] = await ledger(pilot);
    assert.equal(row.reason, 'MISSION_COMPLETED');
    assert.deepEqual([row.factionId, row.factionDelta, row.alphaDelta, row.betaDelta, row.gammaDelta], ['alpha', 19, 19, 0, 0]);
  });

  test('TEST-2.3-META-RENOUNCE-PARAGON: renouncing gamma frees alpha to become Paragon', async () => {
    const pilot = await newPilot();
    await setStandings(pilot, { gamma: 850, alpha: 799 });
    const res = await renounce(pilot, { currentParagonFactionId: 'gamma', dockedReceipt: dockedReceipt(pilot) });
    assert.equal(res.statusCode, 200, res.body);
    const body = json(res);
    assert.equal(body.success, true);
    assert.equal(body.gammaScore, 799);
    assert.deepEqual(body.factions, { alpha: 799, beta: 0, gamma: 799, active_colors: null, ...F5_EMPTY });
    assert.deepEqual(tokenFactions(res), body.factions);
    const [row] = await ledger(pilot);
    assert.deepEqual([row.reason, row.factionId, row.gammaDelta], ['RENOUNCE_PARAGON', 'gamma', -51]);

    const advanced = await settleMission(pilot, 'alpha', 30);
    assert.deepEqual(json(advanced).standings, { alpha: 829, gamma: 799 });
  });

  test('renouncing a faction the pilot is not the Paragon of is refused and changes nothing', async () => {
    const pilot = await newPilot();
    await setStandings(pilot, { gamma: 850, alpha: 700 });
    const wrong = await renounce(pilot, { currentParagonFactionId: 'alpha', dockedReceipt: dockedReceipt(pilot) });
    assert.equal(wrong.statusCode, 409);
    assert.equal(json(wrong).error, 'not_paragon');
    assert.equal(json(wrong).current, 700);

    const unknown = await renounce(pilot, { currentParagonFactionId: 'independent', dockedReceipt: dockedReceipt(pilot) });
    assert.equal(unknown.statusCode, 400);
    const undocked = await renounce(pilot, { currentParagonFactionId: 'gamma' });
    assert.equal(undocked.statusCode, 403);
    assert.equal(json(undocked).error, 'docked_receipt_required');
    assert.deepEqual(await standings(pilot), { alpha: 700, gamma: 850 });
    assert.equal((await ledger(pilot)).length, 0);
  });

  test('TEST-2.4-META-COLORS-REFUSAL-UNDOCKED: colors need a docked receipt', async () => {
    const pilot = await newPilot();
    await setStanding(pilot, 'alpha', 600);
    const res = await colors(pilot, { factionId: 'alpha' });
    assert.equal(res.statusCode, 403);
    assert.equal(json(res).error, 'docked_receipt_required');
    assert.equal(await colorsOf(pilot), null);

    const forged = await colors(pilot, { factionId: 'alpha', dockedReceipt: dockedReceipt(pilot, { pilotId: 'someone-else' }) });
    assert.equal(json(forged).error, 'docked_receipt_invalid');
    const stale = await colors(pilot, { factionId: 'alpha', dockedReceipt: dockedReceipt(pilot, { issuedAtMs: Date.now() - 3_600_000, dockedAtMs: Date.now() - 3_600_000 }) });
    assert.equal(json(stale).error, 'docked_receipt_required');
    assert.equal(await colorsOf(pilot), null);
  });

  test('TEST-2.5-META-COLORS-REFUSAL-REP: colors need a standing of 500', async () => {
    const pilot = await newPilot();
    await setStanding(pilot, 'beta', 490);
    const res = await colors(pilot, { factionId: 'beta', dockedReceipt: dockedReceipt(pilot) });
    assert.equal(res.statusCode, 403);
    const { error, required, current } = json(res);
    assert.deepEqual({ error, required, current }, { error: 'insufficient_reputation', required: 500, current: 490 });
    assert.equal(await colorsOf(pilot), null);

    const unknown = await colors(pilot, { factionId: 'independent', dockedReceipt: dockedReceipt(pilot) });
    assert.equal(unknown.statusCode, 400);
    assert.equal((await colors(pilot, {})).statusCode, 400);
  });

  test('flying colors at 500 reissues the token, and null stops', async () => {
    const pilot = await newPilot();
    await setStanding(pilot, 'alpha', 500);
    const res = await colors(pilot, { factionId: 'alpha', dockedReceipt: dockedReceipt(pilot) });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(json(res).active_colors, 'alpha');
    assert.deepEqual(tokenFactions(res), { alpha: 500, beta: 0, gamma: 0, active_colors: 'alpha', ...F5_EMPTY });
    assert.equal(await colorsOf(pilot), 'alpha');

    const off = await colors(pilot, { factionId: null, dockedReceipt: dockedReceipt(pilot) });
    assert.equal(off.statusCode, 200, off.body);
    assert.equal(tokenFactions(off).active_colors, null);
    assert.equal(await colorsOf(pilot), null);
  });

  test('a mission for the flown faction gains 1.20 times the signed reputation; others do not', async () => {
    const pilot = await newPilot();
    await setStandings(pilot, { alpha: 500 });
    await setColors(pilot, 'alpha');
    const flown = await settleMission(pilot, 'alpha', 30);
    assert.equal(json(flown).reputation_change, 36);
    assert.deepEqual(json(flown).standings, { alpha: 536 });
    assert.deepEqual(tokenFactions(flown), { alpha: 536, beta: 0, gamma: 0, active_colors: 'alpha', ...F5_EMPTY });

    const other = await settleMission(pilot, 'gamma', 30);
    assert.equal(json(other).reputation_change, 30);
    assert.deepEqual(json(other).standings, { alpha: 536, gamma: 30 });
  });

  test('a standing drop below 500 stops flying its colors', async () => {
    const pilot = await newPilot();
    await setStanding(pilot, 'alpha', 505);
    await setColors(pilot, 'alpha');
    const offer = signedOffer(pilot, { type: 'MISSION_TYPE_RESEARCH', required_berths: 0, faction_id: 'alpha' });
    await call(pilot, 'POST', '/game/missions/accept', { offer, dockedReceipt: receiptAtOrigin(pilot, offer) });
    const res = await call(pilot, 'POST', '/game/missions/abandon', { missionId: offer.mission_id });
    assert.equal(res.statusCode, 200, res.body);
    assert.deepEqual(json(res).standings, { alpha: 497 });
    assert.deepEqual(tokenFactions(res), { alpha: 497, beta: 0, gamma: 0, active_colors: null, ...F5_EMPTY });
    assert.equal(await colorsOf(pilot), null);
    const [row] = await ledger(pilot);
    assert.deepEqual([row.reason, row.missionId, row.alphaDelta], ['MISSION_ABANDONED', offer.mission_id, -8]);
  });

  test('TEST-2.6-META-CONCURRENCY-RACE: concurrent settlements leave exactly one Paragon', async () => {
    // Alpha and gamma are not rivals, so only the single-Paragon cap separates them.
    const pilot = await newPilot();
    await setStandings(pilot, { alpha: 795, gamma: 795 });
    const missions = [await hold(pilot, 'alpha', 20), await hold(pilot, 'gamma', 20)];
    const results = await Promise.all(
      missions.map((active) => call(pilot, 'POST', '/game/missions/complete', { claim: signedClaim(pilot, active) }))
    );
    assert.deepEqual(results.map((r) => r.statusCode), [200, 200]);
    const final = await standings(pilot);
    assert.deepEqual([final.alpha, final.gamma].sort(), [799, 815]);
    assert.equal(await app.prisma.playerReputation.count({ where: { playerId: pilot.id, factionId: { in: ['alpha', 'gamma'] } } }), 2);
  });

  test('other factions keep their uncapped standings', async () => {
    const pilot = await newPilot();
    await setStandings(pilot, { gamma: 900, 'faction-high': 850 });
    const res = await settleMission(pilot, 'faction-high', 5);
    assert.deepEqual(json(res).standings, { 'faction-high': 855, gamma: 900 });
    const [row] = await ledger(pilot);
    assert.deepEqual([row.factionId, row.factionDelta, row.gammaDelta], ['faction-high', 5, 0]);
  });
});
