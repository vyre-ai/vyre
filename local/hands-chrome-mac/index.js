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

import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { AsyncLocalStorage } from "node:async_hooks";
import { fileURLToPath } from "node:url";
import { createBridge } from "./bridge.js";
import { createOversight } from "./oversight.js";
import { classify, originOf } from "./floor-url.js";
import { ACTING } from "./extension/shared/proto.js";
import * as nativeHost from "./native-host/install.js";
import { extensionIdFromKey, extensionIdFromPath } from "./native-host/install.js";
import { callerKind, agentClaim } from "../../core/modules/index.js";

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
  description: "How to find one control: role, name (its label), identifier, container. Copy it from chrome.snapshot.",
  properties: { role: str, name: str, identifier: str, container: str, text: str, ref: str },
};
const timeout = { ...int, description: "Give up after this many ms. Default 30000." };

/** Which tabs.* op an action means. */
const TAB_OPS = { list: "tabs.list", find: "tabs.find", use: "tabs.use", open: "tabs.open", activate: "tabs.activate", close: "tabs.close", navigate: "tabs.navigate" };
const SOURCE_OPS = { list: "dev.sources.list", get: "dev.sources.get", search: "dev.sources.search" };
const NET_OPS = { start: "net.start", list: "net.list", get: "net.get", watch: "net.watch", unwatch: "net.unwatch", on: "net.on", off: "net.off", rules: "net.rules", replay: "net.replay" };
const API_OPS = { learn: "api.learn", catalog: "api.catalog", call: "api.call" };
const GHL_OPS = { context: "ghl.context", section: "ghl.section", flows: "ghl.flows", run: "ghl.run" };

/** @param {any} v */ const isObj = v => v && typeof v === "object" && !Array.isArray(v);

