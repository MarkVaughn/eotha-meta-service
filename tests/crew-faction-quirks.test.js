import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, sign } from 'node:crypto';
import { addCrew, app, call, closeApp, dockedReceipt, json, newPilot, receiptAtOrigin, rtseKey, signedOffer } from './helpers.js';
import { canonicalClaimPayload } from '../src/lib/mission-claim.js';
import { missionOfferVersion } from '../src/lib/mission-offer.js';
import {
  BY_THE_BOOK_COVERT_PENALTY, CREW_CAPABILITY, LOYALIST_BETRAYAL_PENALTY, PERFECTIONIST_FAIL_PENALTY, QUIRKS, inHomeSpace
} from '../src/config/crew.js';
import { SETTLEMENT, covertAcceptPenalty, loyalty, seniorityXpGain, settleUtilization } from '../src/config/crew-morale.js';
import { fatigueIntervals, shoreLeaveTerms } from '../src/lib/crew-docking.js';
import { missionSettlement } from '../src/lib/crew.js';
import { withCrewReputationBonus } from '../src/lib/reputation.js';

before(async () => { await app.ready(); });
after(closeApp);

const MIN = 60_000;
const [LOYALIST, HOME_BOUND, PERFECTIONIST, BY_THE_BOOK, NEUTRAL] = ['Q16', 'Q17', 'Q15', 'Q19', 'Q08'];
const member = (overrides = {}) => ({
  crewClass: 'PILOT', rank: 'NOVICE', morale: 75, quirkId: NEUTRAL, unutilizedStreak: 0, seniorityXp: 0, homeFactionId: 'alpha', ...overrides
});
const mission = (overrides = {}) => ({
  kind: SETTLEMENT.MISSION, type: 'MISSION_TYPE_PASSAGE', distanceHexes: 2, requiredBerths: 2, covert: false,
  sponsorFactionId: 'alpha', opposedFactionId: '', speedBonus: true, ...overrides
});
const ctx = { weaponsTier: 1, subsystemUse: 0.5, activeCrew: 1 };
const settle = (m, settlement, opts = {}) => settleUtilization(m, settlement, ctx, { deferred: false, traits: [], ...opts });

describe('the faction quirk numbers', () => {
  test('pin the plan values', () => {
    assert.deepEqual([PERFECTIONIST_FAIL_PENALTY, LOYALIST_BETRAYAL_PENALTY, BY_THE_BOOK_COVERT_PENALTY], [8, 12, 8]);
    const { homeMoraleGain, homeXpMult, homeReputationBonus } = QUIRKS[LOYALIST];
    assert.deepEqual([homeMoraleGain, homeXpMult, homeReputationBonus], [6, 1.4, 0.1]);
    const home = QUIRKS[HOME_BOUND];
    assert.deepEqual(
      [home.homeStationGain, home.homeOutpostGain, home.homeRestedCap, home.awayStationGain, home.awayOutpostGain, home.awayFatigueMult],
      [25, 12, 86, 8, 2, 1.2]
    );
  });

  test('an independent system is the home space of an independent member only', () => {
    assert.equal(inHomeSpace({ homeFactionId: 'independent' }, ''), true);
    assert.equal(inHomeSpace({ homeFactionId: 'independent' }, 'alpha'), false);
    assert.equal(inHomeSpace({ homeFactionId: 'alpha' }, ''), false);
    assert.equal(inHomeSpace({ homeFactionId: 'alpha' }, 'alpha'), true);
    assert.equal(inHomeSpace({ homeFactionId: 'alpha' }, 'beta'), false);
  });
});

