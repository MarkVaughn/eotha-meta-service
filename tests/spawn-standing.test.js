import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { gridDisk } from 'h3-js';
import { app, attestationHeaders, closeApp, INTERNAL_RTSE_CREDENTIAL, json, track } from './helpers.js';
import { DEFAULT_HARBOR } from '../src/config/harbor.js';
import { SPAWN_CONTROLLED_STANDING, SPAWN_NEIGHBOR_STANDING, spawnStandingGains } from '../src/config/factions.js';
import { TerritoryLookupResponse } from '../src/lib/contracts/territory.js';
import { ensureHarbor, harborAt } from '../src/lib/harbor.js';
import { LEDGER_REASONS } from '../src/lib/reputation.js';
import { createTerritoryClient, decodeTerritory } from '../src/lib/territory.js';

// A new player's home harbor grants faction standing from where it is: +35 with the faction controlling its cell, or
// in an uncontrolled cell +5 per ring-1 neighbor cell each faction controls. The engine says who controls what.

const HAMBURG = { latitude: 53.5511, longitude: 9.9937 };
const HAMBURG_H3 = harborAt(HAMBURG).h3Index;
const SF_H3 = DEFAULT_HARBOR.h3Index;

const territoryOf = (controllingFactionId, neighborFactionIds = []) => ({ controllingFactionId, neighborFactionIds });

// The TerritoryLookupResponse the engine sends for `h3Index`: the cell controlled by `own` ('' for none) and its
// ring-1 neighbors (sorted, as the engine sends them) controlled by `neighbors` in order, the rest uncontrolled.
function engineBody(h3Index, own = '', neighbors = []) {
  const ring = gridDisk(h3Index, 1).filter((cell) => cell !== h3Index).sort();
  return TerritoryLookupResponse.encode({
    cell: { h3Cell: h3Index, controllingFactionId: own },
    neighbors: ring.map((h3Cell, i) => ({ h3Cell, controllingFactionId: neighbors[i] ?? '' }))
  }).finish();
}

// A stand-in for the engine's private listener: `answer(h3Index, req, res)` decides each response; every request
// is recorded in `requests`.
async function mockEngine(answer) {
  const requests = [];
  const server = createServer((req, res) => {
    requests.push({ url: req.url, credential: req.headers['x-eotha-workload-credential'] });
    const h3Index = decodeURIComponent(req.url.slice('/internal/v1/territory/'.length));
    answer(h3Index, req, res);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  return {
    url,
    requests,
    client: (options = {}) => createTerritoryClient({ url, credential: INTERNAL_RTSE_CREDENTIAL, ...options }),
    close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); })
  };
}

const protobuf = (res, body) => { res.writeHead(200, { 'content-type': 'application/x-protobuf' }); res.end(Buffer.from(body)); };

describe('spawnStandingGains', () => {
  test('a controlled cell gives its controller +35 and nothing for the neighbors', () => {
    assert.equal(SPAWN_CONTROLLED_STANDING, 35);
    assert.deepEqual(spawnStandingGains(territoryOf('beta', ['alpha', 'gamma', 'gamma', '', '', ''])), { beta: 35 });
  });

  test('an uncontrolled cell with no controlled neighbor gives nothing', () => {
    assert.deepEqual(spawnStandingGains(territoryOf('', ['', '', '', '', '', ''])), {});
    assert.deepEqual(spawnStandingGains(territoryOf('', [])), {});
  });

  test('an uncontrolled cell gives +5 per neighboring cell a faction controls', () => {
    assert.equal(SPAWN_NEIGHBOR_STANDING, 5);
    for (const [count, gain] of [[1, 5], [2, 10], [3, 15], [6, 30]]) {
      const neighbors = Array.from({ length: 6 }, (_, i) => (i < count ? 'alpha' : ''));
      assert.deepEqual(spawnStandingGains(territoryOf('', neighbors)), { alpha: gain }, `${count} alpha neighbors`);
    }
  });

  test('mixed neighbors: two gamma and one alpha give gamma +10 and alpha +5', () => {
    assert.deepEqual(spawnStandingGains(territoryOf('', ['gamma', '', 'alpha', 'gamma', '', ''])), { gamma: 10, alpha: 5 });
    assert.deepEqual(
      spawnStandingGains(territoryOf('', ['alpha', 'beta', 'gamma', 'beta', 'gamma', 'gamma'])),
      { alpha: 5, beta: 10, gamma: 15 }
    );
  });
});

