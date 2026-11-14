import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign } from 'node:crypto';
import {
  AWAY_TEAM_CLAIM_DOMAIN,
  awayTeamClaimNonceKey,
  awayTeamClaimProblem,
  canonicalAwayTeamClaimPayload,
  verifyAwayTeamClaim
} from '../src/lib/expedition.js';
import { EXPEDITION_MAX_CREW } from '../src/config/expedition.js';
import { CARGO_MAX_LOTS } from '../src/config/cargo.js';

// The fixed vectors from eotha-contracts `scripts/check-away-team-claim-vector.js` (and tests/contracts_test.rs):
// Ed25519 seed [7; 32], the seed the RTSE verifier tests use. This file assembles the expected bytes itself so the
// verifier is checked against the contracts hex, not against its own encoder.
const VECTOR_HEX =
  '454f5448415f415741595f5445414d5f434c41494d5f5631' + // domain, 24 bytes
  '07000000' + '70696c6f742d31' + // lp(pilot_id)
  '0f000000' + '383832383330383238316666666666' + // lp(system_h3)
  '09000000' + '706c616e65742d3461' + // lp(planet_id)
  '0f000000' + '386332383330383265313830316666' + // lp(site_node_h3)
  '09000000' + '6d697373696f6e2d31' + // lp(mission_id)
  '03000000' + '34210000' + 'fa000000' + // outcome_tier 3, reward_credits 8500, captain_xp 250
  '0f000000' + 'f6ffffff' + // sponsor_reputation_delta 15, rival_reputation_delta -10
  '02000000' + // crew_states count
  '08000000' + '637265772d736369' + '08000000' + '2d000000' + '00' + '00000000' + // crew-sci: +8, 45 xp, no trauma
  '08000000' + '637265772d656e67' + 'e7ffffff' + '14000000' + '01' + // crew-eng: -25, 20 xp, trauma
  '0f000000' + '524144494154494f4e5f4255524e53' + // lp(trauma_type) "RADIATION_BURNS"
  '01000000' + // recovered_lots count
  '12000000' + '505245435552534f525f4152544946414354' + // lp(resource_type) "PRECURSOR_ARTIFACT"
  'b80b0000' + '04000000' + '1c250000' + // units_milli 3000, grade 4, purity_bp 9500
  '0f000000' + '383832383330383238316666666666' + // lp(origin_system_h3)
  '04000000' + '62657461' + // lp(origin_faction_id) "beta"
  '10000000' + '444f4d45535449435f4f525f46524545' + // lp(customs_status) "DOMESTIC_OR_FREE"
  'f9464230a1010000' + // completed_at_ms 1791811012345
  'cd'.repeat(16); // nonce
const VECTOR_SIGNATURE =
  'hwE7ddZ5uDKw0xrRnXwdYhmVEb8Q4I+DP9PH1IyH+WxhDXd8/ee6Ly5Y+Ka/i2+pnUH190BEzG276ndd4sXmAQ==';
// An aborted free-roam expedition: empty mission_id, one crew member, no lots.
const EMPTY_VECTOR_HEX =
  '454f5448415f415741595f5445414d5f434c41494d5f5631' +
  '07000000' + '70696c6f742d31' +
  '0f000000' + '383832383330383238316666666666' +
  '09000000' + '706c616e65742d3461' +
  '0f000000' + '386332383330383265313830316666' +
  '00000000' + // lp(mission_id) empty: a zero length prefix
  '04000000' + '00000000' + '00000000' + // outcome_tier 4, reward_credits 0, captain_xp 0
  '00000000' + '00000000' + // reputation deltas 0
  '01000000' + // crew_states count
  '08000000' + '637265772d736369' + 'fbffffff' + '00000000' + '00' + '00000000' + // crew-sci: -5, 0 xp, no trauma, empty trauma_type
  '00000000' + // recovered_lots count
  'f9464230a1010000' +
  'cd'.repeat(16);
const EMPTY_SIGNATURE =
  'C4rUNajtsewhFrLVRwvI1TFF/8Lkc65HK83+7HWnqTUOfR1inUgmkpt+374WBmew1vwEEkUW+EzsmdrxsSNZDQ==';

