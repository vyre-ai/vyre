// @ts-check
// caps/index: the capability registry and the one place an op is dispatched.
//
// A capability default-exports { name, ops: { "<cap>.<name>": async (args, ctx) => result },
// onEvent?(evt, ctx) }. dispatch() is where the person's guard rails live so no capability can
// forget them: an op name is validated, an ACTING op is refused while the person's stop is in
// force, and any op that names a tab (args.tabId) is checked against the URL floor first.
//
// The capabilities are STATIC imports: an MV3 service worker forbids dynamic import(), so a
// name-to-module table is the only loader that works in the packed extension as well as under
// node. A capability that throws while registering is reported in loadReport() and the rest still
// load. Vault adds its own with register() from its own file.

import { proto } from "../lib/shared.js";
import { err } from "../lib/err.js";
import { setGhlHosts } from "../shared/ghlhosts.js";
import { url as redactUrl } from "../shared/sk/siteops/redact.js";
import tabs from "./tabs.js";
import page from "./page.js";
import batch from "./batch.js";
import frames from "./frames.js";
import devtools from "./devtools.js";
import net from "./net.js";
import api from "./api.js";
import ghl from "./ghl.js";
import login from "./login.js";
import site from "./site.js";
import recipe from "./recipe.js";
import point from "./point.js";

import { TRUST_KEYS, cleanTrust, trustKeyIn } from "../shared/trust.js";
export { TRUST_KEYS, cleanTrust, trustKeyIn };
/** @typedef {import("../shared/trust.js").Trust} Trust */

export const OPTIONAL = ["devtools", "net", "api", "ghl"];

/** @type {Map<string, { cap: any, handler: (args: any, ctx: any) => Promise<any> }>} */
const ops = new Map();
/** @type {Map<string, any>} */
const caps = new Map();
/** @type {{ loaded: string[], missing: string[], failed: { name: string, error: string }[] }} */
const report = { loaded: [], missing: [], failed: [] };

/**
 * Add a capability. Throws on a bad name, a duplicate op, or a malformed cap so a mistake is
 * loud at load time and never a silent missing tool.
 * @param {{ name: string, ops: Record<string, (args: any, ctx: any) => Promise<any>>, onEvent?: (evt: any, ctx: any) => any }} cap
 */
export function register(cap) {
  if (!cap || typeof cap.name !== "string" || !cap.name || typeof cap.ops !== "object" || !cap.ops) throw new Error("a capability needs a name and an ops object");
  if (caps.get(cap.name) === cap) return;
  for (const [op, fn] of Object.entries(cap.ops)) {
    if (!proto.validOp(op)) throw new Error(`bad op name ${JSON.stringify(op)}`);
    if (typeof fn !== "function") throw new Error(`op ${op} is not a function`);
    const have = ops.get(op);
    if (have && have.cap.name !== cap.name) throw new Error(`op ${op} is already registered by ${have.cap.name}`);
  }
  caps.set(cap.name, cap);
  for (const [op, fn] of Object.entries(cap.ops)) ops.set(op, { cap, handler: fn });
}

/** File names (not capability names: caps/devtools.js registers "dev") already loaded. */
const loadedFiles = new Set();

/**
 * @param {(name: string) => Promise<any>} [importer]
 * @param {string[]} [names] file names under caps/ to try
 */
const STATIC = { devtools, net, api, ghl };

export async function loadOptional(importer = async name => ({ default: /** @type {any} */ (STATIC)[name] }), names = OPTIONAL) {
  for (const name of names) {
    if (loadedFiles.has(name)) continue;
    report.missing = report.missing.filter(n => n !== name);
    report.failed = report.failed.filter(f => f.name !== name);
    try {
      const m = await importer(name);
      if (!m || !m.default) throw new Error(`Cannot find module './${name}.js'`);
      register(m.default);
      loadedFiles.add(name);
      report.loaded.push(name);
    } catch (e) {
      const msg = String(/** @type {any} */ (e)?.message || e);
      // A file that is simply not there yet is normal; a file that is there and broken is not.
      if (new RegExp(`Cannot find module '[^']*/${name}\\.js'|Failed to fetch dynamically imported module: [^ ]*/${name}\\.js`).test(msg)) report.missing.push(name);
      else report.failed.push({ name, error: msg });
    }
  }
}

