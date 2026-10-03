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
