// @ts-check
// computer: Vyre Computer's one front door (R031-90). Chrome on the person's Mac, their Mac's apps, the cloud computer's own browser and desktop, and the screen service are the same thing
// to a person: a computer. This module is one tool, `computer.use`, over the engines that already exist; it adds no engine.
//
//   which computer   `on` names one ("my Mac", "the office computer"); nothing named is the cloud computer. Two matches or none is a question with the real names (route.js), never a guess.
//   which way        interface first, screen last: a Connection or a learned operation that covers the site is offered before the screen is touched, once; `screen: true` ("do it on the screen") skips it.
//   which engine     cloud: hands-chrome (web) and hands-desktop (apps) in the agent's own computer; this machine: hands-chrome-mac and hands-mac; another Mac: the same, asked of it through the link
//                    (computer.call, the person's own allowlist there, link.computer.allow). Every call keeps the engine's own floor, indicator, Gate and stop key.
//   signing in       a login the person lent (a # tag in this conversation, or vault.agent.grant) is typed into the page by the Vault. The model never sees it (core/vault/agent-fill.js).

import fs from "node:fs";
import path from "node:path";
import { agentClaim } from "../modules/index.js";
import { MAX_BYTES, saveName } from "../../lib/computer-files.js";
import { resolveTarget, planRoute, hostOf, registrable } from "./route.js";
import { CLASS, engineFor } from "../../lib/computer-classes.js";
import { isPerson } from "../../lib/caller.js";

const CALLERS = ["cli", "local", "deck", "capsule", "mcp", "harness", "module"];
const AGENT = /^[a-z][a-z0-9-]{0,40}$/;
const TAUGHT_MS = 30 * 60_000;

