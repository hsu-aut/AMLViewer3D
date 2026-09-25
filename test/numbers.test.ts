import { countTokens, parseFloatList, parseIntList } from '../src/collada/numbers';

const f32 = (v: number) => Math.fround(v);

describe('parseFloatList', () => {
  it('reads the forms found in COLLADA files like parseFloat does', () => {
    const tokens = ['0', '-0', '1', '-1.5', '4.72937e-011', '1.2e-005', '-2555', '445', '0.707107', '-7.09223e-007', '.5', '5.', '+3', '1E3', '1e+2', '123456789.123456789', '-0.000274658'];
    const got = Array.from(parseFloatList(`  ${tokens.join(' \n\t')}  `));
    expect(got).toEqual(tokens.map(t => f32(parseFloat(t))));
  });

  it('matches parseFloat on random numbers to float precision', () => {
    let seed = 12345;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    const tokens = Array.from({ length: 20000 }, () => {
      const v = (rnd() - 0.5) * 10 ** Math.floor(rnd() * 12 - 6);
      return rnd() < 0.5 ? v.toString() : v.toExponential(Math.floor(rnd() * 10));
    });
    const got = parseFloatList(tokens.join(' '));
    tokens.forEach((t, i) => expect(got[i]).toBe(f32(parseFloat(t))));
  });

  it('reads the XML Schema infinities and leaves other tokens to parseFloat', () => {
    const got = Array.from(parseFloatList('NaN INF -INF +INF 1.5x'));
    expect(got[0]).toBeNaN();
    expect(got.slice(1, 4)).toEqual([Infinity, -Infinity, Infinity]);
    expect(got[4]).toBe(1.5);
  });

  it('returns an empty array for empty text', () => {
    expect(parseFloatList('  \n ')).toHaveLength(0);
  });
});

describe('parseIntList', () => {
  it('reads index lists', () => {
    expect(Array.from(parseIntList(' 0 12\n345\t-6 +7 '))).toEqual([0, 12, 345, -6, 7]);
  });
});

describe('countTokens', () => {
  it('counts whitespace-separated tokens', () => {
    expect(countTokens('')).toBe(0);
    expect(countTokens(' a  b\n c ')).toBe(3);
  });
});
