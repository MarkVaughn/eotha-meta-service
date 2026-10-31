import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createPrivateKey, createPublicKey, randomBytes, randomUUID, sign } from 'node:crypto';
import { app, call, closeApp, dockedReceipt, json, newPilot, rtseKey, setCredits } from './helpers.js';
import { canonicalHailReceiptPayload, isHailReceiptFresh, verifyHailReceipt } from '../src/lib/hail-receipt.js';
import { canonicalMiningViolationPayload, verifyMiningViolation } from '../src/lib/mining-violation.js';
import { planExportClearance } from '../src/lib/export-toll.js';
import { amnestyFee, exportTollBp, miningPermitCost, standingTier } from '../src/config/regulation.js';
import { MAX_REWARD_CREDITS } from '../src/config/missions.js';

before(async () => { await app.ready(); });
after(closeApp);

// --- The contract vectors (eotha-contracts scripts/check-hail-receipt-vector.js, check-mining-violation-vector.js) ---

const vectorKey = createPrivateKey({
  key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.alloc(32, 7)]),
  format: 'der',
  type: 'pkcs8'
});
const vectorPublic = createPublicKey(vectorKey);
const STATION_BYTES = '07070707070747078707070707070707';
const HAIL_PREFIX = '454f5448415f4841494c5f524543454950545f56310700000070696c6f742d31' + STATION_BYTES + '0f000000383832383330383238316666666666';
const HAIL_TAIL = '02000000f9464230a1010000abababababababababababababababab';
const HAIL_BETA_HEX = `${HAIL_PREFIX}0400000062657461${HAIL_TAIL}`;
const HAIL_INDEPENDENT_HEX = `${HAIL_PREFIX}00000000${HAIL_TAIL}`;
const HAIL_BETA_SIGNATURE = 'V6HoS7aq0LaT8vV0MqQBQOUS8c5ji/jlD/nd/2gbvrpV2QVrM7c81ceXZ6hWiuPbsLb2FVYQPQkrnttOZDggAw==';
const HAIL_INDEPENDENT_SIGNATURE = 'Ct9BqMRXJ7Z3UbQBDUoakvk2i95kTe4+tQMcouVR2cPA7xtCxOUs6ruZWv9+cbIjYaIV2z3vgGEJHwQz++gSDw==';
const VIOLATION_HEX =
  '454f5448415f4d494e494e475f56494f4c4154494f4e5f563107000000' + '70696c6f742d31' + '0f000000383832383330383238316666666666' +
  '0400000062657461f9464230a1010000abababababababababababababababab';
const VIOLATION_SIGNATURE = '8ao5yM8pk4PAJ+AS7dZwq4BU3FnZHZTr0B7S/9u3h1ewmMs+wyQ9QJkn8gx67JCtnMfqiC+wwPK/K9dQjdNlBw==';

const vectorHail = (overrides = {}) => ({
  pilotId: 'pilot-1',
  stationEntityId: '07070707-0707-4707-8707-070707070707',
  systemH3: '8828308281fffff',
  controllingFactionId: 'beta',
  hailIntent: 2,
  issuedAtMs: 1791811012345,
  nonce: Buffer.alloc(16, 0xab).toString('base64'),
  signature: HAIL_BETA_SIGNATURE,
  ...overrides
});
const vectorViolation = (overrides = {}) => ({
  pilotId: 'pilot-1',
  systemH3: '8828308281fffff',
  controllingFactionId: 'beta',
  issuedAtMs: 1791811012345,
  nonce: Buffer.alloc(16, 0xab).toString('base64'),
  signature: VIOLATION_SIGNATURE,
  ...overrides
});

describe('hail receipt and mining violation verifiers', () => {
  test('the hail receipt payload and signature match the eotha-contracts vectors', () => {
    assert.equal(canonicalHailReceiptPayload(vectorHail()).toString('hex'), HAIL_BETA_HEX);
    assert.equal(canonicalHailReceiptPayload(vectorHail({ controllingFactionId: '' })).toString('hex'), HAIL_INDEPENDENT_HEX);
    assert.equal(verifyHailReceipt(vectorHail(), vectorPublic), true);
    assert.equal(verifyHailReceipt(vectorHail({ controllingFactionId: '', signature: HAIL_INDEPENDENT_SIGNATURE }), vectorPublic), true);
  });

  test('changing any signed hail field, or the key, breaks the signature', () => {
    for (const changes of [
      { pilotId: 'pilot-2' },
      { stationEntityId: '07070707-0707-4707-8707-070707070708' },
      { systemH3: '8828308283fffff' },
      { controllingFactionId: 'alpha' },
      { controllingFactionId: '' },
      { hailIntent: 1 },
      { issuedAtMs: 1791811012344 },
      { nonce: Buffer.alloc(16, 0xac).toString('base64') }
    ]) assert.equal(verifyHailReceipt(vectorHail(changes), vectorPublic), false, JSON.stringify(changes));
    assert.equal(verifyHailReceipt(vectorHail(), app.claimKey.key), false);
    assert.equal(verifyHailReceipt(vectorHail({ controllingFactionId: 'delta' }), vectorPublic), false);
    assert.equal(verifyHailReceipt(vectorHail({ signature: 'AAAA' }), vectorPublic), false);
    assert.equal(verifyHailReceipt(null, vectorPublic), false);
    assert.equal(verifyHailReceipt(vectorHail({ nonce: 'AAAA' }), vectorPublic), false);
  });

  test('the mining violation payload and signature match the vector, and no other domain verifies', () => {
    assert.equal(canonicalMiningViolationPayload(vectorViolation()).toString('hex'), VIOLATION_HEX);
    assert.equal(verifyMiningViolation(vectorViolation(), vectorPublic), true);
    for (const changes of [
      { pilotId: 'pilot-2' }, { systemH3: '8828308283fffff' }, { controllingFactionId: 'alpha' },
      { issuedAtMs: 1791811012346 }, { nonce: Buffer.alloc(16, 0xac).toString('base64') }
    ]) assert.equal(verifyMiningViolation(vectorViolation(changes), vectorPublic), false, JSON.stringify(changes));
    // An independent system has no patrol: '' and 'independent' are never a valid controlling faction.
    assert.equal(verifyMiningViolation(vectorViolation({ controllingFactionId: '' }), vectorPublic), false);
    assert.equal(verifyMiningViolation(vectorViolation({ controllingFactionId: 'independent' }), vectorPublic), false);
    assert.equal(verifyMiningViolation(vectorViolation(), app.claimKey.key), false);
    // Signed under the hail domain, a notice-shaped payload does not verify as a violation and vice versa.
    assert.equal(verifyHailReceipt({ ...vectorHail(), signature: VIOLATION_SIGNATURE }, vectorPublic), false);
  });

  test('a hail receipt is fresh for 60 seconds and 5 seconds of skew', () => {
    const now = 1_000_000_000_000;
    assert.equal(isHailReceiptFresh({ issuedAtMs: now }, now), true);
    assert.equal(isHailReceiptFresh({ issuedAtMs: now - 60_000 }, now), true);
    assert.equal(isHailReceiptFresh({ issuedAtMs: now - 60_001 }, now), false);
    assert.equal(isHailReceiptFresh({ issuedAtMs: now + 5_000 }, now), true);
    assert.equal(isHailReceiptFresh({ issuedAtMs: now + 5_001 }, now), false);
  });
});

