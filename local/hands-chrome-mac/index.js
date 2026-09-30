// @ts-check
// chrome (the hands-chrome-mac folder): deep control of the person's own Chrome through the Vyre
// extension (ADR 0049). The module is the one place a tool call is judged: the named agent must
// hold the one grant, an agent must have posted its plan and the person must not have pressed
// stop (oversight.js), the page must be one Vyre may touch (floor-url.js), and only then does the
// call cross the socket to the extension (bridge.js). What comes back is redacted a second time
// before anyone sees it.
//
// An outward act the extension holds ({held: true, signature, fields}) becomes a Gate card, kind
// "act", from the sender chrome:mac. The person sees the field values and the page's origin;
// chrome.release, which only the Gate calls, sends it again with the signature, and the extension
// refuses it if the page changed in between (the same shape as hands.release).
//
// Starting costs nothing: it listens on a private socket and waits. No extension connected means
// tools say so on the call, in words that say what to do.

import crypto from "node:crypto";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { AsyncLocalStorage } from "node:async_hooks";
import { fileURLToPath } from "node:url";
import { createBridge } from "./bridge.js";
import { createOversight } from "./oversight.js";
import { diagnoseConnection } from "./diagnose.js";
import { classify, originOf } from "./floor-url.js";
import { ACTING } from "./extension/shared/proto.js";
import * as nativeHost from "./native-host/install.js";
import { extensionIdFromKey, extensionIdFromPath } from "./native-host/install.js";
import { callerKind, agentClaim } from "./caller.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** An mcp caller inside a named agent's own thread: the same rule as hands. */
/** Who must hold the grant: null for the person (their own surfaces or unnamed MCP session); a named claim from any route by that name; every other caller by a key that can never be granted, so it is refused (reviewer-2 H1, same rule as hands). */
const agentOf = (/** @type {any} */ caller) => {
  const claim = agentClaim(caller);
  if (claim) return claim;
  return [...PEOPLE, "mcp"].includes(callerKind(caller)) ? null : `caller:${callerKind(caller)}`;
};
const PEOPLE = ["cli", "local", "deck", "capsule"];

/**
 * A URL's origin and path, with no query, fragment or login, and any long token-shaped path
 * segment replaced by an ellipsis. Copied from modules/hands-chrome so events read alike.
 * @param {string} u
 */
