// @ts-check
// What happened to this space's lent computers, as a person reads it (R031-95): link writes lease.borrowed, lease.issued and lease.refused on the space's log; this turns them into quiet lines. Pure.

/** How long ago, in words. @param {number} at @param {number} now */
const agoOf = (at, now) => { const s = Math.max(0, Math.round((now - at) / 1000)); return s < 60 ? "just now" : s < 3600 ? `${Math.floor(s / 60)}m ago` : s < 86400 ? `${Math.floor(s / 3600)}h ago` : `${Math.floor(s / 86400)}d ago`; };

/** Why a lease was refused, in words; a reason this app does not know says nothing. @param {string | undefined} why */
export const leaseWhy = (why) => ({ another_computer: "It asked from another computer.", no_lend: "Lending to this space was switched off." }[String(why)] ?? "");

const LIMIT = /** @type {Record<string, string>} */ ({ provider: "It can reach the AI provider and nothing else.", internet: "It can reach the internet." });

/**
 * The lease events as rows of a list, newest first. @param {any} events the space's events (records.events) @param {(device: string) => string} nameOf the computer's name by its id, or "" @param {number} now
 */
export function leaseRows(events, nameOf, now) {
  const list = Array.isArray(events) ? events : Array.isArray(events && events.events) ? events.events : [];
  return list.filter((/** @type {any} */ e) => e && /^lease\.(borrowed|issued|refused)$/.test(String(e.type))).sort((/** @type {any} */ a, /** @type {any} */ b) => Number(b.time) - Number(a.time)).slice(0, 20).map((/** @type {any} */ e) => {
    const d = e.data || {};
    const name = nameOf(String(d.device || "")).trim();
    const age = agoOf(Number(e.time), now);
    const limit = d.limit ? LIMIT[String(d.limit)] || "" : "";
    const computer = name || "one of your computers";
    const [title, sub] = e.type === "lease.borrowed" ? [`A chat borrowed ${computer}`, limit]
      : e.type === "lease.issued" ? [`${name || "One of your computers"} was given its key`, limit]
      : [`${name || "One of your computers"} was refused its key`, leaseWhy(d.why)];
    return { id: String(e.seq ?? e.id ?? `${e.type}${e.time}`), title, subtitle: [sub, age].filter(Boolean).join(" "), icon: "laptop" };
  });
}