describe('regulation tables', () => {
  test('tiers split at the standing thresholds', () => {
    const cases = [[1000, 'PARAGON'], [800, 'PARAGON'], [799, 'TRUSTED'], [450, 'TRUSTED'], [449, 'FRIENDLY'], [150, 'FRIENDLY'],
      [149, 'NEUTRAL'], [0, 'NEUTRAL'], [-149, 'NEUTRAL'], [-150, 'UNFRIENDLY'], [-499, 'UNFRIENDLY'], [-500, 'HOSTILE'],
      [-749, 'HOSTILE'], [-750, 'NEMESIS'], [-1000, 'NEMESIS']];
    for (const [standing, tier] of cases) assert.equal(standingTier(standing), tier, String(standing));
  });

  test('permit prices, toll rates and the amnesty fee follow the tier; the faction\'s colors exempt', () => {
    assert.deepEqual([800, 450, 150, 0, -150].map((s) => miningPermitCost(s, 'alpha', null)), [0, 0, 150, 400, 900]);
    assert.equal(miningPermitCost(-500, 'alpha', null), null);
    assert.equal(miningPermitCost(-750, 'alpha', null), null);
    assert.equal(miningPermitCost(500, 'alpha', 'alpha'), 0);
    assert.equal(miningPermitCost(0, 'alpha', 'beta'), 400);
    assert.deepEqual([800, 450, 150, 0, -150, -500].map((s) => exportTollBp(s, 'alpha', null)), [0, 300, 600, 1200, 1200, 1200]);
    assert.equal(exportTollBp(0, 'alpha', 'alpha'), 0);
    assert.deepEqual([450, 150, 0, -150, -500, -750].map((s) => amnestyFee(s, 'alpha', null)), [0, 165, 440, 990, 990, 990]);
  });

  test('the export toll is exact, rounded once over the cleared lots', () => {
    const lot = (extra) => ({ resource_type: 'TITANIUM', units_milli: 10_000, grade: 4, purity_bp: 8000, ...extra });
    const poached = lot({ origin_system_h3: '8828308281fffff', origin_faction_id: 'alpha', customs_status: 'PERMITTED_UNDECLARED_EXPORT' });
    const options = { systemH3: '8828308281fffff', factionId: 'alpha', standing: 0, activeColors: null };
    const plan = planExportClearance([poached], options);
    assert.deepEqual([plan.cleared, plan.valueCredits, plan.tollBp, plan.tollCredits], [1, 360, 1200, 43]);
    assert.equal(plan.lots[0].customs_status, 'EXPORT_CLEARED');
    assert.equal(planExportClearance([poached], { ...options, standing: 150 }).tollCredits, 22);
    assert.equal(planExportClearance([poached], { ...options, standing: 450 }).tollCredits, 11);
    assert.equal(planExportClearance([poached], { ...options, standing: 800 }).tollCredits, 0);
    // Already cleared, poached, other systems, other factions and legacy lots (no provenance) are left alone.
    const untouched = [
      lot({ origin_system_h3: '8828308281fffff', origin_faction_id: 'alpha', customs_status: 'EXPORT_CLEARED' }),
      lot({ origin_system_h3: '8828308283fffff', origin_faction_id: 'alpha', customs_status: 'UNLICENSED_POACHED' }),
      lot({ origin_system_h3: '8828308281fffff', origin_faction_id: 'beta', customs_status: 'UNLICENSED_POACHED' }),
      lot({ origin_system_h3: '8828308281fffff', origin_faction_id: 'alpha', customs_status: 'UNLICENSED_POACHED' }),
      lot({})
    ];
    const none = planExportClearance(untouched, options);
    assert.deepEqual([none.cleared, none.valueCredits, none.tollCredits], [0, 0, 0]);
    assert.deepEqual(none.lots, untouched);
    const mixed = planExportClearance([...untouched, poached, lot({ ...poached })], options);
    assert.equal(mixed.cleared, 2);
    assert.equal(mixed.tollCredits, 86);
    // Ore the engine stamps DOMESTIC_OR_FREE (mined under a permit or an exemption) clears like the undeclared kind.
    const legal = lot({ origin_system_h3: '8828308281fffff', origin_faction_id: 'alpha', customs_status: 'DOMESTIC_OR_FREE' });
    const cleared = planExportClearance([legal, ...untouched], options);
    assert.deepEqual([cleared.cleared, cleared.valueCredits, cleared.tollCredits], [1, 360, 43]);
    assert.equal(cleared.lots[0].customs_status, 'EXPORT_CLEARED');
    assert.deepEqual(cleared.lots.slice(1), untouched);
    // Legal ore of an independent system or of another faction's system is not this dock's to clear.
    const others = [{ ...legal, origin_faction_id: '' }, { ...legal, origin_faction_id: 'beta' }, { ...legal, origin_system_h3: '8828308283fffff' }];
    assert.equal(planExportClearance(others, options).cleared, 0);
  });
});

// --- Fixtures -------------------------------------------------------------------------------------------------

const SYSTEM = '8828308281fffff';
const OTHER_SYSTEM = '8828308283fffff';
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const str = (s) => Buffer.concat([u32(Buffer.byteLength(s)), Buffer.from(s, 'utf8')]);
const uuidBytes = (uuid) => Buffer.from(uuid.replaceAll('-', ''), 'hex');
const lotBytes = (lots) => [
  u32(lots.length),
  ...lots.flatMap((l) => [
    str(l.resourceType), u32(l.unitsMilli), u32(l.grade), u32(l.purityBp),
    str(l.originSystemH3 ?? ''), str(l.originFactionId ?? ''), str(l.customsStatus ?? '')
  ])
];

/** A hail receipt the engine would sign for `pilot`, assembled here rather than with src/lib/hail-receipt.js. */
function hailFor(pilot, overrides = {}, signer = rtseKey) {
  const receipt = {
    pilotId: pilot.id,
    stationEntityId: randomUUID(),
    systemH3: SYSTEM,
    controllingFactionId: 'alpha',
    hailIntent: 2,
    issuedAtMs: Date.now(),
    nonce: randomBytes(16).toString('base64'),
    ...overrides
  };
  const bytes = Buffer.concat([
    Buffer.from('EOTHA_HAIL_RECEIPT_V1', 'ascii'), str(receipt.pilotId), uuidBytes(receipt.stationEntityId), str(receipt.systemH3),
    str(receipt.controllingFactionId), u32(receipt.hailIntent), u64(receipt.issuedAtMs), Buffer.from(receipt.nonce, 'base64')
  ]);
  return { ...receipt, signature: overrides.signature ?? sign(null, bytes, signer).toString('base64') };
}

function violationFor(pilot, overrides = {}, signer = rtseKey) {
  const notice = {
    pilotId: pilot.id, systemH3: SYSTEM, controllingFactionId: 'alpha', issuedAtMs: Date.now(),
    nonce: randomBytes(16).toString('base64'), ...overrides
  };
  const bytes = Buffer.concat([
    Buffer.from('EOTHA_MINING_VIOLATION_V1', 'ascii'), str(notice.pilotId), str(notice.systemH3), str(notice.controllingFactionId),
    u64(notice.issuedAtMs), Buffer.from(notice.nonce, 'base64')
  ]);
  return { ...notice, signature: overrides.signature ?? sign(null, bytes, signer).toString('base64') };
}

const manifestFor = (pilot, leaseId, sessionId, seq, lots) => {
  const fields = { pilotId: pilot.id, leaseId, sessionId, seq, lots, issuedAtMs: Date.now() };
  const bytes = Buffer.concat([
    Buffer.from('EOTHA_CARGO_MANIFEST_V2', 'ascii'), str(fields.pilotId), uuidBytes(leaseId), uuidBytes(sessionId), u64(seq),
    ...lotBytes(lots), u64(fields.issuedAtMs)
  ]);
  return { ...fields, signature: sign(null, bytes, rtseKey).toString('base64') };
};

const saleFor = (pilot, session, items, overrides = {}) => {
  const fields = {
    pilotId: pilot.id, stationId: randomUUID(), items, totalCredits: 1000, soldAtMs: Date.now(),
    nonce: randomBytes(16).toString('base64'), leaseId: session.leaseId, sessionId: session.sessionId, seq: session.seq += 1,
    remaining: [], ...overrides
  };
  const bytes = Buffer.concat([
    Buffer.from('EOTHA_SALE_RECORD_V3', 'ascii'), str(fields.pilotId), str(fields.stationId), ...lotBytes(fields.items),
    u64(fields.totalCredits), u64(fields.soldAtMs), Buffer.from(fields.nonce, 'base64'), uuidBytes(fields.leaseId),
    uuidBytes(fields.sessionId), u64(fields.seq), ...lotBytes(fields.remaining)
  ]);
  return { ...fields, signature: sign(null, bytes, rtseKey).toString('base64') };
};

const ore = (extra = {}) => ({ resourceType: 'TITANIUM', unitsMilli: 10_000, grade: 4, purityBp: 8000, ...extra });
const mined = (factionId, customsStatus, extra = {}) => ore({ originSystemH3: SYSTEM, originFactionId: factionId, customsStatus, ...extra });

/** Leases a hold for `pilot` and relays a manifest of `lots`; the returned session carries the running seq. */
async function stockHold(pilot, lots) {
  const leased = await call(pilot, 'POST', '/game/cargo/lease');
  assert.equal(leased.statusCode, 200, leased.body);
  const session = { leaseId: json(leased).cargo.lease_id, sessionId: randomUUID(), seq: 1 };
  const res = await call(pilot, 'POST', '/game/cargo/manifest', { manifest: manifestFor(pilot, session.leaseId, session.sessionId, 1, lots) });
  assert.equal(res.statusCode, 200, res.body);
  return session;
}

const setStanding = (pilot, factionId, standing) =>
  app.prisma.playerReputation.upsert({
    where: { playerId_factionId: { playerId: pilot.id, factionId } },
    update: { standing },
    create: { playerId: pilot.id, factionId, standing }
  });
