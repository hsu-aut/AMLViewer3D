// Fast parsing of the whitespace-separated number lists that make up most of a COLLADA
// file (<float_array>, <p>, <vcount>). three.js splits them into JavaScript arrays of
// numbers; reading the characters directly into typed arrays is several times faster and
// needs a fraction of the memory.

// Powers of ten that are exact doubles.
const POW10 = [1, 1e1, 1e2, 1e3, 1e4, 1e5, 1e6, 1e7, 1e8, 1e9, 1e10, 1e11, 1e12, 1e13, 1e14, 1e15, 1e16, 1e17, 1e18, 1e19, 1e20, 1e21, 1e22];

const scale = (value: number, exp: number) => (exp >= 0 ? value * POW10[exp] : value / POW10[-exp]);

const isSpace = (c: number) => c === 32 || c === 10 || c === 13 || c === 9;

/** Number of whitespace-separated tokens in `text`. */
export function countTokens(text: string): number {
  let n = 0, inToken = false;
  for (let i = 0; i < text.length; i++) {
    const space = isSpace(text.charCodeAt(i));
    if (!space && !inToken) n++;
    inToken = !space;
  }
  return n;
}

/**
 * Reads decimal numbers such as `-4.72937e-011`, `.5`, `+3`, `1E3`, and the XML Schema
 * values `INF` and `-INF`. Other tokens (`NaN`, anything else) go through parseFloat.
 *
 * The result equals Math.fround(parseFloat(token)) for every token: with at most 15
 * significant digits and a power of ten up to 22, mantissa and power are exact doubles and
 * one division or multiplication rounds correctly (Clinger's fast path). Longer tokens go
 * through parseFloat, because rounding twice could land on the other side of a float32
 * rounding boundary.
 */
export function parseFloatList(text: string): Float32Array {
  const out = new Float32Array(countTokens(text));
  let n = 0, i = 0;
  const len = text.length;
  while (i < len) {
    while (i < len && isSpace(text.charCodeAt(i))) i++;
    if (i >= len) break;
    const start = i;
    let c = text.charCodeAt(i);
    let negative = false;
    if (c === 45 || c === 43) { negative = c === 45; c = text.charCodeAt(++i); }
    let mantissa = 0, exp = 0, digits = 0, significant = 0, ok = true;
    while (c >= 48 && c <= 57) {
      mantissa = mantissa * 10 + (c - 48);
      if (mantissa !== 0) significant++;
      digits++; c = text.charCodeAt(++i);
    }
    if (c === 46) {
      c = text.charCodeAt(++i);
      while (c >= 48 && c <= 57) {
        mantissa = mantissa * 10 + (c - 48);
        if (mantissa !== 0) significant++;
        exp--; digits++; c = text.charCodeAt(++i);
      }
    }
    if (digits === 0 || significant > 15) ok = false;
    if (ok && (c === 101 || c === 69)) {
      c = text.charCodeAt(++i);
      let expNegative = false, e = 0, expDigits = 0;
      if (c === 45 || c === 43) { expNegative = c === 45; c = text.charCodeAt(++i); }
      while (c >= 48 && c <= 57) { e = e * 10 + (c - 48); expDigits++; c = text.charCodeAt(++i); }
      if (expDigits === 0) ok = false;
      exp += expNegative ? -e : e;
    }
    if (exp > 22 || exp < -22) ok = false;
    if (ok && i < len && !isSpace(c)) ok = false;
    if (ok) {
      const v = scale(mantissa, exp);
      out[n++] = negative ? -v : v;
    } else {
      while (i < len && !isSpace(text.charCodeAt(i))) i++;
      const t = text.slice(start, i);
      out[n++] = t === 'INF' || t === '+INF' ? Infinity : t === '-INF' ? -Infinity : parseFloat(t);
    }
  }
  return out;
}

/** Reads integers, as in <p> and <vcount>. */
export function parseIntList(text: string): Int32Array {
  const out = new Int32Array(countTokens(text));
  let n = 0, i = 0;
  const len = text.length;
  while (i < len) {
    while (i < len && isSpace(text.charCodeAt(i))) i++;
    if (i >= len) break;
    let c = text.charCodeAt(i);
    let negative = false;
    if (c === 45 || c === 43) { negative = c === 45; c = text.charCodeAt(++i); }
    let v = 0;
    while (c >= 48 && c <= 57) { v = v * 10 + (c - 48); c = text.charCodeAt(++i); }
    while (i < len && !isSpace(text.charCodeAt(i))) i++;   // ignore anything else in the token
    out[n++] = negative ? -v : v;
  }
  return out;
}