describe('decodeTerritory', () => {
  test('reads the cell and its neighbors', () => {
    assert.deepEqual(
      decodeTerritory(engineBody(HAMBURG_H3, '', ['gamma', 'alpha', 'gamma']), HAMBURG_H3),
      territoryOf('', ['gamma', 'alpha', 'gamma', '', '', ''])
    );
  });

  test('refuses a body about another cell, an unknown faction or a repeated neighbor', () => {
    assert.equal(decodeTerritory(engineBody(SF_H3, 'alpha'), HAMBURG_H3), null);
    assert.equal(decodeTerritory(engineBody(HAMBURG_H3, 'independent'), HAMBURG_H3), null);
    assert.equal(decodeTerritory(engineBody(HAMBURG_H3, '', ['delta']), HAMBURG_H3), null);
    const repeated = TerritoryLookupResponse.encode({
      cell: { h3Cell: HAMBURG_H3, controllingFactionId: '' },
      neighbors: [{ h3Cell: SF_H3, controllingFactionId: 'alpha' }, { h3Cell: SF_H3, controllingFactionId: 'alpha' }]
    }).finish();
    assert.equal(decodeTerritory(repeated, HAMBURG_H3), null);
  });
});

describe('territory client', () => {
  test('asks the engine with the workload credential and reads its answer', async () => {
    const engine = await mockEngine((h3Index, req, res) => protobuf(res, engineBody(h3Index, 'gamma')));
    try {
      assert.deepEqual(await engine.client().lookup(HAMBURG_H3), territoryOf('gamma', ['', '', '', '', '', '']));
      assert.deepEqual(engine.requests, [{ url: `/internal/v1/territory/${HAMBURG_H3}`, credential: INTERNAL_RTSE_CREDENTIAL }]);
    } finally {
      await engine.close();
    }
  });

  test('has no answer when the engine is slower than the timeout', async () => {
    const engine = await mockEngine(() => {}); // never answers
    try {
      const started = Date.now();
      assert.equal(await engine.client({ timeoutMs: 100 }).lookup(HAMBURG_H3), null);
      assert.ok(Date.now() - started < 2000);
    } finally {
      await engine.close();
    }
  });

  test('has no answer when the engine answers an error', async () => {
    for (const status of [400, 401, 500, 503]) {
      const engine = await mockEngine((h3Index, req, res) => { res.writeHead(status); res.end('{"error":"X"}'); });
      try {
        assert.equal(await engine.client().lookup(HAMBURG_H3), null, String(status));
      } finally {
        await engine.close();
      }
    }
  });

  test('has no answer when the engine is unreachable or sends garbage', async () => {
    const engine = await mockEngine((h3Index, req, res) => protobuf(res, Buffer.from([0xff, 0xff, 0xff])));
    try {
      assert.equal(await engine.client().lookup(HAMBURG_H3), null);
    } finally {
      await engine.close();
    }
    // The port is closed now.
    assert.equal(await createTerritoryClient({ url: engine.url, credential: INTERNAL_RTSE_CREDENTIAL }).lookup(HAMBURG_H3), null);
  });

  test('asks nothing when the URL or the credential is unset', async () => {
    let calls = 0;
    const fetch = async () => { calls += 1; throw new Error('must not be called'); };
    for (const config of [{}, { url: 'http://127.0.0.1:9' }, { credential: INTERNAL_RTSE_CREDENTIAL }]) {
      const client = createTerritoryClient({ ...config, fetch });
      assert.equal(client.configured, false);
      assert.equal(await client.lookup(HAMBURG_H3), null);
    }
    assert.equal(calls, 0);
  });
});