const vectorKey = createPrivateKey({
  key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.alloc(32, 7)]),
  format: 'der',
  type: 'pkcs8'
});
const publicKey = createPublicKey(vectorKey);

const NONCE = Buffer.alloc(16, 0xcd).toString('base64');
const baseClaim = {
  pilotId: 'pilot-1',
  systemH3: '8828308281fffff',
  planetId: 'planet-4a',
  siteNodeH3: '8c283082e1801ff',
  completedAtMs: 1791811012345,
  nonce: NONCE
};
const vectorClaim = (overrides = {}) => ({
  ...baseClaim,
  missionId: 'mission-1',
  outcomeTier: 3,
  rewardCredits: 8500,
  captainXp: 250,
  sponsorReputationDelta: 15,
  rivalReputationDelta: -10,
  crewStates: [
    { crewId: 'crew-sci', classId: 'SCIENCE', rankId: 'ADEPT', moraleDelta: 8, seniorityXpEarned: 45 },
    {
      crewId: 'crew-eng',
      classId: 'ENGINEER',
      rankId: 'NOVICE',
      moraleDelta: -25,
      seniorityXpEarned: 20,
      sufferedTrauma: true,
      traumaType: 'RADIATION_BURNS'
    }
  ],
  recoveredLots: [
    {
      resourceType: 'PRECURSOR_ARTIFACT',
      unitsMilli: 3000,
      grade: 4,
      purityBp: 9500,
      originSystemH3: '8828308281fffff',
      originFactionId: 'beta',
      customsStatus: 'DOMESTIC_OR_FREE'
    }
  ],
  signature: VECTOR_SIGNATURE,
  ...overrides
});
// Proto-JSON omits every default value: the empty mission, trauma_type, lot list and reputation deltas.
const emptyClaim = (overrides = {}) => ({
  ...baseClaim,
  outcomeTier: 4,
  crewStates: [{ crewId: 'crew-sci', classId: 'SCIENCE', rankId: 'ADEPT', moraleDelta: -5 }],
  signature: EMPTY_SIGNATURE,
  ...overrides
});

// A claim the vector key signs, for tampering and bounds cases that no fixed signature covers.
const resign = (claim) => ({ ...claim, signature: sign(null, canonicalAwayTeamClaimPayload(claim), vectorKey).toString('base64') });

