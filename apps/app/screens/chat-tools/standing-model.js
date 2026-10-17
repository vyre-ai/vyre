// @ts-check
// A standing permission (gate.standing.list) in plain words: what the agent may do by itself, to whom, how much a day and through which connection. Pure.

/** @typedef {{ id: string, title: string, sub: string }} StandingRow */

const KIND = { send: "Send", post: "Post", spend: "Pay" };

/** The permissions the box lists, as rows. A row the box sends in a shape that is not understood is left out. @param {any} d @returns {StandingRow[]} */
export function standingRows(d) {
  const list = Array.isArray(d?.permissions) ? d.permissions : [];
  /** @type {StandingRow[]} */ const out = [];
  for (const p of list) {
    if (!p || typeof p.id !== "string") continue;
    const m = /\/outbox\/([a-z]+)(?:\/([^/]+))?$/.exec(String(p.resource ?? ""));
    const kind = m && m[1] in KIND ? /** @type {keyof typeof KIND} */ (m[1]) : null;
    if (!kind) continue;
    const to = [...(Array.isArray(p.to?.patterns) ? p.to.patterns : []), ...(Array.isArray(p.to?.lists) ? p.to.lists : [])].map(String);
    const toLine = to.length > 3 ? `${to.slice(0, 3).join(", ")} and ${to.length - 3} more` : to.join(", ");
    const limit = kind === "spend" && p.max_amount ? `up to ${p.max_amount} each, ${p.daily_amount} a day` : p.daily_cap ? `up to ${p.daily_cap} a day` : "";
    const until = typeof p.when?.expires === "number" ? "until it ends" : "";
    out.push({ id: p.id, title: `${KIND[kind]} by itself`, sub: [toLine ? `To ${toLine}` : "", limit, m && m[2] ? `through ${m[2]}` : "", until].filter(Boolean).join(" · ") });
  }
  return out;
}
