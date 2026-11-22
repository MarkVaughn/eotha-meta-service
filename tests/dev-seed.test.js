import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { attestationDouble, json, keysDir } from './helpers.js';
import { DEV_SEED_PILOTS } from '../src/config/dev.js';
import { COMPONENT_TYPES, hullBudget, maxTierOf, totalSubsystemPoints } from '../src/config/components.js';
import { clampStandingsWithCaps } from '../src/config/factions.js';
import { standingTier } from '../src/config/regulation.js';
import { devSeedTier } from '../src/lib/dev-seed.js';
import prismaPlugin from '../src/plugins/prisma.js';
import securityPlugin from '../src/plugins/security.js';
import attestationPlugin from '../src/plugins/attestation.js';
import identityPlugin from '../src/plugins/identity.js';
import authRoutes from '../src/routes/auth/index.js';

// The dev client's five callsigns (eotha-dev-client src/spaceships.ts); only this file uses them.
const CALLSIGNS = ['Pilot-1-NY', 'Pilot-2-Hamburg', 'Pilot-3-Rio', 'Pilot-4-Jakarta', 'Pilot-5-Sydney'];

const EXPECTED = {
  'Pilot-2-Hamburg': { hull: 4, other: 2, standings: { alpha: -300, beta: 450, gamma: 250 } },
  'Pilot-3-Rio': { hull: 4, other: 2, standings: { alpha: 450, beta: -300, gamma: -250 } },
  'Pilot-4-Jakarta': { hull: 5, other: 3, standings: { alpha: 0, beta: 0, gamma: 0 } },
  'Pilot-5-Sydney': { hull: 5, other: 3, standings: { alpha: -250, beta: -250, gamma: 700 } }
};

const seededComponents = (seed) => COMPONENT_TYPES.map((type) => ({ type, tier: devSeedTier(seed, type) }));

describe('DEV_SEED_PILOTS', () => {
  test('seeds Pilot-2 to Pilot-5 as requested and leaves Pilot-1 alone', () => {
    assert.deepEqual(Object.keys(DEV_SEED_PILOTS).sort(), Object.keys(EXPECTED).sort());
    assert.equal(DEV_SEED_PILOTS['Pilot-1-NY'], undefined);
    for (const [callsign, want] of Object.entries(EXPECTED)) {
      const seed = DEV_SEED_PILOTS[callsign];
      assert.equal(seed.hullTier, want.hull, callsign);
      assert.equal(seed.otherTier, want.other, callsign);
      assert.deepEqual({ ...seed.standings }, want.standings, callsign);
    }
  });

  test('the standings fall in the intended bands', () => {
    const tiers = (callsign) => Object.fromEntries(Object.entries(DEV_SEED_PILOTS[callsign].standings).map(([id, s]) => [id, standingTier(s)]));
    assert.deepEqual(tiers('Pilot-2-Hamburg'), { alpha: 'UNFRIENDLY', beta: 'TRUSTED', gamma: 'FRIENDLY' });
    assert.deepEqual(tiers('Pilot-3-Rio'), { alpha: 'TRUSTED', beta: 'UNFRIENDLY', gamma: 'UNFRIENDLY' });
    assert.deepEqual(tiers('Pilot-4-Jakarta'), { alpha: 'NEUTRAL', beta: 'NEUTRAL', gamma: 'NEUTRAL' });
  });

  test('every seeded standing survives the faction caps unchanged', () => {
    for (const [callsign, { standings }] of Object.entries(DEV_SEED_PILOTS)) {
      const { alpha, beta, gamma } = standings;
      assert.deepEqual(clampStandingsWithCaps(alpha, beta, gamma, { alpha: 0, beta: 0, gamma: 0 }), { alpha, beta, gamma }, callsign);
    }
  });

  test('every seeded ship is a legal loadout', () => {
    for (const [callsign, seed] of Object.entries(DEV_SEED_PILOTS)) {
      const components = seededComponents(seed);
      for (const { type, tier } of components) {
        assert.ok(tier >= 1 && tier <= maxTierOf(type), `${callsign} ${type} T${tier}`);
      }
      assert.ok(totalSubsystemPoints(components) <= hullBudget(seed.hullTier), `${callsign} fits its hull budget`);
      assert.ok(seed.hullTier >= 2, `${callsign} may carry a lander`);
    }
  });
});

