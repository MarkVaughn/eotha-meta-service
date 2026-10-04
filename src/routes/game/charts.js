import { createHash } from 'node:crypto';
import { H3_PATTERN, STATION_PATTERN } from '../../config/missions.js';
import { mockAccount } from '../../lib/mock-accounts.js';
import {
  canonicalJson,
  loadRtsePublicKey,
  verifyPlanetChartSignature,
  verifySystemChartSignature
} from '../../lib/chart-claim.js';

const PLANET_CHART_PAYOUT = 500;
const SYSTEM_CHART_PAYOUT = 2500;

const uint = { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
const id = { type: 'string', minLength: 1, maxLength: 256 };
const signature = { type: 'string', minLength: 1, maxLength: 512 };

const registerPlanetSchema = {
  body: {
    type: 'object',
    required: ['chartKey', 'survey'],
    properties: {
      chartKey: {
        type: 'object',
        required: ['planetId', 'pilotId', 'systemH3', 'completedAtMs', 'signature'],
        properties: {
          planetId: id,
          pilotId: id,
          systemH3: { type: 'string', pattern: H3_PATTERN },
          completedAtMs: uint,
          signature
        }
      },
      survey: { type: 'object' },
      surveyBytesBase64: { type: 'string', maxLength: 1_000_000 }
    }
  }
};

const claimSystemSchema = {
  body: {
    type: 'object',
    required: ['systemKey'],
    properties: {
      systemKey: {
        type: 'object',
        required: ['systemH3', 'pilotId', 'totalBodiesCharted', 'chartedAtMs', 'signature'],
        properties: {
          systemH3: { type: 'string', pattern: H3_PATTERN },
          pilotId: id,
          totalBodiesCharted: { type: 'integer', minimum: 0, maximum: 4294967295 },
          chartedAtMs: uint,
          signature
        }
      }
    }
  }
};

const querySchema = {
  querystring: {
    type: 'object',
    properties: {
      planetId: id,
      systemH3: { type: 'string', pattern: H3_PATTERN }
    }
  }
};

const sellSchema = {
  body: {
    type: 'object',
    required: ['stationId'],
    properties: {
      planetId: id,
      systemH3: { type: 'string', pattern: H3_PATTERN },
      stationId: { type: 'string', pattern: STATION_PATTERN }
    }
  }
};

function surveyHash(survey, surveyBytesBase64) {
  const bytes = surveyBytesBase64 !== undefined
    ? Buffer.from(surveyBytesBase64, 'base64')
    : Buffer.from(canonicalJson(survey), 'utf8');
  return createHash('sha256').update(bytes).digest();
}

const iso = (d) => (d ? d.toISOString() : null);

function planetView(c, withSurvey = false) {
  return {
    planetId: c.planetId,
    systemH3: c.systemH3,
    completedAtMs: Number(c.completedAtMs),
    signature: c.signature,
    sold: !!c.soldAt,
    soldAt: iso(c.soldAt),
    discoveredAt: iso(c.discoveredAt),
    ...(withSurvey ? { survey: c.surveyJson } : {})
  };
}

function systemView(c) {
  return {
    systemH3: c.systemH3,
    totalBodiesCharted: c.totalBodiesCharted,
    chartedAtMs: Number(c.chartedAtMs),
    signature: c.signature,
    sold: !!c.soldAt,
    soldAt: iso(c.soldAt),
    discoveredAt: iso(c.discoveredAt)
  };
}

export default async function chartsRoutes(fastify, opts) {
  const prisma = fastify.prisma;
  const rtsePublicKey = opts.rtsePublicKey ?? loadRtsePublicKey();
  if (!rtsePublicKey) {
    fastify.log.warn('⚠️ keys/public.pem not found; chart registration claims will be rejected.');
  }

  // Dev-login pilots have no database row, so their charts live in memory.
  const mockPlanets = new Map(); // `${playerId}::${planetId}` -> row
  const mockSystems = new Map(); // `${playerId}::${systemH3}` -> row

  fastify.addHook('onRequest', fastify.authenticate);

  const mockRows = (map, playerId) => [...map.entries()]
    .filter(([k]) => k.startsWith(`${playerId}::`)).map(([, v]) => v);

  fastify.post('/charts/register-planet', { schema: registerPlanetSchema }, async (request, reply) => {
    const { chartKey, survey, surveyBytesBase64 } = request.body;
    const playerId = request.user.sub;
    if (chartKey.pilotId !== playerId) {
      return reply.code(403).send({ error: 'Chart does not belong to the authenticated pilot.' });
    }
    if (!verifyPlanetChartSignature(chartKey, surveyHash(survey, surveyBytesBase64), rtsePublicKey)) {
      return reply.code(403).send({ error: 'Invalid chart signature.' });
    }

    const data = {
      systemH3: chartKey.systemH3,
      completedAtMs: BigInt(chartKey.completedAtMs),
      signature: chartKey.signature,
      surveyJson: survey
    };
    if (request.user.mock) {
      const key = `${playerId}::${chartKey.planetId}`;
      const prev = mockPlanets.get(key);
      mockPlanets.set(key, {
        ...prev, ...data, planetId: chartKey.planetId, soldAt: prev?.soldAt ?? null,
        discoveredAt: prev?.discoveredAt ?? new Date()
      });
    } else {
      await prisma.planetChart.upsert({
        where: { playerId_planetId: { playerId, planetId: chartKey.planetId } },
        update: data,
        create: { playerId, planetId: chartKey.planetId, ...data }
      });
    }
    return { registered: true, planetId: chartKey.planetId };
  });

  fastify.post('/charts/claim-system', { schema: claimSystemSchema }, async (request, reply) => {
    const { systemKey } = request.body;
    const playerId = request.user.sub;
    if (systemKey.pilotId !== playerId) {
      return reply.code(403).send({ error: 'Chart does not belong to the authenticated pilot.' });
    }
    if (!verifySystemChartSignature(systemKey, rtsePublicKey)) {
      return reply.code(403).send({ error: 'Invalid chart signature.' });
    }

    const data = {
      totalBodiesCharted: systemKey.totalBodiesCharted,
      chartedAtMs: BigInt(systemKey.chartedAtMs),
      signature: systemKey.signature
    };
    if (request.user.mock) {
      const key = `${playerId}::${systemKey.systemH3}`;
      const prev = mockSystems.get(key);
      mockSystems.set(key, {
        ...prev, ...data, systemH3: systemKey.systemH3, soldAt: prev?.soldAt ?? null,
        discoveredAt: prev?.discoveredAt ?? new Date()
      });
    } else {
      await prisma.systemChart.upsert({
        where: { playerId_systemH3: { playerId, systemH3: systemKey.systemH3 } },
        update: data,
        create: { playerId, systemH3: systemKey.systemH3, ...data }
      });
    }
    return { claimed: true, systemH3: systemKey.systemH3 };
  });

  fastify.get('/charts/inventory', async (request) => {
    const playerId = request.user.sub;
    let planets;
    let systems;
    if (request.user.mock) {
      planets = mockRows(mockPlanets, playerId);
      systems = mockRows(mockSystems, playerId);
    } else {
      [planets, systems] = await Promise.all([
        prisma.planetChart.findMany({ where: { playerId }, orderBy: { discoveredAt: 'asc' } }),
        prisma.systemChart.findMany({ where: { playerId }, orderBy: { discoveredAt: 'asc' } })
      ]);
    }
    return { planetCharts: planets.map((c) => planetView(c)), systemCharts: systems.map(systemView) };
  });

  fastify.get('/charts/query', { schema: querySchema }, async (request, reply) => {
    const { planetId, systemH3 } = request.query;
    const playerId = request.user.sub;
    if ((planetId === undefined) === (systemH3 === undefined)) {
      return reply.code(400).send({ error: 'Provide exactly one of planetId or systemH3.' });
    }

    if (planetId !== undefined) {
      const chart = request.user.mock
        ? mockPlanets.get(`${playerId}::${planetId}`)
        : await prisma.planetChart.findUnique({ where: { playerId_planetId: { playerId, planetId } } });
      if (!chart) return reply.code(404).send({ error: 'Chart not registered.' });
      return planetView(chart, true);
    }

    let system;
    let planets;
    if (request.user.mock) {
      system = mockSystems.get(`${playerId}::${systemH3}`);
      planets = mockRows(mockPlanets, playerId).filter((c) => c.systemH3 === systemH3);
    } else {
      [system, planets] = await Promise.all([
        prisma.systemChart.findUnique({ where: { playerId_systemH3: { playerId, systemH3 } } }),
        prisma.planetChart.findMany({ where: { playerId, systemH3 } })
      ]);
    }
    if (!system && planets.length === 0) return reply.code(404).send({ error: 'Chart not registered.' });
    return {
      systemH3,
      systemChart: system ? systemView(system) : null,
      planetCharts: planets.map((c) => planetView(c, true))
    };
  });

  fastify.post('/charts/sell', { schema: sellSchema }, async (request, reply) => {
    const { planetId, systemH3 } = request.body;
    const playerId = request.user.sub;
    if ((planetId === undefined) === (systemH3 === undefined)) {
      return reply.code(400).send({ error: 'Provide exactly one of planetId or systemH3.' });
    }
    const isPlanet = planetId !== undefined;
    const rewardCredits = isPlanet ? PLANET_CHART_PAYOUT : SYSTEM_CHART_PAYOUT;

    if (request.user.mock) {
      const row = isPlanet
        ? mockPlanets.get(`${playerId}::${planetId}`)
        : mockSystems.get(`${playerId}::${systemH3}`);
      if (!row) return reply.code(404).send({ error: 'Chart not registered.' });
      if (row.soldAt) return reply.code(409).send({ error: 'Chart has already been sold.' });
      // Synchronous from here on, so concurrent requests cannot both sell.
      row.soldAt = new Date();
      const account = mockAccount(playerId);
      account.credits += rewardCredits;
      return { sold: true, rewardCredits, newBalance: account.credits };
    }

    const model = isPlanet ? prisma.planetChart : prisma.systemChart;
    const where = isPlanet ? { playerId, planetId } : { playerId, systemH3 };
    const existing = await model.findFirst({ where, select: { id: true } });
    if (!existing) return reply.code(404).send({ error: 'Chart not registered.' });

    const newBalance = await prisma.$transaction(async (tx) => {
      const txModel = isPlanet ? tx.planetChart : tx.systemChart;
      // Guarded on soldAt so a chart pays out at most once.
      const { count } = await txModel.updateMany({ where: { ...where, soldAt: null }, data: { soldAt: new Date() } });
      if (count !== 1) return null;
      const player = await tx.player.update({
        where: { id: playerId },
        data: { credits: { increment: rewardCredits } },
        select: { credits: true }
      });
      return player.credits;
    });
    if (newBalance === null) return reply.code(409).send({ error: 'Chart has already been sold.' });
    return { sold: true, rewardCredits, newBalance };
  });
}
