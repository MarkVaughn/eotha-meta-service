// The meta-service must derive mission offers exactly as the RTSE does, or the RTSE refuses every
// completion claim as a tampered offer. `fixtures/rtse-mission-vectors.json` holds values the
// engine itself produced (see `fixtures/rtse-mission-vectors.rs`); these tests assert this
// service reproduces them, and that a Tier 1 ship never faces an empty board.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gridDisk, isPentagon, latLngToCell } from 'h3-js';
import {
  MISSION_TYPE_PASSAGE,
  MISSION_TYPE_RESEARCH,
  OFFER_WINDOW_MS,
  authenticateOffer,
  generateMissionOffers,
  isStationOf,
  missionPayout
} from '../src/config/missions.js';
import { MIN_ROUNDING_MARGIN, generateCellNodes, nodeGeometry, nodeName, securityLevel, systemName } from '../src/lib/procedural.js';
import { fma } from '../src/lib/fma.js';
import { asin, atan2, sinCos } from '../src/lib/crmath.js';

const vectors = JSON.parse(readFileSync(new URL('./fixtures/rtse-mission-vectors.json', import.meta.url), 'utf8'));
const TYPES = { 1: MISSION_TYPE_PASSAGE, 2: MISSION_TYPE_RESEARCH };
const SPAWN = latLngToCell(37.7749, -122.4194, 8); // where a new pilot starts
const TIER_1_BERTHS = 2;
const TIER_1_SPEED_MPS = 20;

const nodeAt = (node) => nodeGeometry(node);

describe('procedural content equals the engine', () => {
  test('node ids, kinds, grades, names and security level', () => {
    for (const system of vectors.systems) {
      assert.equal(systemName(system.system_h3), system.system_name, system.system_h3);
      assert.equal(securityLevel(system.system_h3), system.security, system.system_h3);
      const nodes = generateCellNodes(system.system_h3);
      assert.equal(nodes.length, system.nodes.length, system.system_h3);
      nodes.forEach((node, i) => {
        const expected = system.nodes[i];
        assert.equal(node.id, expected.id);
        assert.equal(node.isStation, expected.is_station);
        assert.equal(node.entityType, expected.entity_type);
        assert.equal(node.grade, expected.grade);
        assert.equal(nodeName(expected.node_h3), expected.node_name);
      });
    }
  });

  test('node positions are bit-identical wherever they are trusted, and never far off elsewhere', () => {
    let trusted = 0;
    let untrusted = 0;
    let unsupported = 0;
    for (const system of vectors.systems) {
      generateCellNodes(system.system_h3).forEach((node, i) => {
        const expected = system.nodes[i];
        const where = nodeAt(node);
        if (!where) {
          unsupported++;
          return;
        }
        assert.equal(where.nodeCell, expected.node_h3);
        if (where.margin >= MIN_ROUNDING_MARGIN) {
          trusted++;
          assert.equal(where.lat, expected.lat, `${node.id} latitude`);
          assert.equal(where.lng, expected.lng, `${node.id} longitude`);
        } else {
          untrusted++;
          // Near a rounding tie the last bit may differ from the engine's libm; no more than that.
          assert.ok(Math.abs(where.lat - expected.lat) < 1e-12 && Math.abs(where.lng - expected.lng) < 1e-12, node.id);
        }
      });
    }
    assert.ok(trusted >= 40, `only ${trusted} trusted node positions were compared`);
    assert.ok(unsupported <= 10, `${unsupported} positions unsupported (${trusted} trusted, ${untrusted} near a tie)`);
  });

  test('pentagons are unsupported rather than guessed', () => {
    for (const system of vectors.systems) {
      const unsupported = generateCellNodes(system.system_h3).some((node) => nodeAt(node) === null);
      if (isPentagon(system.system_h3)) assert.ok(unsupported, `${system.system_h3} is a pentagon`);
    }
  });
});

