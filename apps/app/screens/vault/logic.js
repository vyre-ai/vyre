// Vault, as pure functions: grants (use only, fill on a device, give a copy), the day's use of a credential, and the sealed record fields the Vault holds.

export const RIGHTS = /** @type {const} */ ({
  use: { label: "Use only", help: "The Vault uses it for them. They never see it." },
  fill: { label: "Fill on a device", help: "It is filled into a page on their device at the moment, and not kept." },
  copy: { label: "Give a copy", help: "They get the value for good. This cannot be taken back." },
});

/** How long Reveal shows a value before it masks again. */
export const REVEAL_MS = 30_000;

/** @typedef {{ id: string, sp: string, kind: 'Login'|'Key'|'Card', name: string, user: string, secret: string, use: { who: string, for: string, times: number, note: string }[], grants: { who: string, right: 'use'|'fill'|'copy' }[] }} Item */

/** @param {Item} item */
export const usesToday = (item) => item.use.reduce((n, u) => n + u.times, 0);

/** @template {{ sp: string, kind: string }} T @param {T[]} items @param {string} scope @param {string} kind */
export const listOf = (items, scope, kind) => items.filter((v) => (scope === "all" || v.sp === scope) && v.kind === kind);

/** Remove one grant by person; the others stay. @template {{ id: string, grants: { who: string }[] }} T @param {T[]} items @param {string} id @param {string} who */
export const removeGrant = (items, id, who) => items.map((v) => (v.id === id ? { ...v, grants: v.grants.filter((g) => g.who !== who) } : v));

/** Share with someone. Sharing again replaces the right, never doubles the row. @template {{ id: string, grants: { who: string, right: string }[] }} T @param {T[]} items @param {string} id @param {string} who @param {'use'|'fill'|'copy'} right */
export const addGrant = (items, id, who, right) => items.map((v) => (v.id === id ? { ...v, grants: [...v.grants.filter((g) => g.who !== who), { who, right }] } : v));

/** The line under a credential in the list. @param {Item} item */
export const useLine = (item) => {
  const n = usesToday(item);
  return `${item.user} · ${n ? `used ${n} ${n === 1 ? "time" : "times"} today` : "not used yet"}`;
};

/** Sealed record fields the Vault holds, for the spaces in view. @template {{ sp: string }} T @param {T[]} held @param {string} scope */
export const heldIn = (held, scope) => held.filter((h) => scope === "all" || h.sp === scope);

// ---- Generator: a strong password made on this device (the Web Crypto random source), typed into the new item's field and never sent anywhere until the person saves ----

const CLASSES = /** @type {const} */ ({ lower: "abcdefghijkmnopqrstuvwxyz", upper: "ABCDEFGHJKLMNPQRSTUVWXYZ", digit: "23456789", symbol: "!@#$%^&*-_=+?" });

/**
 * A random password. Look-alike characters (l, 1, I, O, 0) are left out so it can be read aloud; every class asked for appears at least once; each character is drawn without bias
 * (rejection sampling over the random source). `random` fills a Uint8Array, as crypto.getRandomValues does, so a test can drive it.
 * @param {(a: Uint8Array) => Uint8Array} random @param {{ length?: number, symbols?: boolean }} [o]
 */
export function generatePassword(random, o = {}) {
  const length = Math.min(64, Math.max(12, Math.trunc(o.length ?? 20)));
  const sets = [CLASSES.lower, CLASSES.upper, CLASSES.digit, ...(o.symbols === false ? [] : [CLASSES.symbol])];
  const all = sets.join("");
  const pick = (/** @type {string} */ from) => {
    const limit = 256 - (256 % from.length), buf = new Uint8Array(1);
    for (;;) { random(buf); if (buf[0] < limit) return from[buf[0] % from.length]; }
  };
  const out = sets.map(pick);
  while (out.length < length) out.push(pick(all));
  // shuffle (Fisher-Yates) so the guaranteed characters are not in front
  for (let i = out.length - 1; i > 0; i--) { const buf = new Uint8Array(1); const limit = 256 - (256 % (i + 1)); let j; for (;;) { random(buf); if (buf[0] < limit) { j = buf[0] % (i + 1); break; } } [out[i], out[j]] = [out[j], out[i]]; }
  return out.join("");
}

/** How strong a generated password is, in words: bits of entropy over the characters it draws from. @param {number} length @param {boolean} symbols */
export function strengthWords(length, symbols) {
  const pool = 24 + 24 + 8 + (symbols ? CLASSES.symbol.length : 0);
  const bits = Math.floor(length * Math.log2(pool));
  return `${length} characters, about ${bits} bits. ${bits >= 100 ? "Very strong." : bits >= 75 ? "Strong." : "Fine for most sites."}`;
}
