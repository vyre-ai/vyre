// @ts-check
// Vendored from app-design's round5/rs.js (ADR 0043, "Identity marks: four families, and the
// Vyre code"), CommonJS -> ESM only, no logic changed. Reed-Solomon over GF(256), the same field
// QR codes and CDs use (primitive polynomial x^8 + x^4 + x^3 + x^2 + 1, 0x11D). Byte-oriented:
// encode(dataBytes, parityCount) appends parity bytes; decode(receivedBytes, parityCount)
// corrects up to floor(parityCount/2) byte errors (Peterson-Gorenstein-Zierler) and returns the
// corrected data bytes, or { ok: false }.

const EXP = new Array(512);
const LOG = new Array(256);
(function buildTables() {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11D;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();
const gmul = (a, b) => (a === 0 || b === 0) ? 0 : EXP[LOG[a] + LOG[b]];
const gdiv = (a, b) => { if (b === 0) throw new Error("div by zero"); if (a === 0) return 0; return EXP[(LOG[a] - LOG[b] + 255) % 255]; };
const gpow = (a, n) => a === 0 ? 0 : EXP[(LOG[a] * n) % 255];

/** The generator polynomial for `parityCount` parity symbols, high-degree coefficient first. */
function generatorPoly(parityCount) {
  let g = [1];
  for (let i = 0; i < parityCount; i++) {
    const next = new Array(g.length + 1).fill(0);
    for (let j = 0; j < g.length; j++) {
      next[j] ^= g[j];
      next[j + 1] ^= gmul(g[j], EXP[i]);
    }
    g = next;
  }
  return g;
}

/** Systematic RS encode: returns dataBytes followed by parityCount parity bytes. */
export function encode(dataBytes, parityCount) {
  const gen = generatorPoly(parityCount);
  const msg = [...dataBytes, ...new Array(parityCount).fill(0)];
  for (let i = 0; i < dataBytes.length; i++) {
    const coef = msg[i];
    if (coef === 0) continue;
    for (let j = 0; j < gen.length; j++) msg[i + j] ^= gmul(gen[j], coef);
  }
  return [...dataBytes, ...msg.slice(dataBytes.length)];
}

/** Syndromes for a received codeword (data+parity, n bytes) against parityCount roots. */
function syndromes(received, parityCount) {
  const synd = new Array(parityCount).fill(0);
  for (let i = 0; i < parityCount; i++) {
    let s = 0;
    for (const byte of received) s = gmul(s, EXP[i]) ^ byte;
    synd[i] = s;
  }
  return synd;
}

/**
 * Corrects up to floor(parityCount/2) byte errors via Peterson-Gorenstein-Zierler.
 * @param {number[]} received data+parity bytes @param {number} parityCount
 * @returns {{ ok: boolean, corrected?: number[], errors?: number }}
 */
export function decode(received, parityCount) {
  const n = received.length;
  const synd = syndromes(received, parityCount);
  if (synd.every(s => s === 0)) return { ok: true, corrected: received.slice(), errors: 0 };

  const maxT = Math.floor(parityCount / 2);
  for (let t = maxT; t >= 1; t--) {
    const M = [];
    for (let i = 0; i < t; i++) M.push(synd.slice(i, i + t).reverse());
    const rhs = synd.slice(t, 2 * t);
    const sigma = solveGF(M, rhs, t);
    if (!sigma) continue;
    const locatorCoeffs = [1, ...sigma.map(v => v)];
    const errPositions = [];
    for (let pos = 0; pos < n; pos++) {
      const deg = n - 1 - pos;
      const xInv = EXP[(255 - (deg % 255)) % 255];
      let val = 0;
      for (let k = 0; k < locatorCoeffs.length; k++) val ^= gmul(locatorCoeffs[k], gpow(xInv, k));
      if (val === 0) errPositions.push(pos);
    }
    if (errPositions.length !== t) continue;
    const errValues = forney(synd, locatorCoeffs, errPositions, n);
    if (!errValues) continue;
    const corrected = received.slice();
    for (let i = 0; i < errPositions.length; i++) corrected[errPositions[i]] ^= errValues[i];
    const check = syndromes(corrected, parityCount);
    if (check.every(s => s === 0)) return { ok: true, corrected, errors: t };
  }
  return { ok: false };
}

/** Gaussian elimination over GF(256) for an n x n system Mx = rhs. Returns null if singular. */
function solveGF(M, rhs, n) {
  const A = M.map((row, i) => [...row, rhs[i]]);
  for (let col = 0; col < n; col++) {
    let pivot = -1;
    for (let r = col; r < n; r++) if (A[r][col] !== 0) { pivot = r; break; }
    if (pivot === -1) return null;
    [A[col], A[pivot]] = [A[pivot], A[col]];
    const inv = gdiv(1, A[col][col]);
    for (let c = col; c <= n; c++) A[col][c] = gmul(A[col][c], inv);
    for (let r = 0; r < n; r++) {
      if (r === col || A[r][col] === 0) continue;
      const factor = A[r][col];
      for (let c = col; c <= n; c++) A[r][c] ^= gmul(factor, A[col][c]);
    }
  }
  return A.map(row => row[n]);
}

function forney(synd, locatorCoeffs, errPositions, n) {
  const t2 = synd.length;
  const S = synd;
  const sigma = locatorCoeffs;
  const omega = new Array(t2).fill(0);
  for (let i = 0; i < t2; i++) for (let j = 0; j < sigma.length && i + j < t2; j++) omega[i + j] ^= gmul(S[i], sigma[j]);
  const values = [];
  for (const pos of errPositions) {
    const deg = n - 1 - pos;
    const xInv = EXP[(255 - (deg % 255)) % 255];
    let omegaVal = 0;
    for (let i = 0; i < omega.length; i++) omegaVal ^= gmul(omega[i], gpow(xInv, i));
    let derivVal = 0;
    for (let i = 1; i < sigma.length; i += 2) derivVal ^= gmul(sigma[i], gpow(xInv, i - 1));
    if (derivVal === 0) return null;
    const xPos = EXP[deg % 255];
    values.push(gmul(xPos, gdiv(omegaVal, derivVal)));
  }
  return values;
}

export { gmul, gdiv };
