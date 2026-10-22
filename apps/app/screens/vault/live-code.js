// @ts-check
// The current one-time code on a Vault item. The secret stays on the item: this only groups the digits vault.totp already returned, and counts the seconds that answer said were left.

/**
 * "123456" reads "123 456". An eight-digit code reads "1234 5678". Anything else is shown as the digits given.
 * @param {unknown} code
 */
export function groupDigits(code) {
  const s = String(code ?? "").replace(/\s+/g, "");
  if (/^\d{6}$/.test(s)) return `${s.slice(0, 3)} ${s.slice(3)}`;
  if (/^\d{8}$/.test(s)) return `${s.slice(0, 4)} ${s.slice(4)}`;
  return s;
}

/**
 * Whole seconds left from one vault.totp answer. `at` is when that answer arrived, in ms.
 * @param {{ remaining: number, at: number }} snap
 * @param {number} now
 */
export function secondsLeft(snap, now) {
  const gone = Math.floor((Number(now) - Number(snap.at)) / 1000);
  const left = Math.floor(Number(snap.remaining)) - (Number.isFinite(gone) ? gone : 0);
  return left > 0 ? left : 0;
}