export { CLASS, engineFor };

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

    /** One call to a paired Mac through the link; the Mac's answer's data, or an error with the Mac's own words. */
    async function onMac(/** @type {import("./route.js").Target} */ target, /** @type {any} */ input) {
      const r = await ctx.call("link.macs.call", { tool: "computer.call", mac: target.id.slice(4), input, timeout: 15_000 });
      if (r.error) throw Object.assign(new Error(r.error.message), { code: r.error.code || "failed" });
      const a = Array.isArray(r.data) ? r.data[0] : r.data;
      if (!a || a.ok === false) throw Object.assign(new Error(a && a.error ? a.error.message : `${target.name} did not answer`), { code: a && a.error ? a.error.code : "failed" });
      return a.data || {};
    }

    /** Bring one file from a Mac's Downloads, Desktop or Documents to the box, a megabyte at a time, and keep it where the agent's work can use it. The file goes nowhere else: sending it on is a separate, held act. */
    async function bringFile(/** @type {import("./route.js").Target} */ target, /** @type {any} */ a, /** @type {string | null} */ agent) {
      const p = String(a.path || "");
      if (!p) throw fail("bad_input", "say which file: args.path (find it first with do: find)");
      /** @type {Buffer[]} */ const parts = [];
      let offset = 0, first = null, name = "file";
      for (let i = 0; i < 16; i++) {
        const c = await onMac(target, { action: "get", args: { path: p, offset, length: 1024 * 1024 } });
        if (!first) { first = { size: Number(c.size), mtime: c.mtime }; name = saveName(String(c.name || p)); if (!(first.size >= 0) || first.size > MAX_BYTES) throw fail("too_big", `${name} is ${first.size} bytes; the most brought at once is ${MAX_BYTES}`); }
        else if (Number(c.size) !== first.size || c.mtime !== first.mtime) throw fail("changed", `${name} changed while it was being brought`);
        if (Number(c.offset) !== offset) throw fail("failed", "the Mac sent the wrong part of the file");
        const buf = Buffer.from(String(c.base64 || ""), "base64");
        if (buf.length !== c.length) throw fail("failed", "a part of the file arrived damaged");
        parts.push(buf); offset += buf.length;
        if (c.done) break;
        if (!buf.length) throw fail("failed", "the Mac stopped sending the file");
        if (offset > MAX_BYTES) throw fail("too_big", `${name} is more than the ${MAX_BYTES} bytes that are brought at once`);
      }
      const data = Buffer.concat(parts);
      if (first && data.length !== first.size) throw fail("changed", `${name} changed while it was being brought`);
      const dir = path.join(ctx.paths.root, "computer", "inbox", agent || "person");
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const to = path.join(dir, name);
      fs.writeFileSync(to, data, { mode: 0o600 });
      return { saved: to, name, size: data.length, from: "the Mac's Downloads, Desktop or Documents", note: "On the box now. Sending it anywhere (a Slack upload, an email) is a separate step, held for your yes." };
    }

    // The operator card (previews.operator / previews.step) and the merged question (ask.many) belong to other modules; when they are not there, nothing is shown and the work goes on.
    /** @type {Map<string, string>} the run of the card for a conversation and computer */
    const cards = new Map();
    const COMPUTER_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
    /** The name Glass lists a computer by: an agent's own for the cloud computer, the Mac's name for a Mac. */
    const glassName = (/** @type {import("./route.js").Target} */ t, /** @type {string | null} */ agent) => {
      const raw = t.kind === "cloud" ? agent || "cloud" : t.name;
      const clean = String(raw).replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[^A-Za-z0-9]+/, "").slice(0, 64);
      return COMPUTER_NAME.test(clean) ? clean : "computer";
    };
    async function card(/** @type {any} */ meta, /** @type {import("./route.js").Target} */ target, /** @type {string | null} */ agent) {
      const thread = meta && meta.thread ? String(meta.thread) : null;
      if (!thread) return null;
      const key = `${thread}|${target.id}`;
      if (cards.has(key)) return cards.get(key) || null;
      const r = await ask("previews.operator", { computer: glassName(target, agent), title: target.kind === "cloud" ? "Cloud computer" : target.name, thread });
      if (r && r.run) { cards.set(key, String(r.run)); for (const k of cards.keys()) if (cards.size > 200) cards.delete(k); return String(r.run); }
      return null;
    }
    const say = (/** @type {string | null} */ run, /** @type {string} */ line, state = "working") => (run ? ask("previews.step", { run, line, state }) : Promise.resolve(null));
    /** What a person reads about an action: no value, no selector, only the place. */
    const LINES = /** @type {Record<string, string>} */ ({ look: "Looking at the page", shot: "Taking a picture of the screen", tabs: "Looking at the open tabs", open: "Opening the page", click: "Clicking a control", type: "Typing in a field", fill: "Filling in the form", act: "Working on the page", press: "Pressing a key", find: "Looking for a file", get: "Bringing a file over", signin: "Signing in from your Vault" });
    const lineFor = (/** @type {string} */ action, /** @type {any} */ input) => { const h = hostOf(input.url || input.site); return action === "open" && h ? `Opening ${h}` : action === "signin" && h ? `Signing in to ${h} from your Vault` : LINES[action] || "Working"; };

    ctx.tool("computer.targets", {
      description: "The computers you can work on by name: the cloud computer and each paired Mac (or this Mac), and whether each is online. Left unnamed, work goes to the cloud computer.",
      input: obj({}), effect: "read", callers: CALLERS,
      run: async () => ({ computers: (await targets()).map(t => ({ name: t.name, kind: t.kind, ...(t.online !== undefined ? { online: t.online } : {}) })) }),
    });

    ctx.tool("computer.use", {
      description: "Work on a computer: the cloud computer by default, or one you name in `on` (\"my Mac\", \"office computer\"). `do`: look (read the page or app), shot, tabs, open {url}, click, type, fill, act, find/get (files), signin {login} (a login lent to you; you never see it), route {goal, site} (what already covers this without the screen). Connections and learned operations come first: if one covers the site you are told once, and `screen: true` keeps the screen. `args` are the engine's own inputs (a selector, a ref, text).",
      input: obj({ do: { type: "string", enum: ["look", "shot", "tabs", "open", "click", "type", "fill", "act", "press", "find", "get", "signin", "route"] }, on: str, url: str, app: str, goal: str, site: str, login: str, screen: { type: "boolean" }, args: { type: "object" }, agent: str }, ["do"]),
      effect: "write", callers: CALLERS,
      run: async (/** @type {any} */ input, /** @type {any} */ meta = {}) => {
        const action = String(input.do);
        const agent = agentOf(input, meta);
        const all = await targets();
        let picked = resolveTarget(input.on, all);
        if (!picked.ok) {
          // One card for the question, with the real names and room to type or speak another; the answer picks the computer and the work goes on.
          const q = picked.ask;
          const a = q.choices.length ? await ask("ask.many", { title: "Which computer?", thread: meta.thread, wait_ms: 55_000, questions: [{ id: "computer", prompt: q.question, choices: q.choices, allowText: true }] }) : null;
          const ans = a && a.state === "answered" && a.answers && a.answers.computer;
          const said = ans && (ans.choice || ans.text);
          picked = said ? resolveTarget(said, all) : picked;
          if (!picked.ok) return { asked: true, question: q.question, choices: q.choices, allowOwn: true, ...(a && a.id ? { card: a.id, state: a.state } : {}) };
        }
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

        // The operator card: one per conversation and computer, and a line for what is being done, in words with no value in them.
        const runId = await card(meta, target, agent);
        await say(runId, lineFor(action, { ...input, site }));
        const work = async () => {

          if (action === "signin") {
            if (target.kind !== "cloud") throw fail("unsupported", "signing in from a Vault login is done on the cloud computer for now; on your Mac, use the Vault's own fill");
            if (!agent) throw fail("denied", "a login is lent to an agent; say which agent's computer with `agent`");
            const r = await ctx.call("vault.agent.fill", { item: String(input.login || ""), ...(input.url ? { origin: new URL(String(input.url)).origin } : {}), agent, thread: meta.thread, lineage: meta.lineage });
            if (r.error && r.error.code === "denied" && /is not lent to/.test(String(r.error.message))) {
              // Nothing is lent for this site: the person signs in themselves, on a card that opens the screen with the keyboard theirs.
              const host = hostOf(input.url || input.site) || "the site";
              const s = await ask("previews.signin", { computer: glassName(target, agent), site: host, why: "A login is needed here", thread: meta.thread, wait_ms: 55_000 });
              if (s && s.state === "done") return { computer: target.name, signedIn: true, by: "you" };
              return { computer: target.name, needsSignIn: true, site: host, ...(s ? { card: s.id, state: s.state } : { note: r.error.message }) };
            }
            if (r.error) throw Object.assign(new Error(r.error.message), { code: r.error.code || "failed" });
            return { computer: target.name, ...r.data };
          }

          if (target.kind === "mac" && action === "get") return { computer: target.name, ...(await bringFile(target, input.args || {}, agent)) };
          if (target.kind === "mac") return { computer: target.name, ...(await onMac(target, { action, args: input.args || {}, ...(input.app ? { app: input.app } : {}), ...(input.screen ? { screen: true } : {}) })) };
          const engine = engineFor(target.kind === "cloud" ? "cloud" : "here", action, { app: input.app, screen: input.screen });
          if (!engine) throw fail("unsupported", `${action} is not something ${target.name} does${input.app ? " in an app" : " on a page"}`);
          // This Mac is driven by a model through the engine's own tools, which carry its own grant for the Mac; the front door names the tool rather than lend it an identity it was not given.
          if (target.kind === "here" && !isPerson(meta)) return { computer: target.name, direct: true, tool: engine, input: { ...(input.args || {}), ...(input.url ? { url: input.url } : {}), ...(input.app ? { app: input.app } : {}) }, note: "Call this tool directly: it carries your own permission to drive this Mac." };
          const call = { ...(input.args || {}), ...(input.url ? { url: input.url } : {}), ...(input.app ? { app: input.app } : {}), ...(target.kind === "cloud" && agent ? { agent } : {}) };
          const r = await ctx.call(engine, call);
          if (r.error) throw Object.assign(new Error(r.error.message), { code: r.error.code || "failed" });
          return { computer: target.name, engine, ...(r.data && typeof r.data === "object" ? r.data : { result: r.data }) };
        };
        try { return await work(); } catch (e) {
          const err = /** @type {any} */ (e);
          await say(runId, String(err && err.message || "It stopped").replace(/\s+/g, " ").slice(0, 140), "stuck");
          throw e;
        }
      },
    });
  },
};
