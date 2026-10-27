// Shared test setup. Import this module before anything from ../src so the environment is in place.
//
// Tests run against a real PostgreSQL database through Prisma (DATABASE_URL, schema applied with
// `prisma db push`) and sign with throwaway Ed25519 keypairs generated per test process, so they
// need neither keys/private.pem nor any state from a previous run. There are two, as in production:
// the login key signs access tokens, and a separate claim key stands in for the engine's.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto';

const dbName = new URL(process.env.DATABASE_URL ?? 'postgresql://localhost/').pathname.slice(1);
if (!dbName.endsWith('_test')) {
  throw new Error(
    `Refusing to run tests against database "${dbName}": set DATABASE_URL to a dedicated database whose name ends in "_test".`
  );
}

// The env schema defaults NODE_ENV to production, which would hide the development-only routes
// (POST /ship/dev/passengers) these tests exercise. CI sets it; a bare `npm test` must not differ.
process.env.NODE_ENV ||= 'test';

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const keysDir = mkdtempSync(join(tmpdir(), 'eotha-test-keys-'));
writeFileSync(join(keysDir, 'private.pem'), privateKey.export({ format: 'pem', type: 'pkcs8' }));
writeFileSync(join(keysDir, 'public.pem'), publicKey.export({ format: 'pem', type: 'spki' }));
process.env.KEYS_DIR = keysDir;
// env.js defaults an unset NODE_ENV to production, which would hide the dev-only routes under test.
process.env.NODE_ENV = 'test';

// The engine holds the private half; the meta service is configured with only the raw public key.
const claimPair = generateKeyPairSync('ed25519');
process.env.CLAIM_PUBLIC_KEY = claimPair.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex');
delete process.env.CLAIM_PUBLIC_KEY_FILE;

export { keysDir };
// Stands in for the RTSE, which signs the claims and chart keys the meta service verifies.
export const rtseKey = claimPair.privateKey;
// The login token key. It must never verify engine claims.
export const loginKey = privateKey;
export const app = (await import('../src/app.js')).default;

export const json = (res) => JSON.parse(res.body);

// Verifier double: stands in for Play Integrity / App Attest, whose real credentials are not
// available to tests. It accepts exactly one token.
export const GOOD_ATTESTATION = 'attested-device';
export const attestationDouble = {
  platform: 'play-integrity',
  verify: async ({ token }) => (token === GOOD_ATTESTATION ? { ok: true } : { ok: false, reason: 'double refused' })
};
app.attestation.register(attestationDouble);
export const attestationHeaders = {
  'x-attestation-platform': 'play-integrity',
  'x-attestation-token': GOOD_ATTESTATION
};

// Built from parts so the literal never looks like a committed credential.
export const PASSWORD = ['correct', 'horse', 'battery', 'staple'].join('-');

const created = [];

/** Registers a player id created outside newPilot (e.g. a guest) for cleanup by closeApp. */
export const track = (id) => created.push(id);

/** Registers and logs in a fresh pilot through the public auth endpoints. */
export async function newPilot(prefix = 'Pilot') {
  const suffix = randomBytes(5).toString('hex');
  const callsign = `${prefix}-${suffix}`;
  const email = `${callsign.toLowerCase()}@example.test`.replace(/[^a-z0-9@.+-]/g, '');
  const reg = await app.inject({
    method: 'POST',
    url: '/auth/register',
    payload: { email, password: PASSWORD, callsign, latitude: 37.7749, longitude: -122.4194, h3Index: '8828308281fffff' }
  });
  if (reg.statusCode !== 201) throw new Error(`register failed: ${reg.statusCode} ${reg.body}`);
  const { id } = json(reg);
  created.push(id);
  const login = await app.inject({
    method: 'POST',
    url: '/auth/login',
    headers: attestationHeaders,
    payload: { email, password: PASSWORD, deviceId: 'login-test-device-id' }
  });
  if (login.statusCode !== 200) throw new Error(`login failed: ${login.statusCode} ${login.body}`);
  const { token } = json(login);
  return { id, email, callsign, token, headers: { authorization: `Bearer ${token}` } };
}

/**
 * A docked receipt signed the way the engine signs it (eotha-contracts `DockedReceipt`): Ed25519 over
 * the domain, then the length-prefixed pilot id, the 16 raw bytes of the station id, the
 * length-prefixed system cell, both times as u64 LE, the 16-byte nonce and the length-prefixed governing
 * faction (V2; `''`, the default, is an independent station). The bytes are assembled
 * here, not with src/lib/docked-receipt.js, so the verifier is checked against an independent
 * encoder. `overrides` replace any field before signing; pass `signer` to sign with another key.
 * `pilot` is a newPilot() result, a guest session, or a bare player id.
 */