describe('LOYALIST (pure)', () => {
  test('a mission for the home faction restores 6 instead of 4, and 40% more seniority XP', () => {
    const loyalist = member({ quirkId: LOYALIST });
    assert.equal(loyalty(loyalist, mission()), 'HOME');
    const result = settle(loyalist, mission());
    assert.equal(result.morale, 81);
    assert.deepEqual(result.quirkEffects, [{ quirk: 'LOYALIST', effect: 'HOME_FACTION' }]);
    assert.equal(settle(member(), mission()).morale, 79);
    assert.equal(seniorityXpGain(loyalist, 100, mission()), 140);
    assert.equal(seniorityXpGain(loyalist, 100, mission({ sponsorFactionId: 'beta' })), 100);
    assert.equal(seniorityXpGain(member(), 100, mission()), 100);
  });

  test('a deferred home mission restores nothing', () => {
    assert.equal(settle(member({ quirkId: LOYALIST }), mission(), { deferred: true }).morale, 75);
  });

  test('a covert mission against the home faction costs 12 and restores nothing, used or not', () => {
    const loyalist = member({ quirkId: LOYALIST });
    const against = mission({ sponsorFactionId: 'beta', opposedFactionId: 'alpha', covert: true });
    assert.equal(loyalty(loyalist, against), 'OPPOSED');
    const used = settle(loyalist, against);
    assert.equal(used.morale, 63);
    assert.deepEqual(used.quirkEffects, [{ quirk: 'LOYALIST', effect: 'OPPOSED_FACTION', moraleLoss: 12 }]);
    assert.equal(settle(member({ quirkId: LOYALIST, crewClass: 'CHEF' }), { ...against, requiredBerths: 0 }).morale, 63);
    assert.equal(seniorityXpGain(loyalist, 100, against), 100);
  });

  test('a mission for a third faction, a non-mission settlement and other quirks are untouched', () => {
    const loyalist = member({ quirkId: LOYALIST });
    assert.equal(loyalty(loyalist, mission({ sponsorFactionId: 'gamma' })), null);
    assert.equal(loyalty(loyalist, mission({ sponsorFactionId: 'gamma', opposedFactionId: 'beta' })), null);
    assert.equal(loyalty(loyalist, { kind: SETTLEMENT.CARGO_SALE }), null);
    assert.equal(loyalty(member(), mission()), null);
    assert.equal(settle(loyalist, mission({ sponsorFactionId: 'gamma' })).morale, 79);
  });

  test('an independent loyalist is loyal to independent sponsors, which an offer without a faction names', () => {
    const independent = member({ quirkId: LOYALIST, homeFactionId: 'independent' });
    assert.equal(loyalty(independent, missionSettlement({ type: 'MISSION_TYPE_PASSAGE' })), 'HOME');
    assert.equal(loyalty(independent, missionSettlement({ type: 'MISSION_TYPE_PASSAGE', faction_id: 'alpha' })), null);
  });

  test('+10% reputation gain for the home faction only, beside the Diplomat and never stacked', () => {
    const loyalist = member({ quirkId: LOYALIST });
    assert.equal(withCrewReputationBonus(20, [loyalist], 'alpha'), 22);
    assert.equal(withCrewReputationBonus(20, [loyalist], 'beta'), 20);
    assert.equal(withCrewReputationBonus(20, [loyalist, loyalist], 'alpha'), 22);
    assert.equal(withCrewReputationBonus(-20, [loyalist], 'alpha'), -20);
    assert.equal(withCrewReputationBonus(20, [{ ...loyalist, morale: 0 }], 'alpha'), 20);
    assert.equal(withCrewReputationBonus(20, [member()], 'alpha'), 20);
    const diplomat = member({ crewClass: 'DIPLOMAT', rank: 'MASTER' });
    assert.equal(withCrewReputationBonus(100, [diplomat], 'alpha'), 135);
    assert.equal(withCrewReputationBonus(100, [diplomat, loyalist], 'alpha'), 145);
  });
});

describe('PERFECTIONIST and BY_THE_BOOK (pure)', () => {
  test('a mission that missed the speed bonus costs a Perfectionist 8, whether or not it was used', () => {
    const perfectionist = member({ quirkId: PERFECTIONIST });
    assert.equal(settle(perfectionist, mission({ speedBonus: true })).morale, 79);
    const missed = settle(perfectionist, mission({ speedBonus: false }));
    assert.equal(missed.morale, 71);
    assert.deepEqual(missed.quirkEffects, [{ quirk: 'PERFECTIONIST', effect: 'SPEED_BONUS_MISSED', moraleLoss: 8 }]);
    assert.equal(settle(member({ ...perfectionist, crewClass: 'CHEF' }), mission({ speedBonus: false, requiredBerths: 0 })).morale, 75 - 8);
    assert.equal(settle(member(), mission({ speedBonus: false })).morale, 79);
  });

  test('only a mission claim can miss the bonus: other settlements and unsettled offers cost nothing', () => {
    const perfectionist = member({ quirkId: PERFECTIONIST, crewClass: 'ENGINEER' });
    assert.equal(settle(perfectionist, { kind: SETTLEMENT.CARGO_SALE }).morale, 79);
    assert.equal(settle(perfectionist, mission({ type: 'MISSION_TYPE_GATHER', speedBonus: undefined })).morale, 79);
  });

  test('the speed bonus is earned only by a claim paid above the offer', () => {
    const offer = { type: 'MISSION_TYPE_PASSAGE', reward_credits: 2500 };
    assert.equal(missionSettlement(offer, { speedBonus: true }).speedBonus, true);
    assert.equal(missionSettlement(offer).speedBonus, undefined);
  });

  test('only By-the-Book members lose morale on a covert contract', () => {
    assert.equal(covertAcceptPenalty(BY_THE_BOOK), 8);
    assert.equal(covertAcceptPenalty(NEUTRAL), 0);
    assert.equal(covertAcceptPenalty(PERFECTIONIST), 0);
  });
});