export function bareUrl(u) {
  const cut = String(u).split(/[?#]/)[0];
  let head, path;
  try { const x = new URL(cut); head = `${x.protocol}//${x.host}`; path = x.pathname; }
  catch {
    const m = /^([a-z][a-z0-9+.-]*:\/\/)(?:[^/@]*@)?([^/]*)(.*)$/i.exec(cut);
    head = m ? m[1] + m[2] : cut; path = m ? m[3] : "";
  }
  return head + path.replace(/\/[A-Za-z0-9_-]{20,}(?=\/|$)/g, "/…");
}

/** Words about an action, one line of at most 200 characters, every URL made bare. @param {unknown} text */
export function scrub(text) {
  const one = String(text ?? "").replace(/\s+/g, " ").trim();
  const cut = one.replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, bareUrl);
  return cut.length > 200 ? cut.slice(0, 199) + "…" : cut;
}

const str = { type: "string" };
const int = { type: "integer" };
const bool = { type: "boolean" };
const obj = (/** @type {any} */ properties, required = []) => ({ type: "object", properties, required });
const tab = { ...int, description: "Tab id from chrome.tabs. Default: the tab Vyre is working in." };
const selector = {
  type: "object",
  description: "How to find one control: role, name (its label), identifier, container, and frame. Copy it from chrome.snapshot, which puts the control's frame in it.",
  properties: { role: str, name: str, identifier: str, container: str, text: str, ref: str, frame: { description: "Look only in this frame: its index from chrome.snapshot or chrome.frames, its frame id, top, or a piece of its origin or URL. Default: every frame." } },
};
const timeout = { ...int, description: "Give up after this many ms. Default 30000." };
const WAIT = obj({ timeoutMs: { ...int, description: "Keep looking for the control this long: it must exist, be enabled and (with stable) hold still, and loading spinners must clear. Default 0: one look." }, stable: bool, busyMs: { ...int, description: "How long to wait for spinners before giving up on them." } });

/** Which tabs.* op an action means. */
const TAB_OPS = { list: "tabs.list", find: "tabs.find", use: "tabs.use", open: "tabs.open", activate: "tabs.activate", close: "tabs.close", navigate: "tabs.navigate", presence: "tabs.presence" };
const SOURCE_OPS = { list: "dev.sources.list", get: "dev.sources.get", search: "dev.sources.search" };
const NET_OPS = { start: "net.start", list: "net.list", get: "net.get", watch: "net.watch", unwatch: "net.unwatch", on: "net.on", off: "net.off", rules: "net.rules", replay: "net.replay" };
const API_OPS = { learn: "api.learn", catalog: "api.catalog", call: "api.call" };
const GHL_OPS = { context: "ghl.context", section: "ghl.section", flows: "ghl.flows", run: "ghl.run", save: "ghl.save" };

/** @param {any} v */ const isObj = v => v && typeof v === "object" && !Array.isArray(v);

/** @type {{ start(ctx: any): Promise<{ stop(): Promise<void> }> }} */
export default {
  async start(ctx) {
    const cfg = (ctx.config && ctx.config.chrome) || {};
    const bridge = createBridge({ extensionOrigin: cfg.extensionOrigin === undefined ? pinnedOrigin() : cfg.extensionOrigin, sockPath: cfg.sockPath, timeoutMs: cfg.timeoutMs, opTimeouts: cfg.opTimeouts, log: m => ctx.log(m) });
    const host = cfg.nativeHost || nativeHost;
    const floorCfg = cfg.floor || {};

    // Which thread, tool call and agent a call came from, for the events it causes (ADR 0036),
    // carried per call so two calls in flight never trade their labels.
    const via = new AsyncLocalStorage();
    const emit = (/** @type {string} */ type, /** @type {any} */ payload) => {
      const m = /** @type {any} */ (via.getStore()) || {};
      const where = { ...(m.thread ? { thread: String(m.thread) } : {}), ...(m.call ? { call: String(m.call) } : {}) };
      return ctx.events.emit(type, { ...payload, ...where }, where.thread ? { thread: where.thread } : {});
    };
    const oversight = createOversight({ emit, push: f => bridge.push(f), clean: scrub });

    let listenError = null;
    try { await bridge.listen(); } catch (e) { listenError = /** @type {Error} */ (e).message; ctx.log(`chrome bridge is not listening: ${listenError}`); }

    /** Why there is no extension, and the one thing to do (diagnose.js). Null while connected. */
    const diagnose = () => {
      if (bridge.connected()) return null;
      let hostRegistered = true;
      try { const hs = host.status({ home: cfg.home, platform: cfg.platform, vyreHome: cfg.vyreHome, hostDir: cfg.hostDir, registry: cfg.registry }); hostRegistered = Boolean(hs && Array.isArray(hs.installed) && hs.installed.length && hs.launcherExists); } catch { /* unknown: do not blame the install */ }
      return diagnoseConnection({ connected: false, listenError, hostRegistered, stats: bridge.stats() });
    };

    /** @type {Map<number, string>} the last URL seen for each tab, so an op is judged before it is sent */
    const urls = new Map();

    /** Learning what each site looks like is OFF until the person turns it on (config learn, or the memory.site.learn setting), while the store's privacy review is open. */
    const learnOn = () => (typeof cfg.learn === "function" ? cfg.learn() : cfg.learn) === true;
    const off = bridge.on(e => {
      if (e.event === "hello") { emit("chrome.connected", { version: e.version || null, browser: e.browser || null }); void bridge.push({ event: "site.config", learn: learnOn() }); }
      else if (e.event === "disconnected") emit("chrome.disconnected", {});
      // A second connection took over from the live extension. A quiet notice for the panel to show
      // if it wants to, never a prompt: the person may simply have restarted Chrome.
      else if (e.event === "replaced") emit("chrome.replaced", {});
      // The extension saw the person stop Vyre in the browser itself.
      else if (e.event === "stop") oversight.stop({ by: "esc" });
      // The extension asks for what Vyre knows about a site, and sends what it learned (Vyre Memory's memory.site.*, or files in standalone).
      else if (e.event === "site.want" && learnOn()) {
        void (async () => {
          const r = /** @type {any} */ (await ctx.call("memory.site.get", { origin: String(e.origin || ""), ...(Number.isInteger(e.since_rev) ? { since_rev: e.since_rev } : {}) }).catch(() => null));
          const d = r && !r.error ? r.data : null;
          if (d && d.origin && typeof d.origin === "object") void bridge.push({ event: "site.card", origin: String(e.origin), card: d.origin, rev: d.rev });
        })();
      }
      else if (e.event === "site.put" && learnOn()) {
        void (async () => {
          const r = /** @type {any} */ (await ctx.call("memory.site.put", { origin: String(e.origin || ""), target: "origin", patch: e.patch }).catch(() => null));
          if (r && r.data && r.data.accepted) emit("chrome.site-learned", { origin: String(e.origin), rev: r.data.rev });
        })();
      }
      // The person pressed Continue in the extension's own popup: the one place a stop is undone from the browser side.
      else if (e.event === "resume" && e.by === "person") { try { oversight.resume({ answer: "the person pressed Continue in Chrome" }); } catch { /* not stopped */ } }
      // The page asked the person to sign in: one line for the chat, and one when they are in.
      else if (e.event === "login.wall") emit("chrome.signin-asked", { tab: e.tab, app: e.app || null, kind: e.kind || null, message: scrub(String(e.message || "")) });
      else if (e.event === "login.done") emit("chrome.signin-done", { tab: e.tab, app: e.app || null });
    });

    // Esc and a double Control are heard by the hands overlay, which Chrome control shares: one pill,
    // one stop key for everything Vyre does on this Mac. Its stop is our stop.
    const offHands = ctx.events.on("hands.stopped", () => { oversight.stop({ by: "esc" }); });
    /** The pill must be up before Vyre acts in the person's browser, exactly as for the hands. A Mac without the hands module (Windows, a box) has none to show. */
    const indicator = async () => {
      const r = await ctx.call("hands.indicator", { app: "Chrome" });
      if (r && r.error && r.error.code !== "unknown_tool" && r.error.code !== "no_such_tool" && r.error.code !== "not_found") throw Object.assign(new Error(r.error.message), { code: r.error.code || "no_indicator" });
    };

    let offered = false;
    const offer = async () => {
      const r = await ctx.call("gate.offer", { name: "chrome:mac", tool: "chrome.release", kinds: ["act"], recipients: "to",
        content: { app: "string", window: "string?", origin: "string (the page's origin)", control: "string (what will be pressed or sent)", fields: "object? (the values, clipped)" } });
      if (r && r.error) ctx.log(`could not offer the chrome:mac sender: ${r.error.message}`);
      else offered = true;
    };
    await offer();

    /** Everything a model reads of an action stays one scrubbed line; the event carries no query strings. */
    const acted = (/** @type {any} */ meta, /** @type {string|null} */ agent, /** @type {string} */ action, /** @type {boolean} */ ok, /** @type {string|undefined} */ why, /** @type {string} */ summary) => {
      ctx.events.emit("chrome.acted", { ...(agent ? { agent } : {}), action, ok, app: "Chrome", ...(meta && meta.thread ? { thread: String(meta.thread) } : {}), ...(meta && meta.call ? { call: String(meta.call) } : {}), ...(why ? { why: scrub(why) } : {}), summary: scrub(summary) },
        meta && meta.thread ? { thread: String(meta.thread) } : {});
    };

    const denied = (/** @type {string} */ code, /** @type {string} */ message) => Object.assign(new Error(`${code}: ${message}`), { code });

    /** The one grant lives in the hands module: an agent granted to drive the Mac may drive its Chrome. */
    const requireGrant = async (/** @type {string|null} */ agent) => {
      if (!agent) return;
      const r = await ctx.call("hands.grant.list", {});
      const ok = r && !r.error && Array.isArray(r.data) && r.data.some((/** @type {any} */ g) => g.agent === agent);
      if (!ok) throw denied("denied", `${agent} is not granted to drive this Mac. Grant it once with hands.grant.add or ask the person to.`);
    };

    /** Refuse when a page is one Vyre may not touch for this op. @param {string|null|undefined} url @param {string|undefined} op */
    const floor = (url, op) => {
      const c = classify(url, op, floorCfg);
      if (!c.allow) throw denied("blocked", `Vyre may not ${op ? "act on" : "look at"} ${originOf(url || "") || "that page"}: ${c.why}${c.tier === "hands" ? " (it can be read, not acted on)" : ""}.`);
    };

    /** The URLs an op will touch: where it goes (judged as a look) and the tab it acts on (judged as the op). @param {any} args */
    const targets = args => {
      const goes = [];
      if (args.url) goes.push(String(args.url));
      if (args.match && args.match.url) goes.push(String(args.match.url));
      for (const s of Array.isArray(args.steps) ? args.steps : []) { const u = s && s.args && s.args.url; if (u) goes.push(String(u)); }
      const on = Number.isInteger(args.tab) ? urls.get(args.tab) : undefined;
      return { goes, on };
    };

    /** Drop what Vyre may not see from a result, and remember the tabs it names. @param {any} r */
    const screen = r => {
      if (!isObj(r)) return r;
      const note = (/** @type {any} */ t) => { if (isObj(t) && Number.isInteger(t.id) && typeof t.url === "string") urls.set(t.id, t.url); };
      if (Array.isArray(r.tabs)) {
        let hidden = 0;
        const kept = r.tabs.filter((/** @type {any} */ t) => {
          if (isObj(t) && typeof t.url === "string" && classify(t.url, undefined, floorCfg).tier === "blind") { hidden++; if (Number.isInteger(t.id)) urls.set(t.id, t.url); return false; }
          note(t);
          return true;
        });
        return { ...r, tabs: kept, ...(hidden ? { hidden } : {}) };
      }
      note(r); note(r.tab);
      const u = typeof r.url === "string" ? r.url : isObj(r.tab) && typeof r.tab.url === "string" ? r.tab.url : null;
      if (u) {
        const c = classify(u, undefined, floorCfg);
        if (c.tier === "blind") return { blind: true, why: c.why, ...(r.tab !== undefined && isObj(r.tab) ? { tab: r.tab.id } : Number.isInteger(r.id) ? { tab: r.id } : {}), ...(typeof r.failed === "string" ? { loaded: false, failed: r.failed } : {}) };
      }
      return r;
    };

    const clipFields = (/** @type {any} */ f) => {
      if (Array.isArray(f)) return f.slice(0, 40).map(x => isObj(x) ? { ...x, ...(x.value !== undefined ? { value: scrub(x.value) } : {}) } : scrub(x));
      if (isObj(f)) return Object.fromEntries(Object.entries(f).slice(0, 40).map(([k, v]) => [k, typeof v === "string" ? scrub(v) : v]));
      return f;
    };

    /** A sentence for the log about one op, with no values a person typed. @param {string} op @param {any} a */
    const summarize = (op, a) => {
      const bits = [];
      if (a.action) bits.push(a.action);
      if (a.kind) bits.push(a.kind);
      if (a.selector) bits.push([a.selector.role, a.selector.name || a.selector.text].filter(Boolean).join(" "));
      if (a.url) bits.push(bareUrl(a.url));
      if (Array.isArray(a.fields)) bits.push(`${a.fields.length} fields`);
      if (Array.isArray(a.steps)) bits.push(`${a.steps.length} steps`);
      return `${op}${bits.length ? ": " + bits.filter(Boolean).join(" ") : ""}`;
    };

    /** A capability's structured error detail (trace, page snippet), as bounded text the model can read; already masked twice on the way here. @param {any} d */
    const detailText = d => { try { return JSON.stringify(d).slice(0, 3000); } catch { return "unreadable"; } };

    /** Tool errors keep their code so a caller can tell "not connected" from "floor" from "stopped". @param {any} e */
    const wrapErr = e => e && e.code === "error" && /changed since it was held/.test(String(e.message)) ? Object.assign(new Error(`changed: ${e.message}`), { code: "changed" }) : e && e.code && !/^[a-z_]+: /.test(String(e.message)) ? Object.assign(new Error(`${e.code}: ${e.message}${e.detail !== undefined ? ` | detail: ${detailText(e.detail)}` : ""}`), { code: e.code, ...(e.detail !== undefined ? { detail: e.detail } : {}), ...(e.interjection ? { interjection: e.interjection } : {}) }) : e;

    /**
     * The one path every op takes: grant, oversight, floor, the socket, hold. `guarded: false`
     * is for the Gate's release, which is the person's approval of an act already judged.
     * @param {string} op @param {any} input @param {any} meta @param {{ tool?: string, map?: (r: any) => any }} [o]
     */
    async function dispatch(op, input, meta, o = {}) {
      return via.run(meta || {}, async () => {
        const agent = agentOf(meta.caller);
        const args = { ...input };
        delete args.agent; delete args.release; delete args.asked; delete args.action; delete args.writeOk;
        const summary = summarize(op, input);
        /** @type {any} */
        let carry = {};
        try {
          await requireGrant(agent);
          carry = oversight.guard(agent, meta.caller);
          if (ACTING.has(op)) await indicator();
          const { goes, on } = targets(args);
          for (const u of goes) floor(u, undefined);
          if (on) floor(on, op);
          // The person's own direct turn (their CLI, the Capsule) may run an outward act free; an
          // agent's, or the model's in a Claude session, may not: the extension holds those.
          // The person's own list of white-label GoHighLevel hosts (standalone: `config ghl-host`); always sent, so removing one takes effect.
          if (cfg.ghlHosts !== undefined) args.ghlHosts = typeof cfg.ghlHosts === "function" ? cfg.ghlHosts() : cfg.ghlHosts;
          args.asked = PEOPLE.includes(callerKind(meta.caller)) && !agent;
          // Scripts, API calls, replays and automations are hands-free after the grant. The extension
          // holds only a request that SENDS something as the person (a message, a post, a payment)
          // when `asked` is false, judged by method and endpoint (extension/shared/outbound.js).
          let res = screen(await bridge.call(op, args, { timeoutMs: op === "login.wait" ? Math.min(Number(args.timeoutMs) || 120_000, 600_000) + 15_000 : args.timeoutMs }));
          // A write with the page's login that the plan in force covers goes through; the rest wait for the person.
          if (isObj(res) && res.held === true && res.write === true && covers(String(res.kind), res, args)) {
            pinPlan(res, args);
            const g = /** @type {NonNullable<typeof grant>} */ (grant);
            g.left[String(res.kind)]--; g.used++;
            res = screen(await bridge.call(op, { ...args, writeOk: true }, { timeoutMs: args.timeoutMs }));
            recordChange(res, summary, true, urls.get(Number(args.tab)) || "");
            showPresence({ of: g.total, label: g.title });
          }
          // A publish or activate is covered only when the person's own words asked for it and the plan card said "and publish": asking is approving.
          else if (isObj(res) && res.held === true && res.write !== true && res.kind === "publish" && op === "api.call" && covers("publish", res, args)) {
            pinPlan(res, args);
            const g = /** @type {NonNullable<typeof grant>} */ (grant);
            g.left.publish--; g.used++;
            res = screen(await bridge.call(op, { ...args, asked: true }, { timeoutMs: args.timeoutMs }));
            recordChange(res, summary, true, urls.get(Number(args.tab)) || "");
            showPresence({ of: g.total, label: g.title });
          }
          if (isObj(res) && res.held === true) res = await hold(op, args, res, meta, summary);
          else if (op === "batch.run" && isObj(res) && isObj(res.held) && res.held.held === true) {
            // The batch stopped at a held step: the card is for that step, released on its own.
            const step = Array.isArray(args.steps) ? args.steps[res.failedAt] : null;
            const h = await hold(step && step.op ? String(step.op) : op, (step && step.args) || {}, res.held, meta, summary, args.tab);
            const { held, ...rest } = res;
            res = { ...rest, ...h };
          }
          else acted(meta, agent, op, true, undefined, summary);
          if (o.map) res = o.map(res);
          return carry.interjection ? (isObj(res) ? { ...res, interjection: carry.interjection } : { result: res, interjection: carry.interjection }) : res;
        } catch (e) {
          const x = /** @type {any} */ (e);
          // Another program already holds the socket (a second session): say that, not "not connected".
          if (x && x.code === "no_extension") { const d = diagnose(); if (d) x.message = `${d.problem}. ${d.fix}`; }
          acted(meta, agent, op, false, x && x.message ? String(x.message).replace(/^[a-z_]+: /, "") : "failed", summary);
          if (carry && /** @type {any} */ (carry).interjection && x && typeof x === "object") x.interjection = /** @type {any} */ (carry).interjection;
          throw wrapErr(x);
        }
      });
    }

    /** @type {Map<string, { op: string, args: any, signature: any, key: string|null, plan?: any }>} */
    const heldActs = new Map();

    // A plan the person approved once (chrome.approve, released like a send): it covers that many creates, edits and deletes made with the page's login
    // (api.call writes). A publish, a message and a payment are never covered, whatever the plan says: each asks again.
    const PLAN_KINDS = ["create", "edit", "delete", "publish", "send"];
    // Covered by a plan: creates and edits, and a publish only when the person's own words asked for it. A delete and a send always ask, one at a time.
    const PLAN_TTL_MS = 60 * 60_000;
    /** @type {null | { id: string, title: string, items: any[], left: Record<string, number>, total: number, used: number, expiresAt: number, tab?: number|null, tabOrigin?: string, apiOrigin?: string }} */
    let grant = null;
    /** What this run changed, for the finish card: one line each. @type {{ at: number, kind: string, what: string, covered: boolean }[]} */
    const changes = [];
    /** The kind of change this held write is, if the plan in force still covers one. @param {string} kind */
    const covers = (kind, res, args) => {
      if (!grant || oversight.state === "stopped") { grant = grant && oversight.state === "stopped" ? null : grant; return false; }
      if (Date.now() > grant.expiresAt) { grant = null; return false; }
      if ((grant.left[kind] || 0) <= 0) return false;
      // A plan is for one site: the tab it was approved for, that tab's origin, and the one API origin its first write used. Any other is asked.
      const tab = Number(args && args.tab);
      const here = originOf(urls.get(tab) || "");
      if (grant.tab != null && tab !== grant.tab) return false;
      if (grant.tabOrigin && here && here !== grant.tabOrigin) return false;
      const ro = isObj(res) && typeof res.origin === "string" ? res.origin : "";
      if (grant.apiOrigin && ro && ro !== grant.apiOrigin) return false;
      return true;
    };
    /** The first covered write fixes what the plan was for, when the approval did not name a tab. @param {any} res @param {any} args */
    const pinPlan = (res, args) => {
      if (!grant) return;
      const tab = Number(args && args.tab);
      if (grant.tab == null && Number.isInteger(tab)) { grant.tab = tab; grant.tabOrigin = originOf(urls.get(tab) || "") || undefined; }
      if (!grant.apiOrigin && isObj(res) && typeof res.origin === "string") grant.apiOrigin = res.origin;
    };
    /** Tell the extension what to show: a step count, a waiting state, a notification. @param {any} s */
    const showPresence = s => { try { void bridge.push({ event: "presence", ...s }); } catch { /* no extension connected */ } };
    /**
     * Where to open one created thing, from ids the response gave and a URL shape we KNOW: GoHighLevel's builder, /v2/location/<loc>/automation/workflows/<id>, on the shell host the person is using
     * (white-label included). Nothing is guessed for other sites: no link is better than a wrong one. (Learned per site in the site record, chrome-learning-plan.md.)
     * @param {string} tabUrl @param {string} apiPath @param {string} id @param {string} method
     */
    const openLink = (tabUrl, apiPath, id, method) => {
      if (!tabUrl || !id || method === "DELETE") return "";
      try {
        const u = new URL(tabUrl);
        const loc = /\/v2\/location\/([A-Za-z0-9]+)\//.exec(u.pathname);
        if (!loc || !/^https?:$/.test(u.protocol) || !/^[A-Za-z0-9_-]{6,64}$/.test(id)) return "";
        if (/(^|\/)workflows?(\/|$)/i.test(apiPath)) return `${u.origin}/v2/location/${loc[1]}/automation/workflows/${id}`;
      } catch { /* not a URL */ }
      return "";
    };
    /** A change the run made with the page's login, for the summary and the card. @param {any} res @param {string} summary @param {boolean} covered @param {string} [tabUrl] the page the call was made from */
    const recordChange = (res, summary, covered, tabUrl = "") => {
      if (!isObj(res) || res.ok === false || res.held) return;
      const method = String(res.method || "").toUpperCase();
      if (!method || /^(GET|HEAD|OPTIONS)$/.test(method)) return;
      const kind = /** @type {any} */ ({ POST: "create", PUT: "edit", PATCH: "edit", DELETE: "delete" })[method] || "edit";
      let id = "";
      try { const b = JSON.parse(String(res.responseBody || "null")); const d = b && (b.data || b); id = String((d && (d.id || d._id)) || "").slice(0, 80); if (!/^[A-Za-z0-9_-]{4,64}$/.test(id)) id = ""; } catch { /* not JSON */ }
      const where = originOf(String(res.url || "")) || "";
      let path = ""; try { path = new URL(String(res.url || "")).pathname; } catch { /* no url */ }
      const open = openLink(tabUrl, path, id, method);
      const c = { at: Date.now(), ...(open ? { url: open } : {}), kind, method, what: scrub(`${kind} ${path || summary}${id ? ` (${id})` : ""}`).slice(0, 160), ...(id ? { id } : {}), ...(where ? { origin: where } : {}), ...(path ? { path } : {}), ...(res.status ? { status: res.status } : {}), covered };
      changes.push(c); while (changes.length > 200) changes.shift();
      showPresence({ change: { kind, what: c.what, ...(open ? { url: open } : {}) } });
    };
    // The person pressing stop ends the plan: what they approved was for a run they have now halted.
    const offStop = ctx.events.on("chrome.stopped", () => { grant = null; });

    /** An outward act the extension held: ask the person at the Gate, with the fields and origin. */
    async function hold(/** @type {string} */ op, /** @type {any} */ args, /** @type {any} */ res, /** @type {any} */ meta, /** @type {string} */ summary, /** @type {any} */ batchTab) {
      const tabId = Number.isInteger(args.tab) ? args.tab : batchTab;
      const url = String(res.url || (Number.isInteger(tabId) ? urls.get(tabId) : "") || args.url || "");
      // The extension names it sig, because redact.value masks any key called signature.
      const signature = res.sig ?? res.signature;
      const control = isObj(res.control) ? [res.control.role, res.control.name].filter(Boolean).join(" ") : res.control;
      const origin = originOf(url) || "this page";
      const { asked, release, ...replay } = args;
      // What to replay stays HERE keyed by the Gate's id; the card carries only what the person
      // reads, so an agent's own gate.request cannot make release run anything (reviewer-2 H2/HIGH).
      const record = { op, args: Number.isInteger(tabId) && replay.tab === undefined ? { ...replay, tab: tabId } : replay, signature, key: agentOf(meta.caller), ...(res.plan ? { plan: res.plan } : {}) };
      const content = { app: "Chrome", window: scrub(res.title || ""), origin, control: scrub(control || res.why || summary), fields: clipFields(res.fields), ...(res.plan ? { kind: "plan" } : {}) };
      // The Gate sends at once what the person's own words or a standing permission covered, and it
      // calls release before gate.request has returned an id. So the record is filed under a fresh
      // random ref first, and release finds it by that ref as well as by id. The ref rides on the
      // card and nowhere an agent reads, and it is deleted on use.
      const ref = crypto.randomBytes(9).toString("hex");
      heldActs.set(ref, record);
      // The Gate may have started after this module; offer again before the first card needs it.
      if (!offered) await offer();
      const r = await ctx.call("gate.request", { kind: "act", via: "chrome:mac", to: origin, content: { ...content, ref }, ...(meta && meta.thread ? { thread: String(meta.thread) } : {}) });
      const agent = agentOf(meta.caller);
      // Covered by what the person said (asked, or a standing permission): the Gate already released it.
      if (r && !r.error && r.data && r.data.state === "sent") {
        heldActs.delete(ref);
        acted(meta, agent, op, true, "the person's own words covered it, so it went out", summary);
        return r.data.result;
      }
      if (!r || r.error || !r.data) {
        heldActs.delete(ref);
        acted(meta, agent, op, false, "held, but there is no Gate to ask the person at", summary);
        return { held: true, gate: false, origin, why: "This sends something as the person and there is no Gate to ask them at, so it was not done." };
      }
      heldActs.delete(ref);
      heldActs.set(String(r.data.id), record);
      while (heldActs.size > 200) heldActs.delete(/** @type {string} */ (heldActs.keys().next().value));
      acted(meta, agent, op, true, "held for the person's approval", summary);
      // Seen, not just asked: the badge turns amber, the pill says so, and Chrome raises a notification the person cannot miss.
      showPresence({ waiting: `approve: ${String(content.control).slice(0, 70)}`, notify: { title: res.plan ? "Vyre needs you to approve a plan" : "Vyre needs your approval", message: `${String(content.control).slice(0, 120)} (${origin})` } });
      return { held: true, id: r.data.id, origin, fields: content.fields, why: cfg.sendTool
        ? `This sends something as the person, so it was not done. To do it, call ${cfg.sendTool} with this id; the person approves that call. It is refused if the page has changed since.`
        : "This sends something as the person. It waits for their approval at the Gate." };
    }

    /** @param {string} name @param {string} description @param {any} input @param {(i: any, m: any) => Promise<any>} run @param {any} [extra] */
    const tool = (name, description, input, run, extra = {}) => ctx.tool(name, { description, input, run: async (/** @type {any} */ i, /** @type {any} */ m) => run(i || {}, m || {}), ...extra });

    const pass = (/** @type {string} */ name, /** @type {string} */ op, /** @type {string} */ description, /** @type {any} */ props) =>
      tool(name, description, obj({ tab, timeoutMs: timeout, ...props }), (i, m) => dispatch(op, i, m));

    tool("chrome.tabs", "The tabs in the person's own Chrome. list: every tab (id, title, URL; pages Vyre may not look at are left out and counted in hidden). find: tabs matching a URL, origin or title. use: reuse a matching tab, and open one only when none matches and url is given (openIfMissing); it never steals focus unless focus is true. open: a new tab (avoid: prefer use). activate: bring a tab to the front. close: only a tab Vyre opened. navigate: send a tab to a URL.",
      obj({ action: { type: "string", enum: Object.keys(TAB_OPS) }, tab, url: str, press: { ...str, description: "For presence: press one of the pill's own buttons (Stop or Pause) with a real click, the same as the person clicking it." }, match: obj({ url: str, origin: str, title: str }), openIfMissing: bool, focus: bool, timeoutMs: timeout }, ["action"]),
      (i, m) => { const { action, ...rest } = i; return dispatch(/** @type {Record<string,string>} */ (TAB_OPS)[action], { ...rest, action }, m); });

    tool("chrome.frames", "The tab's frames (iframes, including cross-origin ones that run in their own process): each with its origin, whether Vyre can read it, and which cannot be read and why. list shows them; clicktest is a diagnostic that clicks one element both ways Input can be sent and counts what the page received; probe reads each readable frame's title and control count, which is the quick way to see that child frames work here. A modern app (GoHighLevel's workflow builder, embedded editors and payment forms) lives in an iframe, so the top page alone can be only its shell.",
      obj({ action: { type: "string", enum: ["list", "probe", "clicktest"] }, tab, frame: { ...str, description: "For clicktest: the frame (index, id or piece of its origin)." }, css: { ...str, description: "For clicktest: a CSS selector of the element to click, default button." }, timeoutMs: timeout }),
      (i, m) => dispatch(i.action === "probe" ? "frames.probe" : i.action === "clicktest" ? "frames.clicktest" : "frames.list", { ...(i.tab !== undefined ? { tab: i.tab } : {}), ...(i.frame !== undefined ? { frame: i.frame } : {}), ...(i.css ? { css: i.css } : {}), ...(i.timeoutMs ? { timeoutMs: i.timeoutMs } : {}) }, m));

    pass("chrome.snapshot", "page.snapshot", "The actionable controls of a page in one read: role, name, state, and a selector to hand to chrome.act or chrome.fill, plus the text on screen (secrets in it are masked). It reads EVERY frame of the tab (an app's iframes, cross-origin ones too): each control carries its frame, frames lists them, and a frame Vyre cannot read is named in notReadable and in the text, never left out. Nothing is returned from pages Vyre may not look at.", { limit: { ...int, description: "Most controls to return, shared out across the frames (each keeps a minimum; main content and dialogs come before navigation)." }, agent: str });
    pass("chrome.act", "page.act", "Do one thing to one control found by selector, in any frame of the tab (selector.frame pins one; a match in two frames is tied unless one is in an open dialog): click, type (with value), select an option, check a box, or press a key (value: the key). An act that sends something as the person (a real submit, a Send, Pay or Post control, decided from the page itself) is held for their approval at the Gate unless they asked for it directly: the answer has held: true.",
      { selector, kind: { type: "string", enum: ["click", "type", "select", "check", "press"] }, value: { ...str, description: "For type and select: the text or option. For press: the key, e.g. Enter." }, wait: WAIT, optional: { ...bool, description: "True: if nothing matches, answer skipped instead of failing." }, fillable: { ...bool, description: "True: match only form fields, by their label." } });
    pass("chrome.fill", "page.fill", "Set many form fields in one step, across the tab's frames: fields is a list of {selector, value}. Values a person typed never come back in results. A submit is held like chrome.act's.", { fields: { type: "array", items: obj({ selector, label: { ...str, description: "Instead of a selector: the field's visible label." }, value: str, optional: bool }) }, submit: bool, partial: { ...bool, description: "True: set the fields that are found and report the rest (notFound) instead of failing before setting any." }, wait: WAIT });
    pass("chrome.eval", "page.eval", "Run a JavaScript expression in a tab and return its JSON result. Values shaped like credentials (tokens, keys, JWTs, values under secret-looking names) are masked; other values come back as the page holds them, so an expression can still read a short cookie or a typed field. Runs in the top page unless frame names one (an index, frame id, or a piece of its origin or URL). Refused when a visible password field is in ANY readable frame of the tab. A script can read with the page's login but cannot write with it: a POST, PUT, PATCH or DELETE it makes is refused and nothing is sent, and a script that opens the page's stored login (IndexedDB or storage auth tokens, cookies) is refused. PREFER chrome_api call OVER eval-fetch: it signs the request with the page's own login inside the page, so the token is never in a script or in your hands, and a write is asked first. A message, post or payment the script tries to send is held for the person's approval.", { expression: str, frame: { description: "Run in this frame: its index, frame id, or a piece of its origin or URL. Default: the top page." } });
    pass("chrome.wait", "page.wait", "Wait for exactly one thing: a control (selector), the URL to contain some text (url), or the network to be quiet for idleMs, up to timeoutMs. It looks in every frame of the tab, including one that appears or navigates while waiting; frame limits it to one.", { selector: { description: "A selector object, or a CSS selector string." }, url: { ...str, description: "Wait until the page URL contains this." }, idleMs: { ...int, description: "Wait until the network has been quiet this long." }, settled: { ...bool, description: "Wait until loading spinners are gone and the DOM and network are quiet." }, enabled: bool, stable: bool, gone: { ...bool, description: "With selector: wait until it is absent." }, quietMs: int, netQuietMs: int, frame: { description: "Look only in this frame: its index, frame id, or a piece of its origin or URL. Default: every frame." } });
    pass("chrome.screenshot", "page.screenshot", "A PNG of a tab (or of one control), base64-encoded. Nothing from pages Vyre may not look at.", { agent: str });
    pass("chrome.batch", "batch.run", "Run a list of steps inside the browser with no round trip between them: fastest for a known sequence. It stops at the first failure, on the person's stop, or at a page Vyre may not touch, and says which step. Give saveAs a name and, when every step worked, the batch is kept as a recipe for this site (what was typed becomes {parameters}; chrome_recipe replays it in one call).", { steps: { type: "array", items: { type: "object" } }, saveAs: { ...str, description: "Keep this batch as a named recipe when every step works." } });
    pass("chrome.inspect", "dev.inspect", "DevTools' view of the page: an element's outerHTML, attributes and box model, computed styles, the CSS rules that match it, and its event listeners. Reads the top page unless frame names one (a cross-origin iframe is read through its own session).", { selector, what: { type: "array", items: { type: "string", enum: ["dom", "box", "styles", "rules", "listeners"] } }, frame: { description: "Inspect in this frame: its index, frame id, or a piece of its origin. Default: the top page." } });
    tool("chrome.sources", "The page's scripts: list them, get one by id, or search across all of them. Source maps' file names come with them. Scripts of every frame (cross-origin iframes too) are covered; each carries its frame, and frame limits a list or search to one.",
      obj({ action: { type: "string", enum: Object.keys(SOURCE_OPS) }, tab, id: str, query: str, limit: int, frame: { description: "Only scripts of this frame: a piece of its origin." }, timeoutMs: timeout }, ["action"]),
      (i, m) => { const { action, ...rest } = i; return dispatch(/** @type {Record<string,string>} */ (SOURCE_OPS)[action], { ...rest, action }, m); });
    pass("chrome.console", "dev.console.read", "The page's console: messages, exceptions and log entries kept in a ring buffer, newest last. It holds every frame's messages (cross-origin iframes too); each entry carries its frame, and frame limits the read to one.", { limit: int, level: str, clear: bool, frame: { description: "Only this frame's entries: a piece of its origin." } });
    tool("chrome.net", "The page's network traffic. start: begin capturing. list and get: what was captured (headers and bodies with every credential masked). watch and unwatch: live capture. on and off: act on matching requests (block, mock, change headers, wait then run a step). rules: the active on rules. replay: re-send a captured request from inside the page, so its own cookies sign it and no credential leaves the browser. Every frame of the tab is captured (cross-origin iframes and nested ones too): a request carries frame, its origin, and frame (here or inside filter) limits list, get and watch to one. A request an iframe made is replayed inside that iframe.",
      obj({ action: { type: "string", enum: Object.keys(NET_OPS) }, tab, id: str, frame: { description: "Only requests of this frame: a piece of its origin." }, filter: { type: "object" }, then: { type: "object" }, limit: int, timeoutMs: timeout }, ["action"]),
      (i, m) => { const { action, ...rest } = i; return dispatch(/** @type {Record<string,string>} */ (NET_OPS)[action], { ...rest, action }, m); });
    tool("chrome.api", "An app's own API, learned from its traffic. learn: reduce captured requests to a catalog (method, path, query and body shape, auth kind, sample status; values masked). catalog: read it. call: invoke one entry from inside the page. learn sees the calls of every frame, including a cross-origin iframe's (the workflow builder), and each entry records the frame it was learned in; call runs in that frame by default, so its own cookies and auth sign it, or in the frame you name. This is the way to call an app's backend with the person's login: prefer call over a fetch in chrome_eval, which cannot write and cannot read the stored login. A write (POST, PUT, PATCH, DELETE) is held for the person unless a plan they approved once (chrome_approve) covers it; a publish, a message or a payment always asks.",
      obj({ action: { type: "string", enum: Object.keys(API_OPS) }, tab, frame: { description: "For call: run in this frame (index, frame id, or a piece of its origin). Default: the frame the entry was learned in." }, entry: str, args: { type: "object" }, host: str, timeoutMs: timeout }, ["action"]),
      (i, m) => { const { action, ...rest } = i; return dispatch(/** @type {Record<string,string>} */ (API_OPS)[action], { ...rest, action }, m); });
    tool("chrome.ghl", "GoHighLevel in the person's own Chrome. context: which sub-account and section the open tab is on. section: go to Contacts, Workflows, Conversations and so on in the tab already open (it never opens another). flows: the ready-made automations. run: do one end to end, either a named flow with params or your own steps, as ONE batch inside the browser, and get back how long it took. save: press Save and verify it saved (toast, disabled Save, URL change or list item); a save that cannot be confirmed is an error. Every result carries a trace, and a failure's error carries the page's host and path and a small masked snippet of the page.",
      obj({ action: { type: "string", enum: Object.keys(GHL_OPS) }, tab, section: str, locationId: str, landmark: str, via: { ...str, description: "For section: nav (default, click the left nav) or url." }, expect: { type: "object", description: "For save: {toast, listItem, status} to check besides the built-in evidence." }, name: str, identifier: str, flow: str, params: { type: "object" }, steps: { type: "array", items: { type: "object" } }, timeoutMs: timeout }, ["action"]),
      (i, m) => { const { action, ...rest } = i; return dispatch(/** @type {Record<string,string>} */ (GHL_OPS)[action], { ...rest, action }, m); });
    tool("chrome.site", "What Vyre for Chrome has learned about a site, from this device: the frame layout, stable controls, the site's own API endpoints, login signals. Structure only: never a value, token or personal data. Give a tab (default: the current one) or an origin.",
      obj({ tab, origin: str }),
      (i, m) => dispatch("site.card", { ...(i.tab !== undefined ? { tab: i.tab } : {}), ...(i.origin ? { origin: i.origin } : {}) }, m));
    tool("chrome.recipe", "Replay a flow that already worked on this site as ONE call: no model turn between steps. list: the recipes for this tab's site (name, steps, parameters, runs, what they write). run: name the recipe and give its parameters; it runs as a normal batch (the stop switch, the URL floor, the send-hold and any plan approval all apply). A recipe is saved when chrome_batch is given saveAs and every step worked; what a person typed is never kept, only {parameters}. Recipes last until the browser closes unless learning is on.",
      obj({ action: { type: "string", enum: ["list", "run", "forget"] }, tab, name: str, params: { type: "object", description: "For run: a value for each parameter the recipe lists." }, timeoutMs: timeout }, ["action"]),
      (i, m) => dispatch(i.action === "run" ? "recipe.run" : i.action === "forget" ? "recipe.forget" : "recipe.list", { ...(i.tab !== undefined ? { tab: i.tab } : {}), ...(i.name ? { name: i.name } : {}), ...(i.params ? { params: i.params } : {}), timeoutMs: i.timeoutMs }, m));
    tool("chrome.login", "A page is asking the person to sign in (a password, a one-time code, or a sign-in page). check: is this tab at a login wall. wait: bring the tab to the front, outline the form, tell the person once, and wait until they are in (the wall gone for two looks), up to timeoutMs (default 2 minutes, at most 10); ask again to keep waiting. Vyre never types a password: the person does, or a vault fill with Touch ID. A failed step on a login page already does the handoff and answers login_required; call wait then.",
      obj({ action: { type: "string", enum: ["check", "wait"] }, tab, timeoutMs: timeout }, ["action"]),
      (i, m) => dispatch(i.action === "wait" ? "login.wait" : "login.check", { ...(i.tab !== undefined ? { tab: i.tab } : {}), ...(i.timeoutMs ? { timeoutMs: i.timeoutMs } : {}) }, m));
    pass("chrome.state", "dev.state", "What a page has stored, by name only: cookie names and flags, localStorage and sessionStorage keys. Values are never returned.", { what: { type: "array", items: { type: "string", enum: ["cookies", "local", "session"] } } });

    // The box's Chrome tools, same input shapes, so one prompt works against either target.
    tool("chrome.click", "Click a control, chosen by role/name/identifier against a fresh look at the page. An outward control (send, pay, post, submit) is held for the person's approval.",
      obj({ agent: str, selector: obj({ role: str, identifier: str, name: str, container: str }) }, ["selector"]),
      (i, m) => dispatch("page.act", { selector: i.selector, kind: "click", ...(i.tab !== undefined ? { tab: i.tab } : {}) }, m));
    tool("chrome.type", "Type text into a text field, chosen by role/name/identifier against a fresh look at the page.",
      obj({ agent: str, selector: obj({ role: str, identifier: str, name: str, container: str }), text: str }, ["selector", "text"]),
      (i, m) => dispatch("page.act", { selector: i.selector, kind: "type", value: i.text }, m));
    tool("chrome.open", "Go to a URL in the person's Chrome: reuse a tab already on that site, or open one if there is none. Never takes focus.",
      obj({ agent: str, url: str }, ["url"]),
      (i, m) => {
        if (!/^https?:\/\//.test(String(i.url))) throw Object.assign(new Error(`bad_request: "${i.url}" is not an http(s) URL`), { code: "bad_request" });
        return dispatch("tabs.use", { url: i.url, openIfMissing: true }, m, { map: r => { const t = isObj(r) && isObj(r.tab) ? r.tab : r; return isObj(t) && t.blind ? { ok: false, ...t } : { ok: true, title: t && t.title, url: t && t.url, ...(t && typeof t.loaded === "boolean" ? { loaded: t.loaded } : {}), ...(t && t.stillLoading ? { stillLoading: true } : {}), ...(isObj(r) && r.interjection ? { interjection: r.interjection } : {}) }; } });
      });

    // Oversight: the plan, the person's word, and stop.
    tool("chrome.approve", "Ask the person to approve a plan ONCE before a job with many changes, for example \"create these 8 workflows as drafts\". items is what you will do: {kind: create | edit | delete | publish | send, what, count}. You get an id back; the person approves it by your calling chrome_send with that id. Once approved, that many creates, edits and deletes made with the page's login (chrome_api call writes) go through without asking again, and the page shows step N of M. A delete, a message to a contact and a payment are never covered: each asks one at a time. A publish is covered only when you set asked: true because the person's own words asked for it (\"build and publish these\"); the card then says \"and publish\" plainly. A plan ends after an hour, when the person stops Vyre, or when you approve another. Without a plan, every write asks.",
      obj({ title: str, items: { type: "array", items: obj({ kind: { type: "string", enum: PLAN_KINDS }, what: str, count: { type: "number" }, asked: { type: "boolean", description: "For publish: true only when the person's own words asked for it (\"build and publish these\"). Without it a publish asks one at a time." } }, ["kind", "what"]) }, tab }, ["title", "items"]),
      async (i, meta) => {
        const agent = agentOf(meta.caller);
        await requireGrant(agent);
        const raw = Array.isArray(i.items) ? i.items : [];
        if (!raw.length || raw.length > 40) throw denied("bad_request", "a plan needs between 1 and 40 items");
        const items = raw.map((/** @type {any} */ x) => {
          const kind = String(x && x.kind);
          if (!PLAN_KINDS.includes(kind)) throw denied("bad_request", `an item's kind must be one of ${PLAN_KINDS.join(", ")}`);
          const what = scrub(String(x && x.what || "").slice(0, 160));
          if (!what.trim()) throw denied("bad_request", "every item needs text that says what it does");
          return { kind, what, count: Math.min(50, Math.max(1, Math.floor(Number(x && x.count) || 1))), ...(kind === "publish" && x && x.asked === true ? { asked: true } : {}) };
        });
        const title = scrub(String(i.title || "").slice(0, 120)) || "Plan";
        const left = { create: 0, edit: 0, publish: 0 };
        for (const it of items) if (it.kind in left && (it.kind !== "publish" || it.asked)) /** @type {any} */ (left)[it.kind] += it.count;
        const total = items.reduce((/** @type {number} */ n, /** @type {any} */ it) => n + it.count, 0);
        const tabId = Number.isInteger(i.tab) ? i.tab : undefined;
        const plan = { id: crypto.randomBytes(6).toString("hex"), title, items, left, total, ...(tabId !== undefined ? { tab: tabId, tabOrigin: originOf(urls.get(tabId) || "") || undefined } : {}) };
        const res = { held: true, sig: "plan", plan, url: tabId !== undefined ? urls.get(tabId) : "", control: `Plan: ${title}`, fields: items.map((/** @type {any} */ it) => ({ name: it.kind === "publish" && it.asked ? `and publish x${it.count}` : `${it.kind} x${it.count}`, value: it.what })) };
        const h = await via.run(meta, async () => hold("chrome.approve", {}, res, meta, `approve plan: ${title}`, tabId));
        return isObj(h) && h.held && h.id ? { ...h, plan: { title, total, items: items.length }, why: `This plan waits for the person's approval. To start it, call ${cfg.sendTool || "the Gate"} with this id; the person approves that call. Deleting, messaging and payments stay one-at-a-time whatever the plan says, and so does publishing unless the plan says the person asked for it.` } : h;
      });

    tool("chrome.summary", "Finish a job: what this run changed in the person's Chrome, in words they can read, with what can be undone. Call it when the job is done and show the person the lines. It also puts the same card on their screen. clear (default true) starts the next job's list empty.",
      obj({ clear: bool }),
      async (i, meta) => {
        const counts = { create: 0, edit: 0, delete: 0 };
        for (const c of changes) if (c.kind in counts) /** @type {any} */ (counts)[c.kind]++;
        const list = changes.map(c => ({ kind: c.kind, what: c.what, ...(c.id ? { id: c.id } : {}), ...(c.url ? { open: c.url } : {}), covered: c.covered,
          undo: c.kind === "create" && c.id ? `delete ${c.id}` : c.kind === "create" ? "delete it by hand (its id was not returned)" : c.kind === "edit" ? "no automatic undo: Vyre did not keep the old value" : "cannot be undone" }));
        const lines = [
          list.length ? `${list.length} change${list.length === 1 ? "" : "s"} made: ${counts.create} created, ${counts.edit} edited, ${counts.delete} deleted.` : "Nothing was changed with the page's login.",
          ...list.map(c => `- ${c.what}${c.open ? ` (open: ${c.open})` : ""}${c.undo && !/^cannot/.test(c.undo) ? ` (undo: ${c.undo})` : ""}`),
          heldActs.size ? `${heldActs.size} action${heldActs.size === 1 ? " is" : "s are"} still waiting for the person's approval.` : "",
          grant ? `Plan "${grant.title}": ${grant.used} of ${grant.total} used.` : "",
        ].filter(Boolean);
        const out = { changes: list, counts, pendingApprovals: heldActs.size, plan: grant ? { title: grant.title, used: grant.used, total: grant.total } : null, lines };
        showPresence({ done: true });
        if (i.clear !== false) { changes.length = 0; }
        return out;
      });

    tool("chrome.plan", "Post what you are about to do in the person's Chrome, as a short list of steps ({id, text, risk?}), before your first action: they see it and can interject or stop. Then report each step with step and status (running, done, failed), and finish when the run is over.",
      obj({ title: str, steps: { type: "array", items: obj({ id: str, text: str, risk: str }, ["text"]) }, step: str, status: { type: "string", enum: ["running", "done", "failed"] }, why: str, finish: bool, agent: str }),
      async (i, meta) => {
        const agent = agentOf(meta.caller);
        await requireGrant(agent);
        const name = agent || (i.agent ? String(i.agent) : "you");
        return via.run(meta, async () => {
          if (Array.isArray(i.steps)) return oversight.plan(name, i.steps, { thread: meta.thread, title: i.title });
          if (i.finish) { showPresence({ done: true }); return oversight.finish(name); }
          if (i.step) return i.status === "done" ? oversight.stepDone(i.step) : i.status === "failed" ? oversight.stepFailed(i.step, i.why) : oversight.stepStarted(i.step);
          throw Object.assign(new Error("bad_request: give steps to post a plan, or step and status to report one"), { code: "bad_request" });
        }).catch(e => { throw wrapErr(e); });
      });
    tool("chrome.interject", "Tell the agent something while it works in Chrome, by prompt or voice: its next call comes back with it (once), so it can change course.",
      obj({ text: str, from: { type: "string", enum: ["prompt", "voice"] } }, ["text"]),
      (i, m) => via.run(m, async () => oversight.interject({ from: i.from, text: i.text })).catch(e => { throw wrapErr(e); }), { callers: PEOPLE });
    tool("chrome.stop", "Stop working in Chrome now, as Escape does. The next call is refused and the extension halts a running batch within a step. Nothing continues until the person answers and chrome.resume is called. Pressing it twice is one stop.",
      obj({ by: { type: "string", enum: ["esc", "user", "agent-error"] } }),
      (i, m) => via.run(m, async () => oversight.stop({ by: i.by })));
    tool("chrome.resume", "Carry on after a stop, once the person has answered. Their answer, if any, reaches the agent on its next call.",
      obj({ answer: str }),
      (i, m) => via.run(m, async () => oversight.resume({ answer: i.answer })).catch(e => { throw wrapErr(e); }), { callers: PEOPLE });

    // The panel's own controls (the person, never a model): pause, retext a step that has not started, and the live voice line.
    tool("chrome.pause", "Pause the run at once, as the person from the panel. It holds exactly like Esc until they resume.",
      obj({ run: str }),
      (i, m) => via.run(m, async () => oversight.pause({ run: i.run })).catch(e => { throw wrapErr(e); }), { callers: PEOPLE });
    tool("chrome.plan.edit", "Change the words of a plan step that has not started, as the person from the panel. A running or finished step cannot be edited, only steered with chrome.interject. The plan is sent again.",
      obj({ run: str, step: str, text: str }, ["step", "text"]),
      (i, m) => via.run(m, async () => oversight.editStep({ run: i.run, step: i.step, text: i.text })).catch(e => { throw wrapErr(e); }), { callers: PEOPLE });
    tool("chrome.voice", "The person's live speech while an agent works in Chrome, for the panel to show. A final phrase also reaches the agent as an interjection, once, on its next call.",
      obj({ run: str, text: str, final: bool }, ["text"]),
      (i, m) => via.run(m, async () => oversight.voice({ run: i.run, text: i.text, final: i.final === true })).catch(e => { throw wrapErr(e); }), { callers: PEOPLE });

    // The Gate's own call once the person approved a held act.
    ctx.tool("chrome.release", {
      internal: true,
      description: "The Gate's own call once a person approved a held act in Chrome: sends it again with the page signature it was held under, and the extension refuses it (changed) if the page moved since. Never called directly.",
      input: obj({ id: str, to: { type: "array", items: str }, content: { type: "object" } }, ["id", "content"]),
      run: async (/** @type {any} */ input, /** @type {any} */ meta) => {
        if (!meta || meta.caller !== "module:gate") throw denied("denied", "only the Gate releases a held act");
        const ref = input.content && typeof input.content.ref === "string" ? input.content.ref : "";
        const rkey = heldActs.has(String(input.id)) ? String(input.id) : ref;
        const c = heldActs.get(rkey);
        if (!c || !c.op || c.signature === undefined) throw denied("denied", "that held act is not one Chrome control made, or it was already released");
        heldActs.delete(rkey);
        await requireGrant(c.key);
        if (c.plan) {
          grant = { ...c.plan, used: 0, expiresAt: Date.now() + PLAN_TTL_MS, tab: Number.isInteger(c.plan.tab) ? c.plan.tab : null, tabOrigin: c.plan.tabOrigin || undefined };
          showPresence({ of: c.plan.total, label: c.plan.title, waiting: null });
          return { ok: true, approved: true, title: c.plan.title, covers: { ...c.plan.left }, total: c.plan.total, expiresInMinutes: PLAN_TTL_MS / 60_000 };
        }
        showPresence({ waiting: null });
        return via.run(meta, async () => {
          const summary = summarize(String(c.op), c.args || {});
          try {
            oversight.guard(null, "module:gate");
            const { goes, on } = targets(c.args || {});
            for (const u of goes) floor(u, undefined);
            if (on) floor(on, String(c.op));
            const res = screen(await bridge.call(String(c.op), { ...(c.args || {}), asked: true, release: { sig: c.signature, signature: c.signature } }, { timeoutMs: (c.args || {}).timeoutMs }));
            acted(meta, null, String(c.op), true, undefined, `released ${summary}`);
            if (String(c.op) === "api.call") recordChange(res, summary, false, urls.get(Number((c.args || {}).tab)) || "");
            return res;
          } catch (e) {
            const x = /** @type {any} */ (e);
            acted(meta, null, String(c.op), false, x && x.code === "changed" ? "the page changed after it was held, so nothing was sent" : x && x.message, `released ${summary}`);
            throw wrapErr(x);
          }
        });
      },
    });

    // Status and install.
    tool("chrome.status", "Is Vyre's Chrome extension connected, is its native host installed, how many tabs are open and how many Vyre is attached to, and what the oversight panel says.",
      obj({}),
      async () => {
        let tabs = null, attached = null;
        if (bridge.connected()) {
          try {
            const r = await bridge.call("tabs.list", {}, { timeoutMs: 3000 });
            const list = isObj(r) && Array.isArray(r.tabs) ? r.tabs : Array.isArray(r) ? r : null;
            if (list) { tabs = list.length + (isObj(r) && r.hidden ? r.hidden : 0); attached = list.filter((/** @type {any} */ t) => t && t.attached).length; }
          } catch { /* the count is a nicety; connected is the answer */ }
        }
        let hostStatus = null;
        try { hostStatus = host.status({ home: cfg.home, platform: cfg.platform, vyreHome: cfg.vyreHome, hostDir: cfg.hostDir, registry: cfg.registry }); } catch (e) { hostStatus = { error: /** @type {Error} */ (e).message }; }
        const installed = Boolean(hostStatus && Array.isArray(hostStatus.installed) && hostStatus.installed.length && hostStatus.launcherExists);
        const why = diagnose();
        return { connected: bridge.connected(), extension: bridge.info(), listening: !listenError, ...(listenError ? { listenError } : {}), ...(why ? { problem: why.problem, fix: why.fix, stage: why.stage } : {}), socket: bridge.stats(), hostInstalled: installed, host: hostStatus, tabs, attached, oversight: oversight.snapshot() };
      });

    tool("chrome.install", "Set up the Vyre Chrome connector: registers the native host with Chrome (and the other Chromium browsers found), then returns the steps the person does in Chrome to load the extension.",
      obj({ extensionId: str, browsers: { type: "array", items: { type: "string", enum: ["chrome", "chromium", "brave", "edge", "dia", "arc"] } }, extensionDir: str }),
      async i => {
        const dir = String(i.extensionDir || cfg.extensionDir || path.join(HERE, "extension"));
        let id = i.extensionId ? String(i.extensionId) : null;
        if (!id) {
          try { const k = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8")).key; if (k) id = extensionIdFromKey(k); } catch { /* no manifest yet */ }
          if (!id) id = extensionIdFromPath(dir, cfg.platform);
        }
        const r = host.install({ home: cfg.home, platform: cfg.platform, vyreHome: cfg.vyreHome, hostDir: cfg.hostDir, registry: cfg.registry, extensionId: id, browsers: i.browsers });
        return { ...r, extensionDir: dir, steps: guide(dir, id, r.written.map((/** @type {any} */ w) => w.browser)) };
      }, { callers: PEOPLE });

    return {
      async stop() { off(); if (typeof offHands === "function") offHands(); if (typeof offStop === "function") offStop(); await bridge.close(); },
    };
  },
};

/**
 * The origin the native host is expected to name, derived from the manifest's public key. This is
 * NOT authentication: the host reports the origin Chrome gave it, but any process of this user can
 * write the same bytes to the socket. It keeps a host started by some other extension or browser
 * profile from being taken for ours; the socket's 0600 mode inside a 0700 folder is what keeps other
 * users out, and the floor, the grant and the Gate are what keep a same-user process honest.
 */
function pinnedOrigin() {
  try {
    const k = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "extension", "manifest.json"), "utf8")).key;
    return k ? `chrome-extension://${extensionIdFromKey(k)}/` : null;
  } catch { return null; }
}

/** The steps a person does in Chrome, in plain words. @param {string} dir @param {string} id @param {string[]} browsers */
export function guide(dir, id, browsers) {
  return [
    `Vyre's connector is registered for ${browsers.join(", ")}. Two steps remain in the browser:`,
    "1. Open chrome://extensions and turn on Developer mode (top right).",
    `2. Press Load unpacked and choose this folder: ${dir}`,
    `The extension's id should read ${id}. If it does not, tell Vyre: the connector only talks to that id.`,
    "Then run chrome.status: it should say connected.",
    "Two bars in Chrome are normal and cannot be hidden. On every start, Chrome warns about developer-mode extensions. While Vyre works in a tab, Chrome says the extension started debugging this browser; it goes away when Vyre lets go of the tab.",
    "Esc stops Vyre at once, and it waits for you before doing anything else.",
  ].join("\n");
}