/** @type {{ start(ctx: any): Promise<{ stop(): Promise<void> }> }} */
export default {
  async start(ctx) {
    const cfg = (ctx.config && ctx.config.chrome) || {};
    const bridge = createBridge({ sockPath: cfg.sockPath, timeoutMs: cfg.timeoutMs, opTimeouts: cfg.opTimeouts, log: m => ctx.log(m) });
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

    /** @type {Map<number, string>} the last URL seen for each tab, so an op is judged before it is sent */
    const urls = new Map();

    const off = bridge.on(e => {
      if (e.event === "hello") emit("chrome.connected", { version: e.version || null, browser: e.browser || null });
      else if (e.event === "disconnected") emit("chrome.disconnected", {});
      // The extension saw the person stop Vyre in the browser itself.
      else if (e.event === "stop") oversight.stop({ by: "esc" });
    });

    // Esc and a double Control are heard by the hands overlay, which Chrome control shares: one pill,
    // one stop key for everything Vyre does on this Mac. Its stop is our stop.
    const offHands = ctx.events.on("hands.stopped", () => { oversight.stop({ by: "esc" }); });
    /** The pill must be up before Vyre acts in the person's browser, exactly as for the hands. A Mac without the hands module (Windows, a box) has none to show. */
    const indicator = async () => {
      const r = await ctx.call("hands.indicator", { app: "Chrome" });
      if (r && r.error && r.error.code !== "unknown_tool" && r.error.code !== "not_found") throw Object.assign(new Error(r.error.message), { code: r.error.code || "no_indicator" });
    };

    let offered = false;
    const offer = async () => {
      const r = await ctx.call("gate.offer", { name: "chrome:mac", tool: "chrome.release", kinds: ["act"],
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
      if (!ok) throw denied("denied", `${agent} is not granted to drive this Mac. Grant it once with hands.grant.add (needs the person present on this Mac), or ask them to.`);
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
        if (c.tier === "blind") return { blind: true, why: c.why, ...(r.tab !== undefined && isObj(r.tab) ? { tab: r.tab.id } : Number.isInteger(r.id) ? { tab: r.id } : {}) };
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

    /** Tool errors keep their code so a caller can tell "not connected" from "floor" from "stopped". @param {any} e */
    const wrapErr = e => e && e.code === "error" && /changed since it was held/.test(String(e.message)) ? Object.assign(new Error(`changed: ${e.message}`), { code: "changed" }) : e && e.code && !/^[a-z_]+: /.test(String(e.message)) ? Object.assign(new Error(`${e.code}: ${e.message}`), { code: e.code, ...(e.detail !== undefined ? { detail: e.detail } : {}), ...(e.interjection ? { interjection: e.interjection } : {}) }) : e;

    /**
     * The one path every op takes: grant, oversight, floor, the socket, hold. `guarded: false`
     * is for the Gate's release, which is the person's approval of an act already judged.
     * @param {string} op @param {any} input @param {any} meta @param {{ tool?: string, map?: (r: any) => any }} [o]
     */
    async function dispatch(op, input, meta, o = {}) {
      return via.run(meta || {}, async () => {
        const agent = agentOf(meta.caller);
        const args = { ...input };
        delete args.agent; delete args.release; delete args.asked; delete args.action;
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
          args.asked = PEOPLE.includes(callerKind(meta.caller)) && !agent;
          let res = screen(await bridge.call(op, args, { timeoutMs: args.timeoutMs }));
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
          acted(meta, agent, op, false, x && x.message ? String(x.message).replace(/^[a-z_]+: /, "") : "failed", summary);
          if (carry && /** @type {any} */ (carry).interjection && x && typeof x === "object") x.interjection = /** @type {any} */ (carry).interjection;
          throw wrapErr(x);
        }
      });
    }

    /** An outward act the extension held: ask the person at the Gate, with the fields and origin. */
    async function hold(/** @type {string} */ op, /** @type {any} */ args, /** @type {any} */ res, /** @type {any} */ meta, /** @type {string} */ summary, /** @type {any} */ batchTab) {
      const tabId = Number.isInteger(args.tab) ? args.tab : batchTab;
      const url = String(res.url || (Number.isInteger(tabId) ? urls.get(tabId) : "") || args.url || "");
      // The extension names it sig, because redact.value masks any key called signature.
      const signature = res.sig ?? res.signature;
      const control = isObj(res.control) ? [res.control.role, res.control.name].filter(Boolean).join(" ") : res.control;
      const origin = originOf(url) || "this page";
      const { asked, release, ...replay } = args;
      const content = { app: "Chrome", window: scrub(res.title || ""), origin, control: scrub(control || res.why || summary), fields: clipFields(res.fields), op, args: Number.isInteger(tabId) && replay.tab === undefined ? { ...replay, tab: tabId } : replay, signature };
      // The Gate may have started after this module; offer again before the first card needs it.
      if (!offered) await offer();
      const r = await ctx.call("gate.request", { kind: "act", via: "chrome:mac", to: origin, content, ...(meta && meta.thread ? { thread: String(meta.thread) } : {}) });
      const agent = agentOf(meta.caller);
      if (!r || r.error || !r.data) {
        acted(meta, agent, op, false, "held, but there is no Gate to ask the person at", summary);
        return { held: true, gate: false, origin, why: "This sends something as the person and there is no Gate to ask them at, so it was not done." };
      }
      acted(meta, agent, op, true, "held for the person's approval", summary);
      return { held: true, id: r.data.id, origin, fields: content.fields, why: "This sends something as the person. It waits for their approval at the Gate." };
    }

    /** @param {string} name @param {string} description @param {any} input @param {(i: any, m: any) => Promise<any>} run @param {any} [extra] */
    const tool = (name, description, input, run, extra = {}) => ctx.tool(name, { description, input, run: async (/** @type {any} */ i, /** @type {any} */ m) => run(i || {}, m || {}), ...extra });

    const pass = (/** @type {string} */ name, /** @type {string} */ op, /** @type {string} */ description, /** @type {any} */ props) =>
      tool(name, description, obj({ tab, timeoutMs: timeout, ...props }), (i, m) => dispatch(op, i, m));

    tool("chrome.tabs", "The tabs in the person's own Chrome. list: every tab (id, title, URL; pages Vyre may not look at are left out and counted in hidden). find: tabs matching a URL, origin or title. use: reuse a matching tab, and open one only when none matches and url is given (openIfMissing); it never steals focus unless focus is true. open: a new tab (avoid: prefer use). activate: bring a tab to the front. close: only a tab Vyre opened. navigate: send a tab to a URL.",
      obj({ action: { type: "string", enum: Object.keys(TAB_OPS) }, tab, url: str, match: obj({ url: str, origin: str, title: str }), openIfMissing: bool, focus: bool, timeoutMs: timeout }, ["action"]),
      (i, m) => { const { action, ...rest } = i; return dispatch(/** @type {Record<string,string>} */ (TAB_OPS)[action], { ...rest, action }, m); });

    pass("chrome.snapshot", "page.snapshot", "The actionable controls of a page in one read: role, name, state, and a selector to hand to chrome.act or chrome.fill, plus the text on screen (secrets in it are masked). Nothing is returned from pages Vyre may not look at.", { limit: { ...int, description: "Most controls to return." }, agent: str });
    pass("chrome.act", "page.act", "Do one thing to one control found by selector: click, type (with value), select an option, check a box, or press a key (value: the key). An act that sends something as the person (a real submit, a Send, Pay or Post control, decided from the page itself) is held for their approval at the Gate unless they asked for it directly: the answer has held: true.",
      { selector, kind: { type: "string", enum: ["click", "type", "select", "check", "press"] }, value: { ...str, description: "For type and select: the text or option. For press: the key, e.g. Enter." } });
    pass("chrome.fill", "page.fill", "Set many form fields in one step: fields is a list of {selector, value}. Values a person typed never come back in results. A submit is held like chrome.act's.", { fields: { type: "array", items: obj({ selector, value: str }, ["selector"]) }, submit: bool });
    pass("chrome.eval", "page.eval", "Run a JavaScript expression in a tab and return its JSON result, redacted. The page's cookies, tokens and storage values are never returned, whatever the expression reads.", { expression: str });
    pass("chrome.wait", "page.wait", "Wait for exactly one thing: a control (selector), the URL to contain some text (url), or the network to be quiet for idleMs, up to timeoutMs.", { selector: { description: "A selector object, or a CSS selector string." }, url: { ...str, description: "Wait until the page URL contains this." }, idleMs: { ...int, description: "Wait until the network has been quiet this long." } });
    pass("chrome.screenshot", "page.screenshot", "A PNG of a tab (or of one control), base64-encoded. Nothing from pages Vyre may not look at.", { agent: str });
    pass("chrome.batch", "batch.run", "Run a list of steps inside the browser with no round trip between them: fastest for a known sequence. It stops at the first failure, on the person's stop, or at a page Vyre may not touch, and says which step.", { steps: { type: "array", items: { type: "object" } } });
    pass("chrome.inspect", "dev.inspect", "DevTools' view of the page: an element's outerHTML, attributes and box model, computed styles, the CSS rules that match it, and its event listeners.", { selector, what: { type: "array", items: { type: "string", enum: ["dom", "box", "styles", "rules", "listeners"] } } });
    tool("chrome.sources", "The page's scripts: list them, get one by id, or search across all of them. Source maps' file names come with them.",
      obj({ action: { type: "string", enum: Object.keys(SOURCE_OPS) }, tab, id: str, query: str, limit: int, timeoutMs: timeout }, ["action"]),
      (i, m) => { const { action, ...rest } = i; return dispatch(/** @type {Record<string,string>} */ (SOURCE_OPS)[action], { ...rest, action }, m); });
    pass("chrome.console", "dev.console.read", "The page's console: messages, exceptions and log entries kept in a ring buffer, newest last.", { limit: int, level: str, clear: bool });
    tool("chrome.net", "The page's network traffic. start: begin capturing. list and get: what was captured (headers and bodies with every credential masked). watch and unwatch: live capture. on and off: act on matching requests (block, mock, change headers, wait then run a step). rules: the active on rules. replay: re-send a captured request from inside the page, so its own cookies sign it and no credential leaves the browser.",
      obj({ action: { type: "string", enum: Object.keys(NET_OPS) }, tab, id: str, filter: { type: "object" }, then: { type: "object" }, limit: int, timeoutMs: timeout }, ["action"]),
      (i, m) => { const { action, ...rest } = i; return dispatch(/** @type {Record<string,string>} */ (NET_OPS)[action], { ...rest, action }, m); });
    tool("chrome.api", "An app's own API, learned from its traffic. learn: reduce captured requests to a catalog (method, path, query and body shape, auth kind, sample status; values masked). catalog: read it. call: invoke one entry from inside the page.",
      obj({ action: { type: "string", enum: Object.keys(API_OPS) }, tab, entry: str, args: { type: "object" }, host: str, timeoutMs: timeout }, ["action"]),
      (i, m) => { const { action, ...rest } = i; return dispatch(/** @type {Record<string,string>} */ (API_OPS)[action], { ...rest, action }, m); });
    tool("chrome.ghl", "GoHighLevel in the person's own Chrome. context: which sub-account and section the open tab is on. section: go to Contacts, Workflows, Conversations and so on in the tab already open (it never opens another). flows: the ready-made automations. run: do one end to end, either a named flow with params or your own steps, as ONE batch inside the browser, and get back how long it took.",
      obj({ action: { type: "string", enum: Object.keys(GHL_OPS) }, tab, section: str, locationId: str, flow: str, params: { type: "object" }, steps: { type: "array", items: { type: "object" } }, timeoutMs: timeout }, ["action"]),
      (i, m) => { const { action, ...rest } = i; return dispatch(/** @type {Record<string,string>} */ (GHL_OPS)[action], { ...rest, action }, m); });
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
        return dispatch("tabs.use", { url: i.url, openIfMissing: true }, m, { map: r => { const t = isObj(r) && isObj(r.tab) ? r.tab : r; return isObj(t) && t.blind ? t : { ok: true, title: t && t.title, url: t && t.url, ...(isObj(r) && r.interjection ? { interjection: r.interjection } : {}) }; } });
      });

    // Oversight: the plan, the person's word, and stop.
    tool("chrome.plan", "Post what you are about to do in the person's Chrome, as a short list of steps ({id, text, risk?}), before your first action: they see it and can interject or stop. Then report each step with step and status (running, done, failed), and finish when the run is over.",
      obj({ steps: { type: "array", items: obj({ id: str, text: str, risk: str }, ["text"]) }, step: str, status: { type: "string", enum: ["running", "done", "failed"] }, why: str, finish: bool, agent: str }),
      async (i, meta) => {
        const agent = agentOf(meta.caller);
        await requireGrant(agent);
        const name = agent || (i.agent ? String(i.agent) : "you");
        return via.run(meta, async () => {
          if (Array.isArray(i.steps)) return oversight.plan(name, i.steps, { thread: meta.thread });
          if (i.finish) return oversight.finish(name);
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

    // The Gate's own call once the person approved a held act.
    ctx.tool("chrome.release", {
      internal: true,
      description: "The Gate's own call once a person approved a held act in Chrome: sends it again with the page signature it was held under, and the extension refuses it (changed) if the page moved since. Never called directly.",
      input: obj({ id: str, to: { type: "array", items: str }, content: { type: "object" } }, ["id", "content"]),
      run: async (/** @type {any} */ input, /** @type {any} */ meta) => {
        if (!meta || meta.caller !== "module:gate") throw denied("denied", "only the Gate releases a held act");
        const c = input.content || {};
        if (!c.op || !c.signature) throw Object.assign(new Error("bad_request: nothing was held here"), { code: "bad_request" });
        return via.run(meta, async () => {
          const summary = summarize(String(c.op), c.args || {});
          try {
            oversight.guard(null, "module:gate");
            const { goes, on } = targets(c.args || {});
            for (const u of goes) floor(u, undefined);
            if (on) floor(on, String(c.op));
            const res = screen(await bridge.call(String(c.op), { ...(c.args || {}), asked: true, release: { sig: c.signature, signature: c.signature } }, { timeoutMs: (c.args || {}).timeoutMs }));
            acted(meta, null, String(c.op), true, undefined, `released ${summary}`);
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
        return { connected: bridge.connected(), extension: bridge.info(), listening: !listenError, ...(listenError ? { listenError } : {}), hostInstalled: installed, host: hostStatus, tabs, attached, oversight: oversight.snapshot() };
      });

    tool("chrome.install", "Set up the Vyre Chrome connector: registers the native host with Chrome (and the other Chromium browsers found), then returns the steps the person does in Chrome to load the extension.",
      obj({ extensionId: str, browsers: { type: "array", items: { type: "string", enum: ["chrome", "chromium", "brave", "edge"] } }, extensionDir: str }),
      async i => {
        const dir = String(i.extensionDir || cfg.extensionDir || path.join(HERE, "extension"));
        let id = i.extensionId ? String(i.extensionId) : null;
        if (!id) {
          try { const k = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8")).key; if (k) id = extensionIdFromKey(k); } catch { /* no manifest yet */ }
          if (!id) id = extensionIdFromPath(dir, cfg.platform);
        }
        const r = host.install({ home: cfg.home, platform: cfg.platform, vyreHome: cfg.vyreHome, hostDir: cfg.hostDir, registry: cfg.registry, extensionId: id, browsers: i.browsers });
        return { ...r, extensionDir: dir, steps: guide(dir, id, r.written.map((/** @type {any} */ w) => w.browser)) };
      }, { callers: PEOPLE, presence: { summary: () => "Install the Vyre connector for Chrome (registers a native messaging host with your browser)" } });

    return {
      async stop() { off(); if (typeof offHands === "function") offHands(); await bridge.close(); },
    };
  },
};

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
