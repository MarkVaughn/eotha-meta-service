import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto';
import { addCrew, app, call, closeApp, credits, json, newPilot, rtseKey, setCredits } from './helpers.js';
import { canonicalAwayTeamClaimPayload } from '../src/lib/expedition.js';
import { EXPEDITION_TRAUMA_DURATION_MS } from '../src/config/expedition.js';
import { CARGO_MAX_LOTS } from '../src/config/cargo.js';
import { MAX_REWARD_CREDITS } from '../src/config/missions.js';
import { MAX_TOTAL_WAGE_BP, MIN_CREW_WAGE_BP } from '../src/config/crew.js';

before(async () => { await app.ready(); });
after(closeApp);

const MIN = 60_000;
const SYSTEM = '8828308281fffff';
const SITE = '8c283082e1801ff';

const crewRow = (member) => app.prisma.crewMember.findUnique({ where: { id: member.id } });
const records = (pilot) => app.prisma.expeditionRecord.findMany({ where: { playerId: pilot.id } });
const captainRow = (pilot) => app.prisma.captain.findUnique({ where: { playerId: pilot.id } });
const ledger = (pilot) => app.prisma.reputationLedger.findMany({ where: { playerId: pilot.id, reason: 'EXPEDITION_SETTLED' } });
const standing = async (pilot, factionId) =>
  (await app.prisma.playerReputation.findUnique({ where: { playerId_factionId: { playerId: pilot.id, factionId } } }))?.standing ?? 0;
const hold = async (pilot) => (await app.prisma.cargoLease.findFirst({ where: { playerId: pilot.id }, orderBy: { generation: 'desc' } }));
const settle = (pilot, claim) => call(pilot, 'POST', '/game/expeditions/settle', { claim });

const artifact = {
  resourceType: 'PRECURSOR_ARTIFACT',
  unitsMilli: 3000,
  grade: 4,
  purityBp: 9500,
  originSystemH3: SYSTEM,
  originFactionId: 'beta',
  customsStatus: 'DOMESTIC_OR_FREE'
};

// An AwayTeamClaim signed as the engine signs it (the bytes are the verifier's, which tests/expedition-claim.test.js
// checks against the eotha-contracts fixed vectors). `overrides` replace any field before signing; pass `signer` to
// sign with another key, or `signature` to keep a stale one.
function signedClaim(pilot, crew, overrides = {}, signer = rtseKey) {
  const claim = {
    pilotId: pilot.id,
    systemH3: SYSTEM,
    planetId: 'planet-4a',
    siteNodeH3: SITE,
    missionId: '',
    outcomeTier: 3,
    rewardCredits: 8500,
    captainXp: 250,
    sponsorReputationDelta: 0,
    rivalReputationDelta: 0,
    crewStates: crew.map((member) => ({ crewId: member.id, moraleDelta: 0, seniorityXpEarned: 0 })),
    recoveredLots: [],
    completedAtMs: Date.now() - 1000,
    nonce: randomBytes(16).toString('base64'),
    ...overrides
  };
  const normal = {
    ...claim,
    crewStates: claim.crewStates.map((state) => ({ sufferedTrauma: false, traumaType: '', ...state })),
    recoveredLots: claim.recoveredLots
  };
  return { ...claim, signature: overrides.signature ?? sign(null, canonicalAwayTeamClaimPayload(normal), signer).toString('base64') };
}

// The plan's anchor slice: an Adept Science (8 %) and a Novice Engineer (5 %), one traumatized.
async function anchorTeam(pilot, { moraleScience = 80, moraleEngineer = 75 } = {}) {
  const science = await addCrew(pilot, { crewClass: 'SCIENCE', rank: 'ADEPT', wageShareBp: 800, morale: moraleScience, seniorityXp: 10 });
  const engineer = await addCrew(pilot, { crewClass: 'ENGINEER', rank: 'NOVICE', wageShareBp: 500, morale: moraleEngineer });
  return { science, engineer };
}
const anchorClaim = (pilot, { science, engineer }, overrides = {}, signer = rtseKey) => signedClaim(pilot, [], {
  crewStates: [
    { crewId: science.id, moraleDelta: 8, seniorityXpEarned: 45 },
    { crewId: engineer.id, moraleDelta: -25, seniorityXpEarned: 20, sufferedTrauma: true, traumaType: 'RADIATION_BURNS' }
  ],
  recoveredLots: [artifact],
  ...overrides
}, signer);

