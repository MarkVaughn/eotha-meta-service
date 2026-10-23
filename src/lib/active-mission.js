import {
  MISSION_ARCHETYPES, MISSION_TYPES, MISSION_VISIBILITIES, isCovert, isLegacyRow, missionEnum
} from './mission-offer.js';

// JSONB may round doubles by an ulp. The original signed coordinates are kept as text beside
// the offer and restored before either an API response or a JWT is built.
export function fromStoredOffer(stored) {
  const { exact_destination: exact, exact_source: source, ...offer } = stored;
  if (Array.isArray(exact)) {
    offer.destination_lat = Number(exact[0]);
    offer.destination_lng = Number(exact[1]);
  }
  if (Array.isArray(source)) {
    offer.source_lat = Number(source[0]);
    offer.source_lng = Number(source[1]);
  }
  return offer;
}

export function toActiveMission(playerId, offer, acceptedAt) {
  const acceptedAtMs = acceptedAt.getTime();
  return {
    mission_id: offer.mission_id,
    player_ship_id: playerId,
    offer,
    accepted_at_ms: acceptedAtMs,
    deadline_ms: acceptedAtMs + offer.duration_limit_ms,
    is_completed: false
  };
}

// Rust's serde ActiveMission JSON is NOT protobuf JSON: enum fields are integers, the
// signature is a byte array, and the timestamp fields are JSON numbers (build.rs / jwt.rs).
// Only the single held covert mission is tracked. Every issuance consults persisted state,
// never an old access token, so stale tokens cannot resurrect an abandoned/completed mission.
export async function activeMissionClaim(db, playerId) {
  const rows = await db.playerMission.findMany({ where: { playerId }, orderBy: [{ acceptedAt: 'asc' }, { id: 'asc' }] });
  const row = rows.find((mission) => !isLegacyRow(mission) && isCovert(mission.offer));
  if (!row) return undefined;
  const offer = fromStoredOffer(row.offer);
  return toActiveMission(playerId, {
    ...offer,
    type: MISSION_TYPES[offer.type],
    visibility: missionEnum(offer.visibility, MISSION_VISIBILITIES),
    archetype: missionEnum(offer.archetype, MISSION_ARCHETYPES),
    signature: [...Buffer.from(offer.signature, 'base64')]
  }, row.acceptedAt);
}
