import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPrivateKey, createPublicKey, sign } from 'node:crypto';
import {
  canonicalMissionOfferPayload, missionOfferVersion, verifyMissionOffer
} from '../src/lib/mission-offer.js';
import { canonicalClaimPayload, verifyClaimSignature } from '../src/lib/mission-claim.js';

// Fixed merged eotha-contracts check-mission-{offer,claim}-vector.js vectors, also pinned
// in the engine tests. This key is the public test seed [7;32], not a production credential.
const privateKey = createPrivateKey({
  key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.alloc(32, 7)]),
  format: 'der', type: 'pkcs8'
});
const publicKey = createPublicKey(privateKey);
const saboteur = {
  pilot_id: 'pilot-1', offered_at_ms: 1791811000000,
  mission_id: '0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a', type: 'MISSION_TYPE_PASSAGE',
  title: 'Insert an operative at SYS-3082A9 I Station',
  description: 'Slip 1 operative into beta space without being traced.',
  origin_station_id: '2fe1f208-c003-44c5-929e-1b020d5a2e47', origin_system_h3: '8828308283fffff',
  destination_station_id: '3536a1db-5599-4b6f-bde9-d48524d31061', destination_system_h3: '88283082a9fffff',
  destination_node_h3: '8c283082a9001ff', destination_lat: 37.78125, destination_lng: -122.40625,
  distance_hexes: 2, required_berths: 1, duration_limit_ms: 600000, reward_credits: 2500,
  reputation_change: 25, faction_id: 'alpha', expires_at_ms: 1791812800000,
  visibility: 'MISSION_VISIBILITY_COVERT', archetype: 'MISSION_ARCHETYPE_SABOTEUR_INSERTION',
  opposed_faction_id: 'beta', opposed_reputation_change: -15, clandestine_bonus_credits: 625,
  carries_contraband_or_operative: true, required_flying_colors_faction_id: '',
  signature: 'w2dj2+ilYpC0k/rkb3vXFstyxRRvo5RLbIPaXSeiItQOI4FS9iTI4JM4ttGvTPrOA8Bse/JsW0gSvIhZOz6tCA=='
};
const arms = {
  ...saboteur, mission_id: '0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b', type: 'MISSION_TYPE_GATHER',
  title: 'Deliver 20 m3 of TITANIUM to SYS-3082A9 I Station',
  description: 'Deliver 20 m3 of grade 4+ TITANIUM to SYS-3082A9 I Station in SYS-3082A9 System.',
  required_berths: 0, duration_limit_ms: 1500000, reward_credits: 5000, reputation_change: 5,
  resource_type: 'TITANIUM', min_grade: 4, quantity_m3: 20,
  source_body_id: '5a1b7c3e-8d2f-4e6a-9b04-c1d2e3f40516', source_system_h3: '8828308281fffff',
  source_node_h3: '8c28308281001ff', source_lat: 37.75, source_lng: -122.4375,
  archetype: 'MISSION_ARCHETYPE_ARMS_DELIVERY', opposed_reputation_change: -20, clandestine_bonus_credits: 1250,
  signature: 'YmJx51Dqhsk+OYRdldgSyNwFNk2UMikS2TLdR9iDFMpfc29qJELs3RvK1sVZSYFaqn3WwgkD6vpVp4fTYZEBBw=='
};

test('V2 passage and gather offer bytes/signatures match contracts, including JSON round trip', () => {
  for (const [offer, length] of [[saboteur, 421], [arms, 567]]) {
    const copy = JSON.parse(JSON.stringify(offer));
    const bytes = canonicalMissionOfferPayload(copy);
    assert.equal(bytes.length, length);
    assert.equal(sign(null, bytes, privateKey).toString('base64'), offer.signature);
    assert.equal(verifyMissionOffer(copy, publicKey), true);
    // Both proto enum names and the engine JWT integer representation encode identical bytes.
    assert.deepEqual(canonicalMissionOfferPayload({ ...offer, visibility: 2, archetype: offer === arms ? 6 : 2 }), bytes);
  }
});

test('all seven V2 offer fields are signed; unsigned V1/V2 mixes and domain downgrades fail', () => {
  for (const changes of [
    { visibility: 'MISSION_VISIBILITY_OVERT' }, { archetype: 'MISSION_ARCHETYPE_SYNDICATE_EXTRACTION' },
    { opposed_faction_id: 'gamma' }, { opposed_reputation_change: -16 }, { clandestine_bonus_credits: 626 },
    { carries_contraband_or_operative: false }, { required_flying_colors_faction_id: 'alpha' }
  ]) assert.equal(verifyMissionOffer({ ...saboteur, ...changes }, publicKey), false);
  const v1 = { ...saboteur, visibility: 0, archetype: 0, opposed_faction_id: '', opposed_reputation_change: 0,
    clandestine_bonus_credits: 0, carries_contraband_or_operative: false, required_flying_colors_faction_id: '' };
  assert.equal(missionOfferVersion(v1), 1);
  assert.equal(verifyMissionOffer(v1, publicKey), false);
  v1.signature = sign(null, canonicalMissionOfferPayload(v1), privateKey).toString('base64');
  assert.equal(verifyMissionOffer(v1, publicKey), true);
  assert.equal(verifyMissionOffer({ ...v1, clandestine_bonus_credits: '0' }, publicKey), true);
  for (const changes of [
    { archetype: 2 }, { opposed_faction_id: 'beta' }, { opposed_reputation_change: -15 },
    { clandestine_bonus_credits: 625 }, { carries_contraband_or_operative: true },
    { required_flying_colors_faction_id: 'alpha' }
  ]) assert.equal(verifyMissionOffer({ ...v1, ...changes }, publicKey), false);
  assert.equal(verifyMissionOffer({ ...v1, visibility: 1 }, publicKey), false);
});