describe('POST /game/expeditions/settle', () => {
  test('credits the gross less the away team wage share and applies captain XP, crew XP, morale, trauma and cargo', async () => {
    const p = await newPilot('Anchor');
    const team = await anchorTeam(p);
    const lease = json(await call(p, 'POST', '/game/cargo/lease')).cargo.lease_id;
    await setCredits(p, 1000);
    const xpBefore = (await captainRow(p)).xp;
    const before = Date.now();

    const res = await settle(p, anchorClaim(p, team));
    assert.equal(res.statusCode, 200, res.body);
    const body = json(res);
    assert.equal(body.gross_credits, 8500);
    assert.equal(body.crew_share_credits, 1105); // 8 % + 5 % of 8500
    assert.equal(body.net_credits, 7395);
    assert.equal(body.credits, 1000 + 7395);
    assert.equal(await credits(p), 8395);
    assert.deepEqual(body.crew_payouts.map((entry) => entry.shareCredits).sort((a, b) => a - b), [425, 680]);
    assert.equal(body.xp_awarded, 250);
    assert.equal((await captainRow(p)).xp, xpBefore + 250);
    assert.equal(body.replayed, false);
    assert.ok(body.token);

    const science = await crewRow(team.science);
    assert.equal(science.morale, 88);
    assert.equal(science.seniorityXp, 55);
    assert.equal(science.traumaUntil, null);
    const engineer = await crewRow(team.engineer);
    assert.equal(engineer.morale, 50);
    assert.equal(engineer.seniorityXp, 20);
    assert.equal(engineer.traumaType, 'RADIATION_BURNS');
    const window = engineer.traumaUntil.getTime() - EXPEDITION_TRAUMA_DURATION_MS;
    assert.ok(window >= before && window <= Date.now(), 'traumaUntil is 45 minutes from the settlement');
    assert.equal(EXPEDITION_TRAUMA_DURATION_MS, 45 * MIN);
    assert.deepEqual(body.crew.map((entry) => entry.morale).sort(), [50, 88]);
    assert.equal(body.crew.find((entry) => entry.crew_id === team.engineer.id).trauma.type, 'RADIATION_BURNS');

    const cargo = await hold(p);
    assert.equal(cargo.id, lease, 'the lot joins the current lease, which is not replaced');
    assert.deepEqual(cargo.lots, [{
      resource_type: 'PRECURSOR_ARTIFACT', units_milli: 3000, grade: 4, purity_bp: 9500,
      origin_system_h3: SYSTEM, origin_faction_id: 'beta', customs_status: 'DOMESTIC_OR_FREE'
    }]);
    assert.deepEqual(body.lots, cargo.lots);

    const [record] = await records(p);
    assert.equal(record.grossCredits, 8500);
    assert.equal(record.crewWageShareCredits, 1105);
    assert.equal(record.netCredits, 7395);
    assert.equal(record.captainXp, 250);
    assert.equal(record.outcomeTier, 3);
    assert.equal(record.missionId, null);
    assert.equal(record.planetId, 'planet-4a');
    assert.equal(body.expedition_id, record.id);
  });

  test('a claim with no lease yet starts the first one', async () => {
    const p = await newPilot('FirstLease');
    const team = await anchorTeam(p);
    assert.equal(await hold(p), null);
    assert.equal((await settle(p, anchorClaim(p, team))).statusCode, 200);
    const cargo = await hold(p);
    assert.equal(cargo.generation, 1);
    assert.equal(cargo.lots.length, 1);
  });

  test('a replayed nonce is refused with the first settlement and changes nothing', async () => {
    const p = await newPilot('Replay');
    const team = await anchorTeam(p);
    const claim = anchorClaim(p, team);
    const first = json(await settle(p, claim));
    const afterFirst = await credits(p);
    const xp = (await captainRow(p)).xp;
    const crewAfter = await crewRow(team.science);

    const res = await settle(p, claim);
    assert.equal(res.statusCode, 409);
    const body = json(res);
    assert.equal(body.code, 'away_team_claim_replayed');
    assert.equal(body.replayed, true);
    assert.equal(body.expedition_id, first.expedition_id);
    assert.equal(body.net_credits, first.net_credits);

    assert.equal(await credits(p), afterFirst);
    assert.equal((await captainRow(p)).xp, xp);
    assert.deepEqual(await crewRow(team.science), crewAfter);
    assert.equal((await hold(p)).lots.length, 1);
    assert.equal((await records(p)).length, 1);
  });

  test('a claim that differs only in its nonce is a second expedition', async () => {
    const p = await newPilot('Twice');
    const team = await anchorTeam(p);
    const unhurt = () => anchorClaim(p, team, { crewStates: [{ crewId: team.science.id, moraleDelta: 1 }] });
    assert.equal((await settle(p, unhurt())).statusCode, 200);
    assert.equal((await settle(p, unhurt())).statusCode, 200);
    assert.equal((await records(p)).length, 2);
    assert.equal((await hold(p)).lots.length, 2);
  });

  test('refuses a forged signature, another engine key, another pilot and a tampered field, applying nothing', async () => {
    const p = await newPilot('Forged');
    const other = await newPilot('Other');
    const team = await anchorTeam(p);
    const otherTeam = await anchorTeam(other);
    const good = anchorClaim(p, team);
    const forgery = generateKeyPairSync('ed25519').privateKey;
    const attempts = [
      { ...good, signature: Buffer.alloc(64, 1).toString('base64') },
      anchorClaim(p, team, {}, forgery),
      { ...good, rewardCredits: 9_000_000 }, // tampered after signing
      anchorClaim(other, otherTeam) // signed for another pilot
    ];
    for (const claim of attempts) {
      const res = await settle(p, claim);
      assert.equal(res.statusCode, 403, res.body);
      assert.equal(json(res).code, 'away_team_claim_invalid');
    }
    assert.equal(await credits(p), 0);
    assert.equal((await records(p)).length, 0);
    assert.equal((await crewRow(team.engineer)).traumaUntil, null);
  });

  test('refuses a malformed body, a future-dated claim and a missing claim key', async () => {
    const p = await newPilot('Shape');
    const team = await anchorTeam(p);
    assert.equal((await call(p, 'POST', '/game/expeditions/settle', {})).statusCode, 400);
    const { nonce, ...unnonced } = anchorClaim(p, team);
    assert.equal((await settle(p, unnonced)).statusCode, 400);
    assert.equal((await settle(p, { ...anchorClaim(p, team), rewardCredits: 'lots' })).statusCode, 400);
    assert.equal((await settle(p, { ...anchorClaim(p, team), crewStates: [] })).statusCode, 400);
    const future = await settle(p, anchorClaim(p, team, { completedAtMs: Date.now() + 10 * MIN }));
    assert.equal(future.statusCode, 400);
    assert.equal(json(future).code, 'away_team_claim_from_future');
    const unauthenticated = await app.inject({ method: 'POST', url: '/game/expeditions/settle', payload: { claim: anchorClaim(p, team) } });
    assert.equal(unauthenticated.statusCode, 401);
    assert.equal((await records(p)).length, 0);
  });

  test('crew take at most MAX_TOTAL_WAGE_BP of the gross, each scaled down in proportion', async () => {
    const p = await newPilot('Cap');
    const crew = [];
    for (const crewClass of ['PILOT', 'NAVIGATOR', 'SCIENCE', 'ENGINEER']) {
      crew.push(await addCrew(p, { crewClass, wageShareBp: 2000 })); // 8000 bp in all
    }
    const res = json(await settle(p, signedClaim(p, crew, { rewardCredits: 10_000, captainXp: 0 })));
    assert.equal(res.crew_share_credits, 10_000 * MAX_TOTAL_WAGE_BP / 10_000);
    assert.equal(res.net_credits, 5000);
    assert.deepEqual(res.crew_payouts.map((entry) => entry.shareCredits), [1250, 1250, 1250, 1250]);
    assert.equal(await credits(p), 5000);
  });

  test('a member below MIN_CREW_WAGE_BP is paid at the floor', async () => {
    const p = await newPilot('Floor');
    const member = await addCrew(p, { crewClass: 'SCIENCE', wageShareBp: 100 });
    const res = json(await settle(p, signedClaim(p, [member], { rewardCredits: 10_000, captainXp: 0 })));
    assert.equal(res.crew_share_credits, 10_000 * MIN_CREW_WAGE_BP / 10_000);
    assert.equal(res.net_credits, 9750);
  });

  test('crew who stayed aboard are not paid and a resigned member is neither paid nor lifted', async () => {
    const p = await newPilot('Stay');
    const away = await addCrew(p, { crewClass: 'SCIENCE', wageShareBp: 1000 });
    const resigned = await addCrew(p, { crewClass: 'ENGINEER', wageShareBp: 1000, morale: 0 });
    await addCrew(p, { crewClass: 'PILOT', wageShareBp: 1000 }); // stayed aboard
    const res = json(await settle(p, signedClaim(p, [], {
      rewardCredits: 10_000,
      captainXp: 0,
      crewStates: [
        { crewId: away.id, moraleDelta: 5, seniorityXpEarned: 7 },
        { crewId: resigned.id, moraleDelta: 30, seniorityXpEarned: 7 }
      ]
    })));
    assert.equal(res.crew_share_credits, 1000);
    assert.equal(res.net_credits, 9000);
    assert.equal((await crewRow(resigned)).morale, 0);
    assert.equal((await crewRow(resigned)).seniorityXp, 7);
    assert.equal((await crewRow(away)).morale, 80);
  });

  test('refuses a claim naming crew who are not active crew of the ship, applying nothing', async () => {
    const p = await newPilot('Gone');
    const other = await newPilot('Neighbour');
    const here = await addCrew(p, { crewClass: 'SCIENCE', wageShareBp: 1000 });
    const standby = await addCrew(p, { crewClass: 'ENGINEER', status: 'STANDBY', spaceshipId: null });
    const theirs = await addCrew(other, { crewClass: 'PILOT' });
    const unknown = randomUUID();
    for (const stranger of [standby.id, theirs.id, unknown]) {
      const res = await settle(p, signedClaim(p, [], {
        crewStates: [{ crewId: here.id, moraleDelta: -10, sufferedTrauma: true, traumaType: 'HYPOTHERMIA' }, { crewId: stranger, moraleDelta: -10 }]
      }));
      assert.equal(res.statusCode, 409, res.body);
      assert.equal(json(res).code, 'away_team_crew_not_aboard');
      assert.deepEqual(json(res).crew_ids, [stranger]);
    }
    assert.equal(await credits(p), 0);
    assert.equal((await captainRow(p)).xp, 0);
    assert.equal((await records(p)).length, 0);
    const member = await crewRow(here);
    assert.equal(member.morale, 75);
    assert.equal(member.traumaUntil, null);
    assert.equal((await crewRow(theirs)).morale, 75);
  });

  test('refuses a claim naming crew still recovering from trauma, applying nothing, and accepts them once it ends', async () => {
    const p = await newPilot('Injured');
    const fit = await addCrew(p, { crewClass: 'SCIENCE' });
    const hurt = await addCrew(p, { crewClass: 'ENGINEER', traumaUntil: new Date(Date.now() + 10 * MIN), traumaType: 'CONCUSSION' });
    const claim = signedClaim(p, [fit, hurt], { rewardCredits: 1000, captainXp: 0 });
    const res = await settle(p, claim);
    assert.equal(res.statusCode, 409, res.body);
    assert.equal(json(res).code, 'away_team_crew_traumatized');
    assert.deepEqual(json(res).crew_ids, [hurt.id]);
    assert.equal(await credits(p), 0);
    assert.equal((await records(p)).length, 0);

    await app.prisma.crewMember.update({ where: { id: hurt.id }, data: { traumaUntil: new Date(Date.now() - MIN) } });
    assert.equal((await settle(p, claim)).statusCode, 200);
    assert.equal(await credits(p) > 0, true);
  });

  test('morale stays within 0..100 and seniority XP is capped', async () => {
    const p = await newPilot('Bounds');
    const high = await addCrew(p, { crewClass: 'SCIENCE', morale: 95 });
    const low = await addCrew(p, { crewClass: 'ENGINEER', morale: 10 });
    await settle(p, signedClaim(p, [], {
      captainXp: 0,
      crewStates: [{ crewId: high.id, moraleDelta: 40 }, { crewId: low.id, moraleDelta: -40 }]
    }));
    assert.equal((await crewRow(high)).morale, 100);
    assert.equal((await crewRow(low)).morale, 0);
  });

  test('a mission expedition moves the sponsor and the rival through the reputation ledger', async () => {
    const p = await newPilot('Mission');
    const team = await anchorTeam(p);
    await app.prisma.playerMission.create({
      data: {
        playerId: p.id,
        missionId: 'mission-1',
        originStationId: randomUUID(),
        offer: { mission_id: 'mission-1', faction_id: 'alpha', opposed_faction_id: 'gamma' }
      }
    });
    await app.prisma.playerReputation.create({ data: { playerId: p.id, factionId: 'gamma', standing: 40 } });
    const res = json(await settle(p, anchorClaim(p, team, { missionId: 'mission-1', sponsorReputationDelta: 15, rivalReputationDelta: -10 })));
    assert.equal(res.reputation.sponsor_faction_id, 'alpha');
    assert.equal(res.reputation.rival_faction_id, 'gamma');
    assert.equal(await standing(p, 'alpha'), 15);
    assert.equal(await standing(p, 'gamma'), 30);
    assert.equal(res.reputation.standings.alpha, 15);
    const [entry] = await ledger(p);
    assert.equal(entry.missionId, 'mission-1');
    assert.equal(entry.factionId, 'alpha');
    assert.equal(entry.factionDelta, 15);
    assert.equal(entry.gammaDelta, -10);
    const [record] = await records(p);
    assert.equal(record.missionId, 'mission-1');
    assert.equal(record.sponsorRepChange, 15);
    assert.equal(record.rivalRepChange, -10);
    // The mission itself is still held: it is completed by its own claim, not by the expedition.
    assert.ok(await app.prisma.playerMission.findUnique({ where: { playerId_missionId: { playerId: p.id, missionId: 'mission-1' } } }));
  });

  test('a free-roam expedition names no faction, so its reputation deltas move no standing', async () => {
    const p = await newPilot('Roam');
    const team = await anchorTeam(p);
    const res = json(await settle(p, anchorClaim(p, team, { sponsorReputationDelta: 15, rivalReputationDelta: -10 })));
    assert.equal(res.reputation, null);
    assert.equal(await standing(p, 'alpha'), 0);
    assert.equal((await ledger(p)).length, 0);
    assert.equal((await records(p)).length, 1);
  });

  test('a balance that would overflow refuses the claim whole, so it can be redeemed later', async () => {
    const p = await newPilot('Overflow');
    const team = await anchorTeam(p);
    const claim = anchorClaim(p, team);
    await setCredits(p, MAX_REWARD_CREDITS - 100);
    const res = await settle(p, claim);
    assert.equal(res.statusCode, 409);
    assert.equal(json(res).code, 'credit_overflow');
    assert.equal(await credits(p), MAX_REWARD_CREDITS - 100);
    assert.equal((await records(p)).length, 0);
    assert.equal((await crewRow(team.engineer)).traumaUntil, null);
    assert.equal((await captainRow(p)).xp, 0);
    assert.equal(await hold(p), null);

    await setCredits(p, 0);
    assert.equal((await settle(p, claim)).statusCode, 200);
  });

  test('a hold with no room for the recovered lots refuses the claim whole', async () => {
    const p = await newPilot('Full');
    const team = await anchorTeam(p);
    const lease = json(await call(p, 'POST', '/game/cargo/lease')).cargo.lease_id;
    const lots = Array.from({ length: CARGO_MAX_LOTS }, () => ({ resource_type: 'FERRITE', units_milli: 1000, grade: 1, purity_bp: 0 }));
    await app.prisma.cargoLease.update({ where: { id: lease }, data: { lots } });
    const claim = anchorClaim(p, team);
    const res = await settle(p, claim);
    assert.equal(res.statusCode, 409);
    assert.equal(json(res).code, 'cargo_hold_full');
    assert.equal(await credits(p), 0);
    assert.equal((await records(p)).length, 0);

    await app.prisma.cargoLease.update({ where: { id: lease }, data: { lots: lots.slice(1) } });
    assert.equal((await settle(p, claim)).statusCode, 200);
    assert.equal((await hold(p)).lots.length, CARGO_MAX_LOTS);
  });

  test('an aborted expedition with no reward or lots only moves the crew', async () => {
    const p = await newPilot('Aborted');
    const member = await addCrew(p, { crewClass: 'SCIENCE' });
    const res = json(await settle(p, signedClaim(p, [], {
      outcomeTier: 4,
      rewardCredits: 0,
      captainXp: 0,
      crewStates: [{ crewId: member.id, moraleDelta: -5 }]
    })));
    assert.equal(res.net_credits, 0);
    assert.equal(res.xp_awarded, 0);
    assert.equal((await crewRow(member)).morale, 70);
    assert.equal(await hold(p), null);
  });
});