describe('HOME_BOUND (pure)', () => {
  const homeBound = member({ quirkId: HOME_BOUND });
  test('shore leave restores 25 at a home station and 12 at a home outpost, up to 86', () => {
    assert.deepEqual(shoreLeaveTerms([homeBound], 'STATION', homeBound, 'alpha'), { gain: 25, flightMult: 0, cap: 86 });
    assert.deepEqual(shoreLeaveTerms([homeBound], 'OUTPOST', homeBound, 'alpha'), { gain: 12, flightMult: 0.5, cap: 86 });
  });

  test('away from home it restores 8 at a station and 2 at an outpost, up to the usual 80', () => {
    for (const faction of ['beta', '']) {
      assert.deepEqual(shoreLeaveTerms([homeBound], 'STATION', homeBound, faction), { gain: 8, flightMult: 0, cap: 80 });
      assert.deepEqual(shoreLeaveTerms([homeBound], 'OUTPOST', homeBound, faction), { gain: 2, flightMult: 0.5, cap: 80 });
    }
  });

  test('a Master Chef still lifts the cap to 90, and the 86 never lowers it', () => {
    const chef = member({ crewClass: 'CHEF', rank: 'MASTER' });
    assert.equal(shoreLeaveTerms([homeBound, chef], 'STATION', homeBound, 'alpha').cap, 90);
    assert.equal(shoreLeaveTerms([homeBound, chef], 'STATION', homeBound, 'beta').cap, 90);
  });

  test('an Adept Chef galley makes an outpost leave a station leave', () => {
    const chef = member({ crewClass: 'CHEF', rank: 'ADEPT' });
    assert.equal(shoreLeaveTerms([homeBound, chef], 'OUTPOST', homeBound, 'alpha').gain, 25);
    assert.equal(shoreLeaveTerms([homeBound, chef], 'OUTPOST', homeBound, 'beta').gain, 8);
  });

  test('other quirks ignore the dock faction', () => {
    assert.deepEqual(shoreLeaveTerms([], 'STATION', member(), 'beta'), { gain: 15, flightMult: 0, cap: 80 });
    assert.deepEqual(shoreLeaveTerms([], 'STATION', member({ quirkId: 'Q06' }), 'beta'), { gain: 13, flightMult: 0, cap: 80 });
  });

  test('fatigue runs 20% faster when the dock is away from home, for this quirk alone', () => {
    assert.equal(fatigueIntervals(70 * MIN, homeBound, 'alpha'), 1);
    assert.equal(fatigueIntervals(70 * MIN, homeBound, 'beta'), 2);
    assert.equal(fatigueIntervals(70 * MIN, homeBound, ''), 2);
    assert.equal(fatigueIntervals(40 * MIN, homeBound, 'beta'), 0);
    assert.equal(fatigueIntervals(70 * MIN, member(), 'beta'), 1);
    assert.equal(fatigueIntervals(70 * MIN, member()), 1);
  });
});

const shipOf = (p) => app.prisma.spaceship.findFirst({ where: { playerId: p.id, active: true } });
const row = (id) => app.prisma.crewMember.findUnique({ where: { id } });
const shore = (p, receipt) => call(p, 'POST', '/game/crew/shore-leave', { dockedReceipt: receipt });
const flagsOf = (body) => app.jwt.verify(body.token).ship_attributes.crew_capability_flags;
const standingOf = async (pilot, factionId) =>
  (await app.prisma.playerReputation.findUnique({ where: { playerId_factionId: { playerId: pilot.id, factionId } } }))?.standing ?? 0;

