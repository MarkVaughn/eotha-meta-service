import { computeShipAttributes, freeBerths } from '../../config/components.js';
import {
  ABANDON_TERMS,
  MAX_OFFER_FUTURE_SKEW_MS,
  MAX_REWARD_CREDITS,
  MISSION_COOLDOWN_MS,
  MISSION_LIMITS,
  lateCutoffMs,
  underMissionLimit
} from '../../config/missions.js';
import { CARGO_MAX_LOTS } from '../../config/cargo.js';
import { missionXp } from '../../config/captain.js';
import { H3_PATTERN, UUID_PATTERN } from '../../config/patterns.js';
import { CARGO_REFUSALS, applyCargoWrite, cargoLotSchema, toStoredLots } from '../../lib/cargo.js';
import {
  DOCKED_ENTITY_ID_PATTERN,
  SIGNATURE_B64_PATTERN,
  dockedReceiptRefusal,
  dockedReceiptSchema
} from '../../lib/docked-receipt.js';
import { awardCaptainXp } from '../../lib/captain.js';
import {
  activeCrewOf, clandestineBonusCredits, deductCrewRevenueShare, missionSettlement, payrollCrewOf, recordCovertAcceptance,
  recordCrewAbandonment, recordCrewSettlement
} from '../../lib/crew.js';
import { doctorCooldownReduction } from '../../config/crew-morale.js';
import { recordCrewDock, recordFlakyDeparture } from '../../lib/crew-docking.js';
import { accruedPenalty, basePenalty, disembarkPlace, hostageMinutes, hostageState } from '../../lib/hostage.js';
import { verifyClaimSignature } from '../../lib/mission-claim.js';
import {
  MISSION_ARCHETYPES, MISSION_TYPES, MISSION_VISIBILITIES, isCovert, isLegacyRow, missionOfferVersion, verifyMissionOffer
} from '../../lib/mission-offer.js';
import { fromStoredOffer, toActiveMission } from '../../lib/active-mission.js';
import { withColorsBonus } from '../../config/factions.js';
import {
  LEDGER_REASONS, adjustMissionReputation, adjustReputation, factionsClaim, missionFaction, standingsOf,
  withCrewReputationBonus, withCrewRivalHarmCut
} from '../../lib/reputation.js';
import { lockActiveShip, reissueToken, toLoadout } from '../../lib/ship.js';

const uint = { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
const uint32 = { type: 'integer', minimum: 0, maximum: 4_294_967_295 };
const int32 = { type: 'integer', minimum: -2147483648, maximum: 2147483647 };
const text = (maxLength) => ({ type: 'string', maxLength, default: '' });
const missionEnumSchema = (values) => ({ anyOf: [
  { type: 'string', enum: Object.keys(values) }, { type: 'integer', enum: Object.values(values) }
] });

const cooldownSchema = {
  querystring: {
    type: 'object',
    required: ['originId'],
    properties: { originId: { type: 'string', pattern: DOCKED_ENTITY_ID_PATTERN } }
  }
};

// A `MissionOffer` (eotha-contracts `rtse/v1/mission.proto`) as proto-JSON, signed by the engine.
// Proto-JSON may omit a field holding its zero value (a survey's `required_berths`, say), so those
// default to it; the fields no genuine offer leaves at zero are required. Unknown fields are
// dropped, so only what the engine signed is ever stored.
const offerSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['mission_id', 'type', 'origin_station_id', 'origin_system_h3', 'offered_at_ms', 'expires_at_ms', 'pilot_id', 'signature'],
  properties: {
    mission_id: { type: 'string', pattern: UUID_PATTERN.source },
    type: { type: 'string', enum: Object.keys(MISSION_TYPES) },
    title: text(512),
    description: text(4096),
    origin_station_id: { type: 'string', pattern: DOCKED_ENTITY_ID_PATTERN },
    origin_system_h3: { type: 'string', pattern: H3_PATTERN },
    destination_station_id: text(256),
    destination_system_h3: text(256),
    destination_node_h3: text(256),
    destination_lat: { type: 'number', default: 0 },
    destination_lng: { type: 'number', default: 0 },
    distance_hexes: { ...uint32, default: 0 },
    required_berths: { ...uint32, default: 0 },
    duration_limit_ms: { ...uint, default: 0 },
    reward_credits: { type: 'integer', minimum: 0, maximum: MAX_REWARD_CREDITS, default: 0 },
    reputation_change: { ...int32, default: 0 },
    faction_id: text(256),
    expires_at_ms: uint,
    offered_at_ms: uint,
    pilot_id: { type: 'string', minLength: 1, maxLength: 256 },
    signature: { type: 'string', pattern: SIGNATURE_B64_PATTERN },
    // GATHER only: the engine signs them for that type alone, so they are left out otherwise, and an
    // offer of that type missing one never verifies.
    resource_type: { type: 'string', maxLength: 256 },
    min_grade: uint32,
    quantity_m3: uint32,
    source_body_id: { type: 'string', maxLength: 256 },
    source_system_h3: { type: 'string', maxLength: 256 },
    source_node_h3: { type: 'string', maxLength: 256 },
    source_lat: { type: 'number' },
    source_lng: { type: 'number' },
    visibility: missionEnumSchema(MISSION_VISIBILITIES),
    archetype: missionEnumSchema(MISSION_ARCHETYPES),
    opposed_faction_id: { type: 'string', maxLength: 256 },
    opposed_reputation_change: int32,
    clandestine_bonus_credits: { type: 'integer', minimum: 0, maximum: MAX_REWARD_CREDITS },
    carries_contraband_or_operative: { type: 'boolean' },
    required_flying_colors_faction_id: { type: 'string', maxLength: 256 }
  }
};

