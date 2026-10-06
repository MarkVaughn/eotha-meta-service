// Port of the RTSE's procedural content (eotha-rtse `simulation/spatial/procedural.rs`,
// `simulation/naming.rs` and the grid helpers they use). Mission offers name real stations and
// resource nodes, and the RTSE re-derives them from the H3 index alone to authenticate an
// offer, so every function here is a pure function of the cell and must agree with the engine
// bit for bit. `tests/fixtures/rtse-mission-vectors.json` pins that agreement to values the
// engine itself produced.
import { createHash } from 'node:crypto';
import { cellToCenterChild, cellToParent, getResolution, gridDisk, gridDistance, latLngToCell } from 'h3-js';
import { withMargin } from './crmath.js';
import { cellGeometry } from './h3geo.js';

export const SYSTEM_RESOLUTION = 8;
export const NODE_RESOLUTION = 12;
export const STATION_TYPE = 'STATION';

const sha256 = (...parts) => {
  const hash = createHash('sha256');
  for (const part of parts) hash.update(part);
  return hash.digest();
};

/** The big-endian u64 of an H3 index given as its hex string. */
export function cellBytes(h3) {
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64BE(BigInt(`0x${h3}`));
  return bytes;
}

export function u64Bytes(value) {
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64BE(BigInt(value));
  return bytes;
}

