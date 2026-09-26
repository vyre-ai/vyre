// @ts-check
// glass: the Capsule's way into Glass (ADR 0005, decision 5).
//
// Glass lives in the Deck, on the box, at `/glass/<agent>` for an agent's computer and
// `/glass/box` for the box's files. The Capsule only opens that page in the default browser:
// Tailscale identifies the user there, so there is no second trust path from here.
//
// Two rules keep it honest. The box's address comes from the link (`link.status`, the address this
// Mac paired with) and nothing else; with no paired box there is no row at all, because a guessed
// host would send the user somewhere they did not choose. And "Open Glass" shows only for an
// agent that has a computer: an agent without one has no screen to watch.

import { execFile } from "node:child_process";
import { guarded } from "./dialogs.js";
import { match } from "./local.js";

/** @typedef {import("./route.js").Catalog & { box?: string|null }} Catalog */
/** @typedef {import("./route.js").Result & { glass?: string }} Result */

/** The box's own target: files only, it has no screen. */
export const BOX = "box";

/**
 * The box's address as the link knows it, or null. Only an https origin counts: that is what
 * pairing accepts, and anything else is not a place to send a browser.
 * @param {{ call: (tool: string, input?: any) => Promise<{ data?: any, error?: any }> }} client
 * @param {boolean} [has] whether this vyred has `link.status` at all
 * @returns {Promise<string|null>}
 */
export async function address(client, has = true) {
  if (!has) return null;
  const r = await client.call("link.status").catch(() => null);
  const s = r && r.data;
  if (!s || !s.linked || !s.box) return null;
  return origin(s.box.address);
}

/** An https origin (with its port, if any), or null. */
export function origin(value) {
  try {
    const u = new URL(String(value || ""));
    return u.protocol === "https:" && u.hostname ? u.origin : null;
  } catch { return null; }
}

/**
 * The Glass page for a target: `https://<box>/glass/<agent>`, the name encoded so a space or a
 * slash stays one path segment. Null without a box address or a target.
 * @param {string|null|undefined} box @param {string} target @returns {string|null}
 */
export function url(box, target) {
  const o = origin(box);
  const t = String(target || "");
  return o && t ? `${o}/glass/${encodeURIComponent(t)}` : null;
}

/** The agents that have a computer, by name. */
const withComputers = (/** @type {Catalog|null} */ cat) =>
  new Set((cat && cat.agents || []).filter(a => /** @type {any} */ (a).computer).map(a => a.name));

const row = (/** @type {string} */ target, /** @type {string} */ sub, /** @type {number} */ score) => /** @type {Result} */ ({
  kind: "glass", id: `glass:${target}`, glass: target, target: "", score,
  label: target === BOX ? "Open the box's files in Glass" : `Open Glass · ${target}`, sub });

const COMMAND = /^glass(?:\s+(.*))?$/i;

/**
 * "Open Glass" rows for a bare query. Typed as a command (`glass`, `glass <agent>`, `glass box`),
 * they lead the list. Otherwise one follows each agent with a computer that the words name, and
 * each thread of such an agent, just under the agent or thread row itself. None without a box
 * address.
 * @param {string} query @param {Catalog|null} cat @returns {Result[]}
 */
export function results(query, cat) {
  const q = String(query || "").trim();
  if (!q || !cat || !origin(cat.box)) return [];
  const agents = withComputers(cat);
  const cmd = COMMAND.exec(q);
  if (cmd) {
    const who = String(cmd[1] || "").trim().toLowerCase();
    /** @type {Result[]} */
    const out = [];
    for (const name of agents) {
      if (!who || name.toLowerCase() === who) out.push(row(name, "watch its computer in the browser", 3));
      else if (name.toLowerCase().startsWith(who)) out.push(row(name, "watch its computer in the browser", 2.5));
    }
    if (!who || BOX.startsWith(who)) out.push(row(BOX, "the box's files in the browser", who === BOX ? 3 : 2.4));
    return out;
  }
  if (!agents.size) return [];
  /** @type {Map<string, Result>} */
  const found = new Map();
  const offer = (name, sub, m) => {
    // A little under the match that brought it, so the agent or thread row comes first.
    const score = m * 0.95;
    const had = found.get(name);
    if (!had || (had.score || 0) < score) found.set(name, row(name, sub, score));
  };
  for (const name of agents) { const m = match(q, name); if (m >= 0.5) offer(name, "watch its computer in the browser", m); }
  const current = new Map((cat.agents || []).filter(a => /** @type {any} */ (a).thread).map(a => [/** @type {any} */ (a).thread, a.name]));
  for (const t of cat.threads || []) {
    const name = t.agent || current.get(t.id);
    if (!name || !agents.has(name) || !t.label) continue;
    const m = match(q, t.label);
    if (m >= 0.5) offer(name, `${t.label} · its computer in the browser`, m);
  }
  return [...found.values()];
}

/**
 * Open a Glass page in the default browser. The URL is rebuilt from the box address and the
 * target, never taken from the page, and it starts with https:// so `open` cannot read it as a flag.
 * @param {string|null|undefined} box @param {string} target
 * @param {typeof execFile} [run]
 * @returns {Promise<{ ok?: true, close?: boolean, error?: string }>}
 */
export function open(box, target, run = execFile) {
  const u = url(box, target);
  if (!u) return Promise.resolve({ error: "no box is paired with this Mac (vyre link pair <address>)" });
  return new Promise(resolve => {
    guarded(run)("/usr/bin/open", [u], err => resolve(err ? { error: String(err.message || err) } : { ok: true, close: true }));
  });
}