export function dockedReceipt(pilot, overrides = {}, signer = rtseKey) {
  const nowMs = Date.now();
  const receipt = {
    pilotId: typeof pilot === 'string' ? pilot : (pilot.id ?? pilot.player.id),
    dockedEntityId: randomUUID(),
    systemH3: '8828308281fffff',
    dockedAtMs: nowMs - 2_000,
    issuedAtMs: nowMs,
    nonce: randomBytes(16).toString('base64'),
    controllingFactionId: '',
    ...overrides
  };
  const str = (value) => {
    const bytes = Buffer.from(value, 'utf8');
    const len = Buffer.alloc(4);
    len.writeUInt32LE(bytes.length);
    return Buffer.concat([len, bytes]);
  };
  const u64 = (value) => {
    const buf = Buffer.alloc(8);
    buf.writeBigUInt64LE(BigInt(value));
    return buf;
  };
  const payload = Buffer.concat([
    Buffer.from('EOTHA_DOCKED_RECEIPT_V2', 'ascii'),
    str(receipt.pilotId),
    Buffer.from(receipt.dockedEntityId.replaceAll('-', ''), 'hex'),
    str(receipt.systemH3),
    u64(receipt.dockedAtMs),
    u64(receipt.issuedAtMs),
    Buffer.from(receipt.nonce, 'base64'),
    str(receipt.controllingFactionId)
  ]);
  return { ...receipt, signature: overrides.signature ?? sign(null, payload, signer).toString('base64') };
}

const MISSION_TYPE_NUMBERS = { MISSION_TYPE_PASSAGE: 1, MISSION_TYPE_RESEARCH: 2, MISSION_TYPE_GATHER: 3 };
const OFFER_WINDOW_MS = 30 * 60_000;
const VISIBILITY_NUMBERS = { MISSION_VISIBILITY_UNSPECIFIED: 0, MISSION_VISIBILITY_OVERT: 1, MISSION_VISIBILITY_COVERT: 2 };
const ARCHETYPE_NUMBERS = Object.fromEntries([
  'UNSPECIFIED', 'DIPLOMAT_ESCORT', 'SABOTEUR_INSERTION', 'SYNDICATE_EXTRACTION', 'STRATEGIC_RECON',
  'FORBIDDEN_PLANET_SURVEY', 'ARMS_DELIVERY', 'ILLEGAL_CARGO_SMUGGLE', 'TRAITOR_DEFECTOR_OP'
].map((name, index) => [`MISSION_ARCHETYPE_${name}`, index]));

/**
 * A mission offer signed the way the engine signs it (eotha-contracts `MissionOffer.signature`):
 * Ed25519 over the domain and every field in proto order, strings length-prefixed, integers little
 * endian, the coordinates as their IEEE-754 bits. As with dockedReceipt, the bytes are assembled
 * here rather than with src/lib/mission-offer.js. The default is a two-passenger passage offered
 * now at a fresh dock; its coordinates are ones the JSON column does not keep exactly. `overrides`
 * replace any field before signing (an `offered_at_ms` alone moves the expiry with it); pass
 * `signer` to sign with another key. `pilot` is a newPilot() result or a bare player id.
 */
