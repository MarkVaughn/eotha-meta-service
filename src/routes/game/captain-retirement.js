import {
  ACADEMY_RECRUIT_NAME,
  LEGACY_DOCTRINES,
  LEGACY_DOCTRINE_IDS,
  MAX_ACTIVE_LEGACY_DOCTRINES,
  PROMOTE_CREW_MIN_MORALE,
  RETIREMENT_TIERS,
  SUCCESSOR_TYPES,
  doctrineTierLimit,
  retirementFeeCredits,
  retirementTierForLevel
} from '../../config/captain.js';
import { ENGINEER_JURY_RIG_TYPES, QUIRKS, RANKS, engineerJuryRigSlots } from '../../config/crew.js';
import { UUID_PATTERN } from '../../config/patterns.js';
import { DOCKED_ENTITY_ID_PATTERN, dockedReceiptRefusal, dockedReceiptSchema } from '../../lib/docked-receipt.js';
import { activeDoctrineIdsOf, captainView, effectIdsFor } from '../../lib/captain.js';
import { activeCrewOf, holdsActiveMission } from '../../lib/crew.js';
import {
  doctrineView,
  resignsWhenPassedOver,
  retiredCaptainData,
  retiredCaptainView,
  retiredCaptainsOf
} from '../../lib/retirement.js';
import { lockActiveShip, reissueToken, toLoadout } from '../../lib/ship.js';

// `dockedReceipt` is optional in the schema on purpose, like the captain trait route: its absence is
// answered with the coded 403 `docked_receipt_required` rather than a generic schema 400.
const receiptProperties = {
  stationId: { type: 'string', pattern: DOCKED_ENTITY_ID_PATTERN },
  dockedReceipt: dockedReceiptSchema
};

const retireSchema = {
  body: {
    type: 'object',
    required: ['successorType'],
    additionalProperties: false,
    properties: {
      retirementTier: { type: 'string', enum: Object.values(RETIREMENT_TIERS) },
      legacyDoctrineId: { type: 'string', enum: LEGACY_DOCTRINE_IDS },
      successorType: { type: 'string', enum: Object.values(SUCCESSOR_TYPES) },
      successorCrewId: { type: 'string', pattern: UUID_PATTERN.source },
      successorName: { type: 'string', minLength: 1, maxLength: 32, pattern: '\\S' },
      ...receiptProperties
    }
  }
};

const doctrineSchema = {
  body: {
    type: 'object',
    required: ['retiredCaptainId', 'active'],
    additionalProperties: false,
    properties: {
      retiredCaptainId: { type: 'string', pattern: UUID_PATTERN.source },
      active: { type: 'boolean' },
      legacyDoctrineId: { type: 'string', enum: LEGACY_DOCTRINE_IDS },
      ...receiptProperties
    }
  }
};

const juryRigSchema = {
  body: {
    type: 'object',
    required: ['componentTypes'],
    additionalProperties: false,
    properties: {
      componentTypes: { type: 'array', uniqueItems: true, maxItems: 2, items: { type: 'string', enum: ENGINEER_JURY_RIG_TYPES } },
      ...receiptProperties
    }
  }
};

