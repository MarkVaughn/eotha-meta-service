import { createHash } from 'node:crypto';
import { PlanetarySurvey } from '../../lib/contracts/exploration.js';
import { H3_PATTERN, STATION_PATTERN } from '../../config/patterns.js';
import { PLANET_CHART_XP, SYSTEM_CHART_XP } from '../../config/captain.js';
import { awardCaptainXp } from '../../lib/captain.js';
import {
  verifyPlanetChartKey,
  verifySystemChartSignature
} from '../../lib/chart-claim.js';
import { deductCrewRevenueShare, payrollCrewOf } from '../../lib/crew.js';
import { lockActiveShip } from '../../lib/ship.js';

const PLANET_CHART_PAYOUT = 500;
const SYSTEM_CHART_PAYOUT = 2500;

const uint = { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
const id = { type: 'string', minLength: 1, maxLength: 256 };
const signature = { type: 'string', minLength: 1, maxLength: 512 };
// Standard base64 of exactly 32 bytes.
const digest32 = { type: 'string', pattern: '^[A-Za-z0-9+/]{43}=$' };

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
        // systemDigest is required: V1 keys, signed without it, are refused.
        required: ['systemH3', 'pilotId', 'totalBodiesCharted', 'chartedAtMs', 'signature', 'systemDigest'],
        properties: {
          systemH3: { type: 'string', pattern: H3_PATTERN },
          pilotId: id,
          totalBodiesCharted: { type: 'integer', minimum: 0, maximum: 4294967295 },
          chartedAtMs: uint,
          signature,
          // Base64 of the 32-byte SHA-256 over the system's planet survey hashes the RTSE signed.
          systemDigest: digest32
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
    systemDigest: c.systemDigest ? Buffer.from(c.systemDigest).toString('base64') : null,
    sold: !!c.soldAt,
    soldAt: iso(c.soldAt),
    discoveredAt: iso(c.discoveredAt)
  };
}

export default async function chartsRoutes(fastify) {
  const prisma = fastify.prisma;
  fastify.addHook('onRequest', fastify.authenticate);

  const staleKey = (reply) => reply.code(409).send({
    error: 'STALE_CHART_KEY',
    message: 'Existing chart has newer or identical timestamp'
  });
  const alreadySold = (reply) => reply.code(409).send({
    error: 'CHART_ALREADY_SOLD',
    message: 'Sold charts cannot be overwritten'
  });

  // Records a newly verified chart with `create(tx)` and awards its captain XP in one transaction
  // holding the pilot's lock, so the XP is earned exactly once per chart: a duplicate fails the create
  // (P2002) and rolls the award back with it.
  const recordWithXp = (request, xp, create) => prisma.$transaction(async (tx) => {
    const { captain } = await lockActiveShip(tx, request.user);
    await create(tx);
    return awardCaptainXp(tx, captain, xp);
  });

  fastify.post('/charts/register-planet', { schema: registerPlanetSchema, preHandler: fastify.requireClaimKey }, async (request, reply) => {
    const { chartKey, surveyBytesBase64 } = request.body;
    const playerId = request.user.sub;
    if (chartKey.pilotId !== playerId) {
      return reply.code(403).send({ error: 'Chart does not belong to the authenticated pilot.' });
    }

    // The signature binds the exact survey bytes; the survey JSON is only ever derived from them.
    const surveyBytes = Buffer.from(surveyBytesBase64, 'base64');
    const surveyHash = createHash('sha256').update(surveyBytes).digest();
    if (!verifyPlanetChartKey(chartKey, chartKey.signature, surveyHash, fastify.claimKey.key)) {
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
        const captain = await recordWithXp(request, PLANET_CHART_XP, (tx) =>
          tx.planetChart.create({ data: { playerId, planetId: chartKey.planetId, ...data } }));
        return { registered: true, planetId: chartKey.planetId, ...captain };
      } catch (err) {
        if (err?.code !== 'P2002') throw err;
        // Lost a creation race: fall through to the update path.
      }
    }
    // Guarded update so concurrent submissions can neither roll back a newer key nor touch a sold chart.
    // A newer key for a chart already registered awards no XP.
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

  fastify.post('/charts/claim-system', { schema: claimSystemSchema, preHandler: fastify.requireClaimKey }, async (request, reply) => {
    const { systemKey } = request.body;
    const playerId = request.user.sub;
    if (systemKey.pilotId !== playerId) {
      return reply.code(403).send({ error: 'Chart does not belong to the authenticated pilot.' });
    }
    // totalBodiesCharted is not validated against any local body count: the meta-service has no
    // system catalog. It is authoritative because the RTSE's Ed25519 signature covers it in the
    // canonical EOTHA_SYSTEM_CHART_V2 payload (pilot, systemH3, totalBodiesCharted, chartedAtMs,
    // systemDigest), so a client cannot alter the count or the digest without invalidating the
    // signature.
    const systemDigest = Buffer.from(systemKey.systemDigest, 'base64');
    if (!verifySystemChartSignature(systemKey, systemDigest, fastify.claimKey.key)) {
      return reply.code(403).send({ error: 'Invalid chart signature.' });
    }

    const data = {
      totalBodiesCharted: systemKey.totalBodiesCharted,
      chartedAtMs: BigInt(systemKey.chartedAtMs),
      signature: systemKey.signature,
      systemDigest
    };
    const duplicate = () => reply.code(409).send({ error: 'SYSTEM_ALREADY_CLAIMED' });
    try {
      const captain = await recordWithXp(request, SYSTEM_CHART_XP, (tx) =>
        tx.systemChart.create({ data: { playerId, systemH3: systemKey.systemH3, ...data } }));
      return { claimed: true, systemH3: systemKey.systemH3, ...captain };
    } catch (err) {
      if (err?.code === 'P2002') return duplicate();
      throw err;
    }
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

    // The pilot's lock serialises the sale with every other payout, and the crew aboard take their
    // share of the reward before the pilot is credited the rest.
    const sale = await prisma.$transaction(async (tx) => {
      const ship = await lockActiveShip(tx, request.user);
      const txModel = isPlanet ? tx.planetChart : tx.systemChart;
      // Guarded on soldAt so a chart pays out at most once.
      const { count } = await txModel.updateMany({ where: { ...where, soldAt: null }, data: { soldAt: new Date() } });
      if (count !== 1) return null;
      const payout = deductCrewRevenueShare(await payrollCrewOf(tx, playerId, ship), ship.traits, rewardCredits);
      const player = await tx.player.update({
        where: { id: playerId },
        data: { credits: { increment: payout.netCredits } },
        select: { credits: true }
      });
      return { payout, newBalance: player.credits };
    });
    if (sale === null) return reply.code(409).send({ error: 'Chart has already been sold.' });
    return { sold: true, rewardCredits, newBalance: sale.newBalance, ...sale.payout };
  });
}