// `dockedReceipt` is optional here on purpose: the route answers its absence with the coded 403
// `docked_receipt_required` rather than a generic schema 400.
const acceptSchema = {
  body: {
    type: 'object',
    required: ['offer'],
    properties: { offer: offerSchema, dockedReceipt: dockedReceiptSchema }
  }
};

// `missionId` names the held mission to abandon; it may be left out while only one is held. A
// `dockedReceipt` says where the ship is docked, which decides a passage's terms (see the route).
const abandonSchema = {
  body: {
    type: ['object', 'null'],
    additionalProperties: false,
    properties: { missionId: { type: 'string', pattern: UUID_PATTERN.source }, dockedReceipt: dockedReceiptSchema }
  }
};

// `missionId` names the abandoned passage whose hostages to drop. The receipt is optional here for the
// same reason as on accept: its absence is answered with a coded 403.
const disembarkSchema = {
  body: {
    type: 'object',
    additionalProperties: false,
    required: ['missionId'],
    properties: { missionId: { type: 'string', pattern: UUID_PATTERN.source }, dockedReceipt: dockedReceiptSchema }
  }
};

// Speed bonuses may raise a payout to at most 125% of the offered reward.
const MAX_BONUS_MULTIPLIER = 1.25;
// Tolerated RTSE/meta clock skew for completion timestamps.
const MAX_FUTURE_SKEW_MS = 60_000;
const OVERFLOW = Symbol('credit-overflow');

const completeSchema = {
  body: {
    type: 'object',
    required: ['claim'],
    properties: {
      // Take the mission's pay as the pilot's whole and owe the crew their cut (see deferCrewPay).
      deferCrewPay: { type: 'boolean', default: false },
      dockedReceipt: dockedReceiptSchema,
      claim: {
        type: 'object',
        required: [
          'missionId', 'playerShipId', 'destinationStationId', 'acceptedAtMs', 'completedAtMs',
          'durationTakenMs', 'rewardCredits', 'reputationChange', 'signature'
        ],
        properties: {
          missionId: { type: 'string', minLength: 1, maxLength: 256 },
          playerShipId: { type: 'string', minLength: 1, maxLength: 256 },
          destinationStationId: { type: 'string', minLength: 1, maxLength: 256 },
          acceptedAtMs: uint,
          completedAtMs: uint,
          durationTakenMs: uint,
          rewardCredits: { type: 'integer', minimum: 0, maximum: MAX_REWARD_CREDITS },
          reputationChange: int32,
          signature: { type: 'string', minLength: 1, maxLength: 512 },
          wasDetected: { type: 'boolean', default: false },
          exposureScoreMilli: { type: 'integer', minimum: 0, maximum: 100_000, default: 0 },
          opposedReputationChange: { ...int32, default: 0 },
          bribePaidCredits: { type: 'integer', minimum: 0, maximum: MAX_REWARD_CREDITS, default: 0 },
          // The cargo suffix of a GATHER claim, and of no other (see `settle`): the engine's position
          // in the pilot's cargo history and the whole hold after the delivered ore left it.
          leaseId: { type: 'string', pattern: DOCKED_ENTITY_ID_PATTERN },
          sessionId: { type: 'string', pattern: DOCKED_ENTITY_ID_PATTERN },
          cargoSeq: uint,
          remaining: { type: 'array', maxItems: CARGO_MAX_LOTS, items: cargoLotSchema }
        }
      }
    }
  }
};

// The JSON column does not keep every double exactly (it moved four in five destination
// coordinates by an ulp), and the offer's signature covers the coordinates' exact bits, so they
// are stored as text beside the offer and restored on the way out. A gather offer's source
// coordinates are signed doubles too.
const toStoredOffer = (offer) => ({
  ...offer,
  exact_destination: [String(offer.destination_lat), String(offer.destination_lng)],
  ...(isGather(offer) && { exact_source: [String(offer.source_lat), String(offer.source_lng)] })
});

const LEGACY_MESSAGE = 'Your previous mission was cancelled because the mission format changed. Nothing was charged; accept a new mission.';

// The mission type without its enum prefix, as AbandonedMission stores it.
const typeName = (offer) => offer.type.replace(/^MISSION_TYPE_/, '');

// Passengers the ship carries once a mission's `berths` disembark (never below zero). A passage
// boards its party and a survey its one surveyor; a gather boards no one.
const unboarded = (ship, berths) => Math.max(0, ship.passengersAboard - berths);

const isGather = (offer) => offer.type === 'MISSION_TYPE_GATHER';
const CARGO_SUFFIX = ['leaseId', 'sessionId', 'cargoSeq', 'remaining'];

