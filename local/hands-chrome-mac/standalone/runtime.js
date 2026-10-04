// @ts-check
// runtime: hosts the chrome module (../index.js, unchanged) with no Vyre server. It gives the module
// the small ctx it expects (tools, events, calls) and turns its tools into a plain registry the MCP
// server serves. There is no Gate here: Claude Code's own tool permissions are the approval, so an
// act that sends something as the person comes back held, and is done only by the separate tool
// chrome.send (which Claude Code asks the person about). Everything else is the same code as in Vyre.

import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import chromeModule from "../index.js";
import { createTrace, rungOf, nextRung, readConfig } from "./trace.js";
import { callerKind } from "../caller.js";
import { createSiteStore } from "./sitestore.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PKG = path.resolve(HERE, "..");
/** A "visit" for the two-visit evidence: the person's setting, never under 5 minutes unless a test flag is on (a tiny window would make "seen twice" true within seconds). @param {any} minutes @param {Record<string, string|undefined>} [env] */
export const visitMsFrom = (minutes, env = process.env) => Math.max(env.NODE_ENV === "test" || env.VYRE_CHROME_TEST ? 1000 : 5 * 60_000, Math.round((Number(minutes) || 30) * 60_000));
export const dataDirOf = (/** @type {Record<string, string|undefined>} */ env = process.env) => env.VYRE_CHROME_HOME || path.join(os.homedir(), ".vyre-chrome");
export const sockPathOf = (/** @type {string} */ dataDir, platform = process.platform) =>
  platform === "win32" ? `\\\\.\\pipe\\vyre-chrome-standalone-${safeUser()}` : path.join(dataDir, "run", "chrome.sock");
function safeUser() { try { return os.userInfo().username; } catch { return "user"; } }

/** Tools the model may not call: the person's own controls, and the Gate's release (chrome.send stands in for it). */
/** Errors that are not about a control or a page (nothing to step down from): the ladder hint would only mislead. */
const NO_LADDER = new Set(["blocked", "stopped", "no_extension", "denied", "declined", "pending", "detached", "not_listening", "plan_first", "waiting_input", "bad_request", "not_found_tool"]);
const HIDDEN = new Set(["chrome.release", "chrome.interject", "chrome.install", "chrome.pause", "chrome.plan.edit", "chrome.voice"]);

/**
 * @param {{ dataDir?: string, sockPath?: string, hostDir?: string, extensionDir?: string, version?: string, log?: (m: string) => void, chrome?: Record<string, any> }} [o]
 */