for (const c of [tabs, page, batch, frames, login, site, recipe, point]) register(c);

/** Resolves when the optional capabilities have been tried. dispatch waits for it. */
export let ready = loadOptional();

/** What loaded and what did not, for the hello event and for support. */
export const loadReport = () => ({ loaded: [...caps.keys()], optional: { ...report } });

/** @returns {string[]} */
export const opNames = () => [...ops.keys()].sort();

/**
 * Run one op. Throws VyreError (with a proto code) on refusal; the shell turns that into
 * {ok:false, error}. Callers inside the worker (batch) get the same guard rails as the module.
 * TRUST. What the person has approved (asked, writeOk, a release signature, the module's write budget) is never in `args`: it arrives in `trust`, set only by
 * the host from the real caller, and every op reads it from there. An args object that carries one of those keys, at any depth, is refused outright, so a
 * model's text (a batch step, a recipe, a flow) cannot approve itself.
 * @param {string} op @param {any} args @param {any} ctx @param {Trust} [trust]
 */
export async function dispatch(op, args, ctx, trust = {}) {
  await ready;
  if (!proto.validOp(op)) throw err("bad_request", `bad op name ${JSON.stringify(op)}`);
  const entry = ops.get(op);
  if (!entry) throw err("unknown_op", `no such operation: ${op}`);
  if (args == null) args = {};
  if (typeof args !== "object" || Array.isArray(args)) throw err("bad_request", "args must be an object");
  { const bad = trustKeyIn(args); if (bad) throw err("bad_request", `arguments may not carry "${bad}": approvals come from the host, not from arguments`); }
  const t = cleanTrust(trust);
  // The wire calls the tab `tab`; the page and tabs capabilities read `tabId`. Accept either and
  // give every capability both, so no file has to know which spelling a caller used.
  if (typeof args.tab === "number" && args.tabId === undefined) args = { ...args, tabId: args.tab };
  else if (typeof args.tabId === "number" && args.tab === undefined) args = { ...args, tab: args.tabId };
  // The person's white-label GoHighLevel hosts ride on every call from the module (their own configuration).
  if (Array.isArray(args.ghlHosts)) setGhlHosts(args.ghlHosts);
  if (proto.ACTING.has(op) && ctx.stopped()) throw err("stopped");
  if (typeof args.tabId === "number") {
    const v = await ctx.floorAllows(args.tabId, op);
    if (!v.allow) {
      // Say which tab and which page it saw, so "blocked" is never a mystery (the user's chrome.open then snapshot on a site that had not loaded).
      let where = "";
      // A sensitive (blind) page is never named to the model, only Chrome's own error page, which is nothing to protect; every other tier names the page.
      try { const tb = await ctx.tabs.get(args.tabId); const u = String(tb.pendingUrl || tb.url || ""); where = (v.tier === "blind" && !u.startsWith("chrome-error:")) ? `tab ${args.tabId}: ` : `tab ${args.tabId} is on ${u ? redactUrl(u.split(/[?#]/)[0]) : "no page yet"}${tb.status === "loading" ? " (still loading)" : ""}: `; } catch { where = `tab ${args.tabId}: `; }
      throw err("blocked", `${where}${v.why} (${v.tier})`);
    }
  }
  return entry.handler(args, ctx, t);
}

/** Tell every capability about an event from the module (stop, resume, ...). @param {any} evt @param {any} ctx */
export async function deliver(evt, ctx) {
  for (const cap of caps.values()) {
    if (typeof cap.onEvent !== "function") continue;
    try { await cap.onEvent(evt, ctx); } catch { /* one capability's bug must not silence the others */ }
  }
}
