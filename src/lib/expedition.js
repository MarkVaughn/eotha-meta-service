import { verify } from 'node:crypto';
import {
  EXPEDITION_LOT_GRADES,
  EXPEDITION_MAX_CREW,
  EXPEDITION_MAX_ID_LENGTH,
  EXPEDITION_MAX_LABEL_LENGTH,
  EXPEDITION_MAX_MORALE_DELTA,
  EXPEDITION_MAX_PURITY_BP,
  EXPEDITION_MAX_REPUTATION_DELTA,
  EXPEDITION_MIN_CREW,
  EXPEDITION_OUTCOME_TIERS
} from '../config/expedition.js';
import { CARGO_MAX_LOTS } from '../config/cargo.js';
import { H3_PATTERN } from '../config/patterns.js';
import { lotsPayload } from './cargo.js';

export const AWAY_TEAM_CLAIM_DOMAIN = Buffer.from('EOTHA_AWAY_TEAM_CLAIM_V1', 'utf8'); // 24 bytes

const U32_MAX = 0xffff_ffff;
const I32_MIN = -0x8000_0000;
const I32_MAX = 0x7fff_ffff;
const U64_MAX = 0xffff_ffff_ffff_ffffn;
const H3 = new RegExp(H3_PATTERN);
const NONCE_BYTES = 16;
const SIGNATURE_BYTES = 64;

function lenPrefixed(value) {
  const bytes = Buffer.from(value, 'utf8');
  const len = Buffer.alloc(4);
  len.writeUInt32LE(bytes.length);
  return Buffer.concat([len, bytes]);
}
function u32(value) {
  const buf = Buffer.alloc(4);
  buf.writeUInt32LE(value);
  return buf;
}
function i32(value) {
  const buf = Buffer.alloc(4);
  buf.writeInt32LE(value);
  return buf;
}
function u64(value) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt(value));
  return buf;
}

// A base64 field decoded to exactly `length` bytes, or null. Strict: it must be canonical padded base64, so two
// spellings never name the same bytes.
function base64Bytes(value, length) {
  if (typeof value !== 'string') return null;
  const bytes = Buffer.from(value, 'base64');
  return bytes.length === length && bytes.toString('base64') === value ? bytes : null;
}

// The value of an integer field: a JS integer, or for a uint64 the decimal string proto-JSON writes. Null otherwise.
function integer(value) {
  if (typeof value === 'number') return Number.isSafeInteger(value) ? BigInt(value) : null;
  if (typeof value === 'string' && /^-?\d+$/.test(value)) return BigInt(value);
  return null;
}

// Mirrors the `AwayTeamClaim` layout in eotha-contracts `rtse/v1/expedition.proto` and the vectors in
// `scripts/check-away-team-claim-vector.js` (EOTHA_AWAY_TEAM_CLAIM_V1): the 24 byte domain, lp(pilot_id),
// lp(system_h3), lp(planet_id), lp(site_node_h3), lp(mission_id), u32le outcome_tier, u32le reward_credits,
// u32le captain_xp, i32le sponsor_reputation_delta, i32le rival_reputation_delta, u32le crew count and per member
// lp(crew_id) || i32le morale_delta || u32le seniority_xp_earned || u8 suffered_trauma || lp(trauma_type), then the
// recovered lots in the CargoLot layout (src/lib/cargo.js lotsPayload, provenance included), u64le completed_at_ms and
// the 16 nonce bytes. `class_id`, `rank_id` and the signature are not signed.
// `claim` is the camelCase proto-JSON of an AwayTeamClaim, `nonce` base64; proto-JSON omits a default value, so an
// absent string, number, bool or list reads as empty, 0, false or []. Throws on a malformed field;
// `verifyAwayTeamClaim` is the caller that never does.
export function canonicalAwayTeamClaimPayload(claim) {
  const nonce = base64Bytes(claim.nonce, NONCE_BYTES);
  if (!nonce) throw new Error('nonce must be 16 bytes.');
  const crewStates = claim.crewStates ?? [];
  return Buffer.concat([
    AWAY_TEAM_CLAIM_DOMAIN,
    lenPrefixed(claim.pilotId),
    lenPrefixed(claim.systemH3),
    lenPrefixed(claim.planetId),
    lenPrefixed(claim.siteNodeH3),
    lenPrefixed(claim.missionId ?? ''),
    u32(claim.outcomeTier),
    u32(claim.rewardCredits ?? 0),
    u32(claim.captainXp ?? 0),
    i32(claim.sponsorReputationDelta ?? 0),
    i32(claim.rivalReputationDelta ?? 0),
    u32(crewStates.length),
    ...crewStates.flatMap((member) => [
      lenPrefixed(member.crewId),
      i32(member.moraleDelta ?? 0),
      u32(member.seniorityXpEarned ?? 0),
      Buffer.from([member.sufferedTrauma ? 1 : 0]),
      lenPrefixed(member.traumaType ?? '')
    ]),
    lotsPayload(claim.recoveredLots ?? []),
    u64(claim.completedAtMs),
    nonce
  ]);
}

