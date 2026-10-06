// Bit-compatible port of the part of `h3o` (the Rust H3 library the RTSE uses) that turns a cell
// into the spherical coordinates of its center and vertices.
//
// `h3-js` computes the same points with a different algorithm, so its doubles differ from h3o's
// in the last digits (~1e-14 degrees), and the RTSE authenticates a mission offer by comparing the
// destination's latitude and longitude for exact equality. h3o goes cell -> FaceIJK -> hex2d ->
// n-vector -> (lat, lng) using fused multiply-adds; this reproduces that arithmetic step by step
// (`fma` below is exactly rounded, like Rust's `f64::mul_add`).
//
// Scope: non-pentagon cells of an even ("Class II") resolution, which is what systems (8) and
// nodes (12) are. Anything else, and any cell whose center sits on an icosahedron face edge (where
// h3o's choice of face is a tie only its cell index can settle), returns `null` so callers can
// leave it out rather than emit a coordinate that might differ from the engine's.
import { cellToLatLng, getResolution, isPentagon } from 'h3-js';
import { asin, atan2, sinCos } from './crmath.js';
import { fma } from './fma.js';

// ---- constants (h3o `coord/mod.rs`, `face.rs`, `coord/faceijk.rs`) ----

const EPSILON = 0.0000000000000001;
const RES0_U_GNOMONIC = 0.381966011250105;
const INV_RES0_U_GNOMONIC = 2.618033988749896;
const SQRT3_2 = 0.8660254037844386;
const RSIN60 = 1.1547005383792515;
const ONE_THIRD = 0.3333333333333333;
const TWO_PI = 2 * Math.PI;
const RAD = Math.PI / 180;
const DEG = 180 / Math.PI;

const SQRT7_POWERS = { 8: 2401.000000000001, 12: 117649.00000000007 };
const INV_SQRT7_POWERS = { 8: 0.0004164931278633901, 12: 0.000008499859752314082 };
const MAX_DIM_BY_CII_RES = { 8: 4802, 12: 235298 };
const UNIT_SCALE_BY_CII_RES = { 8: 2401, 12: 117649 };

const CENTER_POINT = [
  [0.2199307791404606, 0.6583691780274996, 0.7198475378926182],
  [-0.2139234834501421, 0.1478171829550703, 0.9656017935214205],
  [0.1092625278784797, -0.481195157287321, 0.8697775121287253],
  [0.7428567301586791, -0.3593941678278028, 0.5648005936517033],
  [0.8112534709140969, 0.3448953237639384, 0.472138773641393],
  [-0.1055498149613921, 0.9794457296411413, 0.1718874610009365],
  [-0.8075407579970092, 0.1533552485898818, 0.5695261994882688],
  [-0.2846148069787907, -0.8644080972654206, 0.4144792552473539],
  [0.7405621473854482, -0.6673299564565524, -0.0789837646326737],
  [0.8512303986474293, 0.4722343788582681, -0.2289137388687808],
  [-0.7405621473854481, 0.6673299564565524, 0.0789837646326737],
  [-0.8512303986474292, -0.4722343788582682, 0.2289137388687808],
  [0.1055498149613919, -0.9794457296411413, -0.1718874610009365],
  [0.8075407579970092, -0.1533552485898819, -0.5695261994882688],
  [0.2846148069787908, 0.8644080972654204, -0.4144792552473539],
  [-0.7428567301586791, 0.3593941678278027, -0.5648005936517033],
  [-0.811253470914097, -0.3448953237639382, -0.472138773641393],
  [-0.2199307791404607, -0.6583691780274996, -0.7198475378926182],
  [0.213923483450142, -0.1478171829550704, -0.9656017935214205],
  [-0.1092625278784796, 0.481195157287321, -0.8697775121287253]
];

const AXES_AZ_RADS_CII = [
  5.6199582685239395, 5.7603390817141875, 0.78021365439343, 0.4304693639799999, 6.130269123335111,
  2.692877706530643, 2.982963003477244, 3.532912002790141, 3.494305004259568, 3.0032141694995382,
  5.930472956509812, 0.13837848409025486, 0.4487149470591504, 0.15862965011254937, 5.891865957979238,
  2.711123289609793, 3.294508837434268, 3.80481969224544, 3.6644388790551923, 2.361378999196363
];