const MESSAGES = {
  captain_not_engineer: 'Only a captain promoted from the Engineers can overdrive components.',
  jury_rig_slots_exceeded: 'That captain cannot overdrive that many components.',
  COMPONENT_NOT_INSTALLED: 'Overdrive requires an installed component; Tier 0 is unequipped.',
  jury_rig_already_max_tier: 'Tier 5 cannot be overdriven to Tier 6; select a lower-tier component.',
  docked_receipt_required: 'Retiring a captain or setting a doctrine requires a current docked receipt from the engine.',
  docked_receipt_invalid: 'The docked receipt is not valid for this pilot.',
  docked_receipt_wrong_station: 'The docked receipt is for a different station.',
  docked_receipt_stale: 'The docked receipt is for a dock older than the last one this ship docked at.',
  captain_locked_by_active_mission: 'A captain cannot retire while you hold a mission.',
  retirement_tier_required: 'An early discharge costs credits and must be requested by naming its retirementTier.',
  retirement_tier_mismatch: 'That retirement tier is not the one this captain\'s level qualifies for.',
  insufficient_credits: 'Not enough credits for the early discharge fee.',
  successor_crew_required: 'Promoting a crew member needs successorCrewId.',
  successor_crew_not_allowed: 'An Academy recruit successor takes no successorCrewId.',
  successor_name_not_allowed: 'A promoted crew member keeps its own name.',
  crew_not_found: 'No such crew member on your roster.',
  insufficient_rank_for_promotion: 'Only an Adept or a Master can be promoted to Captain.',
  insufficient_morale_for_promotion: 'The crew member\'s morale is too low to be promoted to Captain.',
  doctrine_not_available: 'An early discharge unlocks no Legacy Doctrine.',
  doctrine_tier_locked: 'That Legacy Doctrine needs a master retirement.',
  doctrine_limit_reached: 'Legacy Doctrines in force are at the limit; deactivate one first.',
  retired_captain_not_found: 'No such retired captain on your record.',
  no_doctrine_slot: 'That retired captain left no Legacy Doctrine slot.',
  no_doctrine_unlocked: 'That retired captain has not chosen a Legacy Doctrine yet.',
  doctrine_already_chosen: 'That retired captain\'s Legacy Doctrine slot already holds another doctrine.'
};
const STATUS = {
  captain_not_engineer: 409,
  jury_rig_slots_exceeded: 409,
  COMPONENT_NOT_INSTALLED: 409,
  jury_rig_already_max_tier: 409,
  docked_receipt_stale: 403,
  captain_locked_by_active_mission: 409,
  retirement_tier_required: 400,
  retirement_tier_mismatch: 400,
  insufficient_credits: 402,
  successor_crew_required: 400,
  successor_crew_not_allowed: 400,
  successor_name_not_allowed: 400,
  crew_not_found: 404,
  insufficient_rank_for_promotion: 400,
  insufficient_morale_for_promotion: 400,
  doctrine_not_available: 400,
  doctrine_tier_locked: 400,
  doctrine_limit_reached: 409,
  retired_captain_not_found: 404,
  no_doctrine_slot: 409,
  no_doctrine_unlocked: 409,
  doctrine_already_chosen: 409
};

// `{ error: <code>, message, ...details }`, the shape the captain routes answer refusals with.
const refusal = ({ code, ...details }) => ({ error: code, message: MESSAGES[code], ...details });

