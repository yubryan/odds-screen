// Odds conversions, de-vig methods, EV and Kelly. All prices are decimal.
// Port of oddscreen/odds_math.py.

export function americanToDecimal(american) {
  if (american >= 100) return 1 + american / 100;
  if (american <= -100) return 1 + 100 / -american;
  throw new Error(`invalid American odds: ${american}`);
}

export function decimalToAmerican(decimal) {
  if (decimal <= 1) throw new Error(`invalid decimal odds: ${decimal}`);
  return decimal >= 2 ? (decimal - 1) * 100 : -100 / (decimal - 1);
}

const sum = (xs) => xs.reduce((a, b) => a + b, 0);

/** Book hold expressed as total implied probability minus 1. */
export const overround = (decimals) => sum(decimals.map((d) => 1 / d)) - 1;

export function devigMultiplicative(decimals) {
  const implied = decimals.map((d) => 1 / d);
  const total = sum(implied);
  return implied.map((p) => p / total);
}

export function devigAdditive(decimals) {
  const implied = decimals.map((d) => 1 / d);
  const excess = (sum(implied) - 1) / implied.length;
  const probs = implied.map((p) => Math.max(p - excess, 1e-6));
  const total = sum(probs);
  return probs.map((p) => p / total);
}

/** Find k with sum(p_i ** k) == 1. Shades longshots more than favorites. */
export function devigPower(decimals) {
  const implied = decimals.map((d) => 1 / d);
  let lo = 0.01, hi = 20.0; // sum(p**k) is decreasing in k
  for (let i = 0; i < 200; i++) {
    const k = (lo + hi) / 2;
    if (sum(implied.map((p) => p ** k)) > 1) lo = k;
    else hi = k;
  }
  const k = (lo + hi) / 2;
  const probs = implied.map((p) => p ** k);
  const total = sum(probs);
  return probs.map((p) => p / total);
}

/** Per outcome, the lowest fair probability any method assigns (most conservative EV). */
export function devigWorstCase(decimals) {
  const per = [devigMultiplicative, devigAdditive, devigPower].map((f) => f(decimals));
  return decimals.map((_, i) => Math.min(...per.map((m) => m[i])));
}

export const DEVIG_METHODS = {
  multiplicative: devigMultiplicative,
  additive: devigAdditive,
  power: devigPower,
  worst_case: devigWorstCase,
};

export function devig(decimals, method = "power") {
  const f = DEVIG_METHODS[method];
  if (!f) throw new Error(`unknown devig method '${method}'; choose from ${Object.keys(DEVIG_METHODS).sort()}`);
  return f(decimals);
}

/** EV per unit staked. */
export const expectedValue = (prob, decimal) => prob * decimal - 1;

/** Full-Kelly bankroll fraction, floored at 0. */
export function kellyFraction(prob, decimal) {
  const b = decimal - 1;
  return Math.max((prob * b - (1 - prob)) / b, 0.0);
}

/** Money fields: round to cents (Python's round(x, 2) differs only on exact half-cents). */
export const round2 = (x) => Math.round(x * 100) / 100;