// Per face: the neighbor reached through the ij, ki and jk quadrants as [face, [ti, tj, tk], ccwRot60].
const NEIGHBORS = [
  [[4, [2, 0, 2], 1], [1, [2, 2, 0], 5], [5, [0, 2, 2], 3]],
  [[0, [2, 0, 2], 1], [2, [2, 2, 0], 5], [6, [0, 2, 2], 3]],
  [[1, [2, 0, 2], 1], [3, [2, 2, 0], 5], [7, [0, 2, 2], 3]],
  [[2, [2, 0, 2], 1], [4, [2, 2, 0], 5], [8, [0, 2, 2], 3]],
  [[3, [2, 0, 2], 1], [0, [2, 2, 0], 5], [9, [0, 2, 2], 3]],
  [[10, [2, 2, 0], 3], [14, [2, 0, 2], 3], [0, [0, 2, 2], 3]],
  [[11, [2, 2, 0], 3], [10, [2, 0, 2], 3], [1, [0, 2, 2], 3]],
  [[12, [2, 2, 0], 3], [11, [2, 0, 2], 3], [2, [0, 2, 2], 3]],
  [[13, [2, 2, 0], 3], [12, [2, 0, 2], 3], [3, [0, 2, 2], 3]],
  [[14, [2, 2, 0], 3], [13, [2, 0, 2], 3], [4, [0, 2, 2], 3]],
  [[5, [2, 2, 0], 3], [6, [2, 0, 2], 3], [15, [0, 2, 2], 3]],
  [[6, [2, 2, 0], 3], [7, [2, 0, 2], 3], [16, [0, 2, 2], 3]],
  [[7, [2, 2, 0], 3], [8, [2, 0, 2], 3], [17, [0, 2, 2], 3]],
  [[8, [2, 2, 0], 3], [9, [2, 0, 2], 3], [18, [0, 2, 2], 3]],
  [[9, [2, 2, 0], 3], [5, [2, 0, 2], 3], [19, [0, 2, 2], 3]],
  [[16, [2, 0, 2], 1], [19, [2, 2, 0], 5], [10, [0, 2, 2], 3]],
  [[17, [2, 0, 2], 1], [15, [2, 2, 0], 5], [11, [0, 2, 2], 3]],
  [[18, [2, 0, 2], 1], [16, [2, 2, 0], 5], [12, [0, 2, 2], 3]],
  [[19, [2, 0, 2], 1], [17, [2, 2, 0], 5], [13, [0, 2, 2], 3]],
  [[15, [2, 0, 2], 1], [18, [2, 2, 0], 5], [14, [0, 2, 2], 3]]
];
const IJ = 0;
const KI = 1;
const JK = 2;

// ---- IJK coordinates ----

const ijkNormalize = ([i, j, k]) => {
  const min = Math.min(i, j, k);
  return [i - min, j - min, k - min];
};
const ijkAdd = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const ijkScale = (a, n) => [a[0] * n, a[1] * n, a[2] * n];

function downAperture3(coord, ccw) {
  const [iVec, jVec, kVec] = ccw ? [[2, 0, 1], [1, 2, 0], [0, 1, 2]] : [[2, 1, 0], [0, 2, 1], [1, 0, 2]];
  return ijkNormalize(ijkAdd(ijkAdd(ijkScale(iVec, coord[0]), ijkScale(jVec, coord[1])), ijkScale(kVec, coord[2])));
}

function rotate60(coord, ccw) {
  const [iVec, jVec, kVec] = ccw ? [[1, 1, 0], [0, 1, 1], [1, 0, 1]] : [[1, 0, 1], [1, 1, 0], [0, 1, 1]];
  return ijkNormalize(ijkAdd(ijkAdd(ijkScale(iVec, coord[0]), ijkScale(jVec, coord[1])), ijkScale(kVec, coord[2])));
}

/** hex2d point of an ijk coordinate. */
function ijkToVec2d([i, j, k]) {
  const a = i - k;
  const b = j - k;
  return [fma(0.5, -b, a), b * SQRT3_2];
}

