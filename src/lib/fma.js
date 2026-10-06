// Exactly rounded fused multiply-add and the double <-> BigInt plumbing it (and `crmath.js`) need.
// JavaScript has no `Math.fma`; the RTSE's float arithmetic (Rust `f64::mul_add`) does.

const view = new DataView(new ArrayBuffer(8));

/** `x` as `[mantissa, exponent]` (BigInt, int) with `x = mantissa * 2^exponent`. */
export function decompose(x) {
  view.setFloat64(0, x);
  const bits = view.getBigUint64(0);
  const biased = Number((bits >> 52n) & 0x7ffn);
  const fraction = bits & 0xfffffffffffffn;
  const negative = bits >> 63n === 1n;
  const mantissa = biased === 0 ? fraction : fraction | (1n << 52n);
  const exponent = (biased === 0 ? 1 : biased) - 1075;
  return [negative ? -mantissa : mantissa, exponent];
}

function bitLength(n) {
  return n === 0n ? 0 : n.toString(2).length;
}

/** The double nearest `mantissa * 2^exponent` (ties to even). */
export function compose(mantissa, exponent) {
  if (mantissa === 0n) return 0;
  const negative = mantissa < 0n;
  let m = negative ? -mantissa : mantissa;
  const length = bitLength(m);
  if (length > 53) {
    const shift = BigInt(length - 53);
    const remainder = m & ((1n << shift) - 1n);
    const half = 1n << (shift - 1n);
    m >>= shift;
    if (remainder > half || (remainder === half && (m & 1n) === 1n)) m += 1n;
    exponent += Number(shift);
  }
  let value = Number(m);
  // Scale in two steps so a large |exponent| cannot overflow the intermediate power of two.
  const half = Math.trunc(exponent / 2);
  value = value * 2 ** half * 2 ** (exponent - half);
  return negative ? -value : value;
}

/** `a * b + c` with a single rounding. */
export function fma(a, b, c) {
  if (!Number.isFinite(a) || !Number.isFinite(b) || !Number.isFinite(c) || a === 0 || b === 0) return a * b + c;
  const [ma, ea] = decompose(a);
  const [mb, eb] = decompose(b);
  const [mc, ec] = decompose(c);
  const product = ma * mb;
  const productExp = ea + eb;
  if (c === 0) return compose(product, productExp);
  const exp = Math.min(productExp, ec);
  const sum = (product << BigInt(productExp - exp)) + (mc << BigInt(ec - exp));
  return compose(sum, exp);
}