describe('offers equal the engine, byte for byte', () => {
  test('every engine offer is reproduced field for field', () => {
    let compared = 0;
    let nearTie = 0;
    let skipped = 0;
    for (const c of vectors.cases) {
      const mine = generateMissionOffers({
        systemH3: c.origin_system_h3,
        stationId: c.origin_station_id,
        availableBerths: c.available_berths,
        factionReputation: c.faction_reputation,
        lastMissionTimestampMs: c.last_mission_timestamp_ms,
        nowMs: c.now_ms,
        minMargin: 0
      });
      c.offers.forEach((expected) => {
        const engine = { ...expected, type: TYPES[expected.type] };
        const destination = generateCellNodes(engine.destination_system_h3)
          .find((n) => (engine.type === MISSION_TYPE_PASSAGE ? n.id === engine.destination_station_id : nodeAt(n)?.nodeCell === engine.destination_node_h3));
        const where = destination && nodeAt(destination);
        const offer = mine?.find((o) => o.mission_id === engine.mission_id);
        if (!where) {
          // A destination whose position this service cannot reproduce (a pentagon, a face edge).
          skipped++;
          return;
        }
        if (where.margin >= MIN_ROUNDING_MARGIN) {
          assert.deepEqual(offer, engine, `${c.origin_station_id} berths ${c.available_berths}`);
          compared++;
        } else {
          // Near a rounding tie the engine's libm may differ in the last bit of a coordinate, and
          // such destinations are not put on a board; everything else must still be identical.
          const { destination_lat: lat, destination_lng: lng, ...rest } = offer;
          const { destination_lat: expectedLat, destination_lng: expectedLng, ...expectedRest } = engine;
          assert.deepEqual(rest, expectedRest);
          assert.ok(Math.abs(lat - expectedLat) < 1e-12 && Math.abs(lng - expectedLng) < 1e-12);
          nearTie++;
        }
      });
    }
    assert.ok(compared >= 60, `only ${compared} offers compared bit for bit (${nearTie} near a tie, ${skipped} unsupported)`);
    assert.ok(compared + nearTie >= 3 * skipped, `${skipped} offers unsupported against ${compared + nearTie} reproduced`);
  });

  test('the engine rules decide payout, window, duration, reputation and passengers', () => {
    for (const c of vectors.cases) {
      for (const offer of c.offers) {
        assert.equal(offer.expires_at_ms, c.now_ms + OFFER_WINDOW_MS);
        assert.equal(offer.reward_credits, missionPayout(offer.distance_hexes, offer.required_berths));
        assert.equal(offer.reward_credits, 1000 + 500 * offer.distance_hexes + 250 * offer.required_berths);
        assert.equal(offer.duration_limit_ms, 300_000 * offer.distance_hexes);
        assert.equal(offer.reputation_change, 5);
        if (offer.type === 1) assert.ok(offer.required_berths >= 1 && offer.required_berths <= Math.min(c.available_berths, 4));
      }
    }
  });

  test('a board only ever shows engine offers, all of them authentic', () => {
    for (const c of vectors.cases) {
      const board = generateMissionOffers({
        systemH3: c.origin_system_h3,
        stationId: c.origin_station_id,
        availableBerths: c.available_berths,
        nowMs: c.now_ms
      });
      assert.ok(board.length >= 1, 'a board is never empty');
      assert.equal(new Set(board.map((o) => o.mission_id)).size, board.length);
      for (const offer of board) {
        assert.match(offer.mission_id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
        const authentic = authenticateOffer(offer, { availableBerths: c.available_berths, nowMs: c.now_ms });
        assert.deepEqual(authentic?.offer, offer);
      }
    }
  });
});

describe('starter ships always see a viable board', () => {
  const stationsAround = (system, rings) =>
    gridDisk(system, rings).flatMap((cell) => generateCellNodes(cell).filter((n) => n.isStation).map((n) => ({ cell, id: n.id, node: n })));

  const metersBetween = ([lat1, lng1], [lat2, lng2]) => {
    const rad = Math.PI / 180;
    const a = Math.sin(((lat2 - lat1) * rad) / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(((lng2 - lng1) * rad) / 2) ** 2;
    return 2 * 6_371_008.8 * Math.asin(Math.sqrt(a));
  };

  test('every station near the spawn offers a Tier 1 ship passage that fits its berths and can be flown', () => {
    const nowMs = 1_790_000_000_000;
    const origins = stationsAround(SPAWN, 12);
    assert.ok(origins.length >= 10, 'expected stations around the spawn');
    for (const { cell, id, node } of origins) {
      const board = generateMissionOffers({ systemH3: cell, stationId: id, availableBerths: TIER_1_BERTHS, nowMs });
      const passage = board.filter((o) => o.type === MISSION_TYPE_PASSAGE);
      assert.ok(passage.length >= 1, `no passage offered at ${id} in ${cell}`);
      for (const offer of board) {
        assert.ok(offer.required_berths <= TIER_1_BERTHS, `${offer.required_berths} berths at ${id}`);
        assert.equal(offer.origin_station_id, id);
        assert.notEqual(offer.destination_station_id, id);
        // Real flight at Tier 1 speed has to fit the time allowed.
        const from = nodeAt(node);
        if (from) {
          const meters = metersBetween([from.lat, from.lng], [offer.destination_lat, offer.destination_lng]);
          assert.ok(meters / TIER_1_SPEED_MPS * 1000 < offer.duration_limit_ms, `${meters} m in ${offer.duration_limit_ms} ms`);
        }
      }
    }
  });

  test('the station nearest the spawn offers passage', () => {
    // The spawn system itself has no station; its neighbor does.
    const nearest = stationsAround(SPAWN, 1)[0];
    assert.ok(nearest);
    const board = generateMissionOffers({ systemH3: nearest.cell, stationId: nearest.id, availableBerths: TIER_1_BERTHS, nowMs: Date.now() });
    assert.ok(board.length >= 1);
    assert.ok(board.every((o) => o.type === MISSION_TYPE_PASSAGE && o.required_berths <= TIER_1_BERTHS));
  });

  test('stations across the world: never an empty board, passage whenever a destination exists', () => {
    // Deterministic xorshift sample of the playable band.
    let s = 123456789;
    const next = () => {
      s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0;
      return s / 2 ** 32;
    };
    let boards = 0;
    for (let i = 0; i < 1500; i++) {
      const cell = latLngToCell(-55 + next() * 139, -180 + next() * 360, 8);
      for (const node of generateCellNodes(cell).filter((n) => n.isStation)) {
        const board = generateMissionOffers({ systemH3: cell, stationId: node.id, availableBerths: TIER_1_BERTHS, nowMs: 1_790_000_000_000 });
        boards++;
        assert.ok(board.length >= 1, `empty board at ${node.id} in ${cell}`);
        const hasStationNearby = gridDisk(cell, 3).some((c) => c !== cell && generateCellNodes(c).some((n) => n.isStation));
        if (hasStationNearby) assert.ok(board.some((o) => o.type === MISSION_TYPE_PASSAGE), `no passage at ${node.id} in ${cell}`);
        assert.ok(board.every((o) => o.required_berths <= TIER_1_BERTHS));
      }
    }
    assert.ok(boards >= 100);
  });

  test('a ship with no berths is offered surveys, and the board is never empty either', () => {
    const origin = stationsAround(SPAWN, 1)[0];
    const board = generateMissionOffers({ systemH3: origin.cell, stationId: origin.id, availableBerths: 0, nowMs: Date.now() });
    assert.ok(board.length >= 1);
    assert.ok(board.every((o) => o.type === MISSION_TYPE_RESEARCH && o.required_berths === 0 && o.destination_station_id === origin.id));
  });

  test('a station that is not in the system gets no board', () => {
    const origin = stationsAround(SPAWN, 1)[0];
    assert.equal(generateMissionOffers({ systemH3: SPAWN, stationId: origin.id, availableBerths: 2, nowMs: Date.now() }), null);
    assert.equal(isStationOf(origin.cell, origin.id), true);
    assert.equal(isStationOf(origin.cell, '00000000-0000-4000-8000-000000000000'), false);
  });
});

describe('presented offers are authenticated against the regenerated ones', () => {
  const origin = gridDisk(SPAWN, 1).flatMap((cell) => generateCellNodes(cell).filter((n) => n.isStation).map((n) => ({ cell, id: n.id })))[0];
  const nowMs = 1_790_000_000_000;
  const [offer] = generateMissionOffers({ systemH3: origin.cell, stationId: origin.id, availableBerths: 2, nowMs });
  const check = (presented, at = nowMs, berths = 2) => authenticateOffer(presented, { availableBerths: berths, nowMs: at });

  test('accepts the offer it made, now and until it expires, and flags it expired afterwards', () => {
    assert.deepEqual(check(offer)?.offer, offer);
    assert.equal(check(offer)?.expired, false);
    assert.equal(check(offer, offer.expires_at_ms)?.expired, false);
    assert.equal(check(offer, offer.expires_at_ms + 1)?.expired, true);
  });

  test('refuses an offer from the future, or one that was altered in any field', () => {
    assert.equal(check(offer, nowMs - 1), null);
    for (const [field, value] of Object.entries({
      mission_id: '11111111-1111-4111-8111-111111111111',
      reward_credits: offer.reward_credits + 1,
      duration_limit_ms: offer.duration_limit_ms + 1,
      required_berths: offer.required_berths + 1,
      destination_lat: offer.destination_lat + 1e-12,
      destination_lng: offer.destination_lng - 1e-12,
      destination_node_h3: '8c2830828501dff',
      destination_station_id: '22222222-2222-4222-8222-222222222222',
      distance_hexes: offer.distance_hexes + 1,
      origin_station_id: '33333333-3333-4333-8333-333333333333',
      origin_system_h3: '88195da49bfffff',
      reputation_change: 6,
      title: `${offer.title}!`,
      expires_at_ms: offer.expires_at_ms + OFFER_WINDOW_MS,
      type: MISSION_TYPE_RESEARCH
    })) {
      assert.equal(check({ ...offer, [field]: value }), null, field);
    }
    assert.equal(check({ ...offer, extra: true }), null);
    assert.equal(check(null), null);
    assert.equal(check('offer'), null);
  });

  test('an offer is bound to the berths of the ship it was made for', () => {
    const [big] = generateMissionOffers({ systemH3: origin.cell, stationId: origin.id, availableBerths: 4, nowMs }).filter((o) => o.required_berths > 2);
    assert.equal(check(big, nowMs, 2), null);
    assert.deepEqual(check(big, nowMs, 4)?.offer, big);
  });

  test('the same ids hold throughout a window and change with the next', () => {
    const windowStart = nowMs - (nowMs % OFFER_WINDOW_MS);
    const ids = (at) => generateMissionOffers({ systemH3: origin.cell, stationId: origin.id, availableBerths: 2, nowMs: at }).map((o) => o.mission_id);
    assert.deepEqual(ids(windowStart), ids(windowStart + OFFER_WINDOW_MS - 1));
    const next = ids(windowStart + OFFER_WINDOW_MS);
    assert.ok(ids(windowStart).every((id) => !next.includes(id)));
  });
});

describe('the exact arithmetic behind node positions', () => {
  test('fma rounds once', () => {
    // 1 + 2^-53 is a tie that a separate multiply and add loses to rounding.
    const a = 1 + 2 ** -27;
    assert.equal(fma(a, a, -(a * a)), 2 ** -54);
    assert.equal(fma(3, 4, 5), 17);
    assert.equal(fma(-0.5, 8, 4), 0);
  });

  test('sin, cos, asin and atan2 are correctly rounded', () => {
    // Values whose results V8's own functions get wrong (checked against glibc's, which is correctly rounded here).
    const [s, c] = sinCos(1);
    assert.equal(s, 0.8414709848078965);
    assert.equal(c, 0.5403023058681398);
    assert.equal(asin(0.5), 0.5235987755982989);
    assert.equal(atan2(1, 1), 0.7853981633974483);
    assert.equal(atan2(-1, -1), -2.356194490192345);
    assert.equal(atan2(1, -2), 2.677945044588987);
  });

});