const standingOf = async (pilot, factionId) =>
  (await app.prisma.playerReputation.findUnique({ where: { playerId_factionId: { playerId: pilot.id, factionId } } }))?.standing ?? 0;
const creditsOf = async (pilot) => (await app.prisma.player.findUnique({ where: { id: pilot.id } })).credits;
const tokenFactions = (res) => app.jwt.verify(json(res).token).factions;
const permitRows = (pilot) => app.prisma.systemMiningPermit.findMany({ where: { playerId: pilot.id } });
// The faction routes name a refusal in `error`, the cargo routes in `code`.
const codeOf = (res) => json(res).code ?? json(res).error;
const holdOf = async (pilot) => json(await call(pilot, 'GET', '/game/cargo'));

const buyPermit = (pilot, hailReceipt) => call(pilot, 'POST', '/game/factions/mining-permit', { hailReceipt });
const reportViolation = (pilot, notice) => call(pilot, 'POST', '/game/factions/mining-violation', { notice });
const clearExport = (pilot, receipt) => call(pilot, 'POST', '/game/cargo/clear-export', receipt === undefined ? {} : { dockedReceipt: receipt });
const sell = (pilot, saleRecord, receipt, extra = {}) =>
  call(pilot, 'POST', '/game/cargo/sell', { saleRecord, ...(receipt && { dockedReceipt: receipt }), ...extra });
const dockedAt = (pilot, stationId, factionId, systemH3 = SYSTEM) =>
  dockedReceipt(pilot, { dockedEntityId: stationId, systemH3, controllingFactionId: factionId });

// --- Mining permits -------------------------------------------------------------------------------------------