describe('HOME_BOUND shore leave at a docked receipt', () => {
  const dock = (pilot, controllingFactionId) => dockedReceipt(pilot, { dockedEntityId: randomUUID(), controllingFactionId });

  test('+25 at a station governed by the home faction, +8 at any other, and the rested cap is 86 only at home', async () => {
    const cases = [
      ['alpha', 'alpha', 40, 65], ['alpha', 'beta', 40, 48], ['alpha', '', 40, 48],
      ['independent', '', 40, 65], ['alpha', 'alpha', 80, 86], ['alpha', 'beta', 78, 80]
    ];
    for (const [homeFactionId, governing, before, after] of cases) {
      const pilot = await newPilot('HomeBound');
      const crew = await addCrew(pilot, { crewClass: 'PILOT', quirkId: HOME_BOUND, homeFactionId, morale: before });
      const res = await shore(pilot, dock(pilot, governing));
      assert.equal(res.statusCode, 200, res.body);
      assert.equal((await row(crew.id)).morale, after, `${homeFactionId} at ${governing || 'independent'} from ${before}`);
    }
  });

  test('the leg flown to a dock away from home tires the crew member 20% faster', async () => {
    const intervals = async (governing) => {
      const pilot = await newPilot('Tired');
      await addCrew(pilot, { crewClass: 'PILOT', quirkId: HOME_BOUND, homeFactionId: 'alpha', morale: 75 });
      const ship = await shipOf(pilot);
      const station = randomUUID();
      const end = Date.now() - 2000;
      await app.prisma.spaceship.update({ where: { id: ship.id }, data: { lastCrewDockedAtMs: BigInt(end - 70 * MIN) } });
      const res = await shore(pilot, dockedReceipt(pilot, { dockedEntityId: station, dockedAtMs: end, controllingFactionId: governing }));
      assert.equal(res.statusCode, 200, res.body);
      return json(res).docking.effects[0].fatigueIntervals;
    };
    assert.equal(await intervals('alpha'), 1);
    assert.equal(await intervals('beta'), 2);
  });
});

// A mission held and completed through the routes.
const research = (pilot, overrides = {}) => signedOffer(pilot, { type: 'MISSION_TYPE_RESEARCH', required_berths: 0, ...overrides });
const covertOffer = (pilot, overrides = {}) => signedOffer(pilot, {
  type: 'MISSION_TYPE_RESEARCH', required_berths: 0, visibility: 'MISSION_VISIBILITY_COVERT', archetype: 'MISSION_ARCHETYPE_SABOTEUR_INSERTION',
  faction_id: 'beta', reputation_change: 20, opposed_faction_id: 'alpha', opposed_reputation_change: -15,
  clandestine_bonus_credits: 0, carries_contraband_or_operative: true, ...overrides
});
const accept = (pilot, offer) => call(pilot, 'POST', '/game/missions/accept', { offer, dockedReceipt: receiptAtOrigin(pilot, offer) });
async function hold(pilot, offer) {
  const res = await accept(pilot, offer);
  assert.equal(res.statusCode, 200, res.body);
  return json(res);
}
function claimFor(pilot, active, overrides = {}) {
  const claim = {
    missionId: active.mission_id, playerShipId: pilot.id, destinationStationId: active.offer.destination_station_id,
    acceptedAtMs: active.accepted_at_ms, completedAtMs: active.accepted_at_ms + 60_000, durationTakenMs: 60_000,
    rewardCredits: active.offer.reward_credits, reputationChange: active.offer.reputation_change,
    wasDetected: false, exposureScoreMilli: 0, opposedReputationChange: 0, bribePaidCredits: 0,
    ...overrides
  };
  claim.signature = sign(null, canonicalClaimPayload(claim, false, missionOfferVersion(active.offer)), rtseKey).toString('base64');
  return claim;
}
const complete = (pilot, active, overrides) => call(pilot, 'POST', '/game/missions/complete', { claim: claimFor(pilot, active, overrides) });
// Acceptance also docks the ship, which restores morale: set the crew's morale after it.
const setMorale = (crew, morale) => app.prisma.crewMember.update({ where: { id: crew.id }, data: { morale } });

