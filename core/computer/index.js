// @ts-check
// computer: Vyre Computer's one front door (R031-90). Chrome on the person's Mac, their Mac's apps, the cloud computer's own browser and desktop, and the screen service are the same thing
// to a person: a computer. This module is one tool, `computer`, over the engines that already exist; it adds no engine.
//
//   which computer   `on` names one ("my Mac", "the office computer"); nothing named is the cloud computer. Two matches or none is a question with the real names (route.js), never a guess.
//   which way        interface first, screen last: a Connection or a learned operation that covers the site is offered before the screen is touched, once; `screen: true` ("do it on the screen") skips it.
//   which engine     cloud: hands-chrome (web) and hands-desktop (apps) in the agent's own computer; this machine: hands-chrome-mac and hands-mac; another Mac: the same, asked of it through the link
//                    (computer.call, the person's own allowlist there, link.computer.allow). Every call keeps the engine's own floor, indicator, Gate and stop key.
//   signing in       a login the person lent (a # tag in this conversation, or vault.agent.grant) is typed into the page by the Vault. The model never sees it (core/vault/agent-fill.js).

import { agentClaim } from "../modules/index.js";
import { resolveTarget, planRoute, hostOf, registrable } from "./route.js";
import { CLASS } from "../../lib/computer-classes.js";

const CALLERS = ["cli", "local", "deck", "capsule", "mcp", "harness", "module"];
const AGENT = /^[a-z][a-z0-9-]{0,40}$/;
const TAUGHT_MS = 30 * 60_000;

export { CLASS };

/**
 * The engine tool for an action on a kind of computer. `args` pass through as the engine's own input (its own names for a control: a selector for the cloud's Chrome, a ref for the Mac's).
 * @param {"cloud" | "here" | "mac"} kind @param {string} action @param {{ app?: string, screen?: boolean }} q
 * @returns {string | null}
 */
export function engineFor(kind, action, q = {}) {
  const app = Boolean(q.app);
  if (kind === "cloud") {
    if (app) return { look: "hands-desktop.tree", shot: "hands-desktop.screenshot", act: "hands-desktop.act", click: "hands-desktop.act", type: "hands-desktop.act", press: "hands-desktop.act" }[action] || null;
    return { look: q.screen ? "chrome.screenshot" : "chrome.snapshot", shot: "chrome.screenshot", open: "chrome.open", click: "chrome.click", type: "chrome.type" }[action] || null;
  }
  if (app) return { look: "hands.observe", find: "hands.find", act: "hands.act", click: "hands.act", type: "hands.act", press: "hands.act", shot: "screen.shot" }[action] || null;
  return { look: q.screen ? "chrome.screenshot" : "chrome.snapshot", shot: "chrome.screenshot", tabs: "chrome.tabs", open: "chrome.open", click: "chrome.click", type: "chrome.type", fill: "chrome.fill", act: "chrome.act" }[action] || null;
}

const fail = (/** @type {string} */ code, /** @type {string} */ message) => Object.assign(new Error(message), { code });
const obj = (/** @type {any} */ properties, required = []) => ({ type: "object", properties, required });
const str = { type: "string" };

