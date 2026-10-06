// Correctly rounded sin, cos, asin and atan2.
//
// The RTSE (Rust, glibc's libm) and V8's `Math.*` disagree on the last bit of these functions for
// a few percent of inputs (atan2: about one in five), which is enough to move a computed
// coordinate by an ulp and make the engine's exact-equality check of an offer's destination fail.
// glibc's results are correctly rounded in all but a small share of cases (measured against glibc
// 2.39: 0.05-0.17% of random arguments, always a value within 0.013 ulp of a rounding tie), so
// rounding the true value, computed here in 200-bit fixed point, reproduces them far more often.
// `withMargin` reports how close to a tie the calls made were, so callers can distrust those
// results (see `procedural.js`).
import { compose, decompose } from './fma.js';

const P = 200n; // fractional bits
const ONE = 1n << P;

// ---- fixed-point helpers ----

/** A finite double as a P-bit fixed-point BigInt (exact for |x| >= 2^-147). */
function fix(x) {
  const [m, e] = decompose(x);
  const shift = BigInt(e) + P;
  return shift >= 0n ? m << shift : m >> -shift;
}

/** The double nearest a P-bit fixed-point value. */
const unfix = (v) => compose(v, -Number(P));

/**
 * How far (in ulps, 0 to 0.5) the true value `v` lies from the nearest rounding boundary between
 * two doubles, given its correctly rounded double `r`: near 0 the value is almost a tie, and an
 * implementation that is merely accurate to within a hair over half an ulp may round it the
 * other way.
 */
function roundingMargin(v, r) {
  if (r === 0 || !Number.isFinite(r)) return 0;
  const [, exponent] = decompose(r);
  const ulp = 1n << (BigInt(exponent) + P); // fixed-point size of one ulp of r (r >= 2^-147)
  if (ulp === 0n) return 0;
  const distance = v - fix(r);
  const offset = (distance < 0n ? -distance : distance) * 1_000_000n / ulp; // millionths of an ulp
  return 0.5 - Number(offset) / 1e6;
}

const mul = (a, b) => (a * b) >> P;

function isqrt(n) {
  if (n < 2n) return n;
  let x = 1n << BigInt((n.toString(2).length + 1) >> 1);
  for (;;) {
    const y = (x + n / x) >> 1n;
    if (y >= x) return x;
    x = y;
  }
}

/** arctan(1/n) in fixed point (Machin series). */
function arctanInverse(n) {
  const nn = BigInt(n) * BigInt(n);
  let power = ONE / BigInt(n);
  let sum = power;
  for (let k = 1n; power !== 0n; k++) {
    power /= nn;
    const term = power / (2n * k + 1n);
    sum += k % 2n === 1n ? -term : term;
  }
  return sum;
}

const PI = 16n * arctanInverse(5) - 4n * arctanInverse(239);
const HALF_PI = PI >> 1n;
const QUARTER_PI = PI >> 2n;

/** sin and cos of a fixed-point |r| <= pi/4 by Taylor series. */
function sinCosSmall(r) {
  const r2 = mul(r, r);
  let sin = r;
  let cos = ONE;
  let termSin = r;
  let termCos = ONE;
  for (let n = 1n; termSin !== 0n || termCos !== 0n; n++) {
    termCos = -mul(termCos, r2) / ((2n * n - 1n) * (2n * n));
    termSin = -mul(termSin, r2) / ((2n * n) * (2n * n + 1n));
    cos += termCos;
    sin += termSin;
  }
  return [sin, cos];
}

function sinCosFixed(x) {
  const shifted = x + QUARTER_PI;
  const quadrants = shifted / HALF_PI - (shifted < 0n && shifted % HALF_PI !== 0n ? 1n : 0n);
  const [sin, cos] = sinCosSmall(x - quadrants * HALF_PI);
  switch (((quadrants % 4n) + 4n) % 4n) {
    case 0n: return [sin, cos];
    case 1n: return [cos, -sin];
    case 2n: return [-sin, -cos];
    default: return [-cos, sin];
  }
}

/** arctan of a fixed-point value, in fixed point. */
function atanFixed(t) {
  if (t < 0n) return -atanFixed(-t);
  if (t > ONE) return HALF_PI - atanFixed((ONE * ONE) / t);
  // Halve the angle three times: atan(t) = 2 atan(t / (1 + sqrt(1 + t^2))).
  let x = t;
  for (let i = 0; i < 3; i++) x = (x << P) / (ONE + isqrt(ONE * ONE + x * x));
  const x2 = mul(x, x);
  let sum = x;
  let power = x;
  for (let k = 1n; power !== 0n; k++) {
    power = mul(power, x2);
    const term = power / (2n * k + 1n);
    sum += k % 2n === 1n ? -term : term;
  }
  return sum << 3n;
}

// ---- correctly rounded functions ----

let smallestMargin = 0.5;

/** Rounds a fixed-point value to a double and records how close it was to a rounding tie. */
function round(v) {
  const r = unfix(v);
  smallestMargin = Math.min(smallestMargin, roundingMargin(v, r));
  return r;
}

/**
 * Runs `fn` and returns `[result, margin]`: the smallest rounding margin (see `roundingMargin`)
 * among the correctly rounded calls it made, 0.5 when it made none.
 */
export function withMargin(fn) {
  const saved = smallestMargin;
  smallestMargin = 0.5;
  try {
    const result = fn();
    return [result, smallestMargin];
  } finally {
    smallestMargin = Math.min(saved, smallestMargin);
  }
}

export function sinCos(x) {
  if (!Number.isFinite(x) || Math.abs(x) < 2 ** -30) return [Math.sin(x), Math.cos(x)];
  const [sin, cos] = sinCosFixed(fix(x));
  return [round(sin), round(cos)];
}

export function atan2(y, x) {
  if (!Number.isFinite(x) || !Number.isFinite(y) || x === 0 || y === 0) return Math.atan2(y, x);
  const [my, ey] = decompose(Math.abs(y));
  const [mx, ex] = decompose(Math.abs(x));
  // t = |y| / |x| in fixed point; a ratio this small or large leaves the fixed point too few digits
  // (and arctan is within an ulp of the ratio or of pi/2 anyway).
  const shift = BigInt(ey - ex) + P;
  if (shift < 100n) return x > 0 ? y / x : Math.atan2(y, x);
  if (shift > 3n * P) return Math.atan2(y, x);
  const t = shift >= 0n ? (my << shift) / mx : my / (mx << -shift);
  let angle = atanFixed(t);
  if (x < 0) angle = PI - angle;
  return round(y < 0 ? -angle : angle);
}

export function asin(z) {
  if (!Number.isFinite(z) || Math.abs(z) > 1) return Math.asin(z);
  if (Math.abs(z) < 2 ** -30) return z;
  const zf = fix(z);
  const negative = zf < 0n;
  const a = negative ? -zf : zf;
  const root = isqrt(ONE * ONE - a * a);
  const angle = root === 0n ? HALF_PI : atanFixed((a << P) / root);
  return round(negative ? -angle : angle);
}