describe('away team claim verifier', () => {
  test('canonical payload and signature match the eotha-contracts vectors', () => {
    const payload = canonicalAwayTeamClaimPayload(vectorClaim());
    assert.equal(payload.length, 297);
    assert.equal(payload.toString('hex'), VECTOR_HEX);
    assert.equal(AWAY_TEAM_CLAIM_DOMAIN.length, 24);
    assert.equal(payload.subarray(0, 24).toString('ascii'), 'EOTHA_AWAY_TEAM_CLAIM_V1');
    assert.equal(sign(null, payload, vectorKey).toString('base64'), VECTOR_SIGNATURE);
    assert.equal(awayTeamClaimProblem(vectorClaim()), null);
    assert.equal(verifyAwayTeamClaim(vectorClaim(), publicKey), true);
  });

  test('an aborted free-roam claim with empty strings and no lots matches its vector', () => {
    const payload = canonicalAwayTeamClaimPayload(emptyClaim());
    assert.equal(payload.length, 167);
    assert.equal(payload.toString('hex'), EMPTY_VECTOR_HEX);
    assert.equal(sign(null, payload, vectorKey).toString('base64'), EMPTY_SIGNATURE);
    assert.equal(verifyAwayTeamClaim(emptyClaim(), publicKey), true);
    // Spelling the defaults out signs the same bytes.
    const explicit = emptyClaim({ missionId: '', rewardCredits: 0, captainXp: 0, recoveredLots: [], completedAtMs: '1791811012345' });
    assert.equal(canonicalAwayTeamClaimPayload(explicit).toString('hex'), EMPTY_VECTOR_HEX);
    assert.equal(verifyAwayTeamClaim(explicit, publicKey), true);
    assert.equal(verifyAwayTeamClaim(emptyClaim({ signature: VECTOR_SIGNATURE }), publicKey), false);
  });

  test('class and rank are display only: relabelling a member leaves the signature valid', () => {
    const claim = vectorClaim();
    const relabelled = { ...claim, crewStates: claim.crewStates.map((m) => ({ ...m, classId: 'DOCTOR', rankId: 'MASTER' })) };
    assert.equal(canonicalAwayTeamClaimPayload(relabelled).toString('hex'), VECTOR_HEX);
    assert.equal(verifyAwayTeamClaim(relabelled, publicKey), true);
  });

  test('flipping any signed field breaks verification', () => {
    const claim = vectorClaim();
    const tampered = {
      pilotId: 'pilot-2',
      systemH3: '8828308283fffff',
      planetId: 'planet-4b',
      siteNodeH3: '8c283082e1801fe',
      missionId: 'mission-2',
      outcomeTier: 2,
      rewardCredits: 8501,
      captainXp: 251,
      sponsorReputationDelta: 16,
      rivalReputationDelta: -9,
      completedAtMs: 1791811012344
    };
    for (const [field, value] of Object.entries(tampered)) {
      assert.equal(verifyAwayTeamClaim({ ...claim, [field]: value }, publicKey), false, field);
    }
    const withCrew = (index, change) => ({
      ...claim,
      crewStates: claim.crewStates.map((m, i) => (i === index ? { ...m, ...change } : m))
    });
    for (const [index, change] of [
      [0, { crewId: 'crew-xxx' }],
      [0, { moraleDelta: 9 }],
      [0, { seniorityXpEarned: 46 }],
      [0, { sufferedTrauma: true, traumaType: 'CONCUSSION' }],
      [1, { sufferedTrauma: false, traumaType: '' }],
      [1, { traumaType: 'HYPOTHERMIA' }]
    ]) {
      assert.equal(verifyAwayTeamClaim(withCrew(index, change), publicKey), false, JSON.stringify(change));
    }
    const [lot] = claim.recoveredLots;
    for (const change of [
      { resourceType: 'FERRITE' },
      { unitsMilli: 3001 },
      { grade: 5 },
      { purityBp: 9501 },
      { originSystemH3: '8828308283fffff' },
      { originFactionId: 'alpha' },
      { customsStatus: 'UNLICENSED_POACHED' }
    ]) {
      assert.equal(verifyAwayTeamClaim({ ...claim, recoveredLots: [{ ...lot, ...change }] }, publicKey), false, JSON.stringify(change));
    }
    // A dropped or added entry changes the signed counts.
    assert.equal(verifyAwayTeamClaim({ ...claim, crewStates: [claim.crewStates[0]] }, publicKey), false);
    assert.equal(verifyAwayTeamClaim({ ...claim, recoveredLots: [] }, publicKey), false);
    assert.equal(verifyAwayTeamClaim({ ...claim, recoveredLots: [lot, lot] }, publicKey), false);
    assert.equal(verifyAwayTeamClaim({ ...claim, nonce: Buffer.alloc(16, 0xcc).toString('base64') }, publicKey), false);
  });

  test("another record's domain never verifies as an away team claim", () => {
    const payload = canonicalAwayTeamClaimPayload(vectorClaim());
    const otherDomain = Buffer.concat([Buffer.from('EOTHA_MISSION_CLAIM_V1\0\0', 'ascii'), payload.subarray(24)]);
    assert.equal(otherDomain.length, payload.length);
    const signed = { ...vectorClaim(), signature: sign(null, otherDomain, vectorKey).toString('base64') };
    assert.equal(verifyAwayTeamClaim(signed, publicKey), false);
    // The same body signed under the right domain does verify, so only the domain differed.
    assert.equal(verifyAwayTeamClaim(resign(vectorClaim()), publicKey), true);
  });

  test('a signature by another key is refused', () => {
    const other = generateKeyPairSync('ed25519');
    assert.equal(verifyAwayTeamClaim(vectorClaim(), other.publicKey), false);
    assert.equal(verifyAwayTeamClaim(vectorClaim(), undefined), false);
  });

  test('a malformed claim is refused and never throws', () => {
    for (const claim of [undefined, null, 'claim', 42, [], {}]) {
      assert.equal(verifyAwayTeamClaim(claim, publicKey), false);
    }
    for (const signature of [undefined, '', 'AAAA', VECTOR_SIGNATURE.slice(0, -4) + 'AAAA', Buffer.alloc(63).toString('base64'), 7]) {
      assert.equal(verifyAwayTeamClaim(vectorClaim({ signature }), publicKey), false);
    }
    for (const nonce of [undefined, '', 'AAAA', Buffer.alloc(15, 0xcd).toString('base64'), Buffer.alloc(17, 0xcd).toString('base64')]) {
      assert.equal(verifyAwayTeamClaim(vectorClaim({ nonce }), publicKey), false);
    }
    assert.throws(() => canonicalAwayTeamClaimPayload(vectorClaim({ nonce: 'AAAA' })));
  });

  test('the nonce replay key is the hex of its 16 bytes', () => {
    assert.equal(awayTeamClaimNonceKey(vectorClaim()), 'cd'.repeat(16));
  });
});