export default async function captainRetirementRoutes(fastify) {
  const prisma = fastify.prisma;
  fastify.addHook('onRequest', fastify.authenticate);

  // The signed receipt, or the reply that refuses it. Stateless, so it runs before any write. An
  // expired receipt is answered like a missing one: either way the client must fetch a fresh one.
  function dockedReceiptOf(request, reply) {
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
    return dockedReceipt;
  }

  // A receipt for a dock older than the last the ship's crew settled at proves nothing about now.
  const staleReceipt = (ship, receipt) =>
    ship.lastCrewDockedAtMs != null && BigInt(receipt.dockedAtMs) < ship.lastCrewDockedAtMs;

  // Re-signs the token with the ship's attributes under `traits` (the effect ids now in force) and `crew`.
  async function respondWithShip(request, ship, traits, crew, body) {
    const loadout = toLoadout(ship.id, ship.components, ship.passengersAboard, traits, crew);
    return { ...body, ship_attributes: loadout.ship_attributes, token: await reissueToken(fastify, request, loadout.ship_attributes, ship.factions) };
  }

  // The Hall of Command: every captain the pilot has retired, and the Legacy Doctrines they hold.
  fastify.get('/captain/retired', async (request) => {
    return prisma.$transaction(async (tx) => {
      await lockActiveShip(tx, request.user);
      const rows = await retiredCaptainsOf(tx, request.user.sub);
      return {
        retiredCaptains: rows.map(retiredCaptainView),
        activeDoctrineIds: await activeDoctrineIdsOf(tx, request.user.sub),
        maxActiveDoctrines: MAX_ACTIVE_LEGACY_DOCTRINES,
        doctrines: Object.values(LEGACY_DOCTRINES).map(({ id, name, tier, summary }) => ({ id, name, tier, summary }))
      };
    });
  });

  // Retires the captain while docked and installs a successor, all under the pilot's lock: the fee, the
  // archive row, the successor, the crew leaving and the Legacy Doctrine commit together or not at all.
  // The docked receipt's nonce keys the retirement, so a retried request is answered with the retirement
  // it made instead of retiring the successor.
  fastify.post('/captain/retire', { schema: retireSchema, preHandler: fastify.requireClaimKey }, async (request, reply) => {
    const receipt = dockedReceiptOf(request, reply);
    if (!receipt) return reply;
    const { retirementTier, legacyDoctrineId, successorType, successorCrewId, successorName } = request.body;
    const playerId = request.user.sub;
    const promoting = successorType === SUCCESSOR_TYPES.PROMOTED_CREW;
    if (promoting && !successorCrewId) return reply.code(400).send(refusal({ code: 'successor_crew_required' }));
    if (!promoting && successorCrewId) return reply.code(400).send(refusal({ code: 'successor_crew_not_allowed' }));
    if (promoting && successorName !== undefined) return reply.code(400).send(refusal({ code: 'successor_name_not_allowed' }));

    const outcome = await prisma.$transaction(async (tx) => {
      const ship = await lockActiveShip(tx, request.user);
      const { captain } = ship;

      const prior = await tx.retiredCaptain.findUnique({ where: { playerId_receiptNonce: { playerId, receiptNonce: receipt.nonce } } });
      if (prior) return { replayed: prior, ship };

      if (staleReceipt(ship, receipt)) return { refused: { code: 'docked_receipt_stale' } };
      if (await holdsActiveMission(tx, playerId)) return { refused: { code: 'captain_locked_by_active_mission' } };

      const level = captainView(captain).level;
      const eligibleTier = retirementTierForLevel(level);
      const feeCredits = retirementFeeCredits(eligibleTier);
      if (retirementTier !== undefined && retirementTier !== eligibleTier) {
        return { refused: { code: 'retirement_tier_mismatch', eligibleTier, level } };
      }

      if (legacyDoctrineId !== undefined) {
        const limit = doctrineTierLimit(eligibleTier);
        if (limit === 0) return { refused: { code: 'doctrine_not_available', retirementTier: eligibleTier } };
        if (LEGACY_DOCTRINES[legacyDoctrineId].tier > limit) return { refused: { code: 'doctrine_tier_locked', legacyDoctrineId } };
        const activeDoctrineIds = await activeDoctrineIdsOf(tx, playerId);
        if (!activeDoctrineIds.includes(legacyDoctrineId) && activeDoctrineIds.length >= MAX_ACTIVE_LEGACY_DOCTRINES) {
          return { refused: { code: 'doctrine_limit_reached', maxActiveDoctrines: MAX_ACTIVE_LEGACY_DOCTRINES, activeDoctrineIds } };
        }
      }

      // The whole roster, standby included: a passed-over AMBITIOUS Master resigns wherever it sits.
      const roster = await tx.crewMember.findMany({ where: { playerId } });
      let successor = null;
      if (promoting) {
        successor = roster.find((member) => member.id === successorCrewId);
        if (!successor) return { refused: { code: 'crew_not_found' } };
        if (!['ADEPT', 'MASTER'].includes(successor.rank)) {
          return { refused: { code: 'insufficient_rank_for_promotion', rank: successor.rank, eligibleRanks: RANKS.filter((rank) => rank !== 'NOVICE') } };
        }
        if (successor.morale < PROMOTE_CREW_MIN_MORALE) {
          return { refused: { code: 'insufficient_morale_for_promotion', minMorale: PROMOTE_CREW_MIN_MORALE, currentMorale: successor.morale } };
        }
      }

      // A fee is only charged for a tier the request names, so a retried request that lost its
      // answer cannot discharge the successor.
      if (retirementTier === undefined && feeCredits > 0) {
        return { refused: { code: 'retirement_tier_required', retirementTier: eligibleTier, feeCredits, level } };
      }

      // Every check has passed; what follows commits or rolls back whole.
      if (feeCredits > 0) {
        const paid = await tx.player.updateMany({ where: { id: playerId, credits: { gte: feeCredits } }, data: { credits: { decrement: feeCredits } } });
        if (paid.count !== 1) return { refused: { code: 'insufficient_credits', requiredCredits: feeCredits } };
      }
      const retired = await tx.retiredCaptain.create({
        data: {
          playerId,
          receiptNonce: receipt.nonce,
          ...retiredCaptainData(captain, {
            tier: eligibleTier,
            level,
            factions: ship.factions,
            dock: { stationId: receipt.dockedEntityId, systemH3: receipt.systemH3 },
            doctrineId: legacyDoctrineId
          })
        }
      });

      const resigned = roster.filter((member) => member.id !== successor?.id && resignsWhenPassedOver(member));
      const leaving = [...(successor ? [successor] : []), ...resigned];
      if (leaving.length) await tx.crewMember.deleteMany({ where: { id: { in: leaving.map((member) => member.id) }, playerId } });

      const updated = await tx.captain.update({
        where: { id: captain.id },
        data: {
          name: successor?.name ?? successorName ?? ACADEMY_RECRUIT_NAME,
          level: 1,
          xp: 0,
          unlockedTraits: [],
          missionsCompleted: 0,
          originType: successorType,
          promotedFromCrewId: successor?.id ?? null,
          innateClass: successor?.crewClass ?? null,
          innateRank: successor?.rank ?? null,
          quirkId: successor?.quirkId ?? null,
          juryRigComponentTypes: []
        }
      });
      const player = await tx.player.findUnique({ where: { id: playerId }, select: { credits: true } });
      return {
        ship,
        retired,
        captain: updated,
        feeCredits,
        credits: player.credits,
        promoted: successor && { crewId: successor.id, name: successor.name, crewClass: successor.crewClass, rank: successor.rank, quirk: QUIRKS[successor.quirkId]?.key },
        resigned: resigned.map((member) => ({ crewId: member.id, name: member.name, crewClass: member.crewClass, rank: member.rank })),
        doctrineIds: await activeDoctrineIdsOf(tx, playerId),
        crew: await activeCrewOf(tx, ship.id)
      };
    });
    if (outcome.refused) return reply.code(STATUS[outcome.refused.code]).send(refusal(outcome.refused));

    if (outcome.replayed) {
      // The retirement already happened: report it, with the token for the pilot's state as it is now.
      const { ship } = outcome;
      const player = await prisma.player.findUnique({ where: { id: request.user.sub }, select: { credits: true } });
      return respondWithShip(request, ship, ship.traits, ship.crew, {
        replayed: true,
        retiredCaptain: retiredCaptainView(outcome.replayed),
        captain: captainView(ship.captain),
        credits: player.credits
      });
    }
    const { ship, retired, captain, crew } = outcome;
    return respondWithShip(request, ship, effectIdsFor(captain, outcome.doctrineIds), crew, {
      retiredCaptain: retiredCaptainView(retired),
      captain: captainView(captain),
      retirementTier: retired.retirementTier,
      feeCredits: outcome.feeCredits,
      credits: outcome.credits,
      ...(retired.legacyDoctrineId && { doctrine: { ...doctrineView(retired.legacyDoctrineId), active: retired.activeDoctrine } }),
      ...(outcome.promoted && { promoted: outcome.promoted }),
      resigned: outcome.resigned
    });
  });

  // Chooses the Legacy Doctrine a retired captain's slot holds, if it has none yet, and switches that
  // doctrine on or off. At most MAX_ACTIVE_LEGACY_DOCTRINES are on; the signed attributes change with
  // them, so it needs a dock like a trait does.
  fastify.post('/captain/doctrine', { schema: doctrineSchema, preHandler: fastify.requireClaimKey }, async (request, reply) => {
    const receipt = dockedReceiptOf(request, reply);
    if (!receipt) return reply;
    const { retiredCaptainId, active, legacyDoctrineId } = request.body;
    const playerId = request.user.sub;

    const outcome = await prisma.$transaction(async (tx) => {
      const ship = await lockActiveShip(tx, request.user);
      if (staleReceipt(ship, receipt)) return { refused: { code: 'docked_receipt_stale' } };
      const row = await tx.retiredCaptain.findFirst({ where: { id: retiredCaptainId, playerId } });
      if (!row) return { refused: { code: 'retired_captain_not_found' } };

      let doctrineId = row.legacyDoctrineId;
      if (legacyDoctrineId !== undefined) {
        if (doctrineId && doctrineId !== legacyDoctrineId) return { refused: { code: 'doctrine_already_chosen', legacyDoctrineId: doctrineId } };
        if (!doctrineId) {
          const limit = doctrineTierLimit(row.retirementTier);
          if (limit === 0) return { refused: { code: 'no_doctrine_slot', retirementTier: row.retirementTier } };
          if (LEGACY_DOCTRINES[legacyDoctrineId].tier > limit) return { refused: { code: 'doctrine_tier_locked', legacyDoctrineId } };
          doctrineId = legacyDoctrineId;
        }
      }
      if (!doctrineId) {
        return { refused: { code: doctrineTierLimit(row.retirementTier) === 0 ? 'no_doctrine_slot' : 'no_doctrine_unlocked' } };
      }
      if (active && !row.activeDoctrine) {
        const activeDoctrineIds = await activeDoctrineIdsOf(tx, playerId);
        if (!activeDoctrineIds.includes(doctrineId) && activeDoctrineIds.length >= MAX_ACTIVE_LEGACY_DOCTRINES) {
          return { refused: { code: 'doctrine_limit_reached', maxActiveDoctrines: MAX_ACTIVE_LEGACY_DOCTRINES, activeDoctrineIds } };
        }
      }
      const updated = doctrineId === row.legacyDoctrineId && active === row.activeDoctrine
        ? row
        : await tx.retiredCaptain.update({ where: { id: row.id }, data: { legacyDoctrineId: doctrineId, activeDoctrine: active } });
      return { ship, retired: updated, doctrineIds: await activeDoctrineIdsOf(tx, playerId) };
    });
    if (outcome.refused) return reply.code(STATUS[outcome.refused.code]).send(refusal(outcome.refused));

    const { ship, retired } = outcome;
    return respondWithShip(request, ship, effectIdsFor(ship.captain, outcome.doctrineIds), ship.crew, {
      retiredCaptain: retiredCaptainView(retired),
      activeDoctrineIds: outcome.doctrineIds
    });
  });

  // Selects the components an Engineer captain overdrives, replacing the earlier selection. It is the
  // Phase 3 crew Engineer rule (POST /game/crew/jury-rig) applied to the innate rank: at most
  // engineerJuryRigSlots (a Master's 2) of the installed ENGINES, ENERGY, RADAR or SHIELDS, none at Tier 5,
  // each signed one tier higher (to Tier 5 at most) with no hull budget change. Like a trait it changes
  // the signed attributes, so it needs a dock.
  fastify.post('/captain/jury-rig', { schema: juryRigSchema, preHandler: fastify.requireClaimKey }, async (request, reply) => {
    const receipt = dockedReceiptOf(request, reply);
    if (!receipt) return reply;
    const { componentTypes } = request.body;

    const outcome = await prisma.$transaction(async (tx) => {
      const ship = await lockActiveShip(tx, request.user);
      if (staleReceipt(ship, receipt)) return { refused: { code: 'docked_receipt_stale' } };
      const { captain } = ship;
      if (captain.innateClass !== 'ENGINEER') return { refused: { code: 'captain_not_engineer' } };
      const slots = engineerJuryRigSlots({ crewClass: 'ENGINEER', rank: captain.innateRank });
      if (componentTypes.length > slots) return { refused: { code: 'jury_rig_slots_exceeded', slots } };
      for (const type of componentTypes) {
        const tier = ship.components.find((c) => c.type === type)?.tier ?? 0;
        if (tier === 0) return { refused: { code: 'COMPONENT_NOT_INSTALLED', componentType: type } };
        if (tier >= 5) return { refused: { code: 'jury_rig_already_max_tier', componentType: type } };
      }
      const updated = await tx.captain.update({ where: { id: captain.id }, data: { juryRigComponentTypes: componentTypes } });
      return { ship, captain: updated, doctrineIds: await activeDoctrineIdsOf(tx, request.user.sub) };
    });
    if (outcome.refused) return reply.code(STATUS[outcome.refused.code]).send(refusal(outcome.refused));

    return respondWithShip(request, outcome.ship, effectIdsFor(outcome.captain, outcome.doctrineIds), outcome.ship.crew, {
      captain: captainView(outcome.captain)
    });
  });
}
