import { computeShipAttributes, hullBudget, totalSubsystemPoints } from '../../config/components.js';
import {
  CREW_STATUS,
  CREW_WAGE_SHARE_BP,
  MAX_STANDBY_CREW,
  STANDBY_TRANSFER_FEE_CREDITS,
  signingBonusCredits,
  startingMorale
} from '../../config/crew.js';
import { UUID_PATTERN } from '../../config/patterns.js';
import { candidateView, findCandidate, generateCrewBoard, unavailableReasons } from '../../lib/crew-generator.js';
import { activeCrewOf, boardingReasons, crewLimits, crewMemberView, hiredCandidateIdsOf, primaryReason, standbyCrewOf } from '../../lib/crew.js';
import { DOCKED_ENTITY_ID_PATTERN, dockedReceiptRefusal, dockedReceiptSchema } from '../../lib/docked-receipt.js';
import { isLegacyRow } from '../../lib/mission-offer.js';
import { standingsOf } from '../../lib/reputation.js';
import { lockActiveShip, reissueToken, toLoadout } from '../../lib/ship.js';

// `dockedReceipt` is optional in the schema on purpose, like the captain trait route: its absence is
// answered with the coded 403 `docked_receipt_required` rather than a generic schema 400.
const receiptProperties = {
  stationId: { type: 'string', pattern: DOCKED_ENTITY_ID_PATTERN },
  dockedReceipt: dockedReceiptSchema
};
const crewIdProperty = { type: 'string', pattern: UUID_PATTERN.source };

const boardSchema = {
  querystring: {
    type: 'object',
    required: ['stationId'],
    additionalProperties: false,
    properties: { stationId: { type: 'string', pattern: DOCKED_ENTITY_ID_PATTERN } }
  }
};
const hireSchema = {
  body: {
    type: 'object',
    required: ['candidateId'],
    additionalProperties: false,
    properties: { candidateId: { type: 'string', pattern: '^cand-[0-3]-[0-9a-f]{8}$' }, ...receiptProperties }
  }
};
const crewActionSchema = {
  body: {
    type: 'object',
    required: ['crewId'],
    additionalProperties: false,
    properties: { crewId: crewIdProperty, ...receiptProperties }
  }
};

const MESSAGES = {
  docked_receipt_required: 'Crew can only be hired or moved in port, which needs a current docked receipt from the engine.',
  docked_receipt_invalid: 'The docked receipt is not valid for this pilot.',
  docked_receipt_wrong_station: 'The docked receipt is for a different station.',
  candidate_not_found: 'This station is not offering that candidate; its board may have refreshed.',
  candidate_already_hired: 'That candidate is already on your roster.',
  crew_not_found: 'No such crew member on your roster.',
  hull_crew_cap_reached: "The hull cannot take more active crew.",
  insufficient_free_berths: 'There is no free life support berth for another crew member.',
  class_already_active: 'A crew member of that class is already aboard.',
  insufficient_faction_rep: "Your standing with the candidate's home faction is too low to hire them.",
  insufficient_credits: 'Not enough credits for the signing bonus.',
  crew_locked_by_active_mission: 'Crew cannot be dismissed or moved while you hold a mission.',
  engineer_required_for_loadout: 'The installed components need the hull budget this Engineer provides; step a component down first.',
  standby_full: `Harbor Standby holds at most ${MAX_STANDBY_CREW} crew members.`,
  crew_not_on_standby: 'That crew member is not on Harbor Standby.',
  crew_not_active: 'That crew member is not aboard.'
};
const STATUS = {
  candidate_not_found: 404,
  candidate_already_hired: 409,
  crew_not_found: 404,
  hull_crew_cap_reached: 400,
  insufficient_free_berths: 400,
  class_already_active: 409,
  insufficient_faction_rep: 403,
  insufficient_credits: 402,
  crew_locked_by_active_mission: 409,
  engineer_required_for_loadout: 409,
  standby_full: 409,
  crew_not_on_standby: 409,
  crew_not_active: 409
};