const passageClaim = {
  missionId: 'm1', playerShipId: 'ship', destinationStationId: 'st',
  // Full uint64 test vectors deliberately exceed JS safe numbers: the encoder accepts strings.
  acceptedAtMs: BigInt('0x0102030405060708').toString(), completedAtMs: BigInt('0x1112131415161718').toString(),
  rewardCredits: BigInt('0x2122232425262728').toString(), reputationChange: -2,
  wasDetected: true, exposureScoreMilli: 74500, opposedReputationChange: -20, bribePaidCredits: 0
};
const passageHex = '454f5448415f4d495353494f4e5f434c41494d5f5632020000006d310400000073686970020000007374080706050403020118171615141312112827262524232221feffffff0104230100ecffffff0000000000000000';
const gatherClaim = {
  missionId: 'm1', playerShipId: 'ship', destinationStationId: 'st', acceptedAtMs: 1700000100000,
  completedAtMs: 1700000400000, rewardCredits: 5000, reputationChange: 5,
  leaseId: '11111111-1111-1111-1111-111111111111', sessionId: '22222222-2222-2222-2222-222222222222', cargoSeq: 9,
  remaining: [{ resourceType: 'TITANIUM', unitsMilli: 4500, grade: 4, purityBp: 8000 }],
  wasDetected: false, exposureScoreMilli: 22000, opposedReputationChange: 0, bribePaidCredits: 4500
};
const gatherHex = '454f5448415f4d495353494f4e5f434c41494d5f5632020000006d310400000073686970020000007374a0eee6cf8b0100008082ebcf8b010000881300000000000005000000111111111111111111111111111111112222222222222222222222222222222209000000000000000100000008000000544954414e49554d9411000004000000401f000000f0550000000000009411000000000000';

test('V2 claim passage/gather match full contracts vectors; cargo precedes attribution suffix', () => {
  for (const [claim, gather, hex] of [[passageClaim, false, passageHex], [gatherClaim, true, gatherHex]]) {
    const bytes = canonicalClaimPayload(claim, gather, 2);
    assert.equal(bytes.toString('hex'), hex);
    const signed = { ...claim, signature: sign(null, bytes, privateKey).toString('base64') };
    assert.equal(verifyClaimSignature(JSON.parse(JSON.stringify(signed)), publicKey, gather, 2), true);
    for (const changes of [
      { wasDetected: !claim.wasDetected }, { exposureScoreMilli: claim.exposureScoreMilli + 1 },
      { opposedReputationChange: -19 }, { bribePaidCredits: claim.bribePaidCredits + 1 },
      ...(gather ? [{ cargoSeq: 10 }, { remaining: [] }] : [])
    ]) assert.equal(verifyClaimSignature({ ...signed, ...changes }, publicKey, gather, 2), false);
    assert.equal(verifyClaimSignature(signed, publicKey, gather, 1), false);
  }
});

test('zero V2 claim suffix still uses V2; V1 regression and unsigned attribution rejection', () => {
  const zero = { ...passageClaim, wasDetected: false, exposureScoreMilli: 0, opposedReputationChange: 0 };
  const v2 = { ...zero, signature: sign(null, canonicalClaimPayload(zero, false, 2), privateKey).toString('base64') };
  assert.equal(verifyClaimSignature(v2, publicKey, false, 2), true);
  assert.equal(verifyClaimSignature(v2, publicKey), false);
  const v1 = { ...zero, signature: sign(null, canonicalClaimPayload(zero), privateKey).toString('base64') };
  assert.equal(verifyClaimSignature(v1, publicKey), true);
  assert.equal(verifyClaimSignature({ ...v1, bribePaidCredits: '0' }, publicKey), true);
  assert.equal(verifyClaimSignature(v1, publicKey, false, 2), false);
  for (const changes of [{ wasDetected: true }, { exposureScoreMilli: 1 }, { opposedReputationChange: -1 }, { bribePaidCredits: 1 }]) {
    assert.equal(verifyClaimSignature({ ...v1, ...changes }, publicKey), false);
  }
});