/** The ijk of the hex containing a hex2d point (h3o `From<Vec2d> for CoordIJK`). */
function vec2dToIjk([x, y]) {
  const a1 = Math.abs(x);
  const a2 = Math.abs(y);
  const x2 = a2 * RSIN60;
  const x1 = a1 + x2 / 2;
  const m1 = Math.trunc(x1);
  const m2 = Math.trunc(x2);
  const r1 = x1 - m1;
  const r2 = x2 - m2;
  let i;
  let j;
  if (r1 < 0.5) {
    if (r1 < 1 / 3) {
      i = m1;
      j = m2 + (r2 >= (1 + r1) / 2 ? 1 : 0);
    } else {
      i = m1 + (1 - r1 <= r2 && r2 < 2 * r1 ? 1 : 0);
      j = m2 + (r2 >= 1 - r1 ? 1 : 0);
    }
  } else if (r1 < 2 / 3) {
    j = m2 + (r2 >= 1 - r1 ? 1 : 0);
    i = m1 + (fma(2, r1, -1) >= r2 || r2 >= 1 - r1 ? 1 : 0);
  } else {
    i = m1 + 1;
    j = m2 + (r2 >= r1 / 2 ? 1 : 0);
  }
  if (x < 0) {
    const offset = j % 2;
    const axisI = Math.floor((j + offset) / 2);
    const diff = i - axisI;
    i -= 2 * diff + offset;
  }
  if (y < 0) {
    i -= Math.trunc((2 * j + 1) / 2);
    j = -j;
  }
  return ijkNormalize([i, j, 0]);
}

// ---- 3D vectors (n-vectors), every product fused as in h3o `coord/vec3d.rs` ----

const dot = (a, b) => fma(a[0], b[0], fma(a[1], b[1], a[2] * b[2]));
const cross = (a, b) => [
  fma(a[1], b[2], -(a[2] * b[1])),
  fma(a[2], b[0], -(a[0] * b[2])),
  fma(a[0], b[1], -(a[1] * b[0]))
];
const linearCombination = (a, v1, b, v2) => [
  fma(a, v1[0], b * v2[0]),
  fma(a, v1[1], b * v2[1]),
  fma(a, v1[2], b * v2[2])
];

function normalize(v) {
  const norm = Math.sqrt(dot(v, v));
  if (norm > 0) {
    const scale = 1 / norm;
    return [v[0] * scale, v[1] * scale, v[2] * scale];
  }
  return [0, 0, 0];
}

const NORTH_POLE = [0, 0, 1];

function tangentBasis(v) {
  const north = normalize(linearCombination(1, NORTH_POLE, -dot(NORTH_POLE, v), v));
  return [north, cross(north, v)];
}

function azimuth(from, to) {
  const [north, east] = tangentBasis(from);
  const projected = normalize(linearCombination(1, to, -dot(to, from), from));
  return Math.atan2(dot(projected, east), dot(projected, north));
}

const toPositiveAngle = (angle) => (angle < 0 ? angle + TWO_PI : angle >= TWO_PI ? angle - TWO_PI : angle);

/** n-vector of a hex2d point on `face` (h3o `Vec3d::from_vec2d`, Class II only). */
function vec3dFromVec2d([x, y], face, resolution, isSubstrate) {
  const r = Math.sqrt(fma(x, x, y * y));
  if (r < EPSILON) return CENTER_POINT[face];
  let scale = INV_SQRT7_POWERS[resolution];
  if (isSubstrate) scale *= ONE_THIRD;
  const q = r * scale * RES0_U_GNOMONIC;
  if (q < EPSILON) return CENTER_POINT[face];
  const invHyp = 1 / Math.sqrt(fma(q, q, 1));
  const cosR = invHyp;
  const sinR = q * invHyp;
  const theta = toPositiveAngle(AXES_AZ_RADS_CII[face] - atan2(y, x));
  const center = CENTER_POINT[face];
  const [north, east] = tangentBasis(center);
  const [sinT, cosT] = sinCos(theta);
  const dir = linearCombination(cosT, north, sinT, east);
  return normalize(linearCombination(cosR, center, sinR, dir));
}

const vec3dToLatLngDegrees = (v) => [asin(v[2]) * DEG, atan2(v[1], v[0]) * DEG];

