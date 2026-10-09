// @ts-check
// "What do you know about GoHighLevel?": memory.ask's answer about a site Vyre Computer learned, given when a question names the site, built in code from the
// stored records (lib/site-knowledge.js), no model. It names the origins and the family, when it last worked, what it
// knows (frames, controls, the site's own API, flows), how sure it is, and what used to work. Everything here is structure;
// the store never held a value, so there is none to say. The answer is plain text quoted from memory, never an instruction.

import { mergeFamily, readConf, isQuarantined } from "../../lib/site-knowledge.js";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const day = (/** @type {string|null} */ iso) => { const d = iso ? new Date(iso) : null; return d && Number.isFinite(d.getTime()) ? `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}` : null; };
const esc = (/** @type {string} */ s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const host = (/** @type {string} */ origin) => origin.replace(/^https?:\/\//, "");

/**
 * The whole names a person might use for a site: what it is called, its family id, and its full host (also without a generic
 * app, www or my prefix). Never a fragment of a host ("google" from accounts.google.com), so a question that merely
 * contains a common word does not match. @param {{ key: string, names?: string[], family?: string|null }} rec
 */
function tokensOf(rec) {
  const out = new Set();
  for (const n of rec.names || []) out.add(String(n).toLowerCase());
  if (rec.family) out.add(String(rec.family).toLowerCase());
  if (String(rec.key).startsWith("family:")) out.add(String(rec.key).slice("family:".length));
  else {
    const h = host(rec.key).toLowerCase().replace(/:\d+$/, "");
    out.add(h);
    const bare = h.replace(/^(?:app|www|my|web|go|secure)\./, "");
    out.add(bare);
  }
  return [...out].filter(t => t.length >= 3);
}
const named = (/** @type {string} */ q, /** @type {string} */ t) => new RegExp(`(?:^|[^a-z0-9.])${esc(t)}(?:$|[^a-z0-9])`).test(q);

/**
 * The keys of the records a question needs, found from an index of names, families and hosts alone, so nothing is parsed for
 * a question that names no site: the matched sites, their family's record, and every origin of that family.
 * @param {string} question @param {{ key: string, names: string[], family: string|null }[]} index
 */
export function neededKeys(question, index) {
  const q = String(question || "").toLowerCase();
  const hit = index.filter(e => tokensOf(e).some(t => named(q, t)));
  if (!hit.length) return [];
  const keys = new Set();
  for (const e of hit) {
    const fam = e.key.startsWith("family:") ? e.key.slice("family:".length) : e.family;
    if (fam) for (const x of index) if (x.key === `family:${fam}` || (!x.key.startsWith("family:") && x.family === fam)) keys.add(x.key);
    keys.add(e.key);
  }
  return [...keys];
}

/**
 * @param {string} question @param {any[]} records every stored record, origins and families
 * @param {{ now?: number }} [o]
 * @returns {{ answer: string, confidence: number, abstained: false, known: string[], sources: any[], via: "site" } | null}
 */
export function answerSite(question, records, { now = Date.now() } = {}) {
  const q = String(question || "").toLowerCase();
  if (!records.length) return null;
  const hit = records.filter(r => tokensOf(r).some(t => named(q, t)));
  if (!hit.length) return null;
  // A family stands for its members: what is known about the product, whichever host was named.
  /** @type {Map<string, { family: any, origins: any[] }>} */
  const groups = new Map();
  for (const r of hit) {
    const fam = String(r.key).startsWith("family:") ? r.key.slice("family:".length) : r.family;
    const gk = fam ? `family:${fam}` : r.key;
    const g = groups.get(gk) || { family: records.find(x => x.key === gk && gk.startsWith("family:")) || null, origins: [] };
    g.origins = records.filter(x => !String(x.key).startsWith("family:") && (x.family ? `family:${x.family}` === gk : x.key === gk));
    groups.set(gk, g);
  }
  const parts = [];
  /** @type {any[]} */ const sources = [];
  for (const [gk, g] of groups) {
    const origins = g.origins;
    const view = g.family ? (origins.length ? origins.map(o => mergeFamily(o, g.family))[0] : g.family) : origins[0];
    if (!view) continue;
    const all = [...origins, ...(g.family ? [g.family] : [])];
    const items = all.flatMap(r => [...r.controls, ...r.api, ...r.flows, ...r.frames, ...r.ready, ...r.login.wall, ...r.login.signedIn, ...r.notes]);
    const live = items.filter(x => !isQuarantined(x));
    const verified = items.map(x => x.verified).filter(Boolean).sort().pop() || null;
    const name = (g.family && g.family.names[0]) || view.names[0] || (origins[0] ? host(origins[0].key) : host(view.key));
    const hosts = origins.map(o => host(o.key));
    const pagesWith = new Set(all.flatMap(r => r.controls.filter(c => !isQuarantined(c)).map((/** @type {any} */ c) => c.page)));
    const controls = all.reduce((n, r) => n + r.controls.filter((/** @type {any} */ c) => !isQuarantined(c)).length, 0);
    const api = all.reduce((n, r) => n + r.api.filter((/** @type {any} */ c) => !isQuarantined(c)).length, 0);
    const frames = all.flatMap(r => r.frames.map((/** @type {any} */ f) => f.role));
    const flows = all.flatMap(r => r.flows);
    const conf = live.length ? live.reduce((n, x) => n + readConf(x, now), 0) / live.length : 0;
    const sure = conf >= 0.8 ? "sure" : conf >= 0.5 ? "fairly sure" : "not very sure";
    const wall = all.flatMap(r => r.login.wall).map((/** @type {any} */ s) => s.kind);
    const lines = [`${name}${hosts.length ? ` (${hosts.slice(0, 3).join(", ")}${hosts.length > 3 ? ` and ${hosts.length - 3} more` : ""})` : ""}.`];
    if (verified) lines.push(`Last worked ${day(verified)}; ${sure} about it.`);
    if (wall.length) lines.push(`Signing in shows ${[...new Set(wall)].map(k => k.replace(/-/g, " ")).slice(0, 3).join(" or ")}.`);
    if (frames.length) lines.push(`${frames.length} frame${frames.length === 1 ? "" : "s"} (${[...new Set(frames)].slice(0, 4).join(", ")}).`);
    if (controls) lines.push(`${controls} control${controls === 1 ? "" : "s"} known on ${pagesWith.size} page${pagesWith.size === 1 ? "" : "s"}.`);
    if (api) lines.push(`${api} endpoint${api === 1 ? "" : "s"} of its own API.`);
    if (flows.length) lines.push(`Flows: ${flows.slice(0, 5).map((/** @type {any} */ f) => `${f.name} (${f.src === "shipped" ? "built in" : f.src}, ${f.runs ? `${f.runs} run${f.runs === 1 ? "" : "s"}${f.fails ? `, ${f.fails} failed` : ""}` : "not run yet"})`).join("; ")}.`);
    const stale = items.filter(isQuarantined).length;
    if (stale) lines.push(`${stale} thing${stale === 1 ? "" : "s"} used to work and were set aside.`);
    parts.push(lines.join(" "));
    for (const r of all) sources.push({ session: `site:${r.key}`, seq: 0, role: "site", name, site: r.key, rev: r.rev, quote: lines[0], ts: r.updated ? Date.parse(r.updated) : null });
  }
  if (!parts.length) return null;
  return { answer: `From what Vyre Computer learned: ${parts.join(" ")}`, confidence: 0.9, abstained: false, known: [], sources, via: "site" };
}
