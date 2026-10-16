// @ts-check
// hands-chrome: Chrome control over one long-lived CDP connection per computer (team/archive/work-journals/computers.md).
//
// Every tool resolves which agent's computer it means the same way core/computers does (an
// agent's own hands call as `mcp:agent:<name>`; anyone else must say `agent`), asks
// `computers.endpoint` for where that computer's Chrome answers, and keeps one Cdp connection to
// it in the pool below rather than opening a new one per call (cdp.js; the 137x finding in
// the prototype's bin/macd.cjs).
//
// A consequential control (consequence.js) is refused before it is ever clicked: `computers.may-act`
// is asked first (are these hands even allowed to act right now, i.e. not paused, not taken
// over), then the control itself is classified, and only an observable one is pressed. Nothing
// here retries a consequential action that looks like it missed.
//
// Every action, successful or not, emits `chrome.acted {agent, action, summary, ok, why?}` so
// Glass's action log has something to show. No event, tool result or log line ever carries the
// CDP endpoint's helper token or a page's full text: `summary` is a short, human sentence.

import { AGENT_NAME_RE, resolveComputerAgent } from "../../lib/computer-agent.js";
import { isPerson } from "../../lib/caller.js";
import { requirePublicUrl } from "./nav.js";
import { cdpUrlOf } from "../../lib/browser-access.js";
import { CdpPool } from "./cdp.js";
import { EXPRESSION, toSnapshot } from "./snapshot.js";
import * as act from "./act.js";
import * as consequence from "./consequence.js";
import * as selector from "./selector.js";
import { runBoxOperation, checkBoxOperation, healBoxOperation } from "./siteops.js";
import { watchNetwork } from "./net-tool.js";
import { hostOf, mergeApiCatalog, watchApiTraffic } from "./api-tool.js";
import { callApi, pruneDead, routeApi } from "./api-exec.js";

const AGENT = AGENT_NAME_RE;
const str = { type: "string" };
const obj = (properties, required = []) => ({ type: "object", properties, required });

const SELECTOR = obj({
  role: str, identifier: str, name: str, container: str,
}, []);

/** The person's own surfaces and modules, plus an agent's own hands (a model session): each tool below resolves which computer it means and refuses a model that names none of its own. */
const CALLERS = ["cli", "local", "deck", "capsule", "tailnet", "device", "module", "mcp", "harness"];

/** @param {import("../../lib/computer-agent.js").resolveComputerAgent} _r */
async function resolveAgent(input, caller, call) {
  const kindOf = async name => {
    const r = await call("agents.list", {});
    const a = !r.error && (r.data || []).find(x => x && x.name === name);
    return a ? String(a.kind) : null;
  };
  return resolveComputerAgent(input, caller, kindOf);
}

/** @type {{ start(ctx: any): Promise<any> }} */
/**
 * A URL's origin and path, with no query, fragment or login, and any long token-shaped path
 * segment (a reset or magic link, a signed download) replaced by an ellipsis. Works on what URL()
 * refuses too: everything from the first ? or # goes whatever else the string holds.
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
  return head + path.replace(/\/[A-Za-z0-9_-]{20,}(?=\/|$)/g, "/\u2026");
}

/**
 * Words about an action, cut to one line of at most 200 characters, with every URL in them made
 * bare (bareUrl). A URL runs to the next whitespace, quotes included, so a quote cannot end it
 * early and leave its query behind.
 * @param {unknown} text
 */
export function scrub(text) {
  const one = String(text ?? "").replace(/\s+/g, " ").trim();
  const cut = one.replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, bareUrl);
  return cut.length > 200 ? cut.slice(0, 199) + "\u2026" : cut;
}

/** What a selector asked for, in words: its role and name, never the raw object. @param {any} sel */
const selectorSummary = sel => [sel && sel.role, sel && sel.name].filter(Boolean).map(String).join(" ") || "a control";