describe('LOYALIST on a settled mission', () => {
  test('a mission for the home faction: +6 morale, +40% seniority XP and +10% reputation', async () => {
    const pilot = await newPilot('Loyal');
    const loyalist = await addCrew(pilot, { crewClass: 'PILOT', quirkId: LOYALIST, homeFactionId: 'alpha' });
    const plain = await addCrew(pilot, { crewClass: 'SCIENCE', quirkId: NEUTRAL, homeFactionId: 'alpha' });
    const { active } = await hold(pilot, research(pilot, { faction_id: 'alpha', reputation_change: 20 }));
    await setMorale(loyalist, 75);
    const res = await complete(pilot, active);
    assert.equal(res.statusCode, 200, res.body);
    const body = json(res);
    assert.equal((await row(loyalist.id)).morale, 81);
    assert.ok(body.xpGained > 0);
    assert.equal((await row(loyalist.id)).seniorityXp, Math.round(body.xpGained * 1.4));
    assert.equal((await row(plain.id)).seniorityXp, body.xpGained);
    assert.equal(body.reputation_change, 22);
    assert.equal(await standingOf(pilot, 'alpha'), 22);
    assert.deepEqual(body.crew_morale.find((e) => e.crewId === loyalist.id).quirkEffects, [{ quirk: 'LOYALIST', effect: 'HOME_FACTION' }]);
  });

  test('a mission for another faction is paid and rewarded as for any crew', async () => {
    const pilot = await newPilot('Loyal');
    const loyalist = await addCrew(pilot, { crewClass: 'PILOT', quirkId: LOYALIST, homeFactionId: 'beta' });
    const { active } = await hold(pilot, research(pilot, { faction_id: 'alpha', reputation_change: 20 }));
    await setMorale(loyalist, 75);
    const body = json(await complete(pilot, active));
    assert.equal((await row(loyalist.id)).morale, 79);
    assert.equal((await row(loyalist.id)).seniorityXp, body.xpGained);
    assert.equal(body.reputation_change, 20);
  });

  test('a covert mission against the home faction: -12 morale and capabilities off while it is held', async () => {
    const pilot = await newPilot('Betrayer');
    const loyalist = await addCrew(pilot, { crewClass: 'PILOT', rank: 'ADEPT', quirkId: LOYALIST, homeFactionId: 'alpha', morale: 75 });
    const bystander = await addCrew(pilot, { crewClass: 'SCIENCE', quirkId: LOYALIST, homeFactionId: 'gamma', morale: 75 });
    const before = await call(pilot, 'GET', '/ship/loadout');
    assert.equal(json(before).ship_attributes.crew_capability_flags, CREW_CAPABILITY.HOT_CASTOFF);

    const held = await hold(pilot, covertOffer(pilot));
    assert.equal(flagsOf(held), 0);
    assert.equal(json(await call(pilot, 'GET', '/ship/loadout')).ship_attributes.crew_capability_flags, 0);
    const listed = json(await call(pilot, 'GET', '/game/crew')).active.find((m) => m.id === loyalist.id);
    assert.deepEqual(listed.capabilities.map((c) => [c.capability, c.unlocked, c.active]), [['HOT_CASTOFF', true, false], ['COLD_DRIFT', false, false]]);
    assert.equal(json(await call(pilot, 'GET', '/game/crew')).active.find((m) => m.id === bystander.id).morale > 0, true);

    await setMorale(loyalist, 75);
    const res = await complete(pilot, held.active);
    assert.equal(res.statusCode, 200, res.body);
    assert.equal((await row(loyalist.id)).morale, 63);
    assert.deepEqual(json(res).crew_morale.find((e) => e.crewId === loyalist.id).quirkEffects,
      [{ quirk: 'LOYALIST', effect: 'OPPOSED_FACTION', moraleLoss: 12 }]);
    assert.equal(flagsOf(json(res)), CREW_CAPABILITY.HOT_CASTOFF);
    assert.equal(json(await call(pilot, 'GET', '/ship/loadout')).ship_attributes.crew_capability_flags, CREW_CAPABILITY.HOT_CASTOFF);
  });

  test('abandoning the mission turns the capabilities back on', async () => {
    const pilot = await newPilot('Betrayer');
    await addCrew(pilot, { crewClass: 'PILOT', rank: 'ADEPT', quirkId: LOYALIST, homeFactionId: 'alpha', morale: 75 });
    const { active } = await hold(pilot, covertOffer(pilot));
    const res = await call(pilot, 'POST', '/game/missions/abandon', { missionId: active.mission_id });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(flagsOf(json(res)), CREW_CAPABILITY.HOT_CASTOFF);
  });

  test('a mission for the home faction against another leaves the capabilities on', async () => {
    const pilot = await newPilot('Patriot');
    await addCrew(pilot, { crewClass: 'PILOT', rank: 'ADEPT', quirkId: LOYALIST, homeFactionId: 'alpha', morale: 75 });
    const held = await hold(pilot, covertOffer(pilot, { faction_id: 'alpha', opposed_faction_id: 'beta' }));
    assert.equal(flagsOf(held), CREW_CAPABILITY.HOT_CASTOFF);
  });
});