const isString = (value, { min = 0, max = EXPEDITION_MAX_ID_LENGTH } = {}) =>
  typeof value === 'string' && Buffer.byteLength(value, 'utf8') >= min && Buffer.byteLength(value, 'utf8') <= max;
const inRange = (value, min, max) => {
  const n = integer(value ?? 0);
  return n !== null && n >= BigInt(min) && n <= BigInt(max);
};

function crewStateProblem(member) {
  if (!member || typeof member !== 'object') return 'a crew state is not an object';
  if (!isString(member.crewId, { min: 1 })) return 'crewId is empty or too long';
  if (!inRange(member.moraleDelta, -EXPEDITION_MAX_MORALE_DELTA, EXPEDITION_MAX_MORALE_DELTA)) return 'moraleDelta is out of bounds';
  if (!inRange(member.seniorityXpEarned, 0, U32_MAX)) return 'seniorityXpEarned is out of bounds';
  const suffered = member.sufferedTrauma ?? false;
  const trauma = member.traumaType ?? '';
  if (typeof suffered !== 'boolean') return 'sufferedTrauma is not a boolean';
  if (!isString(trauma, { max: EXPEDITION_MAX_LABEL_LENGTH })) return 'traumaType is too long';
  // The contract: trauma_type is empty exactly when suffered_trauma is false.
  if (suffered === (trauma === '')) return 'traumaType and sufferedTrauma disagree';
  return null;
}

function lotProblem(lot) {
  if (!lot || typeof lot !== 'object') return 'a recovered lot is not an object';
  if (!isString(lot.resourceType, { min: 1, max: EXPEDITION_MAX_LABEL_LENGTH })) return 'resourceType is empty or too long';
  if (!inRange(lot.unitsMilli, 1, U32_MAX)) return 'unitsMilli is out of bounds';
  if (!Number.isInteger(lot.grade) || !EXPEDITION_LOT_GRADES.includes(lot.grade)) return 'grade is out of bounds';
  if (!inRange(lot.purityBp, 0, EXPEDITION_MAX_PURITY_BP)) return 'purityBp is out of bounds';
  const origin = lot.originSystemH3 ?? '';
  if (typeof origin !== 'string' || (origin !== '' && !H3.test(origin))) return 'originSystemH3 is not a system cell';
  if (!isString(lot.originFactionId ?? '', { max: EXPEDITION_MAX_LABEL_LENGTH })) return 'originFactionId is too long';
  if (!isString(lot.customsStatus ?? '', { max: EXPEDITION_MAX_LABEL_LENGTH })) return 'customsStatus is too long';
  return null;
}