/** A v4-shaped UUID from the first 16 bytes of `digest` (uuid `Builder::from_random_bytes`). */
export function uuidFromDigest(digest) {
  const bytes = Buffer.from(digest.subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// h3o's LatLng stores radians and reports degrees back through them, which can move a
// coordinate by an ulp; the engine compares offered coordinates for exact equality.
const toRadians = (degrees) => degrees * (Math.PI / 180);
const toDegrees = (radians) => radians * (180 / Math.PI);
const throughRadians = (degrees) => toDegrees(toRadians(degrees));

// Rust's `(lng + 180.0).rem_euclid(360.0) - 180.0`, with the antimeridian reported as +180.
function wrapLng(lng) {
  let remainder = (lng + 180) % 360;
  if (remainder < 0) remainder += 360;
  const wrapped = remainder - 180;
  return wrapped === -180 ? 180 : wrapped;
}

/**
 * The 1-3 resource nodes and stations living in system `cell`:
 * `{ id, systemCell, slot, isStation, entityType, grade }`. Grade (1-5 for a resource node, 0 for
 * a station) is `SHA256(id || cell)[0] % 5 + 1`, as in the RTSE. Where a node sits is
 * `nodeGeometry`'s business; none of this needs it.
 */
export function generateCellNodes(cell) {
  const index = cellBytes(cell);
  const count = 1 + (sha256('count', index)[0] % 3);
  const nodes = [];
  for (let slot = 0; slot < count; slot++) {
    const d = sha256('node', index, Buffer.from([slot]));
    const kind = d[0] % 8;
    const isStation = kind === 0;
    const id = uuidFromDigest(d.subarray(16));
    nodes.push({
      id,
      systemCell: cell,
      slot,
      isStation,
      entityType: isStation ? STATION_TYPE : kind <= 4 ? 'FERRITE' : 'TITANIUM',
      grade: isStation ? 0 : (sha256(Buffer.from(id.replaceAll('-', ''), 'hex'), index)[0] % 5) + 1,
      vertexSeed: d[1],
      fraction: 0.2 + 0.6 * (d[2] / 255)
    });
  }
  return nodes;
}

// h3o's own libm and a correctly rounded one can disagree on the last bit of a result whose exact
// value is within about 0.019 ulp of a rounding tie (the worst of 300 000 random arguments of each
// function, against glibc 2.39). Positions computed from a value closer than this limit, which
// leaves a safety factor of two, are not trusted.
export const MIN_ROUNDING_MARGIN = 0.04;

const geometryCache = new Map();
const GEOMETRY_CACHE_SIZE = 4096;

/**
 * Where a node sits: `{ lat, lng, nodeCell, margin }` exactly as the RTSE computes them (its
 * `anchor_in_cell`: 20-80% of the way from the system's center towards one of its vertices), or
 * `null` when the node's position cannot be reproduced bit for bit (a pentagon system, or one
 * whose center lies on an icosahedron face edge). `margin` is the rounding margin of the
 * transcendental functions behind the position (see `MIN_ROUNDING_MARGIN`).
 */
export function nodeGeometry(node) {
  const key = `${node.systemCell}:${node.slot}`;
  if (geometryCache.has(key)) return geometryCache.get(key);
  const geometry = computeGeometry(node.systemCell, node.vertexSeed, node.fraction);
  if (geometryCache.size >= GEOMETRY_CACHE_SIZE) geometryCache.delete(geometryCache.keys().next().value);
  geometryCache.set(key, geometry);
  return geometry;
}

function computeGeometry(cell, vertexSeed, fraction) {
  const resolution = getResolution(cell);
  const [geometry, margin] = withMargin(() => cellGeometry(cell, vertexSeed % 6));
  if (!geometry) return null;
  const [centerLat, centerLng] = geometry.center;
  const [vertexLat, vertexLng] = geometry.vertex;

  let dLng = vertexLng - centerLng;
  if (dLng > 180) dLng -= 360;
  else if (dLng < -180) dLng += 360;
  const lat = centerLat + fraction * (vertexLat - centerLat);
  const lng = centerLng + fraction * dLng;

  // The straight-line walk can leave the cell near the antimeridian; fall back to the center so
  // an anchor always stays inside. h3o's LatLng keeps radians, so its degrees went through them.
  let point = null;
  try {
    if (latLngToCell(lat, lng, resolution) === cell) point = [throughRadians(lat), throughRadians(lng)];
  } catch {
    point = null;
  }
  point ??= [throughRadians(centerLat), throughRadians(centerLng)];

  const nodeCell = latLngToCell(point[0], point[1], NODE_RESOLUTION);
  if (cellToParent(nodeCell, resolution) === cell) {
    return { lat: point[0], lng: wrapLng(point[1]), nodeCell, margin };
  }
  // A point right at a system's edge can land in a node of the neighboring system: snap to the
  // system's center child instead.
  const child = cellToCenterChild(cell, NODE_RESOLUTION);
  const [childGeometry, childMargin] = withMargin(() => cellGeometry(child));
  if (!childGeometry) return null;
  return {
    lat: throughRadians(childGeometry.center[0]),
    lng: wrapLng(throughRadians(childGeometry.center[1])),
    nodeCell: child,
    margin: Math.min(margin, childMargin)
  };
}

/** Systems 1..`radius` rings from `system` with their grid distance (the engine drops cells whose distance H3 cannot compute). */
export function systemsWithin(system, radius) {
  const found = [];
  for (const cell of gridDisk(system, radius)) {
    let distance;
    try { distance = gridDistance(system, cell); } catch { continue; }
    if (distance >= 1 && distance <= radius) found.push({ cell, distance });
  }
  return found;
}

// ---- naming (eotha-rtse `simulation/naming.rs`) ----

const ALPHABET = [
  'Cyngon', 'Phi', 'Mynar', 'Hoon', 'Raan', 'Drux', 'Xi', 'Delta', 'Shef', 'Psi', 'Pi',
  'Upsilon', 'Sigma', 'Zuul', 'Fluv', 'Wyzzy', 'Orxon', 'Trion', 'Eta', 'Qix', 'Omega', 'Ildix',
  'Pultron', 'Yekton', 'Iota', 'Jotan', 'Vintu', 'Beta', 'Xoop', 'Kex', 'Epsilon', 'Theta',
  'Gamma', 'Gurdon', 'Epzon', 'Alpha', 'Frynn', 'Zeta', 'Rho', 'Kappa', 'Omicron', 'Lambda',
  'Nu', 'Chi', 'Mu', 'Tau'
];
const SECTOR_SEED = 4;

function coordToGreek(x, y, seed) {
  let number = x * 1000 + y;
  const shift = seed % ALPHABET.length;
  const rotated = [...ALPHABET.slice(shift), ...ALPHABET.slice(0, shift)];
  if (number === 0) return rotated[0];
  let encoded = '';
  while (number > 0) {
    encoded = rotated[number % ALPHABET.length] + encoded;
    number = Math.floor(number / ALPHABET.length);
  }
  return encoded;
}

const cellDigest = (salt, cell) => sha256(salt, cellBytes(cell));

/** A system's name: its Resolution 8 cell digest folded onto the greek alphabet. */
export function systemName(systemCell) {
  const n = cellDigest('sector', systemCell).readUInt32BE(0);
  return coordToGreek(n % 1000, Math.floor(n / 1000) % 1000, SECTOR_SEED);
}

/** A node's name: its cell digest as padded URL-safe base64. */
export function nodeName(nodeCell) {
  return `${cellDigest('sector', nodeCell).toString('base64url')}=`;
}

/** `HIGH`, `LOW` or `NULL`: the security level of a system. */
export function securityLevel(systemCell) {
  const roll = cellDigest('metadata', systemCell)[3] % 10;
  return roll <= 3 ? 'HIGH' : roll <= 7 ? 'LOW' : 'NULL';
}