function vec3dFromLatLng(latDegrees, lngDegrees) {
  const lat = latDegrees * RAD;
  const lng = lngDegrees * RAD;
  return [Math.cos(lng) * Math.cos(lat), Math.sin(lng) * Math.cos(lat), Math.sin(lat)];
}

/** The face whose center is nearest `point`, or `null` when two faces are (nearly) equidistant. */
function closestFace(point) {
  let best = -1;
  let bestDistance = Infinity;
  let secondDistance = Infinity;
  CENTER_POINT.forEach((center, face) => {
    const d = linearCombination(1, point, -1, center);
    const distance = dot(d, d);
    if (distance < bestDistance) {
      secondDistance = bestDistance;
      bestDistance = distance;
      best = face;
    } else if (distance < secondDistance) {
      secondDistance = distance;
    }
  });
  return secondDistance - bestDistance < 1e-9 ? null : { face: best, distance: bestDistance };
}

/** The FaceIJK of the cell whose center is (approximately) `center`: `{ face, coord }`. */
function faceIjkAt(center, resolution) {
  const point = vec3dFromLatLng(center[0], center[1]);
  const nearest = closestFace(point);
  if (!nearest) return null;
  const { face, distance } = nearest;
  const r = Math.acos(fma(distance, -0.5, 1));
  if (r < EPSILON) return { face, coord: [0, 0, 0] };
  const scaledR = Math.tan(r) * INV_RES0_U_GNOMONIC * SQRT7_POWERS[resolution];
  const theta = AXES_AZ_RADS_CII[face] - azimuth(CENTER_POINT[face], point);
  return { face, coord: vec2dToIjk([scaledR * Math.cos(theta), scaledR * Math.sin(theta)]) };
}

/** Moves a substrate-grid vertex onto the face it lies on (h3o `adjust_overage_class2::<true>`). */
function adjustSubstrateOverage(fijk, resolution) {
  const maxDim = MAX_DIM_BY_CII_RES[resolution] * 3;
  const [i, j, k] = fijk.coord;
  // On the face edge (equal) or inside it (less): the vertex stays on this face.
  if (i + j + k <= maxDim) return;
  const quadrant = k > 0 ? (j > 0 ? JK : KI) : IJ;
  const [face, translate, ccwRot] = NEIGHBORS[fijk.face][quadrant];
  let coord = fijk.coord;
  for (let n = 0; n < ccwRot; n++) coord = rotate60(coord, true);
  coord = ijkNormalize(ijkAdd(coord, ijkScale(translate, UNIT_SCALE_BY_CII_RES[resolution] * 3)));
  fijk.face = face;
  fijk.coord = coord;
}

const VERTS_CII = [[2, 1, 0], [1, 2, 0], [0, 2, 1], [0, 1, 2], [1, 0, 2], [2, 0, 1]];

/**
 * The center of `cell`, and its vertex number `vertexIndex` (0-5) when one is asked for, as
 * `[lat, lng]` degrees bit-identical to h3o's `LatLng::from(cell)` and `cell.boundary()[i]`:
 * `{ center, vertex }`, or `null` when this port does not cover the cell.
 */
export function cellGeometry(cell, vertexIndex = null) {
  const resolution = getResolution(cell);
  if (!(resolution in MAX_DIM_BY_CII_RES) || isPentagon(cell)) return null;
  const fijk = faceIjkAt(cellToLatLng(cell), resolution);
  if (!fijk) return null;

  const center = vec3dToLatLngDegrees(vec3dFromVec2d(ijkToVec2d(fijk.coord), fijk.face, resolution, false));
  if (vertexIndex === null) return { center, vertex: null };

  // The center in the aperture 33r substrate grid, then the vertex's offset from it.
  const substrate = downAperture3(downAperture3(fijk.coord, true), false);
  const vertex = { face: fijk.face, coord: ijkNormalize(ijkAdd(substrate, VERTS_CII[vertexIndex])) };
  adjustSubstrateOverage(vertex, resolution);
  const point = vec3dFromVec2d(ijkToVec2d(vertex.coord), vertex.face, resolution, true);
  return { center, vertex: vec3dToLatLngDegrees(point) };
}