export default async function missionsRoutes(fastify) {
  const prisma = fastify.prisma;
  fastify.addHook('onRequest', fastify.authenticate);

  // `db` is the Prisma client or an open transaction.
  async function cooldownRemainingMs(db, playerId, stationId, nowMs) {
    const row = await db.missionCooldown.findUnique({
      where: { playerId_originStationId: { playerId, originStationId: stationId } }
    });
    if (!row) return 0;
    const endsAt = row.availableAt?.getTime() ?? row.completedAt.getTime() + MISSION_COOLDOWN_MS;
    return Math.max(0, endsAt - nowMs);
  }

  // `tx` is an open transaction holding the pilot's lock. Starts a cooldown of `durationMs` at the
  // station, never ending one already running there sooner.
  async function startCooldown(tx, playerId, stationId, nowMs, durationMs) {
    const availableAt = new Date(nowMs + Math.max(durationMs, await cooldownRemainingMs(tx, playerId, stationId, nowMs)));
    await tx.missionCooldown.upsert({
      where: { playerId_originStationId: { playerId, originStationId: stationId } },
      update: { completedAt: new Date(nowMs), availableAt },
      create: { playerId, originStationId: stationId, completedAt: new Date(nowMs), availableAt }
    });
  }

  // `db` is the Prisma client or an open transaction. The pilot's mission rows, oldest first, split
  // into the missions held and the legacy rows.
  async function missionRows(db, playerId) {
    const rows = await db.playerMission.findMany({ where: { playerId }, orderBy: [{ acceptedAt: 'asc' }, { id: 'asc' }] });
    return { held: rows.filter((row) => !isLegacyRow(row)), legacy: rows.filter(isLegacyRow) };
  }

  const deleteRows = (db, rows) =>
    rows.length ? db.playerMission.deleteMany({ where: { id: { in: rows.map((row) => row.id) } } }) : null;

  // The pilot's active missions, oldest first, and the legacy ones this read cancelled.
  async function loadActive(request) {
    const playerId = request.user.sub;
    const { held, legacy } = await missionRows(prisma, playerId);
    await deleteRows(prisma, legacy);
    return {
      missions: held.map((row) => toActiveMission(playerId, fromStoredOffer(row.offer), row.acceptedAt)),
      cancelled: legacy.map((row) => ({ mission_id: row.missionId, reason: 'format_changed', message: LEGACY_MESSAGE }))
    };
  }

  const fail = (status, error, extra = {}) => ({ failure: { status, body: { error, ...extra } } });
  const conflict = (reply, error) => reply.code(409).send({ error });

  // The reissued token carrying the ship's new passenger count and `factions`, the pilot's factions
  // claim after any standing change (the one read under the lock by default).
  const tokenFor = (request, ship, passengersAboard, factions = ship.factions) =>
    reissueToken(fastify, request, toLoadout(ship.id, ship.components, passengersAboard, ship.traits, ship.crew).ship_attributes, factions);

  fastify.get('/missions/cooldown', { schema: cooldownSchema }, async (request) => {
    const nowMs = Date.now();
    const remainingMs = await cooldownRemainingMs(prisma, request.user.sub, request.query.originId, nowMs);
    return remainingMs > 0
      ? { active: true, remaining_ms: remainingMs, available_at_ms: nowMs + remainingMs }
      : { active: false, remaining_ms: 0, available_at_ms: 0 };
  });

  fastify.post('/missions/accept', { schema: acceptSchema, preHandler: fastify.requireClaimKey }, async (request, reply) => {
    const playerId = request.user.sub;
    const { offer, dockedReceipt } = request.body;
    const nowMs = Date.now();

    // Stateless checks first, so a refusal changes nothing.
    // 1. The engine made this offer, to this pilot. Every field is signed, so nothing in it is the client's.
    if (offer.pilot_id !== playerId || !verifyMissionOffer(offer, fastify.claimKey.key)) {
      return reply.code(403).send({ error: 'The mission offer is not valid for this pilot.', code: 'mission_offer_invalid' });
    }
    // 2. The offer is current.
    if (offer.offered_at_ms > nowMs + MAX_OFFER_FUTURE_SKEW_MS || nowMs > offer.expires_at_ms) {
      return reply.code(410).send({ error: 'The mission offer has expired.', code: 'mission_offer_expired' });
    }
    // 3. The pilot is docked at the offer's origin right now, as the engine vouches.
    if (!dockedReceipt) {
      return reply.code(403).send({
        error: 'Accepting a mission requires a docked receipt from the engine.',
        code: 'docked_receipt_required'
      });
    }
    const refusal = dockedReceiptRefusal(dockedReceipt, {
      pilotId: playerId,
      publicKey: fastify.claimKey.key,
      nowMs,
      log: request.log
    });
    if (refusal) return reply.code(403).send(refusal);
    if (dockedReceipt.dockedEntityId !== offer.origin_station_id || dockedReceipt.systemH3 !== offer.origin_system_h3) {
      return reply.code(403).send({ error: 'Missions can only be accepted while docked where they are offered.', code: 'not_docked_at_origin' });
    }

    // Never earlier than the offer was made: the engine refuses the claim otherwise.
    const acceptedAt = new Date(Math.max(nowMs, offer.offered_at_ms));

    // The player rules, the mission and the boarding commit or roll back together.
    const outcome = await prisma.$transaction(async (tx) => {
      const ship = await lockActiveShip(tx, request.user);
      // The lock serialises this count with every other accept of the pilot's.
      const { held, legacy } = await missionRows(tx, playerId);
      if (held.some((row) => row.missionId === offer.mission_id)) {
        return fail(409, 'This mission is already active.', { code: 'mission_already_active' });
      }
      if (isCovert(offer) && held.some((row) => isCovert(row.offer))) {
        return fail(409, 'At most one covert mission can be held at once. Complete or abandon it first.', {
          code: 'covert_mission_limit_reached', limit: 1
        });
      }
      if (!underMissionLimit(held.map((row) => row.offer), offer.type)) {
        const limit = MISSION_LIMITS[offer.type];
        return fail(409, `At most ${limit} missions of this type can be held at once. Complete or abandon one first.`, {
          code: 'mission_limit_reached',
          type: offer.type,
          limit
        });
      }
      const remainingMs = await cooldownRemainingMs(tx, playerId, offer.origin_station_id, nowMs);
      if (remainingMs > 0) return fail(409, 'Station is on cooldown.', { code: 'origin_on_cooldown', remaining_ms: remainingMs });
      const completed = await tx.completedMission.findUnique({
        where: { playerId_missionId: { playerId, missionId: offer.mission_id } }
      });
      if (completed) return fail(409, 'Mission has already been completed.', { code: 'mission_already_completed' });
      // An abandoned mission stays abandoned, so its offer cannot be taken and dropped again.
      const abandoned = await tx.abandonedMission.findUnique({
        where: { playerId_missionId: { playerId, missionId: offer.mission_id } }
      });
      if (abandoned) return fail(409, 'This mission was abandoned and cannot be accepted again.', { code: 'mission_abandoned' });

      // Active crew occupy berths too, as the engine counts them.
      const attributes = computeShipAttributes(ship.components, ship.passengersAboard, ship.traits, ship.crew);
      const available = freeBerths(attributes);
      if (offer.required_berths > available) {
        return fail(400, 'Ship has insufficient free passenger berths for this mission.', {
          code: 'insufficient_berths',
          available_berths: available
        });
      }

      const dock = await recordCrewDock(tx, ship, dockedReceipt);
      const flaky = await recordFlakyDeparture(tx, dock.ship, dockedReceipt, nowMs, dock.docking);
      await deleteRows(tx, legacy);
      await tx.playerMission.create({
        data: {
          playerId,
          missionId: offer.mission_id,
          originStationId: offer.origin_station_id,
          offer: toStoredOffer(offer),
          acceptedAt
        }
      });
      const passengersAboard = attributes.passengers_aboard + offer.required_berths;
      await tx.spaceship.update({ where: { id: ship.id }, data: { passengersAboard } });
      // The crew as it now stands: a covert contract costs the By-the-Book their morale, and a Loyalist
      // sent against its home faction loses its capabilities for as long as the mission is held.
      const accepted = await recordCovertAcceptance(tx, ship.id, ship.traits, isCovert(offer));
      return {
        ship: { ...flaky.ship, crew: accepted.crew }, passengersAboard, docking: dock.docking, departed: flaky.departed,
        crewMorale: accepted.effects
      };
    });

    if (outcome.failure) return reply.code(outcome.failure.status).send(outcome.failure.body);
    return { active: toActiveMission(playerId, offer, acceptedAt),
      ...(outcome.docking.applied && { docking: outcome.docking }),
      ...((outcome.docking.departed?.length || outcome.departed.length) && {
        departed_crew: [...(outcome.docking.departed ?? []), ...outcome.departed]
      }),
      ...(outcome.crewMorale.length > 0 && { crew_morale: outcome.crewMorale }),
      token: await tokenFor(request, outcome.ship, outcome.passengersAboard) };
  });

  // `active` (the oldest mission) and `cancelled_mission` are kept for clients that hold one mission.
  fastify.get('/missions/active', async (request) => {
    const { missions, cancelled } = await loadActive(request);
    const standings = await standingsOf(prisma, request.user.sub);
    const body = { missions, limits: MISSION_LIMITS, active: missions[0] ?? null, standings };
    // Passengers of abandoned passages still aboard, the contract's HostageState, until they disembark.
    const nowMs = Date.now();
    const hostages = (await prisma.abandonedMission.findMany({
      where: { playerId: request.user.sub, hostageBerths: { gt: 0 } }, orderBy: [{ abandonedAt: 'asc' }, { id: 'asc' }]
    })).map((row) => hostageState(row, nowMs));
    if (hostages.length) body.hostages = hostages;
    return cancelled.length ? { ...body, cancelled_missions: cancelled, cancelled_mission: cancelled[0] } : body;
  });

  // Abandoning costs the sponsoring faction's reputation and starts a cooldown at the origin, by type
  // (ABANDON_TERMS), docked or not, and pays nothing, and the mission's berths (a survey's surveyor
  // too) empty. A passage is the exception: only cancelling it
  // while docked at its origin, where the passengers step back off, has those terms. Abandoned
  // anywhere else its passengers stay aboard as hostages, still in their berths and so blocking new
  // crew, at no cost and with no cooldown until POST /missions/disembark drops them. Either way the
  // crew whose quirk minds an abandon lose morale (recordCrewAbandonment).
  fastify.post('/missions/abandon', { schema: abandonSchema }, async (request, reply) => {
    const playerId = request.user.sub;
    const missionId = request.body?.missionId;
    const dockedReceipt = request.body?.dockedReceipt;
    const nowMs = Date.now();

    // A receipt is checked before any transaction, so a refused one changes nothing.
    if (dockedReceipt) {
      if (!fastify.claimKey) return fastify.requireClaimKey(request, reply);
      const refusal = dockedReceiptRefusal(dockedReceipt, { pilotId: playerId, publicKey: fastify.claimKey.key, nowMs, log: request.log });
      if (refusal) return reply.code(403).send(refusal);
    }

    const outcome = await prisma.$transaction(async (tx) => {
      const ship = await lockActiveShip(tx, request.user);
      const { held, legacy } = await missionRows(tx, playerId);
      await deleteRows(tx, legacy);
      if (missionId == null && held.length > 1) {
        return fail(400, 'More than one mission is active; name the one to abandon.', { code: 'mission_id_required' });
      }
      const row = missionId == null ? held[0] : held.find((r) => r.missionId === missionId);
      if (!row) return fail(404, 'No active mission to abandon.');
      const { offer } = row;

      const atOrigin = dockedReceipt?.dockedEntityId === offer.origin_station_id && dockedReceipt.systemH3 === offer.origin_system_h3;
      const reason = atOrigin ? 'in_port_origin' : dockedReceipt ? 'in_port_dock' : 'in_flight';
      const hostage = offer.type === 'MISSION_TYPE_PASSAGE' && !atOrigin && offer.required_berths > 0;
      const terms = offer.type !== 'MISSION_TYPE_PASSAGE' || atOrigin ? ABANDON_TERMS[offer.type] : { reputation: 0, cooldownMs: 0 };
      const factionId = missionFaction(offer);

      await tx.playerMission.delete({ where: { id: row.id } });
      await tx.abandonedMission.create({
        data: {
          playerId,
          missionId: row.missionId,
          originStationId: row.originStationId,
          factionId,
          missionType: typeName(offer),
          reputationLoss: terms.reputation,
          reason,
          abandonedAt: new Date(nowMs),
          ...(hostage && {
            hostageBerths: offer.required_berths,
            originSystemH3: offer.origin_system_h3,
            destinationStationId: offer.destination_station_id || null,
            destinationSystemH3: offer.destination_system_h3 || null
          })
        }
      });
      await adjustReputation(tx, playerId, factionId, terms.reputation, {
        reason: LEDGER_REASONS.MISSION_ABANDONED,
        missionId: row.missionId
      });
      if (terms.cooldownMs > 0) await startCooldown(tx, playerId, row.originStationId, nowMs, terms.cooldownMs);
      // The mission's own passengers step off: a passage's party, or a survey's one surveyor. A
      // hostage party stays aboard and keeps its berths.
      const passengersAboard = hostage ? ship.passengersAboard : unboarded(ship, offer.required_berths);
      await tx.spaceship.update({ where: { id: ship.id }, data: { passengersAboard } });
      const dock = dockedReceipt ? await recordCrewDock(tx, ship, dockedReceipt) : { ship };
      // The crew as stored now: a Loyalist's capabilities return with the mission that turned them off gone.
      const abandoned = await recordCrewAbandonment(tx, ship.id, ship.traits, factionId);
      return {
        ship: { ...dock.ship, crew: abandoned.crew },
        docking: dock.docking,
        crewMorale: abandoned.effects,
        hostage: hostage ? hostageState({ missionId: row.missionId, abandonedAt: new Date(nowMs), hostageBerths: offer.required_berths }, nowMs) : null,
        passengersAboard,
        missionId: row.missionId,
        reputationChange: terms.reputation,
        standings: await standingsOf(tx, playerId),
        factions: await factionsClaim(tx, playerId)
      };
    });
    if (outcome.failure) return reply.code(outcome.failure.status).send(outcome.failure.body);
    // `mission_id`, `outcome` and `reputation_change` are the contract's MissionAbandonResponse.
    return {
      abandoned: true,
      mission_id: outcome.missionId,
      outcome: outcome.hostage ? 'MISSION_ABANDON_OUTCOME_HOSTAGE' : 'MISSION_ABANDON_OUTCOME_CANCELLED',
      reputation_change: outcome.reputationChange,
      ...(outcome.hostage && { hostage: outcome.hostage }),
      standings: outcome.standings,
      ...(outcome.crewMorale.length > 0 && { crew_morale: outcome.crewMorale }),
      ...(outcome.docking?.applied && { docking: outcome.docking }),
      ...(outcome.docking?.departed?.length && { departed_crew: outcome.docking.departed }),
      token: await tokenFor(request, outcome.ship, outcome.passengersAboard, outcome.factions)
    };
  });

  // Drops the hostages of an abandoned passage, which needs the pilot docked at a station or outpost
  // (a signed receipt). The faction that sponsored the mission is charged the base penalty by where they
  // step off (HOSTAGE_BASE_PENALTY) and the time penalty accrued since the abandon, and the berths free.
  // `result` is the contract's DisembarkResult; a refusal changes nothing.
  const disembarkFailure = (status, result, error, code) => fail(status, error, { result, ...(code && { code }) });
  fastify.post('/missions/disembark', { schema: disembarkSchema, preHandler: fastify.requireClaimKey }, async (request, reply) => {
    const playerId = request.user.sub;
    const { missionId, dockedReceipt } = request.body;
    const nowMs = Date.now();

    if (!dockedReceipt) {
      return reply.code(403).send({
        error: 'Disembarking requires a docked receipt from the engine.',
        code: 'docked_receipt_required',
        result: 'DISEMBARK_RESULT_RECEIPT_INVALID'
      });
    }
    const refusal = dockedReceiptRefusal(dockedReceipt, { pilotId: playerId, publicKey: fastify.claimKey.key, nowMs, log: request.log });
    if (refusal) {
      const result = refusal.code === 'docked_receipt_expired' ? 'DISEMBARK_RESULT_RECEIPT_EXPIRED' : 'DISEMBARK_RESULT_RECEIPT_INVALID';
      return reply.code(403).send({ ...refusal, result });
    }

    const outcome = await prisma.$transaction(async (tx) => {
      const ship = await lockActiveShip(tx, request.user);
      const row = await tx.abandonedMission.findUnique({ where: { playerId_missionId: { playerId, missionId } } });
      if (!row) {
        // A mission still held or already paid is real but not a hostage state.
        const live = (await tx.playerMission.findFirst({ where: { playerId, missionId } }))
          || (await tx.completedMission.findUnique({ where: { playerId_missionId: { playerId, missionId } } }));
        return live
          ? disembarkFailure(409, 'DISEMBARK_RESULT_NOT_HOSTAGE', 'The mission is not in the hostage state.', 'not_hostage')
          : disembarkFailure(404, 'DISEMBARK_RESULT_UNKNOWN_MISSION', 'No mission with this id.', 'unknown_mission');
      }
      if (row.hostageBerths <= 0) {
        return disembarkFailure(409, 'DISEMBARK_RESULT_NOT_HOSTAGE', 'The mission is not in the hostage state.', 'not_hostage');
      }

      const place = disembarkPlace(row, dockedReceipt);
      const minutes = hostageMinutes(row, nowMs);
      const base = basePenalty(place);
      const time = accruedPenalty(minutes);
      const reputationChange = -(base + time);
      await adjustReputation(tx, playerId, row.factionId, reputationChange, {
        reason: LEDGER_REASONS.HOSTAGE_DISEMBARKED,
        missionId: row.missionId
      });
      await tx.abandonedMission.update({
        where: { id: row.id },
        data: { hostageBerths: 0, hostageMinutes: minutes, reputationLoss: reputationChange, reason: 'hostage_returned' }
      });
      const passengersAboard = unboarded(ship, row.hostageBerths);
      await tx.spaceship.update({ where: { id: ship.id }, data: { passengersAboard } });
      const dock = await recordCrewDock(tx, ship, dockedReceipt);
      return {
        ship: dock.ship,
        docking: dock.docking,
        passengersAboard,
        missionId: row.missionId,
        place,
        base,
        time,
        minutes,
        reputationChange,
        standings: await standingsOf(tx, playerId),
        factions: await factionsClaim(tx, playerId)
      };
    });
    if (outcome.failure) return reply.code(outcome.failure.status).send(outcome.failure.body);
    return {
      result: 'DISEMBARK_RESULT_SUCCESS',
      mission_id: outcome.missionId,
      place: outcome.place,
      base_penalty: outcome.base,
      time_penalty: outcome.time,
      hostage_minutes: outcome.minutes,
      reputation_change: outcome.reputationChange,
      standings: outcome.standings,
      ...(outcome.docking?.applied && { docking: outcome.docking }),
      ...(outcome.docking?.departed?.length && { departed_crew: outcome.docking.departed }),
      token: await tokenFor(request, outcome.ship, outcome.passengersAboard, outcome.factions)
    };
  });

  // Returns `{ credits, payout, reputationChange, standings, factions, ship, passengersAboard, captain, clandestineBonusCredits }` (`payout` the crew's split of the reward, see deductCrewRevenueShare; plus the stored `lots` for a gather claim), null
  // if the mission was already settled, `{ refusal }` (a cargo 409; nothing changed) if a gather
  // claim's cargo record cannot be credited, or OVERFLOW (mission left active, nothing changed) if
  // the payout would overflow credits.
  async function settle(request, active, claim, deferred = false) {
    const playerId = request.user.sub;
    const stationId = active.offer.origin_station_id;
    const missionId = active.mission_id;

    try {
      return await prisma.$transaction(async (tx) => {
        const ship = await lockActiveShip(tx, request.user);
        // A gather claim also carries the pilot's hold after the delivered ore left it. It is stored
        // only for a mission that is still held and unpaid, so a refused claim stores nothing, and
        // under the cargo fencing rule that governs manifests and sales: a superseded claim pays
        // nothing and leaves the ore in the stored hold.
        let lots;
        if (isGather(active.offer)) {
          const done = await tx.completedMission.findUnique({ where: { playerId_missionId: { playerId, missionId } } });
          const held = await tx.playerMission.findFirst({ where: { playerId, missionId } });
          if (done || !held) return null;
          const write = await applyCargoWrite(tx, playerId, {
            leaseId: claim.leaseId,
            sessionId: claim.sessionId,
            seq: claim.cargoSeq,
            lots: toStoredLots(claim.remaining ?? [])
          });
          if (CARGO_REFUSALS[write.outcome]) return { refusal: CARGO_REFUSALS[write.outcome] };
          ({ lots } = write.lease);
        }
        const { count } = await tx.playerMission.deleteMany({ where: { playerId, missionId } });
        if (count !== 1) return null;
        const factionId = missionFaction(active.offer);
        const covert = isCovert(active.offer);
        // A clean covert mission pays the active Smuggler's rate on its clandestine bonus: the credits
        // beyond the signed reward are paid (and shared with the crew) like the rest of it.
        const clandestineBonus = covert && !claim.wasDetected
          ? clandestineBonusCredits(ship.crew, claim.rewardCredits, active.offer.clandestine_bonus_credits ?? 0) : 0;
        const rewardCredits = claim.rewardCredits + clandestineBonus;
        await tx.completedMission.create({
          data: { playerId, missionId, factionId, rewardCredits, reputationChange: claim.reputationChange }
        });
        // The crew aboard take their share of the reward; the pilot is credited the rest.
        // Guarded increment; throwing rolls back the mission delete and payout record.
        const payroll = await payrollCrewOf(tx, playerId, ship);
        const payout = deductCrewRevenueShare(payroll, ship.traits, rewardCredits, { deferred });
        const { count: credited } = await tx.player.updateMany({
          where: { id: playerId, credits: { lte: MAX_REWARD_CREDITS - payout.netCredits } },
          data: { credits: { increment: payout.netCredits } }
        });
        if (credited !== 1) throw OVERFLOW;
        // The signed reputation, negative for a late enough completion, goes to the sponsor: a gain
        // for the faction whose colors the pilot flies is multiplied (withColorsBonus), and the active
        // Diplomat raises any gain and softens the harm to the rival.
        const reputationChange = withCrewReputationBonus(withColorsBonus(claim.reputationChange, factionId, ship.factions.active_colors), ship.crew, factionId);
        const reason = covert
          ? (claim.wasDetected ? LEDGER_REASONS.COMPLETE_COVERT_DETECTED : LEDGER_REASONS.COMPLETE_COVERT_CLEAN)
          : LEDGER_REASONS.MISSION_COMPLETED;
        await adjustMissionReputation(tx, playerId, factionId, reputationChange,
          covert && claim.wasDetected ? active.offer.opposed_faction_id : null,
          covert && claim.wasDetected ? withCrewRivalHarmCut(claim.opposedReputationChange, ship.crew) : 0, { reason, missionId });
        const cooldownMs = Math.round(MISSION_COOLDOWN_MS * (1 - doctorCooldownReduction(ship.crew)));
        await startCooldown(tx, playerId, stationId, Date.now(), cooldownMs);
        const passengersAboard = unboarded(ship, active.offer.required_berths);
        await tx.spaceship.update({ where: { id: ship.id }, data: { passengersAboard } });
        const standings = await standingsOf(tx, playerId);
        const factions = await factionsClaim(tx, playerId);
        // Captain XP rides on the payout record above: a replayed claim never reaches this line.
        const captain = await awardCaptainXp(tx, ship.captain, missionXp(active.offer, claim), { missionCompleted: true, traits: ship.traits });
        // Morale and seniority follow the settlement; the token below carries the crew as it now stands.
        // The speed bonus is earned when the claim paid above the offered reward, not counting the clean
        // covert bonus the engine adds after the speed and late terms.
        const cleanBonus = covert && !claim.wasDetected ? active.offer.clandestine_bonus_credits ?? 0 : 0;
        const settledCrew = await recordCrewSettlement(tx, ship, payroll, {
          settlement: missionSettlement(active.offer, { speedBonus: claim.rewardCredits - cleanBonus > active.offer.reward_credits }),
          payout, deferred, captainXp: captain.xpGained
        });
        const currentShip = { ...ship, crew: settledCrew.crew };
        const dock = request.body.dockedReceipt ? await recordCrewDock(tx, currentShip, request.body.dockedReceipt, { payoutSettled: true }) : { ship: currentShip };
        const balance = await tx.player.findUnique({ where: { id: playerId }, select: { credits: true } });
        return {
          credits: balance.credits, payout, reputationChange, standings, factions, ship: dock.ship,
          passengersAboard, captain, clandestineBonusCredits: clandestineBonus, crewMorale: settledCrew.effects, ...(dock.docking && { docking: dock.docking }), ...(lots && { lots })
        };
      });
    } catch (err) {
      if (err === OVERFLOW) return OVERFLOW;
      if (err?.code === 'P2002') return null; // payout for this (player, mission) already recorded
      throw err;
    }
  }

  fastify.post('/missions/complete', { schema: completeSchema, preHandler: fastify.requireClaimKey }, async (request, reply) => {
    const { claim, dockedReceipt } = request.body;
    if (dockedReceipt) {
      const refused = dockedReceiptRefusal(dockedReceipt, { pilotId: request.user.sub, publicKey: fastify.claimKey.key, nowMs: Date.now(), log: request.log });
      if (refused) return reply.code(403).send(refused);
    }

    // 1. The claim must be for the authenticated pilot's ship.
    if (request.user.sub !== claim.playerShipId) {
      return reply.code(403).send({ error: 'Claim does not belong to the authenticated pilot.' });
    }

    // 2. The pilot must hold this mission, accepted at the time the RTSE saw.
    const active = (await loadActive(request)).missions.find((mission) => mission.mission_id === claim.missionId);
    if (!active) {
      return reply.code(404).send({ error: 'No matching active mission.' });
    }
    if (claim.acceptedAtMs !== active.accepted_at_ms
        || claim.destinationStationId !== active.offer.destination_station_id
        || claim.durationTakenMs !== claim.completedAtMs - claim.acceptedAtMs) {
      return reply.code(400).send({ error: 'Claim does not match the active mission.' });
    }

    // 3. Deadline. A late claim is paid what the engine decayed and signed, up to the hard cutoff.
    if (claim.completedAtMs < claim.acceptedAtMs) {
      return reply.code(400).send({ error: 'Claim completed outside the mission window.' });
    }
    if (claim.completedAtMs > lateCutoffMs(active.deadline_ms, active.offer.duration_limit_ms)) {
      return reply.code(400).send({ error: 'Mission has expired beyond the allowable late window.', code: 'mission_expired' });
    }

    if (claim.completedAtMs > Date.now() + MAX_FUTURE_SKEW_MS) {
      return reply.code(400).send({ error: 'Claim completion time is in the future.' });
    }
    const version = missionOfferVersion(active.offer);
    const covert = isCovert(active.offer);
    // The engine's final signed reward already includes the clean bonus, added AFTER speed/late
    // terms. Do not add it again at settlement or let a detected/overt claim use this allowance.
    const cleanBonus = covert && !claim.wasDetected ? (active.offer.clandestine_bonus_credits ?? 0) : 0;
    if (claim.rewardCredits > Math.floor(active.offer.reward_credits * MAX_BONUS_MULTIPLIER) + cleanBonus) {
      return reply.code(400).send({ error: 'Claim reward exceeds the maximum speed bonus.' });
    }
    // Lateness only lowers reputation, so a claim never gains more than the offer.
    if (claim.reputationChange > Math.max(0, active.offer.reputation_change)) {
      return reply.code(400).send({ error: 'Claim reputation exceeds the offered reputation.' });
    }

    // Phase 3 has no customs/bribes. Detection attribution and opposed harm must match the
    // signed offer; overt/V1 missions carry zero attribution fields, including when defaults omit them.
    const expectedHarm = covert && claim.wasDetected ? (active.offer.opposed_reputation_change ?? 0) : 0;
    if (claim.bribePaidCredits !== 0 || claim.opposedReputationChange !== expectedHarm
        || (!covert && (claim.wasDetected || claim.exposureScoreMilli !== 0))) {
      return reply.code(400).send({ error: 'Claim attribution does not match the active mission.' });
    }

    // The cargo suffix is required exactly when the stored offer's signed type is GATHER.
    const gather = isGather(active.offer);
    if (gather ? CARGO_SUFFIX.slice(0, 3).some((field) => claim[field] === undefined) : CARGO_SUFFIX.some((field) => claim[field] !== undefined)) {
      return reply.code(400).send({
        error: gather ? 'A gather claim must carry the cargo record.' : 'Only a gather claim carries a cargo record.'
      });
    }

    // 4. Canonical Ed25519 signature by the engine's claim key.
    if (!verifyClaimSignature(claim, fastify.claimKey.key, gather, version)) {
      return reply.code(403).send({ error: 'Invalid claim signature.' });
    }

    // 5. Atomic settlement: payout (less the crew's share), reputation (with any Flying Colors bonus), cooldown, captain XP, and the passengers disembark.
    const settled = await settle(request, active, claim, request.body.deferCrewPay);
    if (settled === OVERFLOW) return conflict(reply, 'Payout would overflow the credit balance.');
    if (settled === null) return conflict(reply, 'Mission has already been completed.');
    if (settled.refusal) return reply.code(409).send(settled.refusal);
    return {
      success: true,
      credits: settled.credits,
      // `payout` is the signed reward and any Smuggler bonus; the crew's share comes out of it before the
      // pilot is credited.
      payout: settled.payout.grossCredits,
      ...settled.payout,
      ...(settled.clandestineBonusCredits > 0 && { clandestineBonusCredits: settled.clandestineBonusCredits }),
      reputation_change: settled.reputationChange,
      standings: settled.standings,
      ...settled.captain,
      ...(settled.crewMorale.length > 0 && { crew_morale: settled.crewMorale }),
      ...(settled.docking?.applied && { docking: settled.docking }),
      ...(settled.docking?.departed?.length && { departed_crew: settled.docking.departed }),
      ...(settled.lots && { lots: settled.lots }),
      token: await tokenFor(request, settled.ship, settled.passengersAboard, settled.factions)
    };
  });
}