// Why `claim` is not one an engine could have signed, or null when every field is in bounds. Checks shape only:
// which pilot, planet or crew exist is for the settle route, and the signature is `verifyAwayTeamClaim`'s.
export function awayTeamClaimProblem(claim) {
  if (!claim || typeof claim !== 'object') return 'the claim is not an object';
  if (!isString(claim.pilotId, { min: 1 })) return 'pilotId is empty or too long';
  if (typeof claim.systemH3 !== 'string' || !H3.test(claim.systemH3)) return 'systemH3 is not a system cell';
  if (!isString(claim.planetId, { min: 1 })) return 'planetId is empty or too long';
  if (typeof claim.siteNodeH3 !== 'string' || !H3.test(claim.siteNodeH3)) return 'siteNodeH3 is not a site cell';
  if (!isString(claim.missionId ?? '')) return 'missionId is too long';
  if (!Number.isInteger(claim.outcomeTier) || !EXPEDITION_OUTCOME_TIERS.includes(claim.outcomeTier)) return 'outcomeTier is out of bounds';
  if (!inRange(claim.rewardCredits, 0, U32_MAX)) return 'rewardCredits is out of bounds';
  if (!inRange(claim.captainXp, 0, U32_MAX)) return 'captainXp is out of bounds';
  if (!inRange(claim.sponsorReputationDelta, -EXPEDITION_MAX_REPUTATION_DELTA, EXPEDITION_MAX_REPUTATION_DELTA)) return 'sponsorReputationDelta is out of bounds';
  if (!inRange(claim.rivalReputationDelta, -EXPEDITION_MAX_REPUTATION_DELTA, EXPEDITION_MAX_REPUTATION_DELTA)) return 'rivalReputationDelta is out of bounds';

  const crew = claim.crewStates ?? [];
  if (!Array.isArray(crew) || crew.length < EXPEDITION_MIN_CREW || crew.length > EXPEDITION_MAX_CREW) return 'crewStates is empty or too long';
  for (const member of crew) {
    const problem = crewStateProblem(member);
    if (problem) return problem;
  }
  if (new Set(crew.map((member) => member.crewId)).size !== crew.length) return 'crewStates names a member twice';

  const lots = claim.recoveredLots ?? [];
  if (!Array.isArray(lots) || lots.length > CARGO_MAX_LOTS) return 'recoveredLots is too long';
  for (const lot of lots) {
    const problem = lotProblem(lot);
    if (problem) return problem;
  }

  const completedAtMs = integer(claim.completedAtMs);
  if (completedAtMs === null || completedAtMs < 0n || completedAtMs > U64_MAX) return 'completedAtMs is out of bounds';
  if (!base64Bytes(claim.nonce, NONCE_BYTES)) return 'nonce is not 16 bytes of base64';
  if (!base64Bytes(claim.signature, SIGNATURE_BYTES)) return 'signature is not 64 bytes of base64';
  return null;
}

// Whether `claim` is one the RTSE signed: every field within `awayTeamClaimProblem`'s bounds and a valid Ed25519
// signature (`claim.signature`, base64 of 64 bytes) by `publicKey` over the canonical EOTHA_AWAY_TEAM_CLAIM_V1
// payload. The domain is part of the signed bytes, so a signature made under any other record's domain never
// verifies. Never throws.
export function verifyAwayTeamClaim(claim, publicKey) {
  if (!publicKey || awayTeamClaimProblem(claim) !== null) return false;
  try {
    const payload = canonicalAwayTeamClaimPayload(claim);
    if (!payload.subarray(0, AWAY_TEAM_CLAIM_DOMAIN.length).equals(AWAY_TEAM_CLAIM_DOMAIN)) return false;
    return verify(null, payload, publicKey, base64Bytes(claim.signature, SIGNATURE_BYTES));
  } catch {
    return false;
  }
}

// The replay key of `claim` (`ExpeditionRecord.nonceHex`): the hex of its 16 nonce bytes, as the other signed records
// store theirs.
export const awayTeamClaimNonceKey = (claim) => Buffer.from(claim.nonce, 'base64').toString('hex');