describe('a new player starts with the standing of its spawn cell', () => {
  // What the mock engine says about each cell: [own, neighbors]; any other cell is uncontrolled all round.
  let world;
  let engine;
  let original;

  before(async () => {
    await app.ready();
    engine = await mockEngine((h3Index, req, res) => {
      if (world.fail) { res.writeHead(500); res.end(); return; }
      if (world.hang) return;
      const [own, neighbors] = world.cells[h3Index] ?? ['', []];
      protobuf(res, engineBody(h3Index, own, neighbors));
    });
    original = app.territory.lookup;
  });
  beforeEach(() => {
    world = { cells: {} };
    engine.requests.length = 0;
    app.territory.lookup = engine.client({ timeoutMs: 300 }).lookup;
  });
  after(async () => {
    app.territory.lookup = original;
    await engine.close();
    await closeApp();
  });

  const guestLogin = (deviceId = randomUUID(), location = {}) =>
    app.inject({ method: 'POST', url: '/auth/guest', headers: attestationHeaders, payload: { deviceId, ...location } });
  async function newGuest(location = {}, deviceId = randomUUID()) {
    const res = await guestLogin(deviceId, location);
    assert.equal(res.statusCode, 200, res.body);
    const session = json(res);
    track(session.player.id);
    return session;
  }
  const standingsOf = async (playerId) => Object.fromEntries(
    (await app.prisma.playerReputation.findMany({ where: { playerId } })).map((r) => [r.factionId, r.standing])
  );
  const ledgerOf = (playerId) => app.prisma.reputationLedger.findMany({ where: { playerId, reason: LEDGER_REASONS.SPAWN_TERRITORY } });
  const claimed = (session) => {
    const { alpha, beta, gamma } = app.jwt.verify(session.token).factions;
    return { alpha, beta, gamma };
  };

  test('a harbor in a controlled cell starts +35 with its controller, signed into the first token', async () => {
    world.cells[HAMBURG_H3] = ['beta', ['alpha', 'gamma']];
    const guest = await newGuest(HAMBURG);
    assert.deepEqual(await standingsOf(guest.player.id), { beta: 35 });
    assert.deepEqual(claimed(guest), { alpha: 0, beta: 35, gamma: 0 });
    const [entry, ...more] = await ledgerOf(guest.player.id);
    assert.equal(more.length, 0);
    assert.equal(entry.factionId, 'beta');
    assert.deepEqual([entry.factionDelta, entry.alphaDelta, entry.betaDelta, entry.gammaDelta], [35, 0, 35, 0]);
    assert.deepEqual(engine.requests.map(({ url }) => url), [`/internal/v1/territory/${HAMBURG_H3}`]);
  });

  test('an uncontrolled cell with no controlled neighbor gives no standing', async () => {
    const guest = await newGuest(HAMBURG);
    assert.deepEqual(await standingsOf(guest.player.id), {});
    assert.equal((await ledgerOf(guest.player.id)).length, 0);
    assert.deepEqual(claimed(guest), { alpha: 0, beta: 0, gamma: 0 });
  });

  for (const [count, neighbors, want] of [
    [1, ['alpha'], { alpha: 5 }],
    [2, ['gamma', '', 'gamma'], { gamma: 10 }],
    [3, ['beta', 'beta', '', 'beta'], { beta: 15 }]
  ]) {
    test(`an uncontrolled cell with ${count} neighbor(s) of one faction gives +${5 * count}`, async () => {
      world.cells[HAMBURG_H3] = ['', neighbors];
      const guest = await newGuest(HAMBURG);
      assert.deepEqual(await standingsOf(guest.player.id), want);
      const [entry] = await ledgerOf(guest.player.id);
      assert.equal(entry.factionId, null);
    });
  }

  test('mixed neighbors: two gamma and one alpha give gamma +10 and alpha +5', async () => {
    world.cells[HAMBURG_H3] = ['', ['gamma', 'alpha', '', 'gamma']];
    const guest = await newGuest(HAMBURG);
    assert.deepEqual(await standingsOf(guest.player.id), { alpha: 5, gamma: 10 });
    assert.deepEqual(claimed(guest), { alpha: 5, beta: 0, gamma: 10 });
    assert.equal((await ledgerOf(guest.player.id)).length, 1);
  });

  test('three factions around the cell each get their share', async () => {
    world.cells[HAMBURG_H3] = ['', ['alpha', 'beta', 'gamma', 'gamma', 'beta', 'gamma']];
    const guest = await newGuest(HAMBURG);
    assert.deepEqual(await standingsOf(guest.player.id), { alpha: 5, beta: 10, gamma: 15 });
  });

  test('the San Francisco fallback harbor is looked up like any other', async () => {
    world.cells[SF_H3] = ['alpha', []];
    const guest = await newGuest();
    assert.equal(guest.player.spawn_point.h3_index, SF_H3);
    assert.deepEqual(engine.requests.map(({ url }) => url), [`/internal/v1/territory/${SF_H3}`]);
    assert.deepEqual(await standingsOf(guest.player.id), { alpha: 35 });
  });

  test('a later sign-in never grants it again', async () => {
    world.cells[HAMBURG_H3] = ['gamma', []];
    const deviceId = randomUUID();
    const first = await newGuest(HAMBURG, deviceId);
    const again = json(await guestLogin(deviceId, HAMBURG));
    const refreshed = await app.inject({ method: 'POST', url: '/auth/refresh', payload: { refreshToken: first.refreshToken } });
    assert.equal(refreshed.statusCode, 200);
    assert.deepEqual(await standingsOf(first.player.id), { gamma: 35 });
    assert.deepEqual(claimed(again), { alpha: 0, beta: 0, gamma: 35 });
    assert.equal((await ledgerOf(first.player.id)).length, 1);
    assert.equal(engine.requests.length, 1);
  });

  test('an existing harbor is never looked up or granted, and existing standings are untouched', async () => {
    world.cells[HAMBURG_H3] = ['alpha', []];
    world.fail = true; // the first sign-in gets nothing
    const guest = await newGuest(HAMBURG);
    world.fail = false;
    await app.prisma.playerReputation.create({ data: { playerId: guest.player.id, factionId: 'beta', standing: 120 } });
    engine.requests.length = 0;
    await ensureHarbor(app.prisma, guest.player.id, HAMBURG, { territory: app.territory });
    assert.equal(engine.requests.length, 0);
    assert.deepEqual(await standingsOf(guest.player.id), { beta: 120 });
  });

  test('concurrent first sign-ins from one device grant it once', async () => {
    world.cells[HAMBURG_H3] = ['', ['alpha', 'alpha']];
    const deviceId = randomUUID();
    const sessions = (await Promise.all(Array.from({ length: 4 }, () => guestLogin(deviceId, HAMBURG)))).map((res) => {
      assert.equal(res.statusCode, 200, res.body);
      return json(res);
    });
    const ids = new Set(sessions.map(({ player }) => player.id));
    for (const id of ids) track(id);
    assert.equal(ids.size, 1);
    const [playerId] = ids;
    assert.deepEqual(await standingsOf(playerId), { alpha: 10 });
    assert.equal((await ledgerOf(playerId)).length, 1);
  });

  test('concurrent ensureHarbor calls for a player without a harbor grant it once', async () => {
    world.cells[HAMBURG_H3] = ['gamma', []];
    world.fail = true;
    const guest = await newGuest(HAMBURG); // created with no standing
    world.fail = false;
    await app.prisma.spaceHarbor.delete({ where: { playerId: guest.player.id } });
    engine.requests.length = 0;
    await Promise.all(Array.from({ length: 6 }, () => ensureHarbor(app.prisma, guest.player.id, HAMBURG, { territory: app.territory })));
    assert.equal(engine.requests.length, 1);
    assert.deepEqual(await standingsOf(guest.player.id), { gamma: 35 });
    assert.equal((await ledgerOf(guest.player.id)).length, 1);
  });

  test('an engine error, a timeout or an unset lookup still signs in, with no standing', async () => {
    world.cells[HAMBURG_H3] = ['alpha', []];
    world.fail = true;
    const failed = await newGuest(HAMBURG);
    world.fail = false;
    world.hang = true;
    const started = Date.now();
    const timedOut = await newGuest(HAMBURG);
    assert.ok(Date.now() - started < 5000);
    world.hang = false;
    app.territory.lookup = createTerritoryClient({}).lookup;
    const unset = await newGuest(HAMBURG);
    for (const guest of [failed, timedOut, unset]) {
      assert.equal(guest.player.spawn_point.h3_index, HAMBURG_H3);
      assert.deepEqual(await standingsOf(guest.player.id), {});
      assert.equal((await ledgerOf(guest.player.id)).length, 0);
    }
  });
});
