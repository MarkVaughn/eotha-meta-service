//! Exports the mission test vectors `rtse-mission-vectors.json` holds: procedural nodes (ids,
//! positions, names) and the mission offers the engine itself generates for them.
//!
//! Copy this file to `examples/` in an `eotha-rtse` checkout (unmodified; this one was run at
//! commit a116335 on glibc 2.39, x86-64) and run:
//!
//! ```sh
//! cargo run -q --example rtse-mission-vectors > rtse-mission-vectors.json
//! ```
//!
//! `tests/mission-vectors.test.js` asserts the meta-service derives exactly these values. Regenerate
//! the file, and update `src/lib/procedural.js` / `src/config/missions.js`, whenever the engine's
//! mission generator or procedural content changes on purpose.

use eotha_rtse::simulation::missions::{generate_mission_offers, h3_hex, OFFER_WINDOW_MS};
use eotha_rtse::simulation::naming::{get_system_metadata, node_name, system_name};
use eotha_rtse::simulation::spatial::{generate_cell_nodes, grid_disk, ProceduralNode};
use eotha_rtse::contracts::MissionOffer;
use h3o::{CellIndex, LatLng, Resolution};
use serde_json::{json, Value};

/// Spots around the world, including the starter spawn, a system beside it that holds a
/// station, a pentagon and a system next to it, and one across the antimeridian.
const SPOTS: [(f64, f64); 8] = [
    (37.7749, -122.4194),
    (51.5074, -0.1278),
    (39.9042, 116.4074),
    (-33.8688, 151.2093),
    (64.1466, -21.9426),
    (-2.3, 179.9999),
    (37.7759, -122.4078),
    (-1.2921, 36.8219),
];

const NOW_MS: u64 = 1_700_000_000_000;

fn system_at(lat: f64, lng: f64) -> CellIndex {
    LatLng::new(lat, lng).unwrap().to_cell(Resolution::Eight)
}

fn offer_json(o: &MissionOffer) -> Value {
    json!({
        "mission_id": o.mission_id, "type": o.r#type, "title": o.title, "description": o.description,
        "origin_station_id": o.origin_station_id, "origin_system_h3": o.origin_system_h3,
        "destination_station_id": o.destination_station_id, "destination_system_h3": o.destination_system_h3,
        "destination_node_h3": o.destination_node_h3, "destination_lat": o.destination_lat,
        "destination_lng": o.destination_lng, "distance_hexes": o.distance_hexes,
        "required_berths": o.required_berths, "duration_limit_ms": o.duration_limit_ms,
        "reward_credits": o.reward_credits, "reputation_change": o.reputation_change,
        "faction_id": o.faction_id, "expires_at_ms": o.expires_at_ms,
    })
}

fn node_json(n: &ProceduralNode) -> Value {
    json!({
        "id": n.id.to_string(), "node_h3": h3_hex(n.node_cell), "lat": n.latitude, "lng": n.longitude,
        "is_station": n.is_station, "entity_type": n.entity_type, "grade": n.grade,
        "node_name": node_name(n.node_cell),
    })
}

fn main() {
    let pentagon = CellIndex::base_cells()
        .find(|c| c.is_pentagon())
        .unwrap()
        .center_child(Resolution::Eight)
        .unwrap();
    let next_to_pentagon = grid_disk(pentagon, 1).into_iter().find(|c| *c != pentagon).unwrap();
    let mut spots: Vec<CellIndex> = SPOTS.iter().map(|(lat, lng)| system_at(*lat, *lng)).collect();
    spots.push(pentagon);
    spots.push(next_to_pentagon);

    // Every system around the starter spawn too, so node positions are checked in bulk.
    let mut systems: Vec<CellIndex> = grid_disk(spots[0], 4);
    systems.extend(&spots);
    systems.sort();
    systems.dedup();

    let systems_json: Vec<Value> = systems
        .iter()
        .map(|cell| {
            json!({
                "system_h3": h3_hex(*cell), "system_name": system_name(*cell),
                "security": get_system_metadata(*cell).security_level.as_str(),
                "nodes": generate_cell_nodes(*cell).iter().map(node_json).collect::<Vec<_>>(),
            })
        })
        .collect();

    // One origin station per spot: the first station within three systems.
    let mut origins: Vec<(CellIndex, String)> = vec![];
    for spot in &spots {
        let mut stations: Vec<(CellIndex, String)> = grid_disk(*spot, 3)
            .into_iter()
            .flat_map(|s| {
                generate_cell_nodes(s)
                    .into_iter()
                    .filter(|n| n.is_station)
                    .map(move |n| (s, n.id.to_string()))
            })
            .collect();
        stations.sort();
        if let Some(first) = stations.into_iter().next() {
            if !origins.contains(&first) {
                origins.push(first);
            }
        }
    }

    let window_start = NOW_MS - NOW_MS % OFFER_WINDOW_MS;
    let mut cases: Vec<Value> = vec![];
    for (system, station) in &origins {
        let station_id = uuid::Uuid::parse_str(station).unwrap();
        // (berths, reputation, last mission, request time)
        let requests = [
            (0u32, 0i32, 0u64, NOW_MS),
            (2, 0, 0, NOW_MS),
            (2, 0, 0, window_start + OFFER_WINDOW_MS - 1),
            (4, 0, 0, NOW_MS),
            (2, 100, 0, NOW_MS),
            (2, -10, 0, NOW_MS),
            (2, 0, NOW_MS - 60_000, NOW_MS),
        ];
        for (berths, reputation, last_mission_ms, now) in requests {
            let offers =
                generate_mission_offers(*system, Some(station_id), berths, reputation, last_mission_ms, now);
            cases.push(json!({
                "origin_system_h3": h3_hex(*system), "origin_station_id": station,
                "available_berths": berths, "faction_reputation": reputation,
                "last_mission_timestamp_ms": last_mission_ms, "now_ms": now,
                "offers": offers.iter().map(offer_json).collect::<Vec<_>>(),
            }));
        }
    }

    println!(
        "{}",
        serde_json::to_string(&json!({
            "engine": { "repo": "eotha-rtse", "commit": "a116335" },
            "window_ms": OFFER_WINDOW_MS,
            "systems": systems_json,
            "cases": cases,
        }))
        .unwrap()
    );
}