export default {
  async start(ctx) {
    // a rig may hand in its own pool of CDP connections (a test with no Chrome); a real box never does
    const pool = (ctx.config && ctx.config.handsChrome && ctx.config.handsChrome.pool) || new CdpPool({
      onEvent: (agent, m) => { if (m.method === "Inspector.detached" || m.method === "Target.targetCrashed") ctx.log(`${agent}'s Chrome: ${m.method}`); },
    });

    // A shield (a person signing in, ADR 0005 decision 3) drops the connection, so nothing
    // already attached can see the page; may-act refuses a new one until the shield is down.
    const unshielded = ctx.events.on("computer.shielded", e => {
      const agent = e && e.payload && e.payload.agent;
      if (agent) pool.drop(String(agent)).catch(err => ctx.log(`dropping ${agent}'s Chrome: ${err.message}`));
    });

    // Every event is stored and readable by every module, so what an action says about itself
    // is scrubbed first: a URL keeps its origin and path, never its query or fragment, where
    // sign-in links and tokens live. The thread and the tool call it came from (vyred's meta)
    // let a view tie the step to the chat row that asked for it.
    const act_ = (meta, agent, action, ok, why, extra = {}) => {
      const where = {
        ...(meta && meta.thread ? { thread: String(meta.thread) } : {}),
        ...(meta && meta.call ? { call: String(meta.call) } : {}),
      };
      const said = { ...extra, ...(extra.summary !== undefined ? { summary: scrub(extra.summary) } : {}) };
      ctx.events.emit("chrome.acted", { agent, action, ok, app: "Chrome", ...where, ...(why ? { why: scrub(why) } : {}), ...said },
        where.thread ? { thread: where.thread } : {});
    };

    // A Vault sign-in on the agent's computer names the tab it earned a session in (core/vault/agent-fill.js); the hands work there next.
    try { ctx.events.on("computer.fill-ended", (/** @type {any} */ e) => { const p = e && e.payload; if (p && p.agent && p.target && p.why === "done") pool.prefer(String(p.agent), String(p.target)); }); } catch { /* no event bus in a bare test */ }

    /** Connect (or reuse) the agent's CDP session and its page. */
    const session = async agent => {
      const r = await ctx.call("computers.endpoint", { agent });
      if (r.error) throw new Error(r.error.message);
      // Chrome's own port is never handed out; only computerd's authenticated /cdp proxy is.
      const cdp = await pool.get(agent, cdpUrlOf(r.data.helper), r.data.helper.token);
      const sessionId = await cdp.page();
      return { cdp, sessionId };
    };

    const evaluate = async (cdp, sessionId, expression) => {
      const r = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, sessionId);
      if (r.exceptionDetails) throw new Error(`page script failed: ${r.exceptionDetails.text || "unknown error"}`);
      return r.result && r.result.value;
    };

    const perceive = async (cdp, sessionId) => toSnapshot(await evaluate(cdp, sessionId, EXPRESSION));

    /** May the agent's hands act at all right now (not paused, not taken over)? Throws if not. */
    const mayAct = async (agent, tool) => {
      const r = await ctx.call("computers.may-act", { agent, tool });
      if (r.error) throw new Error(r.error.message);
      if (!r.data.ok) throw new Error(r.data.why);
    };

    /** screenshot and snapshot only look; the rest drive the page. */
    const tool = (name, description, input, run) => ctx.tool(name, { description, input, run, callers: CALLERS, effect: /^chrome\.(snapshot|screenshot)$/.test(name) ? "read" : "write" });

    // The connectors module's way to a learned website operation in an agent's own Chrome on this box (rung "box"): the Chrome keeps its profile, so the person's login, made once through the
    // screen view, is there at the next run with the Mac off. Nothing else may call it. A read runs; anything outward only with the yes the kernel already has (`approved`).
    ctx.tool("chrome.op.run", {
      internal: true, callers: ["module"],
      description: "Run one learned operation of a site in an agent's own Chrome on this box, for the connectors module: { agent, site, name, inputs, approved?, check? } -> the operation's answer (ok, class, data, next). Never called directly.",
      input: obj({ agent: str, site: str, name: str, inputs: { type: "object" }, approved: { type: "boolean" }, check: { type: "boolean" }, heal: { type: "boolean" } }, ["agent", "site", "name"]),
      run: async (i, meta) => {
        if (!meta || meta.caller !== "module:connectors") throw Object.assign(new Error("only the connectors module runs a site's operation here"), { code: "denied" });
        const agent = String(i.agent || "");
        if (!AGENT.test(agent)) throw new Error(`"${agent}" is not an agent name`);
        let origin = ""; try { origin = new URL(String(i.site)).origin; } catch { throw new Error("site is an origin such as https://app.example.com"); }
        const got = await ctx.call("memory.site.get", { origin, parts: ["ops"] });
        const entry = !got.error && got.data && got.data.origin && Array.isArray(got.data.origin.ops) ? got.data.origin.ops.find(o => o.name === i.name) : null;
        if (!entry) throw Object.assign(new Error(`no operation ${String(i.name).slice(0, 40)} is kept for ${origin} (connectors.site.operations lists the ones kept)`), { code: "not_found" });
        await mayAct(agent, "chrome.op.run");
        const { cdp, sessionId } = await session(agent);
        if (i.check === true) return checkBoxOperation({ cdp, sessionId, op: entry.op });
        const inputs = i.inputs && typeof i.inputs === "object" ? i.inputs : {};
        let res = await runBoxOperation({ cdp, sessionId, op: entry.op, inputs, approved: i.approved === true });
        act_(meta, agent, "op", res.ok === true, res.ok ? undefined : String(res.reason || res.class), { summary: `${entry.name} on ${bareUrl(origin)}` });
        // Reactive repair, reads only: the stored template is always tried first; a drift relearns the operation from what the page sends, and the repair is kept (as a new version) only after a replay answers.
        if (!res.ok && res.class === "drift" && entry.kind === "read" && i.heal !== false) {
          const h = /** @type {any} */ (await healBoxOperation({ cdp, sessionId, op: entry.op, inputs }));
          if (h.outcome === "healed" && h.operation) {
            await ctx.call("memory.site.put", { origin, target: "origin", patch: { key: origin, ops: [{ name: entry.name, kind: entry.kind, op: h.operation, outcome: "ok" }] } }).catch(() => null);
            const again = await runBoxOperation({ cdp, sessionId, op: h.operation, inputs, approved: false });
            if (again.ok) {
              await ctx.call("memory.site.report", { origin, part: "ops", id: entry.name, outcome: "ok" }).catch(() => null);
              act_(meta, agent, "op", true, undefined, { summary: `${entry.name} repaired on ${bareUrl(origin)}` });
              return { ...again, healed: true };
            }
          }
          await ctx.call("memory.site.report", { origin, part: "ops", id: entry.name, outcome: "miss" }).catch(() => null);
          return { ...res, heal: { outcome: h.outcome, reason: h.reason }, version: entry.version, next: "could not repair automatically: teach it again with chrome_op learn" };
        }
        // the store's own count: a success raises the trust, a drift counts a miss (never an auth or rate failure: those are not the operation's fault)
        if (res.ok) await ctx.call("memory.site.report", { origin, part: "ops", id: entry.name, outcome: "ok" }).catch(() => null);
        else if (res.class === "drift") await ctx.call("memory.site.report", { origin, part: "ops", id: entry.name, outcome: "miss" }).catch(() => null);
        return { ...res, version: entry.version };
      } });

    tool("chrome.snapshot", "Every actionable control on the agent's current page: role, name, whether it is enabled, and where it sits. No page text beyond a length.",
      obj({ agent: str }), async (i, meta) => {
        const agent = await resolveAgent(i, meta.caller, ctx.call);
        await mayAct(agent, "chrome.snapshot");
        const { cdp, sessionId } = await session(agent);
        const snap = await perceive(cdp, sessionId);
        act_(meta, agent, "snapshot", true, undefined, { summary: `${snap.controls.length} controls on ${snap.title || snap.url}` });
        return { title: snap.title, url: snap.url, controls: snap.controls, named: snap.named, nameless: snap.nameless };
      });

    tool("chrome.open", "Navigate the agent's Chrome to a URL.", obj({ agent: str, url: str }, ["url"]),
      async (i, meta) => {
        const agent = await resolveAgent(i, meta.caller, ctx.call);
        await mayAct(agent, "chrome.open");
        const url = String(i.url);
        if (!/^https?:\/\//.test(url)) throw new Error(`"${url}" is not an http(s) URL`);
        // A model's Chrome reaches the public web only (lib/netguard.js, the runner egress rule); the person's own call is not held to it.
        const guarded = !isPerson(meta.caller);
        if (guarded) await requirePublicUrl(url);
        const { cdp, sessionId } = await session(agent);
        try {
          const loaded = cdp.waitFor(m => m.method === "Page.loadEventFired" && m.sessionId === sessionId);
          await cdp.send("Page.navigate", { url }, sessionId);
          await loaded;
        } catch (e) {
          act_(meta, agent, "open", false, /** @type {Error} */ (e).message, { summary: bareUrl(url) });
          throw e;
        }
        const snap = await perceive(cdp, sessionId);
        // A redirect or a script may have taken the page somewhere inside: check where it landed, and leave it on a blank page.
        if (guarded && /^https?:/.test(String(snap.url || ""))) { try { await requirePublicUrl(String(snap.url)); } catch (e) { await cdp.send("Page.navigate", { url: "about:blank" }, sessionId).catch(() => null); act_(meta, agent, "open", false, "landed on a non-public address", { summary: bareUrl(url) }); throw e; } }
        act_(meta, agent, "open", true, undefined, { summary: bareUrl(url) });
        return { ok: true, title: snap.title, url: snap.url };
      });

    tool("chrome.click", "Click a control, chosen by role, name or identifier against a fresh look at the page. Refuses consequential controls (send, pay, delete): use Glass.",
      obj({ agent: str, selector: SELECTOR }, ["selector"]), async (i, meta) => {
        const agent = await resolveAgent(i, meta.caller, ctx.call);
        await mayAct(agent, "chrome.click");
        const { cdp, sessionId } = await session(agent);
        const r = await act.once({
          request: i.selector,
          perceive: () => perceive(cdp, sessionId),
          decide: act.decideBySelector,
          click: async ctl => {
            const check = await ctx.call("computers.may-act", { agent, tool: "chrome.click" });
            if (check.error || !check.data.ok) return { ok: false, why: (check.data && check.data.why) || (check.error && check.error.message) || "cannot act right now" };
            const c = ctl.frame ? { x: Math.round(ctl.frame.x + ctl.frame.w / 2), y: Math.round(ctl.frame.y + ctl.frame.h / 2) } : null;
            if (!c) throw new Error(`${ctl.name || ctl.role} has no on-screen position to click`);
            await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: c.x, y: c.y, button: "left", clickCount: 1 }, sessionId);
            await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: c.x, y: c.y, button: "left", clickCount: 1 }, sessionId);
          },
        });
        act_(meta, agent, "click", r.ok, r.ok ? undefined : r.why, { summary: r.control ? (r.control.name || r.control.role) : selectorSummary(i.selector) });
        return r;
      });

    tool("chrome.type", "Type text into a text field, chosen by role/name/identifier against a fresh look at the page.",
      obj({ agent: str, selector: SELECTOR, text: str }, ["selector", "text"]), async (i, meta) => {
        const agent = await resolveAgent(i, meta.caller, ctx.call);
        await mayAct(agent, "chrome.type");
        const { cdp, sessionId } = await session(agent);
        const snap = await perceive(cdp, sessionId);
        const bound = selector.resolve(i.selector, snap.controls);
        if (!bound.control) {
          act_(meta, agent, "type", false, `nothing matches ${selectorSummary(i.selector)}`, { summary: selectorSummary(i.selector) });
          return { ok: false, why: bound.why === "tied" ? "more than one control matches" : `nothing matches ${JSON.stringify(i.selector)}` };
        }
        const ctl = bound.control;
        if (ctl.enabled === false) {
          act_(meta, agent, "type", false, `${ctl.name || ctl.role} is disabled`, { summary: ctl.name || ctl.role });
          return { ok: false, why: `${ctl.name || ctl.role} is disabled right now` };
        }
        const check = await ctx.call("computers.may-act", { agent, tool: "chrome.type" });
        if (check.error || !check.data.ok) {
          const why = (check.data && check.data.why) || (check.error && check.error.message) || "cannot act right now";
          act_(meta, agent, "type", false, why, { summary: ctl.name || ctl.role });
          return { ok: false, why };
        }
        const cx = ctl.frame ? Math.round(ctl.frame.x + ctl.frame.w / 2) : 0;
        const cy = ctl.frame ? Math.round(ctl.frame.y + ctl.frame.h / 2) : 0;
        await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: cx, y: cy, button: "left", clickCount: 1 }, sessionId);
        await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: cx, y: cy, button: "left", clickCount: 1 }, sessionId);
        await cdp.send("Input.insertText", { text: String(i.text) }, sessionId);
        act_(meta, agent, "type", true, undefined, { summary: ctl.name || ctl.role });
        return { ok: true, control: ctl };
      });

    /** @type {Map<string, ReturnType<typeof watchNetwork>>} */
    const nets = new Map();
    /** @type {Map<string, ReturnType<typeof watchApiTraffic>>} */
    const apiNets = new Map();
    /** @type {Map<string, any[]>} */
    const apiCatalogs = new Map();

    const catalogForAgent = (/** @type {string} */ agent) => {
      const out = [];
      for (const [k, v] of apiCatalogs) if (k.startsWith(`${agent}|`)) out.push(...v);
      return pruneDead(out);
    };
    const trafficForAgent = (/** @type {string} */ agent) => {
      const w = apiNets.get(agent);
      return w ? w.all() : [];
    };

    tool("chrome.api", "Learn, catalog, route, and call a site's in-page API from traffic on the agent's browser (writes need approved: true).",
      obj({ agent: str, action: str, host: str, hint: str, entryId: str, entry: str, params: { type: "object" }, approved: { type: "boolean" } }, ["action"]), async (i, meta) => {
        const agent = await resolveAgent(i, meta.caller, ctx.call);
        const action = String(i.action || "");
        if (action === "learn") {
          await mayAct(agent, "chrome.api");
          const { cdp, sessionId } = await session(agent);
          const prev = apiNets.get(agent);
          if (prev) prev.stop();
          const w = watchApiTraffic(cdp, sessionId);
          await w.start();
          apiNets.set(agent, w);
          const fresh = await w.collect();
          const pageUrl = String((await cdp.send("Runtime.evaluate", { expression: "location.href", returnByValue: true }, sessionId)).result?.value || "");
          const host = String(i.host || hostOf(pageUrl));
          if (!host) throw new Error("say which host to learn, or open a page first");
          const catalog = mergeApiCatalog(apiCatalogs, agent, host, fresh);
          act_(meta, agent, "api", true, undefined, { summary: `learned ${catalog.length} entries for ${host}` });
          return { host, entries: catalog.length, catalog };
        }
        if (action === "catalog") {
          const host = String(i.host || "");
          if (!host) throw new Error("host is required for catalog");
          const catalog = apiCatalogs.get(`${agent}|${host}`) || [];
          return { host, catalog };
        }
        if (action === "route") {
          await mayAct(agent, "chrome.api");
          const { cdp, sessionId } = await session(agent);
          const hint = String(i.hint || "");
          const res = await routeApi(catalogForAgent(agent), hint, i.params && typeof i.params === "object" ? i.params : {}, trafficForAgent(agent),
            (entry, params) => callApi(entry, params, trafficForAgent(agent), {}, cdp, sessionId));
          act_(meta, agent, "api", res.route === "api", res.route === "api" ? undefined : String(res.why || res.route), { summary: `route ${res.route} for ${hint.slice(0, 40)}` });
          return res;
        }
        if (action === "call") {
          const id = String(i.entryId || i.entry || "");
          if (!id) throw new Error("entryId is required for call");
          const entry = catalogForAgent(agent).find(e => e.id === id);
          if (!entry) throw new Error("no catalog entry with that id (run chrome.api learn first)");
          await mayAct(agent, "chrome.api");
          const { cdp, sessionId } = await session(agent);
          const res = await callApi(entry, i.params && typeof i.params === "object" ? i.params : {}, trafficForAgent(agent),
            { approved: i.approved === true }, cdp, sessionId);
          act_(meta, agent, "api", !res.held, res.held ? String(res.why || "held") : undefined, { summary: `${entry.method} ${entry.pathTemplate}` });
          return res;
        }
        throw new Error(`chrome.api does not know action "${action}"; use learn, catalog, route, or call`);
      });

    tool("chrome.net", "The agent page's network traffic on the box (CDP). start: capture; list: recent requests (URLs only, no secrets).",
      obj({ agent: str, action: str }, ["action"]), async (i, meta) => {
        const agent = await resolveAgent(i, meta.caller, ctx.call);
        const action = String(i.action || "");
        if (action === "start") {
          await mayAct(agent, "chrome.net");
          const { cdp, sessionId } = await session(agent);
          const prev = nets.get(agent);
          if (prev) prev.stop();
          const w = watchNetwork(cdp, sessionId);
          await w.start();
          nets.set(agent, w);
          act_(meta, agent, "net", true, undefined, { summary: "capturing network" });
          return { capturing: true };
        }
        if (action === "list") {
          const w = nets.get(agent);
          if (!w) throw new Error("call chrome.net with action start before list");
          return { requests: w.list() };
        }
        throw new Error(`chrome.net does not know action "${action}"; use start or list`);
      });

    tool("chrome.screenshot", "A PNG of the agent's current page, base64-encoded.", obj({ agent: str }),
      async (i, meta) => {
        const agent = await resolveAgent(i, meta.caller, ctx.call);
        await mayAct(agent, "chrome.screenshot");
        const { cdp, sessionId } = await session(agent);
        const r = await cdp.send("Page.captureScreenshot", { format: "png" }, sessionId);
        act_(meta, agent, "screenshot", true, undefined, { summary: "captured" });
        return { image: r.data, mime: "image/png" };
      });

    return {
      pool,
      async stop() { unshielded(); await pool.closeAll(); },
    };
  },
};