describe('dev login seeds the dev pilots', () => {
  let server;
  // A territory lookup that would grant every new harbor spawn standing: dev login creates its pilots' harbors
  // itself, so it must never be asked, and the seeded standings are exactly what the seed lists.
  const territoryCalls = [];
  const territory = { configured: true, lookup: async (h3Index) => { territoryCalls.push(h3Index); return { controllingFactionId: 'alpha', neighborFactionIds: [] }; } };
  const forget = () => server.prisma.player.deleteMany({ where: { callsign: { in: CALLSIGNS } } });

  before(async () => {
    server = Fastify();
    await server.register(prismaPlugin);
    await server.register(securityPlugin, { keysDir });
    await server.register(attestationPlugin, { verifiers: [attestationDouble] });
    await server.register(identityPlugin);
    await server.register(authRoutes, { prefix: '/auth', devLogin: true, territory });
    await server.ready();
    await forget();
  });
  after(async () => {
    await forget();
    await server.close();
  });

  const devLogin = async (callsign) => {
    const res = await server.inject({ method: 'GET', url: `/auth/dev-login?callsign=${callsign}` });
    assert.equal(res.statusCode, 200);
    return json(res);
  };
  const stored = async (callsign) => {
    const player = await server.prisma.player.findUnique({
      where: { callsign },
      include: { reputations: true, spaceships: { include: { components: true } } }
    });
    const tiers = Object.fromEntries(player.spaceships[0]?.components.map((c) => [c.type, c.tier]) ?? []);
    const standings = Object.fromEntries(player.reputations.map((r) => [r.factionId, r.standing]));
    return { player, tiers, standings, components: player.spaceships[0]?.components ?? [] };
  };

  test('Pilot-2 to Pilot-5 start outfitted and with their standings', async () => {
    for (const [callsign, want] of Object.entries(EXPECTED)) {
      const body = await devLogin(callsign);
      const { player, tiers, standings, components } = await stored(callsign);
      assert.ok(player.devSeededAt, callsign);
      for (const type of COMPONENT_TYPES) {
        assert.equal(tiers[type], type === 'HULL' ? want.hull : want.other, `${callsign} ${type}`);
      }
      assert.ok(components.every((c) => c.quality === 'BASIC' && c.healthPct === 100), callsign);
      for (const id of ['alpha', 'beta', 'gamma']) assert.equal(standings[id] ?? 0, want.standings[id], `${callsign} ${id}`);

      // The login that seeded the pilot already signs the seeded ship and standings.
      assert.equal(body.player.ship.ship_attributes.hull_tier, want.hull, callsign);
      assert.equal(body.player.ship.ship_attributes.sensor_tier, want.other, callsign);
      assert.equal(body.player.ship.ship_attributes.lander_tier, want.other, callsign);
      const claims = server.jwt.decode(body.token);
      assert.deepEqual(
        { alpha: claims.factions.alpha, beta: claims.factions.beta, gamma: claims.factions.gamma },
        want.standings,
        callsign
      );
    }
  });

  test('dev pilots never get spawn standing on top of their seed', async () => {
    for (const callsign of CALLSIGNS) await devLogin(callsign);
    assert.deepEqual(territoryCalls, []);
    for (const [callsign, want] of Object.entries(EXPECTED)) {
      const { standings } = await stored(callsign);
      for (const id of ['alpha', 'beta', 'gamma']) assert.equal(standings[id] ?? 0, want.standings[id], `${callsign} ${id}`);
    }
    assert.deepEqual((await stored('Pilot-1-NY')).standings, {});
  });

  test('Pilot-1 keeps the plain dev-login start', async () => {
    const body = await devLogin('Pilot-1-NY');
    const { player, standings } = await stored('Pilot-1-NY');
    assert.equal(player.devSeededAt, null);
    assert.deepEqual(standings, {});
    assert.equal(body.player.ship.ship_attributes.hull_tier, 1);
  });

  test('logging in again changes nothing the pilot has since done', async () => {
    const callsign = 'Pilot-3-Rio';
    await devLogin(callsign);
    const first = await stored(callsign);
    // Progress after the seed: a standing moved and a component raised.
    await server.prisma.playerReputation.update({
      where: { playerId_factionId: { playerId: first.player.id, factionId: 'alpha' } },
      data: { standing: 100 }
    });
    await server.prisma.shipComponentRecord.updateMany({
      where: { spaceshipId: first.player.spaceships[0].id, type: 'ENGINES' },
      data: { tier: 3 }
    });
    await devLogin(callsign);
    await devLogin(callsign);
    const again = await stored(callsign);
    assert.deepEqual(again.player.devSeededAt, first.player.devSeededAt);
    assert.equal(again.standings.alpha, 100);
    assert.equal(again.tiers.ENGINES, 3);
    assert.equal(again.player.spaceships.length, 1);
    const ledger = await server.prisma.reputationLedger.count({ where: { playerId: first.player.id, reason: 'DEV_SEED' } });
    assert.equal(ledger, 1);
  });

  test('concurrent first logins seed once', async () => {
    const callsign = 'Pilot-5-Sydney';
    await server.prisma.player.deleteMany({ where: { callsign } });
    const results = await Promise.allSettled(
      Array.from({ length: 4 }, () => server.inject({ method: 'GET', url: `/auth/dev-login?callsign=${callsign}` }))
    );
    assert.ok(results.some((r) => r.status === 'fulfilled' && r.value.statusCode === 200));
    const { player, standings, tiers } = await stored(callsign);
    assert.equal(player.spaceships.length, 1);
    assert.equal(tiers.HULL, 5);
    assert.deepEqual(standings, EXPECTED[callsign].standings);
    assert.equal(await server.prisma.reputationLedger.count({ where: { playerId: player.id, reason: 'DEV_SEED' } }), 1);
  });

  test('a dev pilot created before the seed is seeded on its next login', async () => {
    const callsign = 'Pilot-2-Hamburg';
    await server.prisma.player.deleteMany({ where: { callsign } });
    const legacy = await server.prisma.player.create({
      data: {
        email: `${callsign}@dev-login.invalid`,
        passwordHash: '!',
        callsign,
        spaceships: { create: { callsign, components: { create: [{ type: 'HULL', tier: 1 }, { type: 'ENGINES', tier: 1 }] } } }
      }
    });
    await devLogin(callsign);
    const { player, tiers, standings } = await stored(callsign);
    assert.equal(player.id, legacy.id);
    assert.equal(player.spaceships.length, 1);
    assert.equal(tiers.HULL, 4);
    assert.equal(tiers.ENGINES, 2);
    assert.equal(tiers.LANDER, 2);
    assert.deepEqual(standings, EXPECTED[callsign].standings);
  });

  test('an account that did not come from dev login is never seeded', async () => {
    const callsign = 'Pilot-4-Jakarta';
    await server.prisma.player.deleteMany({ where: { callsign } });
    await server.prisma.player.create({ data: { email: 'pilot4@example.com', passwordHash: '!', callsign } });
    await devLogin(callsign);
    const { player, tiers } = await stored(callsign);
    assert.equal(player.devSeededAt, null);
    assert.notEqual(tiers.HULL, 5);
  });
});
