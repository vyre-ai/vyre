// @ts-check
// presence: the declaration every value-out or access-giving vault tool carries (ADR 0004,
// ADR 0006 section 3), and small helpers for the words a person reads before proving presence.

export const quoted = n => `"${String(n ?? "").slice(0, 128)}"`;
export const list = ns => (Array.isArray(ns) ? ns : []).slice(0, 8).map(n => quoted(n && typeof n === "object" ? n.name : n)).join(", ") + (Array.isArray(ns) && ns.length > 8 ? ` and ${ns.length - 8} more` : "");

/**
 * A presence declaration (ADR 0004, ADR 0006 section 3). The summary names the item, its kind
 * and where it goes, never a value, and never throws: presence's fallback prints the input,
 * which for a put would carry the value.
 * @param {string} fallback @param {(input: any) => string | Promise<string>} [fn] @param {any} [extra]
 */
export function presence(fallback, fn, extra = {}) {
  return { ...extra, summary: async input => { try { return (fn && (await fn(input || {}))) || fallback; } catch { return fallback; } } };
}

