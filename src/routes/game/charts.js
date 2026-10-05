import { createHash } from 'node:crypto';
import { PlanetarySurvey } from '../../lib/contracts/exploration.js';
import { H3_PATTERN, STATION_PATTERN } from '../../config/missions.js';
import {
  loadRtsePublicKey,
  verifyPlanetChartKey,
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
    required: ['chartKey', 'surveyBytesBase64'],
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
      // Exact PlanetarySurvey protobuf bytes the RTSE signed; the survey JSON is derived from these.
      surveyBytesBase64: { type: 'string', minLength: 1, maxLength: 1_000_000 }
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
      // Charts sell at any station; the id is only format-checked (there is no station registry).
      stationId: { type: 'string', pattern: STATION_PATTERN }
    }
  }
};

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

  fastify.addHook('onRequest', fastify.authenticate);

  const staleKey = (reply) => reply.code(409).send({
    error: 'STALE_CHART_KEY',
    message: 'Existing chart has newer or identical timestamp'
  });
  const alreadySold = (reply) => reply.code(409).send({
    error: 'CHART_ALREADY_SOLD',
    message: 'Sold charts cannot be overwritten'
  });

  fastify.post('/charts/register-planet', { schema: registerPlanetSchema }, async (request, reply) => {
    const { chartKey, surveyBytesBase64 } = request.body;
    const playerId = request.user.sub;
    if (chartKey.pilotId !== playerId) {
      return reply.code(403).send({ error: 'Chart does not belong to the authenticated pilot.' });
    }

    // The signature binds the exact survey bytes; the survey JSON is only ever derived from them.
    const surveyBytes = Buffer.from(surveyBytesBase64, 'base64');
    const surveyHash = createHash('sha256').update(surveyBytes).digest();
    if (!verifyPlanetChartKey(chartKey, chartKey.signature, surveyHash, rtsePublicKey)) {
      return reply.code(403).send({ error: 'Invalid chart signature.' });
    }
    let surveyJson;
    try {
      surveyJson = PlanetarySurvey.toJSON(PlanetarySurvey.decode(surveyBytes));
    } catch {
      return reply.code(400).send({ error: 'surveyBytesBase64 is not a valid PlanetarySurvey.' });
    }

    const completedAtMs = BigInt(chartKey.completedAtMs);
    const data = { systemH3: chartKey.systemH3, completedAtMs, signature: chartKey.signature, surveyJson };
    const reject = (existing, reply) => {
      if (completedAtMs <= BigInt(existing.completedAtMs)) return staleKey(reply);
      return alreadySold(reply); // newer key, but the existing chart was already sold
    };

    const where = { playerId_planetId: { playerId, planetId: chartKey.planetId } };
    const existing = await prisma.planetChart.findUnique({ where });
    if (!existing) {
      try {
        await prisma.planetChart.create({ data: { playerId, planetId: chartKey.planetId, ...data } });
        return { registered: true, planetId: chartKey.planetId };
      } catch (err) {
        if (err?.code !== 'P2002') throw err;
        // Lost a creation race: fall through to the update path.
      }
    }
    // Guarded update so concurrent submissions can neither roll back a newer key nor touch a sold chart.
    const { count } = await prisma.planetChart.updateMany({
      where: { playerId, planetId: chartKey.planetId, soldAt: null, completedAtMs: { lt: completedAtMs } },
      data
    });
    if (count !== 1) {
      const current = await prisma.planetChart.findUnique({ where });
      return reject(current ?? existing ?? { completedAtMs }, reply);
    }
    return { registered: true, planetId: chartKey.planetId };
  });

  fastify.post('/charts/claim-system', { schema: claimSystemSchema }, async (request, reply) => {
    const { systemKey } = request.body;
    const playerId = request.user.sub;
    if (systemKey.pilotId !== playerId) {
      return reply.code(403).send({ error: 'Chart does not belong to the authenticated pilot.' });
    }
    // totalBodiesCharted is not validated against any local body count: the meta-service has no
    // system catalog. It is authoritative because the RTSE's Ed25519 signature covers it in the
    // canonical EOTHA_SYSTEM_CHART_V1 payload (pilot, systemH3, totalBodiesCharted, chartedAtMs), so
    // a client cannot alter the count without invalidating the signature.
    if (!verifySystemChartSignature(systemKey, rtsePublicKey)) {
      return reply.code(403).send({ error: 'Invalid chart signature.' });
    }

    const data = {
      totalBodiesCharted: systemKey.totalBodiesCharted,
      chartedAtMs: BigInt(systemKey.chartedAtMs),
      signature: systemKey.signature
    };
    const duplicate = () => reply.code(409).send({ error: 'SYSTEM_ALREADY_CLAIMED' });
    try {
      await prisma.systemChart.create({ data: { playerId, systemH3: systemKey.systemH3, ...data } });
    } catch (err) {
      if (err?.code === 'P2002') return duplicate();
      throw err;
    }
    return { claimed: true, systemH3: systemKey.systemH3 };
  });

  fastify.get('/charts/inventory', async (request) => {
    const playerId = request.user.sub;
    const [planets, systems] = await Promise.all([
      prisma.planetChart.findMany({ where: { playerId }, orderBy: { discoveredAt: 'asc' } }),
      prisma.systemChart.findMany({ where: { playerId }, orderBy: { discoveredAt: 'asc' } })
    ]);
    return { planetCharts: planets.map((c) => planetView(c)), systemCharts: systems.map(systemView) };
  });

  fastify.get('/charts/query', { schema: querySchema }, async (request, reply) => {
    const { planetId, systemH3 } = request.query;
    const playerId = request.user.sub;
    if ((planetId === undefined) === (systemH3 === undefined)) {
      return reply.code(400).send({ error: 'Provide exactly one of planetId or systemH3.' });
    }

    if (planetId !== undefined) {
      const chart = await prisma.planetChart.findUnique({ where: { playerId_planetId: { playerId, planetId } } });
      if (!chart) return reply.code(404).send({ error: 'Chart not registered.' });
      return planetView(chart, true);
    }

    const [system, planets] = await Promise.all([
      prisma.systemChart.findUnique({ where: { playerId_systemH3: { playerId, systemH3 } } }),
      prisma.planetChart.findMany({ where: { playerId, systemH3 } })
    ]);
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
