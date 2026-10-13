// @ts-check
// The servers a Create a team space can be made on. Each choice: `key` (what the call names the server by: a box id on a phone or browser, the daemon's server id on the Mac), `name`, `route` (where the server is
// reached, for the Space's directory record: null when unknown) and `has` (the tag of the Space already on it, or ""). Pure; src/real/servers-list.ts reads the pairings and the daemon.
import { placeTag } from "../state/space-name.js";

/** @typedef {{ relay: string, route: string, box: string }} Route */
/** @typedef {{ key: string, name: string, route: Route | null, has: string }} Choice */

/** A device paired to servers itself (a phone, a browser, Windows): one choice per pairing. @param {Array<{ relay: string, route: string, box: string, name?: string }>} pairings @param {Array<Record<string, any>>} spaces the merged list, each row tagged with its server @returns {Choice[]} */
export function choicesFromPairings(pairings, spaces) {
  return pairings.map((p, n) => {
    const row = spaces.find((s) => s.server === p.box);
    return { key: p.box, name: (p.name || "").trim() || `Server ${n + 1}`, route: { relay: p.relay, route: p.route, box: p.box }, has: row ? placeTag(row) : "" };
  });
}

/** The Mac: what its own daemon is paired to (spaces.servers). @param {any} answer @returns {Choice[]} */
export function choicesFromDaemon(answer) {
  const rows = answer && Array.isArray(answer.servers) ? answer.servers : [];
  /** @type {Choice[]} */ const out = [];
  for (const r of rows) {
    if (!r || typeof r.id !== "string" || !r.id) continue;
    const c = r.channel && typeof r.channel.route === "string" ? { relay: String(r.channel.relay || ""), route: r.channel.route, box: String(r.channel.box || "") } : null;
    out.push({ key: r.id, name: typeof r.name === "string" && r.name.trim() ? r.name.trim() : `Server ${out.length + 1}`, route: c, has: "" });
  }
  return out;
}