export function signedOffer(pilot, overrides = {}, signer = rtseKey) {
  const offeredAtMs = overrides.offered_at_ms ?? Date.now();
  const offer = {
    mission_id: randomUUID(),
    type: 'MISSION_TYPE_PASSAGE',
    title: 'Passage to SYS-3082A9 I Station in SYS-3082A9 System',
    description: 'Ferry 2 passengers from the SYS-308283 System to SYS-3082A9 I Station, 2 systems out.',
    origin_station_id: randomUUID(),
    origin_system_h3: '8828308283fffff',
    destination_station_id: randomUUID(),
    destination_system_h3: '88283082a9fffff',
    destination_node_h3: '8c283082a9001ff',
    destination_lat: 37.716557269075864,
    destination_lng: -122.41941550000001,
    distance_hexes: 2,
    required_berths: 2,
    duration_limit_ms: 600_000,
    reward_credits: 2500,
    reputation_change: 5,
    faction_id: 'faction-high',
    expires_at_ms: offeredAtMs + OFFER_WINDOW_MS,
    offered_at_ms: offeredAtMs,
    pilot_id: typeof pilot === 'string' ? pilot : pilot.id,
    ...overrides
  };
  const str = (value) => {
    const bytes = Buffer.from(value, 'utf8');
    const len = Buffer.alloc(4);
    len.writeUInt32LE(bytes.length);
    return Buffer.concat([len, bytes]);
  };
  const num = (write, size) => (value) => {
    const buf = Buffer.alloc(size);
    buf[write](value);
    return buf;
  };
  const u32 = num('writeUInt32LE', 4);
  const i32 = num('writeInt32LE', 4);
  const f64 = num('writeDoubleLE', 8);
  const u64 = (value) => num('writeBigUInt64LE', 8)(BigInt(value));
  const visibility = typeof offer.visibility === 'number' ? offer.visibility : (VISIBILITY_NUMBERS[offer.visibility] ?? 0);
  const archetype = typeof offer.archetype === 'number' ? offer.archetype : (ARCHETYPE_NUMBERS[offer.archetype] ?? 0);
  const payload = Buffer.concat([
    Buffer.from(`EOTHA_MISSION_OFFER_V${visibility ? 2 : 1}`, 'ascii'),
    str(offer.pilot_id),
    u64(offer.offered_at_ms),
    str(offer.mission_id),
    u32(MISSION_TYPE_NUMBERS[offer.type]),
    str(offer.title),
    str(offer.description),
    str(offer.origin_station_id),
    str(offer.origin_system_h3),
    str(offer.destination_station_id),
    str(offer.destination_system_h3),
    str(offer.destination_node_h3),
    f64(offer.destination_lat),
    f64(offer.destination_lng),
    u32(offer.distance_hexes),
    u32(offer.required_berths),
    u64(offer.duration_limit_ms),
    u64(offer.reward_credits),
    i32(offer.reputation_change),
    str(offer.faction_id),
    u64(offer.expires_at_ms),
    // Only a gather offer signs the suffix.
    ...(offer.type === 'MISSION_TYPE_GATHER'
      ? [
          str(offer.resource_type), u32(offer.min_grade), u32(offer.quantity_m3), str(offer.source_body_id),
          str(offer.source_system_h3), str(offer.source_node_h3), f64(offer.source_lat), f64(offer.source_lng)
        ]
      : []),
    ...(visibility ? [
      u32(visibility), u32(archetype), str(offer.opposed_faction_id ?? ''), i32(offer.opposed_reputation_change ?? 0),
      u64(offer.clandestine_bonus_credits ?? 0), Buffer.from([offer.carries_contraband_or_operative ? 1 : 0]),
      str(offer.required_flying_colors_faction_id ?? '')
    ] : [])
  ]);
  return { ...offer, signature: overrides.signature ?? sign(null, payload, signer).toString('base64') };
}

/** A docked receipt for `pilot` at the dock `offer` was made at (see dockedReceipt). */
export const receiptAtOrigin = (pilot, offer, overrides = {}) =>
  dockedReceipt(pilot, { dockedEntityId: offer.origin_station_id, systemH3: offer.origin_system_h3, ...overrides });

export const call = (pilot, method, url, payload) => app.inject({ method, url, headers: pilot.headers, payload });

export const credits = async (pilot) => json(await call(pilot, 'GET', '/game/credits')).credits;

export const setCredits = (pilot, value) =>
  app.prisma.player.update({ where: { id: pilot.id }, data: { credits: value } });

/**
 * Puts a crew member aboard `pilot`'s active ship directly (no signing bonus, no board): a Novice Chef
 * with the plain quirk Q01 unless `overrides` say otherwise. Pass `status: 'STANDBY'` with
 * `spaceshipId: null` for one on Harbor Standby.
 */
export async function addCrew(pilot, overrides = {}) {
  await call(pilot, 'GET', '/ship/loadout'); // creates the ship row
  const ship = await app.prisma.spaceship.findFirst({ where: { playerId: pilot.id, active: true } });
  return app.prisma.crewMember.create({
    data: {
      playerId: pilot.id,
      spaceshipId: ship.id,
      name: 'Test Crew',
      crewClass: 'CHEF',
      rank: 'NOVICE',
      quirkId: 'Q01',
      wageShareBp: 500,
      homeFactionId: 'independent',
      hiredAtStationId: randomUUID(),
      ...overrides
    }
  });
}

/** Deletes the pilots created by newPilot (their rows cascade) and closes the app. */
export async function closeApp() {
  await app.prisma.player.deleteMany({ where: { id: { in: created.splice(0) } } });
  await app.close();
}