// Bounds apply before the signature is looked at, so a case the encoder can express is signed by the real key: only
// the bounds stop it. A value the layout cannot hold at all (a negative u32, say) cannot be signed, and is refused too.
describe('away team claim bounds', () => {
  const refused = (claim, message) => {
    assert.match(awayTeamClaimProblem(claim), message);
    assert.equal(verifyAwayTeamClaim(claim, publicKey), false);
    let signed;
    try {
      signed = resign(claim);
    } catch {
      return;
    }
    assert.equal(verifyAwayTeamClaim(signed, publicKey), false);
  };
  const member = (n, overrides = {}) => ({ crewId: `crew-${n}`, moraleDelta: 0, seniorityXpEarned: 0, ...overrides });

  test('a claim within bounds verifies when signed by the key', () => {
    assert.equal(verifyAwayTeamClaim(resign(vectorClaim({ rewardCredits: 0xffffffff, captainXp: 0xffffffff })), publicKey), true);
    assert.equal(verifyAwayTeamClaim(resign(vectorClaim({ completedAtMs: '18446744073709551615' })), publicKey), true);
    assert.equal(verifyAwayTeamClaim(resign(vectorClaim({ outcomeTier: 1 })), publicKey), true);
    assert.equal(verifyAwayTeamClaim(resign(vectorClaim({ outcomeTier: 5 })), publicKey), true);
  });

  test('outcome tier must be 1 to 5', () => {
    for (const outcomeTier of [0, 6, -1, 2.5, '3', undefined]) refused(vectorClaim({ outcomeTier }), /outcomeTier/);
  });

  test('cells and identifiers must be well formed', () => {
    refused(vectorClaim({ pilotId: '' }), /pilotId/);
    refused(vectorClaim({ pilotId: 'p'.repeat(257) }), /pilotId/);
    refused(vectorClaim({ systemH3: '8828308281FFFFF' }), /systemH3/);
    refused(vectorClaim({ systemH3: '8828308281fffff0' }), /systemH3/);
    refused(vectorClaim({ siteNodeH3: '' }), /siteNodeH3/);
    refused(vectorClaim({ planetId: '' }), /planetId/);
    refused(vectorClaim({ missionId: 'm'.repeat(257) }), /missionId/);
  });

  test('credits, xp, reputation and time stay in their integer ranges', () => {
    refused(vectorClaim({ rewardCredits: 0x100000000 }), /rewardCredits/);
    refused(vectorClaim({ rewardCredits: -1 }), /rewardCredits/);
    refused(vectorClaim({ rewardCredits: 1.5 }), /rewardCredits/);
    refused(vectorClaim({ captainXp: 0x100000000 }), /captainXp/);
    refused(vectorClaim({ sponsorReputationDelta: 2001 }), /sponsorReputationDelta/);
    refused(vectorClaim({ rivalReputationDelta: -2001 }), /rivalReputationDelta/);
    refused(vectorClaim({ completedAtMs: -1 }), /completedAtMs/);
    refused(vectorClaim({ completedAtMs: '18446744073709551616' }), /completedAtMs/);
    refused(vectorClaim({ completedAtMs: 'soon' }), /completedAtMs/);
    refused(vectorClaim({ completedAtMs: undefined }), /completedAtMs/);
  });

  test('the away team is one to the berth limit of distinct members', () => {
    refused(vectorClaim({ crewStates: [] }), /crewStates/);
    refused(vectorClaim({ crewStates: Array.from({ length: EXPEDITION_MAX_CREW + 1 }, (_, i) => member(i)) }), /crewStates/);
    assert.equal(awayTeamClaimProblem(vectorClaim({ crewStates: Array.from({ length: EXPEDITION_MAX_CREW }, (_, i) => member(i)) })), null);
    refused(vectorClaim({ crewStates: [member(1), member(1)] }), /twice/);
    refused(vectorClaim({ crewStates: [member(1, { crewId: '' })] }), /crewId/);
    refused(vectorClaim({ crewStates: [member(1, { moraleDelta: 101 })] }), /moraleDelta/);
    refused(vectorClaim({ crewStates: [member(1, { moraleDelta: -101 })] }), /moraleDelta/);
    refused(vectorClaim({ crewStates: [member(1, { seniorityXpEarned: -1 })] }), /seniorityXpEarned/);
    refused(vectorClaim({ crewStates: [null] }), /crew state/);
  });

  test('trauma type is set exactly when the member suffered trauma', () => {
    refused(vectorClaim({ crewStates: [member(1, { sufferedTrauma: true })] }), /disagree/);
    refused(vectorClaim({ crewStates: [member(1, { sufferedTrauma: false, traumaType: 'CONCUSSION' })] }), /disagree/);
    refused(vectorClaim({ crewStates: [member(1, { sufferedTrauma: 1, traumaType: 'CONCUSSION' })] }), /sufferedTrauma/);
    refused(vectorClaim({ crewStates: [member(1, { sufferedTrauma: true, traumaType: 'T'.repeat(65) })] }), /traumaType/);
    assert.equal(awayTeamClaimProblem(vectorClaim({ crewStates: [member(1, { sufferedTrauma: true, traumaType: 'CONCUSSION' })] })), null);
  });

  test('recovered lots follow the cargo lot bounds', () => {
    const [lot] = vectorClaim().recoveredLots;
    refused(vectorClaim({ recoveredLots: Array.from({ length: CARGO_MAX_LOTS + 1 }, () => lot) }), /recoveredLots/);
    assert.equal(awayTeamClaimProblem(vectorClaim({ recoveredLots: Array.from({ length: CARGO_MAX_LOTS }, () => lot) })), null);
    refused(vectorClaim({ recoveredLots: [{ ...lot, resourceType: '' }] }), /resourceType/);
    refused(vectorClaim({ recoveredLots: [{ ...lot, unitsMilli: 0 }] }), /unitsMilli/);
    refused(vectorClaim({ recoveredLots: [{ ...lot, unitsMilli: 0x100000000 }] }), /unitsMilli/);
    refused(vectorClaim({ recoveredLots: [{ ...lot, grade: 0 }] }), /grade/);
    refused(vectorClaim({ recoveredLots: [{ ...lot, grade: 6 }] }), /grade/);
    refused(vectorClaim({ recoveredLots: [{ ...lot, purityBp: 10001 }] }), /purityBp/);
    refused(vectorClaim({ recoveredLots: [{ ...lot, originSystemH3: 'not-a-cell' }] }), /originSystemH3/);
    refused(vectorClaim({ recoveredLots: [{ ...lot, customsStatus: 'C'.repeat(65) }] }), /customsStatus/);
    // Empty provenance is a valid signed value.
    assert.equal(
      verifyAwayTeamClaim(resign(vectorClaim({ recoveredLots: [{ resourceType: 'FERRITE', unitsMilli: 1, grade: 1 }] })), publicKey),
      true
    );
  });
});