describe('POST /game/factions/mining-permit', () => {
  test('sells a 2 hour permit at the tier price and lists it in the token and the permit list', async () => {
    for (const [standing, cost] of [[800, 0], [450, 0], [150, 150], [0, 400], [-150, 900]]) {
      const pilot = await newPilot('Permit');
      await setStanding(pilot, 'alpha', standing);
      await setCredits(pilot, 1000);
      const before = Date.now();
      const res = await buyPermit(pilot, hailFor(pilot));
      assert.equal(res.statusCode, 200, `${standing}: ${res.body}`);
      const body = json(res);
      assert.equal(body.cost_credits, cost, String(standing));
      assert.equal(body.credits, 1000 - cost);
      assert.equal(await creditsOf(pilot), 1000 - cost);
      assert.equal(body.replayed, false);
      assert.equal(body.permit.system_h3, SYSTEM);
      assert.equal(body.permit.faction_id, 'alpha');
      assert.ok(body.permit.expires_at_ms >= before + 2 * 3_600_000 && body.permit.expires_at_ms <= Date.now() + 2 * 3_600_000);
      assert.deepEqual(tokenFactions(res).mining_permits, { [SYSTEM]: body.permit.expires_at_ms });
      const listed = json(await call(pilot, 'GET', '/game/factions/mining-permits')).permits;
      assert.deepEqual(listed.map((p) => p.system_h3), [SYSTEM]);
    }
  });

  test('refuses a Hostile or Nemesis pilot without charging', async () => {
    for (const standing of [-500, -749, -750, -1000]) {
      const pilot = await newPilot('Hostile');
      await setStanding(pilot, 'alpha', standing);
      await setCredits(pilot, 5000);
      const res = await buyPermit(pilot, hailFor(pilot));
      assert.equal(res.statusCode, 403, res.body);
      assert.equal(codeOf(res), 'permit_denied_hostile');
      assert.equal(await creditsOf(pilot), 5000);
      assert.deepEqual(await permitRows(pilot), []);
    }
  });

  test('an unaffordable permit is refused 402 at the boundary, leaving credits and permits unchanged', async () => {
    const pilot = await newPilot('Broke');
    await setCredits(pilot, 399);
    const res = await buyPermit(pilot, hailFor(pilot));
    assert.equal(res.statusCode, 402, res.body);
    assert.equal(codeOf(res), 'permit_unaffordable');
    assert.equal(json(res).cost_credits, 400);
    assert.equal(await creditsOf(pilot), 399);
    assert.deepEqual(await permitRows(pilot), []);
    await setCredits(pilot, 400);
    assert.equal((await buyPermit(pilot, hailFor(pilot))).statusCode, 200);
    assert.equal(await creditsOf(pilot), 0);
  });

  test('the faction\'s flown colors make it free', async () => {
    const pilot = await newPilot('Colors');
    await setStanding(pilot, 'alpha', 520);
    await app.prisma.player.update({ where: { id: pilot.id }, data: { activeColorsFactionId: 'alpha' } });
    await setCredits(pilot, 0);
    const res = await buyPermit(pilot, hailFor(pilot));
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(json(res).cost_credits, 0);
  });

  test('a repeat of a redeemed receipt is answered with its first result and charged once', async () => {
    const pilot = await newPilot('Twice');
    await setCredits(pilot, 1000);
    const receipt = hailFor(pilot);
    const first = json(await buyPermit(pilot, receipt));
    assert.equal(first.replayed, false);
    for (let i = 0; i < 2; i++) {
      const again = await buyPermit(pilot, receipt);
      assert.equal(again.statusCode, 200, again.body);
      assert.equal(json(again).replayed, true);
      assert.equal(json(again).cost_credits, 0);
      assert.equal(json(again).permit.expires_at_ms, first.permit.expires_at_ms);
      assert.deepEqual(tokenFactions(again).mining_permits, { [SYSTEM]: first.permit.expires_at_ms });
    }
    assert.equal(await creditsOf(pilot), 600);
    assert.equal((await permitRows(pilot)).length, 1);
    assert.equal(await app.prisma.miningPermitRedemption.count({ where: { playerId: pilot.id } }), 1);
  });

  test('a new receipt for a running permit renews it to 2 hours from now and charges the tier price', async () => {
    const pilot = await newPilot('Renewing');
    await setCredits(pilot, 1000);
    const first = json(await buyPermit(pilot, hailFor(pilot)));
    // The first permit has 5 minutes left.
    await app.prisma.systemMiningPermit.updateMany({ where: { playerId: pilot.id }, data: { expiresAt: new Date(Date.now() + 300_000) } });
    const before = Date.now();
    const renewed = await buyPermit(pilot, hailFor(pilot));
    assert.equal(renewed.statusCode, 200, renewed.body);
    const body = json(renewed);
    assert.equal(body.replayed, false);
    assert.equal(body.cost_credits, 400);
    assert.ok(body.permit.expires_at_ms >= before + 2 * 3_600_000 && body.permit.expires_at_ms <= Date.now() + 2 * 3_600_000);
    assert.ok(body.permit.expires_at_ms > first.permit.expires_at_ms);
    assert.deepEqual(tokenFactions(renewed).mining_permits, { [SYSTEM]: body.permit.expires_at_ms });
    assert.equal(await creditsOf(pilot), 200);
    assert.equal((await permitRows(pilot)).length, 1);
  });

  test('a redeemed receipt cannot buy a second permit once the first has expired, nor after a later receipt', async () => {
    const pilot = await newPilot('Across');
    await setCredits(pilot, 2000);
    const receipt = hailFor(pilot);
    const first = json(await buyPermit(pilot, receipt));
    await app.prisma.systemMiningPermit.updateMany({ where: { playerId: pilot.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const across = await buyPermit(pilot, receipt);
    assert.equal(across.statusCode, 200, across.body);
    assert.equal(json(across).replayed, true);
    assert.equal(json(across).cost_credits, 0);
    assert.equal(json(across).permit.expires_at_ms, first.permit.expires_at_ms);
    assert.equal(await creditsOf(pilot), 1600);
    assert.deepEqual(tokenFactions(across).mining_permits, {});
    // Nor does a later receipt's renewal reopen the earlier one.
    const second = json(await buyPermit(pilot, hailFor(pilot)));
    assert.equal(second.replayed, false);
    assert.equal(await creditsOf(pilot), 1200);
    const old = json(await buyPermit(pilot, receipt));
    assert.equal(old.replayed, true);
    assert.equal(old.permit.expires_at_ms, first.permit.expires_at_ms);
    assert.equal(await creditsOf(pilot), 1200);
    assert.equal((await permitRows(pilot))[0].expiresAt.getTime(), second.permit.expires_at_ms);
  });

  test('a refused receipt stays unspent: it buys the permit once the pilot can afford it', async () => {
    const pilot = await newPilot('Unspent');
    await setCredits(pilot, 100);
    const receipt = hailFor(pilot);
    assert.equal((await buyPermit(pilot, receipt)).statusCode, 402);
    assert.equal(await app.prisma.miningPermitRedemption.count({ where: { playerId: pilot.id } }), 0);
    await setCredits(pilot, 400);
    const res = await buyPermit(pilot, receipt);
    assert.equal(json(res).replayed, false);
    assert.equal(await creditsOf(pilot), 0);
  });

  test('concurrent relays of one receipt charge once; distinct receipts each buy', async () => {
    const pilot = await newPilot('Race');
    await setCredits(pilot, 1200);
    const receipt = hailFor(pilot);
    const results = await Promise.all([1, 2, 3, 4].map(() => buyPermit(pilot, receipt)));
    assert.deepEqual(results.map((r) => r.statusCode), [200, 200, 200, 200]);
    assert.equal(results.filter((r) => !json(r).replayed).length, 1);
    assert.equal(await creditsOf(pilot), 800);
    const distinct = await Promise.all([1, 2].map(() => buyPermit(pilot, hailFor(pilot))));
    assert.deepEqual(distinct.map((r) => [r.statusCode, json(r).replayed]), [[200, false], [200, false]]);
    assert.equal(await creditsOf(pilot), 0);
    assert.equal((await permitRows(pilot)).length, 1);
    assert.equal(await app.prisma.miningPermitRedemption.count({ where: { playerId: pilot.id } }), 3);
  });

  test('an expired permit is renewed and charged again; each system has its own', async () => {
    const pilot = await newPilot('Renew');
    await setCredits(pilot, 1000);
    assert.equal((await buyPermit(pilot, hailFor(pilot))).statusCode, 200);
    await app.prisma.systemMiningPermit.updateMany({ where: { playerId: pilot.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const renewed = await buyPermit(pilot, hailFor(pilot));
    assert.equal(json(renewed).replayed, false);
    assert.equal(await creditsOf(pilot), 200);
    assert.equal((await permitRows(pilot)).length, 1);
    const elsewhere = await buyPermit(pilot, hailFor(pilot, { systemH3: OTHER_SYSTEM, controllingFactionId: 'beta' }));
    assert.equal(elsewhere.statusCode, 402, elsewhere.body);
    assert.equal((await permitRows(pilot)).length, 1);
  });

  test('an expired permit does not appear in the token or the list', async () => {
    const pilot = await newPilot('Lapsed');
    await setCredits(pilot, 1000);
    await buyPermit(pilot, hailFor(pilot));
    await app.prisma.systemMiningPermit.updateMany({ where: { playerId: pilot.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    assert.deepEqual(json(await call(pilot, 'GET', '/game/factions/mining-permits')).permits, []);
    assert.deepEqual(tokenFactions(await call(pilot, 'POST', '/game/cargo/lease')).mining_permits, {});
  });

  test('a receipt that is forged, for another pilot, for another intent, stale or from the future is refused', async () => {
    const pilot = await newPilot('Bad');
    const other = await newPilot('Other');
    await setCredits(pilot, 1000);
    const refused = async (receipt, code) => {
      const res = await buyPermit(pilot, receipt);
      assert.equal(res.statusCode, 403, res.body);
      assert.equal(codeOf(res), code);
    };
    await refused(hailFor(pilot, {}, vectorKey), 'hail_receipt_invalid');
    await refused({ ...hailFor(pilot), controllingFactionId: 'gamma' }, 'hail_receipt_invalid');
    await refused({ ...hailFor(pilot), systemH3: OTHER_SYSTEM }, 'hail_receipt_invalid');
    await refused(hailFor(other), 'hail_receipt_invalid');
    await refused(hailFor(pilot, { hailIntent: 1 }), 'hail_receipt_wrong_intent');
    await refused(hailFor(pilot, { issuedAtMs: Date.now() - 61_000 }), 'hail_receipt_expired');
    await refused(hailFor(pilot, { issuedAtMs: Date.now() + 6_000 }), 'hail_receipt_expired');
    const fresh = await buyPermit(pilot, hailFor(pilot, { issuedAtMs: Date.now() - 55_000 }));
    assert.equal(fresh.statusCode, 200, fresh.body);
    assert.equal(await creditsOf(pilot), 600);
  });

  test('an independent system needs no permit; a malformed receipt is a 400', async () => {
    const pilot = await newPilot('Free');
    await setCredits(pilot, 1000);
    const res = await buyPermit(pilot, hailFor(pilot, { controllingFactionId: '' }));
    assert.equal(res.statusCode, 409, res.body);
    assert.equal(codeOf(res), 'permit_not_required');
    assert.equal(await creditsOf(pilot), 1000);
    assert.equal((await call(pilot, 'POST', '/game/factions/mining-permit', { hailReceipt: { pilotId: pilot.id } })).statusCode, 400);
    assert.equal((await call(pilot, 'POST', '/game/factions/mining-permit', {})).statusCode, 400);
  });

  test('a customs lockout at the hailed station refuses the permit; another station does not', async () => {
    const pilot = await newPilot('Locked');
    await setCredits(pilot, 1000);
    const stationId = randomUUID();
    await app.prisma.stationLockout.create({ data: { playerId: pilot.id, stationId, tier: 3, until: new Date(Date.now() + 600_000) } });
    const res = await buyPermit(pilot, hailFor(pilot, { stationEntityId: stationId }));
    assert.equal(res.statusCode, 403, res.body);
    assert.equal(codeOf(res), 'station_locked_out');
    assert.equal(await creditsOf(pilot), 1000);
    assert.equal((await buyPermit(pilot, hailFor(pilot))).statusCode, 200);
  });

  test('an unauthenticated call is refused', async () => {
    const res = await app.inject({ method: 'POST', url: '/game/factions/mining-permit', payload: { hailReceipt: {} } });
    assert.equal(res.statusCode, 401);
  });
});

// --- Mining violations ----------------------------------------------------------------------------------------

describe('POST /game/factions/mining-violation', () => {
  test('costs 10 standing, flags the transponder for an hour and signs the flag into the token', async () => {
    const pilot = await newPilot('Poacher');
    await setStanding(pilot, 'alpha', 100);
    const before = Date.now();
    const res = await reportViolation(pilot, violationFor(pilot));
    assert.equal(res.statusCode, 200, res.body);
    const body = json(res);
    assert.equal(body.replayed, false);
    assert.equal(body.faction_id, 'alpha');
    assert.equal(body.reputation_change, -10);
    assert.equal(await standingOf(pilot, 'alpha'), 90);
    assert.equal(body.standings.alpha, 90);
    assert.ok(body.flagged_until_ms >= before + 3_600_000 && body.flagged_until_ms <= Date.now() + 3_600_000);
    const claim = tokenFactions(res);
    assert.equal(claim.customs_flagged_until_ms, body.flagged_until_ms);
    assert.equal(claim.customs_flagged_faction_id, 'alpha');
    assert.equal('customs_flagged' in claim, false);
    const ledger = await app.prisma.reputationLedger.findMany({ where: { playerId: pilot.id, reason: 'MINING_VIOLATION' } });
    assert.equal(ledger.length, 1);
    assert.equal(ledger[0].factionDelta, -10);
  });

  test('a replay changes nothing and answers the first result with the current standings', async () => {
    const pilot = await newPilot('Replay');
    const notice = violationFor(pilot);
    const first = json(await reportViolation(pilot, notice));
    await setStanding(pilot, 'alpha', 300);
    const again = await reportViolation(pilot, notice);
    assert.equal(again.statusCode, 200, again.body);
    const body = json(again);
    assert.equal(body.replayed, true);
    assert.equal(body.reputation_change, first.reputation_change);
    assert.equal(body.flagged_until_ms, first.flagged_until_ms);
    assert.equal(body.standings.alpha, 300);
    assert.equal(await standingOf(pilot, 'alpha'), 300);
    assert.equal(await app.prisma.miningViolation.count({ where: { playerId: pilot.id } }), 1);
  });

  test('concurrent relays of one notice apply it once', async () => {
    const pilot = await newPilot('Dup');
    const notice = violationFor(pilot);
    const results = await Promise.all([1, 2, 3].map(() => reportViolation(pilot, notice)));
    assert.deepEqual(results.map((r) => r.statusCode), [200, 200, 200]);
    assert.equal(results.filter((r) => !json(r).replayed).length, 1);
    assert.equal(await standingOf(pilot, 'alpha'), -10);
  });

  test('an old notice still applies once without reviving its elapsed citation', async () => {
    const pilot = await newPilot('Old');
    const issuedAtMs = Date.now() - 7 * 86_400_000;
    const res = await reportViolation(pilot, violationFor(pilot, { issuedAtMs }));
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(json(res).replayed, false);
    assert.equal(json(res).flagged_until_ms, issuedAtMs + 3_600_000);
    const player = await app.prisma.player.findUnique({ where: { id: pilot.id } });
    assert.equal(player.customsFlaggedUntil, null);
    assert.equal(player.customsFlaggedFactionId, null);
  });

  test('another notice extends a running flag and never shortens it', async () => {
    const pilot = await newPilot('Flagged');
    const first = json(await reportViolation(pilot, violationFor(pilot)));
    await app.prisma.player.update({ where: { id: pilot.id }, data: { customsFlaggedUntil: new Date(first.flagged_until_ms + 3_600_000) } });
    const second = await reportViolation(pilot, violationFor(pilot));
    // The notice reports its own signed citation; the running flag is the later of the two.
    assert.equal(json(second).flagged_until_ms >= first.flagged_until_ms, true);
    const player = await app.prisma.player.findUnique({ where: { id: pilot.id } });
    assert.equal(player.customsFlaggedUntil.getTime(), first.flagged_until_ms + 3_600_000);
    assert.equal(tokenFactions(second).customs_flagged_until_ms, first.flagged_until_ms + 3_600_000);
    // The same faction citing again keeps the flag at that faction's docks.
    assert.equal(tokenFactions(second).customs_flagged_faction_id, 'alpha');
    assert.equal(await standingOf(pilot, 'alpha'), -20);
  });

  test('a second faction citing the pilot inside the hour cites them at every faction\'s docks', async () => {
    const pilot = await newPilot('Doubly');
    const first = json(await reportViolation(pilot, violationFor(pilot)));
    assert.equal((await app.prisma.player.findUnique({ where: { id: pilot.id } })).customsFlaggedFactionId, 'alpha');
    const res = await reportViolation(pilot, violationFor(pilot, { controllingFactionId: 'beta', systemH3: OTHER_SYSTEM }));
    const second = json(res);
    assert.equal(second.faction_id, 'beta');
    assert.equal(second.flagged_until_ms >= first.flagged_until_ms, true);
    assert.equal(await standingOf(pilot, 'alpha'), -10);
    assert.equal(await standingOf(pilot, 'beta'), -10);
    const player = await app.prisma.player.findUnique({ where: { id: pilot.id } });
    assert.equal(player.customsFlaggedFactionId, null);
    assert.equal(player.customsFlaggedUntil.getTime(), second.flagged_until_ms);
    const claim = tokenFactions(res);
    assert.equal(claim.customs_flagged_until_ms, second.flagged_until_ms);
    assert.equal('customs_flagged_faction_id' in claim, false);
    // It stays an all-faction citation when either faction cites again, or a third does.
    for (const factionId of ['alpha', 'gamma']) {
      const again = await reportViolation(pilot, violationFor(pilot, { controllingFactionId: factionId }));
      assert.equal('customs_flagged_faction_id' in tokenFactions(again), false, factionId);
    }
    assert.equal((await app.prisma.player.findUnique({ where: { id: pilot.id } })).customsFlaggedFactionId, null);
  });

  test('a citation that has lapsed is replaced by the faction of the next notice', async () => {
    const pilot = await newPilot('Lapsing');
    await reportViolation(pilot, violationFor(pilot));
    await app.prisma.player.update({ where: { id: pilot.id }, data: { customsFlaggedUntil: new Date(Date.now() - 1000) } });
    const res = await reportViolation(pilot, violationFor(pilot, { controllingFactionId: 'beta', systemH3: OTHER_SYSTEM }));
    assert.equal(tokenFactions(res).customs_flagged_faction_id, 'beta');
    assert.equal((await app.prisma.player.findUnique({ where: { id: pilot.id } })).customsFlaggedFactionId, 'beta');
  });

  test('refuses a forged, foreign, independent or future-dated notice and changes nothing', async () => {
    const pilot = await newPilot('Framed');
    const other = await newPilot('Other');
    for (const notice of [
      { ...violationFor(pilot), systemH3: OTHER_SYSTEM },
      violationFor(other),
      violationFor(pilot, {}, vectorKey),
      violationFor(pilot, { issuedAtMs: Date.now() + 120_000 })
    ]) {
      const res = await reportViolation(pilot, notice);
      assert.equal(res.statusCode, 403, res.body);
      assert.equal(codeOf(res), 'mining_violation_invalid');
    }
    assert.equal((await reportViolation(pilot, violationFor(pilot, { controllingFactionId: 'independent' }))).statusCode, 400);
    assert.equal(await standingOf(pilot, 'alpha'), 0);
    const player = await app.prisma.player.findUnique({ where: { id: pilot.id } });
    assert.equal(player.customsFlaggedUntil, null);
  });

  test('the penalty is clamped by the standing caps like any other loss', async () => {
    const pilot = await newPilot('Floor');
    await setStanding(pilot, 'alpha', -1000);
    const res = await reportViolation(pilot, violationFor(pilot));
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(json(res).reputation_change, 0);
    assert.equal(await standingOf(pilot, 'alpha'), -1000);
  });

  test('the flag ends with its time: an elapsed flag is not in a later token', async () => {
    const pilot = await newPilot('Cleared');
    await reportViolation(pilot, violationFor(pilot));
    await app.prisma.player.update({ where: { id: pilot.id }, data: { customsFlaggedUntil: new Date(Date.now() - 1000) } });
    const claim = tokenFactions(await call(pilot, 'POST', '/game/cargo/lease'));
    assert.equal(claim.customs_flagged_until_ms, 0);
    assert.equal('customs_flagged_faction_id' in claim, false);
    assert.equal('customs_flagged' in claim, false);
  });
});

describe('the token\'s active_lockouts', () => {
  test('lists the stations whose customs lockout still runs, lowercase, and drops the expired', async () => {
    const pilot = await newPilot('Barred');
    const running = randomUUID();
    await app.prisma.stationLockout.create({ data: { playerId: pilot.id, stationId: running, tier: 2, until: new Date(Date.now() + 600_000) } });
    await app.prisma.stationLockout.create({ data: { playerId: pilot.id, stationId: randomUUID(), tier: 2, until: new Date(Date.now() - 1000) } });
    assert.deepEqual(tokenFactions(await call(pilot, 'POST', '/game/cargo/lease')).active_lockouts, [running]);
  });
});

// --- Clearing exports -----------------------------------------------------------------------------------------

describe('POST /game/cargo/clear-export', () => {
  const POACHED = mined('alpha', 'UNLICENSED_POACHED');
  const CLEARABLE = mined('alpha', 'PERMITTED_UNDECLARED_EXPORT');
  const UNDECLARED = mined('alpha', 'PERMITTED_UNDECLARED_EXPORT', { unitsMilli: 20_000 });
  const DOMESTIC = mined('alpha', 'DOMESTIC_OR_FREE');
  const ELSEWHERE = ore({ originSystemH3: OTHER_SYSTEM, originFactionId: 'beta', customsStatus: 'UNLICENSED_POACHED' });

  test('clears the dock\'s undeclared ore at the tier toll, as a new lease the token carries', async () => {
    const pilot = await newPilot('Exporter');
    await setCredits(pilot, 500);
    const session = await stockHold(pilot, [CLEARABLE, UNDECLARED, ELSEWHERE]);
    const res = await clearExport(pilot, dockedAt(pilot, randomUUID(), 'alpha'));
    assert.equal(res.statusCode, 200, res.body);
    const body = json(res);
    // 10 + 20 units of grade 4, 80% purity, at 25 each: 360 + 720 = 1080; 12% is 129.6.
    assert.deepEqual([body.cleared_lots, body.value_credits, body.toll_bp, body.toll_credits, body.credits], [2, 1080, 1200, 130, 370]);
    assert.equal(await creditsOf(pilot), 370);
    assert.deepEqual(body.cargo.lots.map((l) => l.customs_status), ['EXPORT_CLEARED', 'EXPORT_CLEARED', 'UNLICENSED_POACHED']);
    assert.notEqual(body.cargo.lease_id, session.leaseId);
    assert.equal(body.cargo.generation, 2);
    const claim = app.jwt.verify(body.token).cargo;
    assert.equal(claim.lease_id, body.cargo.lease_id);
    assert.deepEqual(claim.lots, body.cargo.lots);
    assert.deepEqual((await holdOf(pilot)).lots, body.cargo.lots);

    // The engine session of the old lease is fenced out: its next record cannot revert the paid clearance.
    const stale = await call(pilot, 'POST', '/game/cargo/manifest', { manifest: manifestFor(pilot, session.leaseId, session.sessionId, 5, [CLEARABLE]) });
    assert.notEqual(stale.statusCode, 200, stale.body);
    assert.deepEqual((await holdOf(pilot)).lots, body.cargo.lots);
  });

  test('clears ore the engine stamps DOMESTIC_OR_FREE, and leaves the poached ore beside it', async () => {
    const pilot = await newPilot('Licensed');
    await setCredits(pilot, 500);
    await stockHold(pilot, [DOMESTIC, POACHED]);
    const res = await clearExport(pilot, dockedAt(pilot, randomUUID(), 'alpha'));
    assert.equal(res.statusCode, 200, res.body);
    const body = json(res);
    assert.deepEqual([body.cleared_lots, body.value_credits, body.toll_credits, body.credits], [1, 360, 43, 457]);
    assert.deepEqual(body.cargo.lots.map((l) => l.customs_status), ['EXPORT_CLEARED', 'UNLICENSED_POACHED']);
    assert.deepEqual((await holdOf(pilot)).lots, body.cargo.lots);
    // Cleared once: the same dock has nothing more to clear, and the poached lot is never cleared by the toll.
    const again = await clearExport(pilot, dockedAt(pilot, randomUUID(), 'alpha'));
    assert.equal(again.statusCode, 409, again.body);
    assert.equal(codeOf(again), 'nothing_to_clear');
    assert.equal(await creditsOf(pilot), 457);
  });

  test('poached ore is not cleared by the toll and answers nothing_to_clear', async () => {
    const pilot = await newPilot('Poacher');
    await setCredits(pilot, 500);
    const session = await stockHold(pilot, [POACHED]);
    const res = await clearExport(pilot, dockedAt(pilot, randomUUID(), 'alpha'));
    assert.equal(res.statusCode, 409, res.body);
    assert.equal(codeOf(res), 'nothing_to_clear');
    assert.equal(await creditsOf(pilot), 500);
    const hold = await holdOf(pilot);
    assert.equal(hold.lease_id, session.leaseId);
    assert.equal(hold.lots[0].customs_status, 'UNLICENSED_POACHED');
  });

  test('a failure while building the answer rolls the toll back, and a retry charges once', async () => {
    const pilot = await newPilot('Flaky');
    await setCredits(pilot, 500);
    const session = await stockHold(pilot, [CLEARABLE]);
    const receipt = dockedAt(pilot, randomUUID(), 'alpha');
    const sign = app.signWithExpiry;
    app.signWithExpiry = () => { throw new Error('signing down'); };
    try {
      const failed = await clearExport(pilot, receipt);
      assert.equal(failed.statusCode, 500, failed.body);
    } finally {
      app.signWithExpiry = sign;
    }
    assert.equal(await creditsOf(pilot), 500);
    assert.equal((await holdOf(pilot)).lease_id, session.leaseId);
    assert.equal(await app.prisma.cargoLease.count({ where: { playerId: pilot.id } }), 1);
    const retry = await clearExport(pilot, receipt);
    assert.equal(retry.statusCode, 200, retry.body);
    assert.equal(json(retry).toll_credits, 43);
    assert.equal(await creditsOf(pilot), 457);
    assert.equal(app.jwt.verify(json(retry).token).cargo.lease_id, json(retry).cargo.lease_id);
  });

  test('a second call has nothing to clear and charges nothing', async () => {
    const pilot = await newPilot('Exporter');
    await setCredits(pilot, 500);
    await stockHold(pilot, [CLEARABLE]);
    const station = randomUUID();
    assert.equal((await clearExport(pilot, dockedAt(pilot, station, 'alpha'))).statusCode, 200);
    const credits = await creditsOf(pilot);
    const again = await clearExport(pilot, dockedAt(pilot, station, 'alpha'));
    assert.equal(again.statusCode, 409, again.body);
    assert.equal(codeOf(again), 'nothing_to_clear');
    assert.equal(await creditsOf(pilot), credits);
    assert.equal(await app.prisma.cargoLease.count({ where: { playerId: pilot.id } }), 2);
  });

  test('the toll follows standing and the flown colors', async () => {
    for (const [standing, colors, toll] of [[0, null, 43], [150, null, 22], [450, null, 11], [800, null, 0], [520, 'alpha', 0], [-150, null, 43], [-600, null, 43]]) {
      const pilot = await newPilot('Tier');
      await setStanding(pilot, 'alpha', standing);
      if (colors) await app.prisma.player.update({ where: { id: pilot.id }, data: { activeColorsFactionId: colors } });
      await setCredits(pilot, 100);
      await stockHold(pilot, [CLEARABLE]);
      const res = await clearExport(pilot, dockedAt(pilot, randomUUID(), 'alpha'));
      assert.equal(res.statusCode, 200, `${standing}: ${res.body}`);
      assert.equal(json(res).toll_credits, toll, String(standing));
      assert.equal(await creditsOf(pilot), 100 - toll);
    }
  });

  test('an unaffordable toll is refused 402 at the boundary and the hold stays as it was', async () => {
    const pilot = await newPilot('Short');
    await setCredits(pilot, 42);
    const session = await stockHold(pilot, [CLEARABLE]);
    const receipt = dockedAt(pilot, randomUUID(), 'alpha');
    const res = await clearExport(pilot, receipt);
    assert.equal(res.statusCode, 402, res.body);
    assert.equal(codeOf(res), 'toll_unaffordable');
    assert.equal(json(res).toll_credits, 43);
    assert.equal(await creditsOf(pilot), 42);
    const hold = await holdOf(pilot);
    assert.equal(hold.lease_id, session.leaseId);
    assert.equal(hold.lots[0].customs_status, 'PERMITTED_UNDECLARED_EXPORT');
    assert.equal(await app.prisma.cargoLease.count({ where: { playerId: pilot.id } }), 1);
    await setCredits(pilot, 43);
    assert.equal((await clearExport(pilot, receipt)).statusCode, 200);
    assert.equal(await creditsOf(pilot), 0);
  });

  test('needs a current docked receipt of the pilot, and a dock without a lockout', async () => {
    const pilot = await newPilot('Docs');
    const other = await newPilot('Other');
    await setCredits(pilot, 500);
    await stockHold(pilot, [CLEARABLE]);
    const missing = await clearExport(pilot);
    assert.equal(missing.statusCode, 403, missing.body);
    assert.equal(codeOf(missing), 'docked_receipt_required');
    assert.equal((await clearExport(pilot, dockedAt(other, randomUUID(), 'alpha'))).statusCode, 403);
    assert.equal((await clearExport(pilot, { ...dockedAt(pilot, randomUUID(), 'alpha'), controllingFactionId: 'beta' })).statusCode, 403);
    const stale = dockedReceipt(pilot, { dockedEntityId: randomUUID(), controllingFactionId: 'alpha', issuedAtMs: Date.now() - 3_600_000 });
    assert.equal((await clearExport(pilot, stale)).statusCode, 403);
    const station = randomUUID();
    await app.prisma.stationLockout.create({ data: { playerId: pilot.id, stationId: station, tier: 3, until: new Date(Date.now() + 600_000) } });
    const locked = await clearExport(pilot, dockedAt(pilot, station, 'alpha'));
    assert.equal(locked.statusCode, 403, locked.body);
    assert.equal(codeOf(locked), 'station_locked_out');
    assert.equal(await creditsOf(pilot), 500);
    assert.equal((await holdOf(pilot)).lots[0].customs_status, 'PERMITTED_UNDECLARED_EXPORT');
  });

  test('an independent dock levies no toll; another faction\'s dock clears none of this ore', async () => {
    const pilot = await newPilot('Neutral');
    await setCredits(pilot, 500);
    await stockHold(pilot, [CLEARABLE]);
    const independent = await clearExport(pilot, dockedAt(pilot, randomUUID(), ''));
    assert.equal(independent.statusCode, 409, independent.body);
    assert.equal(codeOf(independent), 'export_not_regulated');
    const beta = await clearExport(pilot, dockedAt(pilot, randomUUID(), 'beta'));
    assert.equal(beta.statusCode, 409, beta.body);
    assert.equal(codeOf(beta), 'nothing_to_clear');
    const wrongSystem = await clearExport(pilot, dockedAt(pilot, randomUUID(), 'alpha', OTHER_SYSTEM));
    assert.equal(codeOf(wrongSystem), 'nothing_to_clear');
    assert.equal(await creditsOf(pilot), 500);
  });

  test('with no hold at all there is nothing to clear', async () => {
    const pilot = await newPilot('Empty');
    const res = await clearExport(pilot, dockedAt(pilot, randomUUID(), 'alpha'));
    assert.equal(res.statusCode, 409, res.body);
    assert.equal(codeOf(res), 'nothing_to_clear');
  });
});

// --- Sales: domestic standing, the amnesty and the station proof ------------------------------------------------

describe('POST /game/cargo/sell with provenance', () => {
  const station = () => randomUUID();

  test('lot provenance survives a manifest, a lease and a sale\'s remaining hold', async () => {
    const pilot = await newPilot('Provenance');
    const lots = [mined('alpha', 'DOMESTIC_OR_FREE'), ore()];
    const session = await stockHold(pilot, lots);
    const hold = await holdOf(pilot);
    assert.deepEqual(hold.lots, [
      { resource_type: 'TITANIUM', units_milli: 10_000, grade: 4, purity_bp: 8000, origin_system_h3: SYSTEM, origin_faction_id: 'alpha', customs_status: 'DOMESTIC_OR_FREE' },
      { resource_type: 'TITANIUM', units_milli: 10_000, grade: 4, purity_bp: 8000 }
    ]);
    const leased = json(await call(pilot, 'POST', '/game/cargo/lease'));
    assert.deepEqual(leased.cargo.lots, hold.lots);
    assert.deepEqual(app.jwt.verify(leased.token).cargo.lots, hold.lots);
    const sale = saleFor(pilot, { ...session, leaseId: leased.cargo.lease_id }, [lots[1]], { remaining: [lots[0]], totalCredits: 100 });
    const res = await sell(pilot, sale);
    assert.equal(res.statusCode, 200, res.body);
    assert.deepEqual(json(res).lots, [hold.lots[0]]);
  });

  test('a provenance field the signature does not cover is refused', async () => {
    const pilot = await newPilot('Tamper');
    const session = await stockHold(pilot, []);
    const sale = saleFor(pilot, session, [mined('alpha', 'UNLICENSED_POACHED')], { totalCredits: 1000 });
    const tampered = { ...sale, items: [{ ...sale.items[0], customsStatus: 'DOMESTIC_OR_FREE' }] };
    const res = await sell(pilot, tampered, dockedAt(pilot, sale.stationId, 'alpha'));
    assert.equal(res.statusCode, 403, res.body);
    assert.equal(codeOf(res), 'sale_record_invalid');
    assert.equal(await creditsOf(pilot), 0);
  });

  test('domestic ore earns one standing per 50 units, carries the remainder and caps at 6 a sale', async () => {
    const pilot = await newPilot('Miner');
    const session = await stockHold(pilot, []);
    const stationId = station();
    const sellUnits = async (units, expectedGain) => {
      const sale = saleFor(pilot, session, [mined('alpha', 'DOMESTIC_OR_FREE', { unitsMilli: units * 1000 })], { stationId, totalCredits: 100 });
      const res = await sell(pilot, sale, dockedAt(pilot, stationId, 'alpha'));
      assert.equal(res.statusCode, 200, res.body);
      assert.equal(json(res).domesticReputation ?? 0, expectedGain, `${units} units`);
      return res;
    };
    await sellUnits(25, 0);
    assert.equal(await standingOf(pilot, 'alpha'), 0);
    const second = await sellUnits(25, 1);
    assert.equal(await standingOf(pilot, 'alpha'), 1);
    assert.equal(tokenFactions(second).alpha, 1);
    await sellUnits(100, 2);
    // 1010 units are 20 points, capped at 6; the 10 left over short of a point are kept, the capped excess is dropped.
    await sellUnits(1010, 6);
    assert.equal(await standingOf(pilot, 'alpha'), 9);
    const row = await app.prisma.playerReputation.findUnique({ where: { playerId_factionId: { playerId: pilot.id, factionId: 'alpha' } } });
    assert.equal(row.domesticOreRemainder, 10_000);
    const ledger = await app.prisma.reputationLedger.findMany({ where: { playerId: pilot.id, reason: 'DOMESTIC_ORE_SALE' } });
    assert.deepEqual(ledger.map((entry) => entry.factionDelta).sort((a, b) => a - b), [1, 2, 6]);
  });

  test('ore mined elsewhere, under another faction, cleared or undeclared earns nothing; without a receipt it cannot be proven', async () => {
    const pilot = await newPilot('Trader');
    const session = await stockHold(pilot, []);
    const stationId = station();
    const items = [
      mined('alpha', 'EXPORT_CLEARED', { unitsMilli: 100_000 }),
      mined('alpha', 'PERMITTED_UNDECLARED_EXPORT', { unitsMilli: 100_000 }),
      mined('beta', 'DOMESTIC_OR_FREE', { unitsMilli: 100_000 }),
      ore({ originSystemH3: OTHER_SYSTEM, originFactionId: 'alpha', customsStatus: 'DOMESTIC_OR_FREE', unitsMilli: 100_000 }),
      ore({ unitsMilli: 100_000 })
    ];
    const res = await sell(pilot, saleFor(pilot, session, items, { stationId, totalCredits: 500 }), dockedAt(pilot, stationId, 'alpha'));
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(json(res).domesticReputation, undefined);
    assert.equal(json(res).amnestyCredits, undefined);
    assert.equal(await creditsOf(pilot), 500);
    assert.equal(await standingOf(pilot, 'alpha'), 0);
    // Domestic ore sold with no receipt is a plain sale: no standing, and no refusal either.
    const bare = await sell(pilot, saleFor(pilot, session, [mined('alpha', 'DOMESTIC_OR_FREE', { unitsMilli: 100_000 })], { totalCredits: 100 }));
    assert.equal(bare.statusCode, 200, bare.body);
    assert.equal(await standingOf(pilot, 'alpha'), 0);
    // A receipt for another station proves nothing about this one.
    const elsewhere = saleFor(pilot, session, [mined('alpha', 'DOMESTIC_OR_FREE', { unitsMilli: 100_000 })], { totalCredits: 100 });
    assert.equal((await sell(pilot, elsewhere, dockedAt(pilot, station(), 'alpha'))).statusCode, 200);
    assert.equal(await standingOf(pilot, 'alpha'), 0);
  });

  test('poached ore sold at home pays the permit plus 10%, never more than the proceeds', async () => {
    for (const [standing, fee] of [[450, 0], [150, 165], [0, 440], [-150, 990], [-600, 990]]) {
      const pilot = await newPilot('Amnesty');
      await setStanding(pilot, 'alpha', standing);
      const session = await stockHold(pilot, []);
      const stationId = station();
      const sale = saleFor(pilot, session, [mined('alpha', 'UNLICENSED_POACHED')], { stationId, totalCredits: 1500 });
      const res = await sell(pilot, sale, dockedAt(pilot, stationId, 'alpha'));
      assert.equal(res.statusCode, 200, `${standing}: ${res.body}`);
      assert.equal(json(res).amnestyCredits, fee === 0 ? undefined : fee, String(standing));
      assert.equal(json(res).total_credits, 1500 - fee);
      assert.equal(await creditsOf(pilot), 1500 - fee);
    }
  });

  test('the amnesty is capped at the gross proceeds', async () => {
    const pilot = await newPilot('Capped');
    const session = await stockHold(pilot, []);
    const stationId = station();
    const sale = saleFor(pilot, session, [mined('alpha', 'UNLICENSED_POACHED')], { stationId, totalCredits: 300 });
    const res = await sell(pilot, sale, dockedAt(pilot, stationId, 'alpha'));
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(json(res).amnestyCredits, 300);
    assert.equal(json(res).total_credits, 0);
    assert.equal(await creditsOf(pilot), 0);
    const exact = saleFor(pilot, session, [mined('alpha', 'UNLICENSED_POACHED')], { stationId, totalCredits: 440 });
    assert.equal(json(await sell(pilot, exact, dockedAt(pilot, stationId, 'alpha'))).amnestyCredits, 440);
    const over = saleFor(pilot, session, [mined('alpha', 'UNLICENSED_POACHED')], { stationId, totalCredits: 441 });
    const overRes = await sell(pilot, over, dockedAt(pilot, stationId, 'alpha'));
    assert.equal(json(overRes).amnestyCredits, 440);
    assert.equal(json(overRes).total_credits, 1);
  });

  test('a running permit for the system waives the amnesty', async () => {
    const pilot = await newPilot('Licensed');
    await setCredits(pilot, 400);
    assert.equal((await buyPermit(pilot, hailFor(pilot))).statusCode, 200);
    const session = await stockHold(pilot, []);
    const stationId = station();
    const sale = saleFor(pilot, session, [mined('alpha', 'UNLICENSED_POACHED')], { stationId, totalCredits: 1000 });
    const res = await sell(pilot, sale, dockedAt(pilot, stationId, 'alpha'));
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(json(res).amnestyCredits, undefined);
    assert.equal(await creditsOf(pilot), 1000);
    // A permit of another system does not.
    const other = await newPilot('Licensed');
    await setCredits(other, 400);
    await buyPermit(other, hailFor(other, { systemH3: OTHER_SYSTEM, controllingFactionId: 'beta' }));
    const otherSession = await stockHold(other, []);
    const res2 = await sell(other, saleFor(other, otherSession, [mined('alpha', 'UNLICENSED_POACHED')], { stationId, totalCredits: 1000 }), dockedAt(other, stationId, 'alpha'));
    assert.equal(json(res2).amnestyCredits, 440);
  });

  test('poached ore of a faction system is refused without the station\'s docked receipt, and stays unsold', async () => {
    const pilot = await newPilot('Dodger');
    const session = await stockHold(pilot, [mined('alpha', 'UNLICENSED_POACHED')]);
    const stationId = station();
    const sale = saleFor(pilot, session, [mined('alpha', 'UNLICENSED_POACHED')], { stationId, totalCredits: 1000 });
    const missing = await sell(pilot, sale);
    assert.equal(missing.statusCode, 403, missing.body);
    assert.equal(codeOf(missing), 'docked_receipt_required');
    const wrong = await sell(pilot, sale, dockedAt(pilot, station(), 'alpha'));
    assert.equal(wrong.statusCode, 403, wrong.body);
    assert.equal(codeOf(wrong), 'docked_receipt_wrong_station');
    assert.equal(await creditsOf(pilot), 0);
    assert.equal(await app.prisma.cargoSale.count({ where: { playerId: pilot.id } }), 0);
    assert.equal((await holdOf(pilot)).lots.length, 1);
    // Still creditable once the proof is given.
    const ok = await sell(pilot, sale, dockedAt(pilot, stationId, 'alpha'));
    assert.equal(ok.statusCode, 200, ok.body);
    assert.equal(await creditsOf(pilot), 560);
    assert.equal((await holdOf(pilot)).lots.length, 0);
  });

  test('a status this service does not know counts as poached', async () => {
    const pilot = await newPilot('Unknown');
    const session = await stockHold(pilot, []);
    const stationId = station();
    const sale = saleFor(pilot, session, [mined('alpha', 'SOMETHING_NEW')], { stationId, totalCredits: 1000 });
    assert.equal((await sell(pilot, sale)).statusCode, 403);
    const res = await sell(pilot, sale, dockedAt(pilot, stationId, 'alpha'));
    assert.equal(json(res).amnestyCredits, 440);
  });

  test('poached ore of an independent system, or sold at another system\'s dock, owes no amnesty', async () => {
    const pilot = await newPilot('Free');
    const session = await stockHold(pilot, []);
    const stationId = station();
    const free = saleFor(pilot, session, [ore({ originSystemH3: SYSTEM, originFactionId: 'independent', customsStatus: 'UNLICENSED_POACHED' })], { stationId, totalCredits: 500 });
    const res = await sell(pilot, free);
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(json(res).amnestyCredits, undefined);
    const away = saleFor(pilot, session, [mined('alpha', 'UNLICENSED_POACHED')], { stationId: station(), totalCredits: 500 });
    const awayRes = await sell(pilot, away, dockedAt(pilot, away.stationId, 'beta', OTHER_SYSTEM));
    assert.equal(awayRes.statusCode, 200, awayRes.body);
    assert.equal(json(awayRes).amnestyCredits, undefined);
    assert.equal(await creditsOf(pilot), 1000);
  });

  test('a customs lockout at the sale\'s station refuses it whatever receipt comes along', async () => {
    const pilot = await newPilot('Barred');
    const session = await stockHold(pilot, []);
    const stationId = station();
    await app.prisma.stationLockout.create({ data: { playerId: pilot.id, stationId, tier: 3, until: new Date(Date.now() + 600_000) } });
    const sale = saleFor(pilot, session, [mined('alpha', 'UNLICENSED_POACHED')], { stationId, totalCredits: 1000 });
    for (const receipt of [undefined, dockedAt(pilot, stationId, 'alpha'), dockedAt(pilot, station(), 'alpha')]) {
      const res = await sell(pilot, sale, receipt);
      assert.equal(res.statusCode, 403, res.body);
      assert.equal(codeOf(res), 'station_locked_out');
    }
    const upper = await sell(pilot, { ...sale, stationId: stationId.toUpperCase() });
    assert.equal(upper.statusCode, 403, upper.body);
    assert.equal(await creditsOf(pilot), 0);
  });

  test('a replay answers the first sale\'s amnesty and standing, credits once and takes no second look at the proof', async () => {
    const pilot = await newPilot('Replayer');
    const session = await stockHold(pilot, []);
    const stationId = station();
    const sale = saleFor(pilot, session, [mined('alpha', 'UNLICENSED_POACHED'), mined('alpha', 'DOMESTIC_OR_FREE', { unitsMilli: 100_000 })], { stationId, totalCredits: 1000 });
    const first = await sell(pilot, sale, dockedAt(pilot, stationId, 'alpha'));
    assert.equal(first.statusCode, 200, first.body);
    assert.equal(json(first).domesticReputation, 2);
    assert.equal(json(first).amnestyCredits, 440);
    await setStanding(pilot, 'alpha', 300);
    for (const receipt of [dockedAt(pilot, stationId, 'alpha'), undefined]) {
      const again = await sell(pilot, sale, receipt);
      assert.equal(again.statusCode, 200, again.body);
      const body = json(again);
      assert.equal(body.replayed, true);
      assert.equal(body.amnestyCredits, 440);
      assert.equal(body.domesticReputation, 2);
      assert.equal(body.total_credits, 560);
    }
    assert.equal(await creditsOf(pilot), 560);
    assert.equal(await standingOf(pilot, 'alpha'), 300);
  });

  test('the amnesty comes off before the Quartermaster bonus and the crew share', async () => {
    const pilot = await newPilot('Crewed');
    await app.prisma.player.update({ where: { id: pilot.id }, data: { credits: 0 } });
    await call(pilot, 'GET', '/ship/loadout');
    const ship = await app.prisma.spaceship.findFirst({ where: { playerId: pilot.id, active: true } });
    await app.prisma.crewMember.create({
      data: {
        playerId: pilot.id, spaceshipId: ship.id, name: 'Chef', crewClass: 'CHEF', rank: 'NOVICE', quirkId: 'Q01',
        wageShareBp: 500, homeFactionId: 'independent', hiredAtStationId: randomUUID()
      }
    });
    const session = await stockHold(pilot, []);
    const stationId = station();
    const sale = saleFor(pilot, session, [mined('alpha', 'UNLICENSED_POACHED')], { stationId, totalCredits: 1440 });
    const res = await sell(pilot, sale, dockedAt(pilot, stationId, 'alpha'));
    assert.equal(res.statusCode, 200, res.body);
    // 1440 - 440 = 1000 proceeds; the Chef takes 5%.
    assert.equal(json(res).amnestyCredits, 440);
    assert.equal(json(res).grossCredits, 1000);
    assert.equal(json(res).crewShareCredits, 50);
    assert.equal(await creditsOf(pilot), 950);
  });

  test('a sale that would overflow the balance rolls back the standing, the hold and the amnesty', async () => {
    const pilot = await newPilot('Rich');
    await setCredits(pilot, MAX_REWARD_CREDITS - 100);
    const session = await stockHold(pilot, [ore()]);
    const stationId = station();
    const items = [mined('alpha', 'DOMESTIC_OR_FREE', { unitsMilli: 100_000 })];
    const sale = saleFor(pilot, session, items, { stationId, totalCredits: 1000, remaining: [] });
    const res = await sell(pilot, sale, dockedAt(pilot, stationId, 'alpha'));
    assert.equal(res.statusCode, 409, res.body);
    assert.equal(codeOf(res), 'credit_overflow');
    assert.equal(await standingOf(pilot, 'alpha'), 0);
    assert.equal(await app.prisma.cargoSale.count({ where: { playerId: pilot.id } }), 0);
    assert.equal((await holdOf(pilot)).lots.length, 1);
    assert.equal(await creditsOf(pilot), MAX_REWARD_CREDITS - 100);
    // The balance has room for exactly the sale: the same record credits.
    await setCredits(pilot, MAX_REWARD_CREDITS - 1000);
    const ok = await sell(pilot, sale, dockedAt(pilot, stationId, 'alpha'));
    assert.equal(ok.statusCode, 200, ok.body);
    assert.equal(await creditsOf(pilot), MAX_REWARD_CREDITS);
    assert.equal(await standingOf(pilot, 'alpha'), 2);
  });
});
