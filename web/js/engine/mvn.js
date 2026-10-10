// Normal distribution helpers and the multivariate normal CDF used by the
// same-game parlay copula (replaces scipy.stats.norm / multivariate_normal).

const LOG_SQRT_2PI = 0.91893853320467274178;

/** Standard normal CDF (Marsaglia 2004 series), ~1e-15 absolute for |x| <= 8. */
export function normCdf(x) {
  if (x < -8) return 0;
  if (x > 8) return 1;
  let s = x, t = 0, b = x;
  const q = x * x;
  for (let i = 1; s !== t; ) { t = s; i += 2; b *= q / i; s = t + b; }
  return 0.5 + s * Math.exp(-0.5 * q - LOG_SQRT_2PI);
}

export const normPdf = (x) => Math.exp(-0.5 * x * x - LOG_SQRT_2PI);

/** Inverse standard normal CDF: Acklam's approximation + one Halley refinement. */
export function normPpf(p) {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.383577518672690e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const plow = 0.02425;
  let x;
  if (p < plow) {
    const q = Math.sqrt(-2 * Math.log(p));
    x = (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  } else if (p <= 1 - plow) {
    const q = p - 0.5, r = q * q;
    x = (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  } else {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    x = -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  const e = normCdf(x) - p; // Halley step
  const u = e * Math.sqrt(2 * Math.PI) * Math.exp(x * x / 2);
  return x - u / (1 + x * u / 2);
}

// 20-point Gauss-Legendre nodes/weights on [-1, 1]
const GL_X = [-0.9931285991850949, -0.9639719272779138, -0.912234428251326, -0.8391169718222188, -0.7463319064601508,
  -0.636053680726515, -0.5108670019508271, -0.37370608871541955, -0.2277858511416451, -0.07652652113349734,
  0.07652652113349734, 0.2277858511416451, 0.37370608871541955, 0.5108670019508271, 0.636053680726515,
  0.7463319064601508, 0.8391169718222188, 0.912234428251326, 0.9639719272779138, 0.9931285991850949];
const GL_W = [0.017614007139152118, 0.04060142980038694, 0.06267204833410907, 0.08327674157670475, 0.10193011981724044,
  0.11819453196151841, 0.13168863844917664, 0.14209610931838204, 0.14917298647260374, 0.15275338713072584,
  0.15275338713072584, 0.14917298647260374, 0.14209610931838204, 0.13168863844917664, 0.11819453196151841,
  0.10193011981724044, 0.08327674157670475, 0.06267204833410907, 0.04060142980038694, 0.017614007139152118];

/** P(Z1 <= a, Z2 <= b) with correlation rho:
 * Phi(a)Phi(b) + integral_0^rho phi2(a, b; r) dr, by Gauss-Legendre. */
export function bivariateNormalCdf(a, b, rho) {
  let integral = 0;
  const half = rho / 2;
  for (let i = 0; i < GL_X.length; i++) {
    const r = half * (GL_X[i] + 1);
    const om = 1 - r * r;
    integral += GL_W[i] * Math.exp(-(a * a - 2 * r * a * b + b * b) / (2 * om)) / (2 * Math.PI * Math.sqrt(om));
  }
  return normCdf(a) * normCdf(b) + half * integral;
}

/** Eigen-decomposition of a small symmetric matrix (cyclic Jacobi). Returns {values, vectors (columns)}. */
export function symmetricEigen(m) {
  const n = m.length;
  const a = m.map((row) => [...row]);
  const v = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)));
  for (let sweep = 0; sweep < 100; sweep++) {
    let off = 0;
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) off += a[i][j] * a[i][j];
    if (off < 1e-30) break;
    for (let p = 0; p < n; p++) {
      for (let q = p + 1; q < n; q++) {
        if (Math.abs(a[p][q]) < 1e-300) continue;
        const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1), s = t * c;
        for (let k = 0; k < n; k++) {
          const akp = a[k][p], akq = a[k][q];
          a[k][p] = c * akp - s * akq;
          a[k][q] = s * akp + c * akq;
        }
        for (let k = 0; k < n; k++) {
          const apk = a[p][k], aqk = a[q][k];
          a[p][k] = c * apk - s * aqk;
          a[q][k] = s * apk + c * aqk;
        }
        for (let k = 0; k < n; k++) {
          const vkp = v[k][p], vkq = v[k][q];
          v[k][p] = c * vkp - s * vkq;
          v[k][q] = s * vkp + c * vkq;
        }
      }
    }
  }
  return { values: a.map((row, i) => row[i]), vectors: v };
}

/** Clip negative eigenvalues so a user-entered matrix is a valid correlation matrix. */
export function nearestCorrelation(r) {
  const n = r.length;
  const { values, vectors } = symmetricEigen(r);
  const w = values.map((x) => Math.max(x, 1e-6));
  const fixed = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => {
    let s = 0;
    for (let k = 0; k < n; k++) s += vectors[i][k] * w[k] * vectors[j][k];
    return s;
  }));
  const d = fixed.map((row, i) => Math.sqrt(row[i]));
  return fixed.map((row, i) => row.map((x, j) => x / (d[i] * d[j])));
}

function cholesky(m) {
  const n = m.length;
  const L = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let s = m[i][j];
      for (let k = 0; k < j; k++) s -= L[i][k] * L[j][k];
      L[i][j] = i === j ? Math.sqrt(Math.max(s, 1e-12)) : s / L[j][j];
    }
  }
  return L;
}

// Deterministic randomized QMC (Richtmyer lattice, fixed shifts) so results are
// stable across calls -- the break-even search bisects on them.
const PRIMES = [2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37];
function mulberry32(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** P(Z <= b) for Z ~ MVN(0, corr): Genz's separation-of-variables with QMC. */
export function mvnCdf(b, corr, { points = 4000, shifts = 12 } = {}) {
  const n = b.length;
  if (n === 1) return normCdf(b[0]);
  if (n === 2) return bivariateNormalCdf(b[0], b[1], corr[0][1]);
  const C = cholesky(corr);
  const alpha = PRIMES.slice(0, n - 1).map((p) => Math.sqrt(p) % 1);
  const rand = mulberry32(7);
  const y = new Array(n).fill(0);
  let total = 0;
  for (let s = 0; s < shifts; s++) {
    const shift = alpha.map(() => rand());
    let acc = 0;
    for (let j = 1; j <= points; j++) {
      let e = normCdf(b[0] / C[0][0]);
      let f = e;
      for (let i = 1; i < n; i++) {
        let w = (j * alpha[i - 1] + shift[i - 1]) % 1;
        w = Math.abs(2 * w - 1); // baker's transform
        y[i - 1] = normPpf(Math.min(Math.max(w * e, 1e-15), 1 - 1e-15));
        let sum = 0;
        for (let k = 0; k < i; k++) sum += C[i][k] * y[k];
        e = normCdf((b[i] - sum) / C[i][i]);
        f *= e;
      }
      acc += f;
    }
    total += acc / points;
  }
  return total / shifts;
}