export default {
  /** @param {any} ctx */
  async start(ctx) {
    const role = ctx.config && ctx.config.role === "box" ? "box" : "local";
    /** @type {Map<string, number>} what has been offered an interface already, by agent and service */
    const taught = new Map();
    /** @type {Map<string, string>} the host an agent last worked on, by agent and computer */
    const lastHost = new Map();

    const ask = async (/** @type {string} */ tool, /** @type {any} */ input) => { try { const r = await ctx.call(tool, input); return r && !r.error ? r.data : null; } catch { return null; } };

    /** The computers there are, for this caller. @returns {Promise<import("./route.js").Target[]>} */
    async function targets() {
      /** @type {import("./route.js").Target[]} */ const out = [];
      if (role === "box") {
        out.push({ id: "cloud", kind: "cloud", name: "Cloud computer" });
        const macs = await ask("link.macs", {});
        for (const m of Array.isArray(macs) ? macs : []) out.push({ id: `mac:${m.mac}`, kind: "mac", name: String(m.name || m.mac), online: m.online === true });
      } else {
        out.push({ id: "here", kind: "here", name: "This Mac", aliases: ["my Mac", "this computer", "here"], online: true });
      }
      return out;
    }

    /** Who the model is: its own agent, or (for a person's surface) the agent they name. */
    function agentOf(/** @type {any} */ input, /** @type {any} */ meta) {
      const self = agentClaim(String(meta && meta.caller || ""));
      if (self) {
        if (input.agent && input.agent !== self) throw fail("denied", `${self} can only use its own computer, not ${input.agent}'s`);
        return self;
      }
      if (/^(mcp|harness)\b/.test(String(meta && meta.caller || ""))) throw fail("denied", "a model session that names no agent has no computer of its own");
      return input.agent ? String(input.agent) : null;
    }

    /** Interface first. A hit is offered once per service and half an hour; the same call again goes through. */
    async function interfaceFirst(/** @type {string | null} */ agent, /** @type {any} */ q) {
      const reg = registrable(hostOf(q.site));
      const key = `${agent || "-"}|${reg || q.goal || ""}`;
      const conns = await ask("connectors.connection.list", {});
      const list = conns && Array.isArray(conns.connections) ? conns.connections : [];
      const plain = list.filter((/** @type {any} */ c) => c.transport !== "site").map((/** @type {any} */ c) => ({ id: c.id, label: c.label, host: c.host }));
      const sites = list.filter((/** @type {any} */ c) => c.transport === "site").map((/** @type {any} */ c) => ({ id: c.id, site: c.site, operations: (Array.isArray(c.operations) ? c.operations : []).map((/** @type {any} */ o) => String(o && o.name || o)) }));
      const plan = planRoute(q, { connections: plain, sites });
      if (plan.route === "screen") return { plan };
      const at = taught.get(key);
      if (at && Date.now() - at < TAUGHT_MS) return { plan, passed: true };
      taught.set(key, Date.now());
      for (const [k, t] of taught) if (Date.now() - t > TAUGHT_MS) taught.delete(k);
      return { plan, teach: true };
    }

    ctx.tool("computer.targets", {
      description: "The computers you can work on by name: the cloud computer and each paired Mac (or this Mac), and whether each is online. Left unnamed, work goes to the cloud computer.",
      input: obj({}), effect: "read", callers: CALLERS,
      run: async () => ({ computers: (await targets()).map(t => ({ name: t.name, kind: t.kind, ...(t.online !== undefined ? { online: t.online } : {}) })) }),
    });

    ctx.tool("computer", {
      description: "Work on a computer: the cloud computer by default, or one you name in `on` (\"my Mac\", \"office computer\"). `do`: look (read the page or app), shot, tabs, open {url}, click, type, fill, act, find/get (files), signin {login} (a login lent to you; you never see it), route {goal, site} (what already covers this without the screen). Connections and learned operations come first: if one covers the site you are told once, and `screen: true` keeps the screen. `args` are the engine's own inputs (a selector, a ref, text).",
      input: obj({ do: { type: "string", enum: ["look", "shot", "tabs", "open", "click", "type", "fill", "act", "press", "find", "get", "signin", "route"] }, on: str, url: str, app: str, goal: str, site: str, login: str, screen: { type: "boolean" }, args: { type: "object" }, agent: str }, ["do"]),
      effect: "write", callers: CALLERS,
      run: async (/** @type {any} */ input, /** @type {any} */ meta = {}) => {
        const action = String(input.do);
        const agent = agentOf(input, meta);
        const all = await targets();
        const picked = resolveTarget(input.on, all);
        if (!picked.ok) return { asked: true, question: picked.ask.question, choices: picked.ask.choices, allowOwn: true };
        const target = picked.target;
        if (target.online === false) throw fail("offline", `${target.name} is offline; it will be done when it is back`);

        if (action === "route") {
          const { plan } = await interfaceFirst(agent, { goal: input.goal, site: input.site || input.url, app: input.app, screen: input.screen });
          return { computer: target.name, ...plan };
        }
        if (!(action in CLASS)) throw fail("bad_input", `${action} is not something a computer does here`);

        const cls = /** @type {Record<string, string>} */ (CLASS)[action];
        const where = `${agent || "-"}|${target.id}`;
        // Interface first: the host this work is on, from the address given or the last one worked on.
        const site = input.site || input.url || (input.args && input.args.url) || lastHost.get(where) || "";
        if (cls === "act" && !input.screen) {
          const f = await interfaceFirst(agent, { goal: input.goal, site, app: input.app });
          if (f.teach) {
            const p = /** @type {any} */ (f.plan);
            return { interfaceFirst: true, route: p.route, why: p.why, ...(p.route === "connection" ? { use: "connectors / vault.request with that Connection", connection: p.connection } : { use: "the learned operations (chrome.op list, connectors.site.*)", operations: p.operations }),
              note: "Nothing was done. Use that, or call again to do it on the screen, or pass screen: true." };
          }
        }
        if (input.url) { const h = hostOf(input.url); if (h) lastHost.set(where, h); }

        if (action === "signin") {
          if (target.kind !== "cloud") throw fail("unsupported", "signing in from a Vault login is done on the cloud computer for now; on your Mac, use the Vault's own fill");
          if (!agent) throw fail("denied", "a login is lent to an agent; say which agent's computer with `agent`");
          const r = await ctx.call("vault.agent.fill", { item: String(input.login || ""), ...(input.url ? { origin: new URL(String(input.url)).origin } : {}), agent, thread: meta.thread, lineage: meta.lineage });
          if (r.error) throw Object.assign(new Error(r.error.message), { code: r.error.code || "failed" });
          return { computer: target.name, ...r.data };
        }

        if (target.kind === "mac") {
          const r = await ctx.call("link.macs.call", { tool: "computer.call", mac: target.id.slice(4), input: { action, args: input.args || {}, ...(input.app ? { app: input.app } : {}), ...(input.screen ? { screen: true } : {}) }, timeout: 15_000 });
          if (r.error) throw Object.assign(new Error(r.error.message), { code: r.error.code || "failed" });
          const a = Array.isArray(r.data) ? r.data[0] : r.data;
          if (!a || a.ok === false) throw Object.assign(new Error(a && a.error ? a.error.message : `${target.name} did not answer`), { code: a && a.error ? a.error.code : "failed" });
          return { computer: target.name, ...(a.data || {}) };
        }
        const engine = engineFor(target.kind === "cloud" ? "cloud" : "here", action, { app: input.app, screen: input.screen });
        if (!engine) throw fail("unsupported", `${action} is not something ${target.name} does${input.app ? " in an app" : " on a page"}`);
        const call = { ...(input.args || {}), ...(input.url ? { url: input.url } : {}), ...(input.app ? { app: input.app } : {}), ...(target.kind === "cloud" && agent ? { agent } : {}) };
        const r = await ctx.call(engine, call);
        if (r.error) throw Object.assign(new Error(r.error.message), { code: r.error.code || "failed" });
        return { computer: target.name, engine, ...(r.data && typeof r.data === "object" ? r.data : { result: r.data }) };
      },
    });

    // The Mac's side of computer.call: what the paired box asked, run here after the person's own allowlist (link) has passed it. Modules only.
    ctx.tool("computer.exec", {
      internal: true, callers: ["module"],
      description: "Run one action on this machine for the paired box: { action, args, app, screen } -> the engine's answer. The link has already checked the person's allowlist for the action's class. Never called directly.",
      input: obj({ action: str, args: { type: "object" }, app: str, screen: { type: "boolean" } }, ["action"]),
      run: async (/** @type {any} */ i, /** @type {any} */ meta = {}) => {
        if (!meta || meta.caller !== "module:link") throw fail("denied", "only the link runs an action for the box");
        const engine = engineFor("here", String(i.action), { app: i.app, screen: i.screen });
        if (!engine) throw fail("unsupported", `${i.action} is not something this Mac does${i.app ? " in an app" : " on a page"}`);
        const r = await ctx.call(engine, { ...(i.args || {}), ...(i.app ? { app: i.app } : {}) });
        if (r.error) throw Object.assign(new Error(r.error.message), { code: r.error.code || "failed" });
        return { engine, ...(r.data && typeof r.data === "object" ? r.data : { result: r.data }) };
      },
    });
  },
};