describe('PERFECTIONIST on a settled mission', () => {
  const run = async (rewardCredits) => {
    const pilot = await newPilot('Perfect');
    const crew = await addCrew(pilot, { crewClass: 'PILOT', quirkId: PERFECTIONIST });
    const { active } = await hold(pilot, research(pilot, { reward_credits: 2000 }));
    await setMorale(crew, 75);
    const res = await complete(pilot, active, rewardCredits === undefined ? {} : { rewardCredits });
    assert.equal(res.statusCode, 200, res.body);
    return { body: json(res), morale: (await row(crew.id)).morale, crew };
  };

  test('a speed bonus keeps the +4', async () => {
    assert.equal((await run(2400)).morale, 79);
  });

  test('paid the offered reward, the bonus window was missed: +4 and -8', async () => {
    const { body, morale, crew } = await run();
    assert.equal(morale, 71);
    assert.deepEqual(body.crew_morale.find((e) => e.crewId === crew.id).quirkEffects,
      [{ quirk: 'PERFECTIONIST', effect: 'SPEED_BONUS_MISSED', moraleLoss: 8 }]);
  });

  test('a late completion paid less than the offer also missed it', async () => {
    assert.equal((await run(1500)).morale, 71);
  });

  test('another quirk takes no penalty for the same claim', async () => {
    const pilot = await newPilot('Calm');
    const crew = await addCrew(pilot, { crewClass: 'PILOT', quirkId: NEUTRAL });
    const { active } = await hold(pilot, research(pilot));
    await setMorale(crew, 75);
    assert.equal((await complete(pilot, active)).statusCode, 200);
    assert.equal((await row(crew.id)).morale, 79);
  });
});

describe('BY_THE_BOOK on accepting a contract', () => {
  // The accept docks the ship: a first dock restores 15, so a member starting at 60 reaches 75 first.
  test('a covert contract costs 8 morale, reported beside the accept', async () => {
    const pilot = await newPilot('Book');
    const crew = await addCrew(pilot, { crewClass: 'CHEF', quirkId: BY_THE_BOOK, morale: 60 });
    const other = await addCrew(pilot, { crewClass: 'PILOT', quirkId: NEUTRAL, morale: 60 });
    const res = await accept(pilot, covertOffer(pilot));
    assert.equal(res.statusCode, 200, res.body);
    assert.equal((await row(crew.id)).morale, 67);
    assert.equal((await row(other.id)).morale, 75);
    const effects = json(res).crew_morale;
    assert.equal(effects.length, 1);
    assert.deepEqual([effects[0].crewId, effects[0].moraleBefore, effects[0].morale], [crew.id, 75, 67]);
    assert.deepEqual(effects[0].quirkEffects, [{ quirk: 'BY_THE_BOOK', effect: 'COVERT_ACCEPTED', moraleLoss: 8 }]);
  });

  test('an overt contract costs nothing', async () => {
    const pilot = await newPilot('Book');
    const crew = await addCrew(pilot, { crewClass: 'CHEF', quirkId: BY_THE_BOOK, morale: 60 });
    const res = await accept(pilot, research(pilot));
    assert.equal(res.statusCode, 200, res.body);
    assert.equal((await row(crew.id)).morale, 75);
    assert.equal(json(res).crew_morale, undefined);
  });

  test('a refused accept costs nothing', async () => {
    const pilot = await newPilot('Book');
    const crew = await addCrew(pilot, { crewClass: 'CHEF', quirkId: BY_THE_BOOK, morale: 60 });
    assert.equal((await accept(pilot, covertOffer(pilot))).statusCode, 200);
    await setMorale(crew, 60);
    const second = await accept(pilot, covertOffer(pilot));
    assert.equal(second.statusCode, 409);
    assert.equal((await row(crew.id)).morale, 60);
  });
});