// `{ error: <code>, message, ...details }`, the shape the crew routes answer refusals with.
const refusal = ({ code, ...details }) => ({ error: code, message: MESSAGES[code], ...details });
// A reason from the board (`INSUFFICIENT_CREDITS`, ...) as the refusal of a hire or activation.
const reasonRefusal = (reason, reasons) => {
  const { code, label, ...details } = reason;
  return { code: code.toLowerCase(), ...details, label, unavailableReasons: reasons };
};

export default async function crewRoutes(fastify) {
  const prisma = fastify.prisma;
  fastify.addHook('onRequest', fastify.authenticate);

  // The station the receipt is for, or the reply that refuses it. Stateless, so it runs before any
  // write. An expired receipt is answered like a missing one: either way the client must fetch a
  // fresh one.
  function dockedStation(request, reply) {
    const { stationId, dockedReceipt } = request.body;
    if (!dockedReceipt) return void reply.code(403).send(refusal({ code: 'docked_receipt_required' }));
    const receiptRefusal = dockedReceiptRefusal(dockedReceipt, {
      pilotId: request.user.sub,
      publicKey: fastify.claimKey.key,
      nowMs: Date.now(),
      log: request.log
    });
    if (receiptRefusal) {
      const code = receiptRefusal.code === 'docked_receipt_expired' ? 'docked_receipt_required' : receiptRefusal.code;
      return void reply.code(403).send(refusal({ code }));
    }
    if (stationId !== undefined && stationId !== dockedReceipt.dockedEntityId) {
      return void reply.code(403).send(refusal({ code: 'docked_receipt_wrong_station' }));
    }
    return dockedReceipt.dockedEntityId;
  }

  // Re-signs the token with the ship's attributes after `ship.crew` changed to `crew`.
  async function respondWithShip(request, ship, crew, body) {
    const loadout = toLoadout(ship.id, ship.components, ship.passengersAboard, ship.traits, crew);
    return { ...body, ship_attributes: loadout.ship_attributes, token: await reissueToken(fastify, request, loadout.ship_attributes, ship.factions) };
  }

  // The pilot's roster and the limits the lounge shows.
  fastify.get('/crew', async (request) => {
    return prisma.$transaction(async (tx) => {
      const ship = await lockActiveShip(tx, request.user);
      const standby = await standbyCrewOf(tx, request.user.sub);
      return {
        active: ship.crew.map((member) => crewMemberView(member, ship.traits)),
        standby: standby.map((member) => crewMemberView(member, ship.traits)),
        limits: crewLimits(ship)
      };
    });
  });

  // The station's candidates this window, each with whether this pilot can hire them. The board is the
  // same for every pilot and cannot be rerolled by refreshing, so it needs no receipt. Only a candidate
  // already on this pilot's roster is left out, so the others keep their places and the board may show
  // fewer than four.
  fastify.get('/crew/board', { schema: boardSchema }, async (request) => {
    const { stationId } = request.query;
    const nowMs = Date.now();
    const { window, candidates } = generateCrewBoard(stationId, nowMs);
    const ctx = await prisma.$transaction(async (tx) => {
      const ship = await lockActiveShip(tx, request.user);
      const player = await tx.player.findUnique({ where: { id: request.user.sub }, select: { credits: true } });
      return {
        ship,
        credits: player.credits,
        standings: await standingsOf(tx, request.user.sub),
        hired: await hiredCandidateIdsOf(tx, request.user.sub)
      };
    });
    return {
      stationId,
      window: { startsAt: new Date(window.startsAtMs).toISOString(), expiresAt: new Date(window.expiresAtMs).toISOString() },
      candidates: candidates.filter((candidate) => !ctx.hired.has(candidate.candidateId)).map((candidate) => candidateView(candidate, ctx)),
      credits: ctx.credits
    };
  });

  // Hires a candidate from the docked station's board: checks, signing bonus and the new crew member
  // commit together under the pilot's lock, so berths, the class slot and credits are never over-spent.
  fastify.post('/crew/hire', { schema: hireSchema, preHandler: fastify.requireClaimKey }, async (request, reply) => {
    const stationId = dockedStation(request, reply);
    if (!stationId) return reply;
    const candidate = findCandidate(stationId, request.body.candidateId, Date.now());
    if (!candidate) return reply.code(404).send(refusal({ code: 'candidate_not_found' }));

    const outcome = await prisma.$transaction(async (tx) => {
      const ship = await lockActiveShip(tx, request.user);
      const playerId = request.user.sub;
      if ((await hiredCandidateIdsOf(tx, playerId)).has(candidate.candidateId)) return { refused: { code: 'candidate_already_hired' } };
      const player = await tx.player.findUnique({ where: { id: playerId }, select: { credits: true } });
      const reasons = unavailableReasons(candidate, { ship, credits: player.credits, standings: await standingsOf(tx, playerId) });
      if (reasons.length > 0) return { refused: reasonRefusal(primaryReason(reasons), reasons) };

      const bonus = signingBonusCredits(candidate.rank, candidate.quirkId, ship.traits);
      // Guarded decrement: only succeeds while the stored balance still covers the bonus.
      const paid = await tx.player.updateMany({ where: { id: playerId, credits: { gte: bonus } }, data: { credits: { decrement: bonus } } });
      if (paid.count !== 1) return { refused: { code: 'insufficient_credits', requiredCredits: bonus } };
      const member = await tx.crewMember.create({
        data: {
          playerId,
          spaceshipId: ship.id,
          name: candidate.name,
          crewClass: candidate.crewClass,
          rank: candidate.rank,
          quirkId: candidate.quirkId,
          status: CREW_STATUS.ACTIVE,
          morale: startingMorale(candidate.quirkId, ship.traits),
          wageShareBp: CREW_WAGE_SHARE_BP[candidate.rank],
          homeFactionId: candidate.homeFactionId,
          hiredAtStationId: stationId,
          sourceCandidateId: candidate.candidateId
        }
      });
      return { ship, member, credits: player.credits - bonus, crew: await activeCrewOf(tx, ship.id) };
    });
    if (outcome.refused) return reply.code(STATUS[outcome.refused.code]).send(refusal(outcome.refused));

    const { ship, member, credits, crew } = outcome;
    return respondWithShip(request, ship, crew, { crew: crewMemberView(member, ship.traits), credits });
  });

  // The guards both ways of taking a crew member off the ship share: no mission held (a pilot could
  // otherwise fire the crew just before a payout to dodge their share) and, for an Engineer, the
  // installed components still fit the hull budget without them. Returns a refusal or undefined.
  async function leaveRefusal(tx, ship, member) {
    const held = await tx.playerMission.findMany({ where: { playerId: ship.playerId } });
    if (held.some((row) => !isLegacyRow(row))) return { code: 'crew_locked_by_active_mission' };
    const remaining = ship.crew.filter((other) => other.id !== member.id);
    const { hull_tier: hullTier } = computeShipAttributes(ship.components, ship.passengersAboard, ship.traits, remaining);
    const requiredBudget = totalSubsystemPoints(ship.components);
    if (requiredBudget > hullBudget(hullTier, ship.traits, remaining)) {
      return { code: 'engineer_required_for_loadout', requiredBudget, baseBudget: hullBudget(hullTier, ship.traits, remaining) };
    }
    return undefined;
  }

  // Lets a crew member go. The signing bonus is not refunded.
  fastify.post('/crew/dismiss', { schema: crewActionSchema, preHandler: fastify.requireClaimKey }, async (request, reply) => {
    if (!dockedStation(request, reply)) return reply;
    const outcome = await prisma.$transaction(async (tx) => {
      const ship = await lockActiveShip(tx, request.user);
      const member = await tx.crewMember.findFirst({ where: { id: request.body.crewId, playerId: request.user.sub } });
      if (!member) return { refused: { code: 'crew_not_found' } };
      const refused = await leaveRefusal(tx, ship, member);
      if (refused) return { refused };
      await tx.crewMember.delete({ where: { id: member.id } });
      return { ship, crew: await activeCrewOf(tx, ship.id) };
    });
    if (outcome.refused) return reply.code(STATUS[outcome.refused.code]).send(refusal(outcome.refused));
    return respondWithShip(request, outcome.ship, outcome.crew, { dismissed: request.body.crewId });
  });

  // Moves an active crew member to Harbor Standby for a fee: off the ship's berths, still on the roster.
  fastify.post('/crew/standby', { schema: crewActionSchema, preHandler: fastify.requireClaimKey }, async (request, reply) => {
    if (!dockedStation(request, reply)) return reply;
    const outcome = await prisma.$transaction(async (tx) => {
      const ship = await lockActiveShip(tx, request.user);
      const playerId = request.user.sub;
      const member = await tx.crewMember.findFirst({ where: { id: request.body.crewId, playerId } });
      if (!member) return { refused: { code: 'crew_not_found' } };
      if (member.status !== CREW_STATUS.ACTIVE || member.spaceshipId !== ship.id) return { refused: { code: 'crew_not_active' } };
      const refused = await leaveRefusal(tx, ship, member);
      if (refused) return { refused };
      if ((await standbyCrewOf(tx, playerId)).length >= MAX_STANDBY_CREW) return { refused: { code: 'standby_full', maxStandbyCrew: MAX_STANDBY_CREW } };
      const paid = await tx.player.updateMany({
        where: { id: playerId, credits: { gte: STANDBY_TRANSFER_FEE_CREDITS } },
        data: { credits: { decrement: STANDBY_TRANSFER_FEE_CREDITS } }
      });
      if (paid.count !== 1) return { refused: { code: 'insufficient_credits', requiredCredits: STANDBY_TRANSFER_FEE_CREDITS } };
      const moved = await tx.crewMember.update({ where: { id: member.id }, data: { status: CREW_STATUS.STANDBY, spaceshipId: null } });
      const player = await tx.player.findUnique({ where: { id: playerId }, select: { credits: true } });
      return { ship, member: moved, credits: player.credits, crew: await activeCrewOf(tx, ship.id) };
    });
    if (outcome.refused) return reply.code(STATUS[outcome.refused.code]).send(refusal(outcome.refused));
    const { ship, member, credits, crew } = outcome;
    return respondWithShip(request, ship, crew, { crew: crewMemberView(member, ship.traits), credits, feeCredits: STANDBY_TRANSFER_FEE_CREDITS });
  });

  // Brings a crew member from Harbor Standby back aboard, subject to the same class, hull and berth
  // limits as a hire. No fee and no new signing bonus.
  fastify.post('/crew/activate', { schema: crewActionSchema, preHandler: fastify.requireClaimKey }, async (request, reply) => {
    if (!dockedStation(request, reply)) return reply;
    const outcome = await prisma.$transaction(async (tx) => {
      const ship = await lockActiveShip(tx, request.user);
      const member = await tx.crewMember.findFirst({ where: { id: request.body.crewId, playerId: request.user.sub } });
      if (!member) return { refused: { code: 'crew_not_found' } };
      if (member.status !== CREW_STATUS.STANDBY) return { refused: { code: 'crew_not_on_standby' } };
      const reasons = boardingReasons(ship, member.crewClass);
      if (reasons.length > 0) return { refused: reasonRefusal(primaryReason(reasons), reasons) };
      const moved = await tx.crewMember.update({ where: { id: member.id }, data: { status: CREW_STATUS.ACTIVE, spaceshipId: ship.id } });
      return { ship, member: moved, crew: await activeCrewOf(tx, ship.id) };
    });
    if (outcome.refused) return reply.code(STATUS[outcome.refused.code]).send(refusal(outcome.refused));
    const { ship, member, crew } = outcome;
    return respondWithShip(request, ship, crew, { crew: crewMemberView(member, ship.traits) });
  });
}