export async function createRuntime(o = {}) {
  const dataDir = o.dataDir || dataDirOf();
  const log = o.log || (m => process.stderr.write(`[vyre-chrome] ${m}\n`));
  const trace = createTrace({ dataDir, version: o.version });
  const sites = createSiteStore({ dataDir });
  /** @type {Map<string, any>} */ const tools = new Map();
  /** @type {Map<string, Set<Function>>} */ const listeners = new Map();
  /** @type {Map<string, { content: any, tool: string }>} */ const held = new Map();
  /** Failures on rungs 2 to 4 by target, in one call chain: a success on the target clears it. @type {Map<string, { n: number, at: number }>} */ const failing = new Map();
  const CHAIN_MS = 90_000;
  const targetOf = (/** @type {string} */ name, /** @type {any} */ input) => {
    const i = input && typeof input === "object" ? input : {};
    const sel = i.selector || (Array.isArray(i.fields) && i.fields[0] && i.fields[0].selector) || null;
    const what = sel && typeof sel === "object" ? String(sel.identifier || sel.name || "") : String(i.text || i.label || "");
    return `${Number.isInteger(i.tab) ? i.tab : "active"}|${what.toLowerCase().slice(0, 80)}`;
  };
  /** @param {string} name @param {any} input @param {any} c */
  async function stepDown(name, input, c) {
    const rung = rungOf(name);
    if (rung < 2 || rung > 4 || !/^chrome\.(act|fill|click|type|wait|snapshot|batch)$/.test(name)) return;
    const key = targetOf(name, input), now = Date.now();
    for (const [k, v] of failing) if (now - v.at > CHAIN_MS) failing.delete(k);
    if (c.ok) { failing.delete(key); return; }
    if (NO_LADDER.has(String(c.error && c.error.code))) return;
    const cur = failing.get(key) || { n: 0, at: now };
    cur.n++; cur.at = now; failing.set(key, cur);
    if (cur.n < 2 || !tools.has("chrome.point") || !tools.has("chrome.screenshot")) return;
    const tab = c.error && c.error.detail && Number.isInteger(c.error.detail.tab) ? c.error.detail.tab : input && input.tab;
    // The picture is taken by the same tool the model would use, so the floor, the credential-field refusal and a blind origin all apply: a refusal means no picture and no step-down.
    const shot = /** @type {any} */ (await run("chrome.screenshot", { ...(Number.isInteger(tab) ? { tab } : {}), format: "jpeg", quality: 30, maxWidth: 640 }, "mcp"));
    if (!shot || !shot.image || !shot.shot) return;
    c.error.message = `${c.error.message} | ladder: rungs 1 to 4 have failed on this target twice. The picture attached is the page now (shot ${shot.shot.id}, image ${shot.shot.image.w}x${shot.shot.image.h}): find the thing in it and act with chrome_point {shot, x, y, action} in the picture's own pixels (rung 5). This is a hint for where to look: chrome_point holds and asks exactly as chrome_act does.`;
    c.error.image = shot.image;
  }

  const events = {
    emit(/** @type {string} */ type, /** @type {any} */ payload) {
      if (type !== "chrome.acted") trace.event(type, payload);
      for (const f of listeners.get(type) || []) { try { f(payload); } catch { /* a listener's fault is its own */ } }
    },
    on(/** @type {string} */ type, /** @type {Function} */ fn) {
      const set = listeners.get(type) || new Set(); set.add(fn); listeners.set(type, set);
      return () => set.delete(fn);
    },
  };

  /** What the module asks of the rest of Vyre, answered for a world with no Vyre. @param {string} tool @param {any} input */
  async function call(tool, input) {
    if (tool === "gate.offer") return { data: { ok: true } };
    if (tool === "gate.request") {
      const id = crypto.randomBytes(9).toString("hex");
      held.set(id, { content: input.content, tool: String(input.via || "") });
      while (held.size > 100) held.delete(/** @type {string} */ (held.keys().next().value));
      return { data: { id, state: "held" } };
    }
    if (tool === "hands.grant.list") return { data: [] };
    // Vyre Memory's site knowledge, answered from files in this folder when there is no Vyre to ask.
    if (tool === "memory.site.get") return sites.get(input || {});
    if (tool === "memory.site.put") return readConfig(dataDir).learn !== true ? { data: { accepted: false, refused: [{ path: "", why: "learning is off" }] } } : sites.put(input || {});
    if (tool === "memory.site.report") return readConfig(dataDir).learn !== true ? { data: { known: false } } : sites.report(input || {});
    if (tool === "memory.site.list") return sites.list();
    if (tool === "memory.site.forget") return sites.forget(input || {});
    return { error: { code: "no_such_tool", message: `no tool ${tool}` } };
  }

  const ctx = {
    config: { chrome: { sockPath: o.sockPath || sockPathOf(dataDir), vyreHome: dataDir, hostDir: o.hostDir || path.join(PKG, "native-host"), extensionDir: o.extensionDir || path.join(PKG, "extension"), sendTool: "chrome_send", learn: () => readConfig(dataDir).learn === true, learnVisitMs: () => visitMsFrom(readConfig(dataDir).learnVisitMinutes), ghlHosts: () => { const h = trace.config().ghlHosts; return Array.isArray(h) ? h : []; }, ...(o.chrome || {}) } },
    log,
    events,
    call,
    tool(/** @type {string} */ name, /** @type {any} */ def) { tools.set(name, def); },
  };

  const running = await chromeModule.start(ctx);

  // What this server knows, for `vyre-chrome doctor` and the install check to read from another process: the connection state, why not, the one fix.
  const statusFile = path.join(dataDir, "run", "status.json");
  const writeStatus = async () => {
    try {
      const r = /** @type {any} */ (await run("chrome.status", {}, "cli"));
      fs.mkdirSync(path.dirname(statusFile), { recursive: true, mode: 0o700 });
      const tmp = `${statusFile}.${process.pid}`;
      fs.writeFileSync(tmp, JSON.stringify({ pid: process.pid, at: new Date().toISOString(), connected: r.connected === true, listening: r.listening !== false, extension: r.extension ? { version: r.extension.version, protocol: r.extension.protocol } : null, stage: r.stage || null, problem: r.problem || null, fix: r.fix || null, socket: r.socket || null, hostInstalled: r.hostInstalled === true }, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, statusFile);
    } catch { /* status is a courtesy; never a failure */ }
  };
  for (const ev of ["chrome.connected", "chrome.disconnected", "chrome.replaced"]) events.on(ev, () => { void writeStatus(); });
  void writeStatus();
  const statusTimer = setInterval(() => { void writeStatus(); }, 20_000);
  statusTimer.unref();

  /** Run a tool as the model in Claude Code would: a person's session, not a named agent. @param {string} name @param {any} input @param {string} caller */
  async function run(name, input, caller) {
    const def = tools.get(name);
    if (!def) throw Object.assign(new Error(`no tool ${name}`), { code: "no_such_tool" });
    // The module's own caller rules apply here as they do in Vyre: "mcp" is the model, and a tool listed
    // for the person's surfaces is not the model's to call (reviewer-2 M3).
    if (Array.isArray(def.callers) && !def.callers.includes(callerKind(caller))) throw Object.assign(new Error(`${name} is for the person, not for a model`), { code: "denied" });
    return def.run(input || {}, { caller, standalone: true });
  }

  /**
   * One tool call from the MCP server: timed, traced, and returned as {ok, result} or {ok:false, error}.
   * @param {string} name @param {any} input @param {{ receivedAt?: number }} [o2]
   */
  async function invoke(name, input, { receivedAt = Date.now(), ask = null } = {}) {
    const t0 = Date.now();
    const queueMs = t0 - receivedAt;
    /** @type {any} */ let out;
    try {
      if (name === "chrome.send") {
        const id = String(input && input.id || "");
        const h = held.get(id);
        if (!h) throw Object.assign(new Error("no held act with that id (it was already sent, or it is not one this session held)"), { code: "not_found" });
        // The person is asked by the server itself when the client can show a question, so an allow rule
        // for this server never stands in for their yes. Without it, Claude Code's own permission is the approval.
        if (typeof ask === "function" && trace.config().confirmSends !== false) {
          const c = h.content || {};
          const fields = Array.isArray(c.fields) ? c.fields.slice(0, 12).map((/** @type {any} */ f) => `${f.name || f.label || "field"}: ${String(f.value ?? "").slice(0, 60)}`).join("\n") : "";
          const isPlan = c.kind === "plan";
          const r = /** @type {any} */ (await ask(isPlan
            ? `Approve this plan once?\n${c.control || "?"}${fields ? "\n" + fields : ""}\nEach create and edit it lists then goes through without asking again, and a publish only if it says "and publish". Deleting, messaging and payments still ask one at a time.`
            : `Send this from ${c.origin || "your browser"}?\nControl: ${c.control || "?"}${fields ? "\n" + fields : ""}`));
          // No answer is not a no: the act stays held, the person was notified in Chrome, and the same id can be asked again.
          if (r && r.action === "timeout") throw Object.assign(new Error(`the person has not answered yet (they were notified in Chrome). Nothing was ${isPlan ? "approved" : "sent"}; it is still waiting. Call chrome_send with the same id to ask again, or carry on with something else.`), { code: "pending" });
          if (!r || r.action !== "accept" || !r.content || r.content.approve !== true) throw Object.assign(new Error(isPlan ? "the person did not approve this plan, so nothing was started" : "the person did not approve this send, so nothing was sent"), { code: "declined" });
        }
        held.delete(id);
        out = { ok: true, result: await run("chrome.release", { id, content: h.content }, "module:gate") };
      } else if (name === "chrome.resume") {
        // Esc is the person's: only they undo it. The server asks them itself; the run is then theirs.
        const confirm = trace.config().confirmSends !== false;
        // Esc is the person's. If their client cannot be asked and they have not turned confirmation off, the
        // model may not undo it: they resume from their own terminal with `config confirm-sends off`, or use a client that can ask.
        if (confirm && typeof ask !== "function") throw Object.assign(new Error("Chrome control was stopped by the person, and this client cannot ask them to let it carry on. Press resume yourself in the panel, or run chrome_resume from a client that can ask you (or turn the question off with `vyre-chrome config confirm-sends off`)."), { code: "denied" });
        if (confirm && typeof ask === "function") {
          const r = /** @type {any} */ (await ask("Chrome control was stopped (you pressed Esc, or stopped it). Let it carry on?" + (input && input.answer ? `\nYou told it: ${String(input.answer).slice(0, 200)}` : "")));
          if (!r || r.action !== "accept" || !r.content || r.content.approve !== true) throw Object.assign(new Error("the person did not let it carry on"), { code: "declined" });
        }
        out = { ok: true, result: await run("chrome.resume", input, "cli") };
      } else if (HIDDEN.has(name) || !tools.has(name)) {
        throw Object.assign(new Error(`no tool ${name}`), { code: "no_such_tool" });
      } else {
        out = { ok: true, result: await run(name, input, "mcp") };
      }
    } catch (e) {
      out = { ok: false, error: e };
    }
    const runMs = Date.now() - t0;
    const c = /** @type {any} */ (out);
    // The ladder: a failure says which rung it was on and what the next one is.
    if (!c.ok && c.error && rungOf(name)) { const hint = nextRung(rungOf(name)); if (hint && !NO_LADDER.has(String(c.error.code))) c.error.message = `${c.error.message} | ladder: ${hint}`; }
    // The automatic step-down: the same target failed on rungs 1 to 4 in one call chain, so the error hands over a fresh picture and names chrome_point, and the model does not have to remember it.
    try { await stepDown(name, input, c); } catch { /* a hint that cannot be made is no second failure */ }
    trace.call({ tool: name, args: input, queueMs, runMs, ok: c.ok, result: c.result, error: c.error });
    // A failure can leave a small screenshot behind, when the person turned that on.
    if (!c.ok && trace.config().shots === true && tools.has("chrome.screenshot") && name !== "chrome.screenshot") {
      try {
        const tab = c.error && c.error.detail && Number.isInteger(c.error.detail.tab) ? c.error.detail.tab : input && input.tab;
        const shot = await run("chrome.screenshot", Number.isInteger(tab) ? { tab } : {}, "mcp");
        const img = shot && shot.image;
        if (img && img.data) trace.event("failure_screenshot", { file: trace.shot(img.data, img.mime === "image/png" ? "png" : "jpg"), of: name });
      } catch { /* no screenshot is not a second failure */ }
    }
    return out;
  }

  /** The tools a model sees: name, description, input schema. Dots become underscores (MCP names allow no dots). */
  function list() {
    const rows = [...tools.entries()].filter(([n]) => !HIDDEN.has(n)).map(([n, d]) => ({
      name: n, description: (n === "chrome.resume" ? "Never put this tool in an allow list: only the person undoes their Esc. " : "") + (String(d.description || "") + (n === "chrome.eval" ? " Containment: a script you run cannot send anything to a site the page does not already talk to over HTTP(S), navigation, WebSockets or beacons (enforced by the browser for every frame); WebRTC and DNS hints are refused only in their plain forms (a script that builds an iframe, or uses innerHTML or document.write, can get around those two)." : "")).replace(/at the Gate/g, "until the person approves chrome_send"), inputSchema: d.input || { type: "object", properties: {} },
    }));
    rows.push({
      name: "chrome.send",
      description: "Never put this tool in an allow list: it is where the person approves (the server also asks them itself when their client can be asked). Do an act that sends something as the person (a real submit, a message, a post, a payment) which another chrome tool held and returned an id for. Claude Code asks the person to approve this call; nothing that sends goes out without it. Refused if the page changed since it was held.",
      inputSchema: { type: "object", properties: { id: { type: "string", description: "The id from the held answer." } }, required: ["id"] },
    });
    return rows;
  }

  return {
    dataDir, trace, list, invoke, held, call,
    async stop() { clearInterval(statusTimer); try { const j = JSON.parse(fs.readFileSync(statusFile, "utf8")); if (j && j.pid === process.pid) fs.rmSync(statusFile, { force: true }); } catch { /* gone or not ours */ } trace.write({ kind: "session", event: "stop" }); await running.stop(); },
  };
}
