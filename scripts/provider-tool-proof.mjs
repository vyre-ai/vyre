#!/usr/bin/env node
// @ts-check
// What the real Codex and Grok Build CLIs do through Vyre's ACP driver when the model asks for a tool, with no account and no key
// (a local stand-in for the model, scripts/proof-mock-model.mjs), on a hosted runner, never the person's Mac:
//   tool     a shell tool call reaches Vyre as a permission question BEFORE anything runs (nothing is auto-approved);
//   deny     a denied command does not run; an allowed one does and the turn finishes on its result;
//   floor    the question's command is judged by Vyre's security floor (a command that reads Vyre's own files is denied);
//   interrupt  a turn that is streaming stops when Vyre interrupts it, and the session lives on;
//   resume   after the agent process is stopped and started again, session/load carries the same session on.
// One line per fact: PASS, FAIL or INFO. Exit 0 always: a measurement, read the lines.
//
// With `--real-home <VYRE_HOME>` it instead runs a few turns (three per provider) on the REAL signed-in accounts under
// <VYRE_HOME>/accounts and the real model, with no stand-in: a plain reply, a command that has to leave the sandbox (a question to Vyre
// for Codex, the floor-served terminal for Grok) and a Vyre tool through the real MCP bridge. It uses the account's own HOME as Vyre
// would, so only for a throwaway Vyre on a test box. A provider with no signed-in account says so and is skipped.
// `--capture <dir>` (with --real-home) also records the raw ACP stream of the handshake and of every real turn, scrubbed of the account's
// folder, the working folder, tokens and addresses, as ndjson fixtures under <dir>/<provider>/ (handshake, then one file per turn), for
// building and testing rendering against the stand-in without spending another real turn. A fourth turn asks for a plan and a file edit
// so plans, tool-call kinds and diffs are in the set.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { codexProvider } from "../core/sessions/drivers/codex.js";
import { grokProvider } from "../core/sessions/drivers/grok.js";
import { rules } from "../core/harness/rules.js";
import { mockModel, shellArgs } from "./proof-mock-model.mjs";

const MCP_SERVER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "harness", "mcp", "server.js");
const out = [];
const say = (kind, what) => { out.push(`${kind} ${what}`); console.log(`${kind} ${what}`); };
const tmp = p => fs.mkdtempSync(path.join(os.tmpdir(), p));
const where = bin => { try { return execFileSync("which", [bin], { encoding: "utf8" }).trim(); } catch { return null; } };
const scrub = s => String(s).replace(/\s+/g, " ").slice(0, 240);

/** A stand-in for vyred on a session's own socket: Vyre's real MCP server (harness/mcp/server.js) lists and calls one tool through it. */
function fakeVyred() {
  const dir = tmp("proof-vyred-");
  const sock = path.join(dir, "vyre.sock");
  /** @type {any[]} */ const calls = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", c => { body += c; });
    req.on("end", () => {
      const caller = String(req.headers["x-vyre-caller"] || "");
      const url = String(req.url);
      if (req.method === "GET" && url === "/v1/tools") {
        res.end(JSON.stringify({ data: [{ name: "waiting.count", description: "How many things wait on the person.", input: { properties: {} } }] }));
      } else if (req.method === "POST" && url === "/v1/tools/waiting.count") {
        calls.push({ caller, url, call: req.headers["x-vyre-call-id"] || null });
        res.end(JSON.stringify({ data: { count: 2, by_kind: { ask: 1, draft: 1 } } }));
      } else res.end(JSON.stringify({ error: { code: "no_such_tool", message: `no ${url}` } }));
    });
  });
  return new Promise(resolve => { server.listen(sock, () => resolve({ sock, calls, close: () => { try { server.close(); } catch {} } })); });
}

const floorHome = tmp("proof-tool-floor-");
const vyreHome = path.join(floorHome, ".vyre");
fs.mkdirSync(path.join(vyreHome, "vault"), { recursive: true });
fs.writeFileSync(path.join(vyreHome, "vault", "key"), "not-a-real-key");
/** Every command the floor was asked about, with what it said: how a provider that runs commands through Vyre's own terminal (Grok) is shown to be gated. */
const floorSeen = [];
const floorFor = cwd => c => { const v = rules({ tool: c.tool, input: c.input, cwd: c.cwd || cwd, home: vyreHome }); floorSeen.push({ tool: c.tool, command: c.input && c.input.command, decision: v.decision }); return v; };

/** @param {string} which */
async function prove(which) {
  const bin = which === "codex" ? "codex-acp" : "grok";
  if (!where(bin)) { say("FAIL", `${which}: \`${bin}\` is not installed on this runner`); return; }
  const work = tmp(`proof-tool-${which}-work-`);
  const home = tmp(`proof-tool-${which}-home-`);
  /** What the stand-in does next, set per step. */
  const scen = { mode: "text", cmd: "", text: "PROOF-OK", outputs: [], raw: "" };
  const mock = /** @type {any} */ (await mockModel(req => {
    if (process.env.PROOF_DEBUG) console.log(`DEBUG ${which}: request mode=${scen.mode} hasToolResult=${req.hasToolResult} tools=${req.toolNames.slice(0, 3)} lastInput=${JSON.stringify((req.body.input || []).slice(-2).map(x => [x.type, x.role || x.name || ""]))}`);
    // What the CLI says the tool did (its output as the model would read it), so a refusal or an error is in the log.
    if (req.hasToolResult) {
      const o = (Array.isArray(req.body.input) ? req.body.input : []).filter(x => x && /tool_call_output|function_call_output/.test(String(x.type))).at(-1);
      const m = (Array.isArray(req.body.messages) ? req.body.messages : []).filter(x => x && x.role === "tool").at(-1);
      if (m) { scen.outputs.push(scrub(String(typeof m.content === "string" ? m.content : JSON.stringify(m.content))).slice(0, 220)); scen.raw = JSON.stringify(m.content); }
      if (o) { scen.outputs.push(scrub(JSON.stringify(o.output).replace(/\\n/g, " ")).slice(0, 220)); scen.raw = JSON.stringify(o.output); }
    }
    if (scen.mode === "hang") return { hang: true, text: "late" };
    // Codex reaches a Vyre MCP tool the way it reaches the shell: from inside the one `exec` custom tool, as tools.mcp__<server>__<tool>.
    if ((scen.mode === "list" || scen.mode === "vyretool") && !req.hasToolResult) {
      const t = req.tools.find(x => x.type === "custom" && x.name === "exec");
      if (!t) return { text: "noted" };
      return { custom: { name: "exec", input: scen.mode === "list" ? "text(JSON.stringify(ALL_TOOLS.map(t => t.name)))" : "text(JSON.stringify(await tools.mcp__vyre__waiting_count({})))" } };
    }
    if (scen.mode === "list" || scen.mode === "vyretool") return { text: "VYRE-TOOL-DONE" };
    if (scen.mode === "tool" && !req.hasToolResult) {
      // Only the main request has a shell-like tool (Grok also sends a title request with one tool, session_title): anything else gets text.
      const t = req.tools.find(x => /terminal|shell|exec|bash|run_?command|local_shell/i.test(String(x.name || (x.function && x.function.name) || x.type || "")));
      if (!t) return { text: "noted" };
      const name = String(t.name || (t.function && t.function.name) || t.type);
      // Codex's newer models reach the shell only through the one `exec` custom tool, whose JavaScript calls the nested tools.
      // Codex runs a command inside its own sandbox without asking; it asks the person only for one that needs to leave it, which the
      // model says with sandbox_permissions "require_escalated" and a justification. That is the question Vyre has to see and answer.
      if (t.type === "custom") return { custom: { name, input: `text(JSON.stringify(await tools.exec_command({ cmd: ${JSON.stringify(scen.cmd)}, sandbox_permissions: "require_escalated", justification: "the proof asks Vyre" })))` } };
      return { tool: { name, args: shellArgs(t, scen.cmd) } };
    }
    return { text: scen.mode === "tool" ? "TOOL-DONE" : scen.text };
  }));
  const base = `http://127.0.0.1:${mock.port}/v1`;
  let provider, env;
  if (which === "codex") {
    fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
    provider = codexProvider({ floor: floorFor(work), custom: { id: "mockmodel", baseUrl: base, envKey: "MOCK_MODEL_KEY", model: "mock-model" } });
    env = { PATH: process.env.PATH || "", HOME: home, MOCK_MODEL_KEY: "mock-key" };
  } else {
    fs.mkdirSync(path.join(home, ".grok"), { recursive: true });
    fs.writeFileSync(path.join(home, ".grok", "config.toml"), `[models]\ndefault = "proof"\n\n[model.proof]\nmodel = "mock-model"\nbase_url = "${base}"\nenv_key = "MOCK_MODEL_KEY"\nname = "proof"\n`);
    provider = grokProvider({ floor: floorFor(work), home });
    env = { PATH: process.env.PATH || "", HOME: home, MOCK_MODEL_KEY: "mock-key" };
  }
  const vyred = /** @type {any} */ (await fakeVyred());
  // The same bridge the Switchboard hands every provider that is not Claude: Vyre's MCP server, scoped by the thread's own socket.
  const mcpServers = [{ name: "vyre", command: process.execPath, args: [MCP_SERVER], env: Object.entries({ VYRE_SOCKET: vyred.sock, VYRE_THREAD: "proof-thread", VYRE_AGENT: "juno", VYRE_AGENT_KIND: "assistant" }).map(([name, value]) => ({ name, value })) }];
  const threadId = crypto.randomUUID();
  /** @type {any[]} */ let got = [];
  /** @type {((m: any) => void)|null} */ let onAsk = null;
  const floor = floorFor(work);
  const start = (resume) => {
    got = [];
    const proc = provider.run({ id: threadId, resume, cwd: work, env, mcpServers, onSpawn() {}, onExit() {}, onMessage: m => {
      got.push(m);
      if (m.type === "control_request" && m.request && m.request.subtype === "can_use_tool" && onAsk) onAsk(m);
    } });
    return proc;
  };
  const until = async (test, ms) => { const end = Date.now() + ms; while (Date.now() < end) { const f = got.find(test); if (f) return f; await new Promise(r => setTimeout(r, 100)); } return null; };
  const results = () => got.filter(m => m.type === "result").length;
  const answer = (proc, m, behavior) => proc.write({ type: "control_response", response: { request_id: m.request_id, response: behavior === "allow" ? { behavior: "allow", updatedInput: m.request.input } : { behavior: "deny", message: "denied" } } });
  const turn = async (proc, text, ms = 90_000) => { const n = results(); proc.write({ type: "user", message: { role: "user", content: text } }); const end = Date.now() + ms; while (results() <= n && Date.now() < end) await new Promise(r => setTimeout(r, 100)); return results() > n; };

  let proc = start(false);
  const init = await until(m => m.type === "system" && m.subtype === "init", 90_000);
  if (!init) { say("FAIL", `${which}: no init: ${scrub((got.find(m => m.type === "result") || {}).result || "")}`); try { await proc.stop(2000); } catch {} mock.close(); return; }
  say("PASS", `${which}: session started (start mode ${init.mode || "(none)"})`);
  // How each CLI is gated. Codex runs commands in its own sandbox and asks the person only for one that must leave it: that question is
  // Vyre's gate. Grok Build runs every command through the client's terminal (terminal/create), which Vyre serves through the floor: the
  // floor is its gate, and no question is raised unless the floor says ask.
  const asksPerson = which === "codex";

  // tool + ask + allow
  const markAllow = path.join(work, "marker-allow"), markDeny = path.join(work, "marker-deny");
  scen.mode = "tool"; scen.cmd = `touch ${markAllow}`;
  /** @type {any} */ let ask = null;
  onAsk = m => { ask = m; say(fs.existsSync(markAllow) ? "FAIL" : "PASS", `${which}: a permission question reached Vyre before the command ran (tool ${m.request.tool_name}, command ${scrub(JSON.stringify(m.request.input).slice(0, 160))})`); answer(proc, m, "allow"); };
  const done1 = await turn(proc, "Run the touch command with your shell tool.");
  if (asksPerson) say(ask ? "PASS" : "FAIL", `${which}: the shell tool call was asked about, not auto-approved`);
  else {
    const j = floorSeen.find(x => x.command && x.command.includes(markAllow));
    say(j && j.decision !== "deny" ? "PASS" : "FAIL", `${which}: the shell command reached Vyre's terminal and was judged by the floor first (${j ? `the floor said ${j.decision}` : "the floor was not asked"})`);
    say("INFO", `${which}: permission questions raised for it: ${ask ? 1 : 0} (none expected: Vyre's terminal and its floor are this CLI's gate)`);
  }
  say(done1 && fs.existsSync(markAllow) ? "PASS" : "FAIL", `${which}: an allowed command ran (marker ${fs.existsSync(markAllow) ? "exists" : "missing"}) and the turn finished${done1 ? "" : " (no result in time)"}`);
  say("INFO", `${which}: what the stand-in was asked ${JSON.stringify(mock.seen.slice(0, 4).map(x => ({ url: x.url, keys: x.keys, toolTypes: x.toolTypes, toolChoice: x.toolChoice, toolNames: (x.toolNames || []).slice(0, 4) })))}`);
  say("INFO", `${which}: what the tool returned to the model ${JSON.stringify(scen.outputs)}`);
  say("INFO", `${which}: the stand-in saw tools ${JSON.stringify([...mock.seen].sort((a, b) => (b.toolNames || []).length - (a.toolNames || []).length)[0]?.toolNames || [])}`);

  // a Vyre tool: Vyre's own MCP server must reach the real agent's tool surface, and a call must come back
  if (which === "codex") {
    onAsk = null;
    scen.mode = "list"; scen.raw = "";
    await turn(proc, "List your tools.");
    say(/mcp__vyre__waiting_count/.test(scen.raw) ? "PASS" : "FAIL", `${which}: Vyre's MCP server (mcpServers in session/new) is on the agent's tool surface: ${/mcp__vyre__waiting_count/.test(scen.raw) ? "mcp__vyre__waiting_count is among its nested tools" : `its nested tools were ${scrub(scen.raw).slice(0, 200)}`}`);
    /** @type {any[]} */ const asked = [];
    onAsk = m => { asked.push(`${m.request.tool_name} ${scrub(JSON.stringify(m.request.input)).slice(0, 140)}`); answer(proc, m, "allow"); };
    scen.mode = "vyretool"; scen.raw = "";
    await turn(proc, "How many things wait on me? Use the Vyre tool.");
    const got1 = vyred.calls.at(-1);
    say(got1 && got1.caller === "mcp:agent:juno" && got1.url === "/v1/tools/waiting.count" ? "PASS" : "FAIL", `${which}: the model's call reached vyred through Vyre's MCP server as the verified caller (${got1 ? `${got1.caller} ${got1.url}` : "no call arrived"})`);
    say(/"count":\s*2|\\"count\\":\s*2/.test(scen.raw) || /count/.test(scen.raw) ? "PASS" : "FAIL", `${which}: vyred's answer came back to the model (${scrub(scen.raw).slice(0, 160)})`);
    say("INFO", `${which}: permission questions raised for the Vyre tool call: ${JSON.stringify(asked)}`);
    scen.mode = "tool";
  }

  if (which === "grok") say("INFO", `grok: Vyre's MCP server in session/new: its tools among those the stand-in saw: ${JSON.stringify([...new Set(mock.seen.flatMap(x => x.toolNames || []))].filter(n => /vyre|waiting/i.test(n)))} (Grok lists only a fixed set plus a search_tool, so a deferred MCP tool is not shown here)`);

  // deny
  if (!asksPerson) say("INFO", `${which}: no deny step: a command is stopped by the floor (next step), not by a question`);
  else {
  scen.cmd = `touch ${markDeny}`; ask = null;
  onAsk = m => { ask = m; answer(proc, m, "deny"); };
  const done2 = await turn(proc, "Run the second touch command.");
  await new Promise(r => setTimeout(r, 500));
  say(ask && !fs.existsSync(markDeny) ? "PASS" : "FAIL", `${which}: a denied command did not run (asked ${Boolean(ask)}, marker ${fs.existsSync(markDeny) ? "exists" : "missing"})`);
  say(done2 ? "PASS" : "FAIL", `${which}: the turn finished after the denial`);

  }

  // floor: a command that reads Vyre's own vault is judged by the floor
  if (!asksPerson) {
    scen.cmd = `cat ${path.join(vyreHome, "vault", "key")}`; scen.raw = ""; onAsk = null;
    const seenFrom = floorSeen.length;
    await turn(proc, "Read the key file with your shell tool.");
    const j = floorSeen.slice(seenFrom).find(x => x.command && x.command.includes("vault"));
    say(j && j.decision === "deny" ? "PASS" : "FAIL", `${which}: the floor denies a command that reads Vyre's own vault (${j ? `the floor said ${j.decision}` : "the floor was not asked"})`);
    say(!scen.outputs.some(o => o.includes("not-a-real-key")) ? "PASS" : "FAIL", `${which}: the vault's bytes never reached the model`);
  } else {
  scen.cmd = `cat ${path.join(vyreHome, "vault", "key")}`; ask = null; let judged = null;
  onAsk = m => { ask = m; const cmd = m.request.input && (m.request.input.command || (Array.isArray(m.request.input.cmd) ? m.request.input.cmd.join(" ") : m.request.input.cmd)); judged = floor({ tool: "Bash", input: { command: Array.isArray(cmd) ? cmd.join(" ") : String(cmd || "") }, cwd: work }); answer(proc, m, judged && judged.decision === "deny" ? "deny" : "allow"); };
  await turn(proc, "Read the key file with your shell tool.");
  say(ask && judged && judged.decision === "deny" ? "PASS" : "FAIL", `${which}: the floor denies a command that reads Vyre's own vault (${ask ? `asked; the floor said ${judged ? judged.decision : "nothing"}` : "no question reached Vyre"})`);

  }

  // interrupt
  onAsk = null; scen.mode = "hang";
  const n0 = results();
  proc.write({ type: "user", message: { role: "user", content: "Take your time." } });
  await new Promise(r => setTimeout(r, 4000));
  await proc.interrupt();
  const end = Date.now() + 20_000; while (results() <= n0 && Date.now() < end) await new Promise(r => setTimeout(r, 100));
  const cancelled = got.filter(m => m.type === "result").at(-1);
  say(results() > n0 ? "PASS" : "FAIL", `${which}: an interrupted turn ended (${cancelled ? `stop ${cancelled.stop_reason || "?"}` : "no result"})`);
  scen.mode = "text"; scen.text = "STILL-HERE";
  const after = await turn(proc, "Say something.");
  say(after && /STILL-HERE/.test(JSON.stringify(got.slice(-6))) ? "PASS" : "FAIL", `${which}: the session answers after an interrupt`);

  // resume after the agent process is stopped and started again
  try { await proc.stop(3000); } catch {}
  proc = start(true);
  const again = await until(m => m.type === "system" && m.subtype === "init", 90_000);
  say(again && again.resumed ? "PASS" : again ? "INFO" : "FAIL", `${which}: after a stop and a new process the session ${again ? (again.resumed ? "was loaded again (session/load)" : "started fresh (not resumed)") : "did not start"}`);
  scen.text = "RESUMED-OK";
  const resumed = await turn(proc, "Are you there?");
  say(resumed && /RESUMED-OK/.test(JSON.stringify(got.slice(-6))) ? "PASS" : "FAIL", `${which}: a turn after the resume answers`);
  try { await proc.stop(3000); } catch {}
  mock.close(); vyred.close();
}

/**
 * The real accounts: a few turns on a signed-in account and the real model, nothing scripted.
 * @param {string} which @param {string} realHome the Vyre home of a throwaway vyred (its accounts/ folder holds each account's HOME)
 */
async function proveReal(which, realHome) {
  // the capture folder (module scope `capture`) is only written with --capture
  const bin = which === "codex" ? "codex-acp" : "grok";
  if (!where(bin)) { say("FAIL", `${which}: \`${bin}\` is not installed here`); return; }
  const token = which === "codex" ? path.join(".codex", "auth.json") : path.join(".grok", "auth.json");
  const accounts = (fs.existsSync(path.join(realHome, "accounts")) ? fs.readdirSync(path.join(realHome, "accounts")) : []).map(d => path.join(realHome, "accounts", d)).filter(d => fs.existsSync(path.join(d, token)));
  if (!accounts.length) { say("FAIL", `${which}: no signed-in account under ${path.join(realHome, "accounts")} (no ${token}): sign one in first`); return; }
  const home = accounts[0];
  const work = tmp(`proof-real-${which}-work-`);
  const floor = floorFor(work);
  const vyred = /** @type {any} */ (await fakeVyred());
  const mcpServers = [{ name: "vyre", command: process.execPath, args: [MCP_SERVER], env: Object.entries({ VYRE_SOCKET: vyred.sock, VYRE_THREAD: "proof-thread", VYRE_AGENT: "juno", VYRE_AGENT_KIND: "assistant" }).map(([name, value]) => ({ name, value })) }];
  /** @type {{ t: number, dir: string, msg: any }[]} */ const wire = [];
  const t0 = Date.now();
  const tap = capture ? (dir, msg) => { wire.push({ t: Date.now() - t0, dir, msg }); } : undefined;
  const provider = which === "codex" ? codexProvider({ floor }) : grokProvider({ floor, home });
  /** @type {any[]} */ const got = [];
  /** @type {any[]} */ const asked = [];
  let allow = true;
  /** @type {any} */ let proc = null;
  proc = provider.run({ id: crypto.randomUUID(), resume: false, cwd: work, env: { PATH: process.env.PATH || "", HOME: home }, mcpServers, tap, onSpawn() {}, onExit() {}, onMessage: m => {
    got.push(m);
    if (m.type === "control_request" && m.request && m.request.subtype === "can_use_tool") {
      asked.push(`${m.request.tool_name} ${scrub(JSON.stringify(m.request.input)).slice(0, 120)}`);
      proc.write({ type: "control_response", response: { request_id: m.request_id, response: allow ? { behavior: "allow", updatedInput: m.request.input } : { behavior: "deny", message: "denied" } } });
    }
  } });
  const results = () => got.filter(m => m.type === "result").length;
  const until = async (test, ms) => { const end = Date.now() + ms; while (Date.now() < end) { const f = got.find(test); if (f) return f; await new Promise(r => setTimeout(r, 200)); } return null; };
  let mark = 0, saved = 0;
  /** Write what crossed the wire since the last mark as one fixture, scrubbed. */
  const save = name => {
    if (!capture) return;
    const dir = path.join(capture, which);
    fs.mkdirSync(dir, { recursive: true });
    const lines = wire.slice(mark).map(w => JSON.stringify({ t: w.t, dir: w.dir, msg: w.msg }));
    mark = wire.length;
    fs.writeFileSync(path.join(dir, `${String(saved++).padStart(2, "0")}-${name}.ndjson`), scrubWire(lines.join("\n"), [[home, "<ACCOUNT_HOME>"], [work, "<WORK>"], [realHome, "<VYRE_HOME>"]]) + "\n");
  };
  const turn = async (text, ms = 150_000) => {
    const n = results();
    const from = got.length;
    proc.write({ type: "user", message: { role: "user", content: text } });
    const end = Date.now() + ms;
    while (results() <= n && Date.now() < end) await new Promise(r => setTimeout(r, 300));
    const res = got.filter(m => m.type === "result")[n];
    return { done: Boolean(res), res, said: got.slice(from).filter(m => m.type === "stream_event" && m.event.delta && m.event.delta.text).map(m => m.event.delta.text).join("") };
  };
  try {
    const init = await until(m => m.type === "system" && m.subtype === "init", 120_000);
    if (!init) { say("FAIL", `${which}: no init on the signed-in account: ${scrub((got.find(m => m.type === "result") || {}).result || "")}`); return; }
    save("handshake");
    say("PASS", `${which}: the signed-in account's session started (model ${init.model || "(none said)"}, start mode ${init.mode || "(none)"})`);
    // 1. a plain turn, and what the meter reports
    const t1 = await turn("Reply with exactly the words PROOF-OK and nothing else.");
    save("turn-plain");
    say(t1.done && !t1.res.is_error && /PROOF-OK/.test(t1.said + String(t1.res.result)) ? "PASS" : "FAIL", `${which}: a real turn on the real model answered${t1.res && t1.res.is_error ? ` with an error: ${scrub(t1.res.result)}` : ""}`);
    say("INFO", `${which}: usage the driver reported for the turn ${JSON.stringify(t1.res && t1.res.usage || null)}`);
    // 2. a command that must leave the sandbox: a file in the account's home, outside the workspace
    const marker = path.join(home, `proof-real-${crypto.randomBytes(4).toString("hex")}`);
    const from2 = floorSeen.length;
    const t2 = await turn(`Use your shell tool to run exactly this command and nothing else: touch ${marker}`);
    save("turn-command-outside-workspace");
    const ran = fs.existsSync(marker);
    if (which === "codex") say(asked.length ? "PASS" : "INFO", `${which}: a command outside the workspace ${asked.length ? "reached Vyre as a permission question before it ran" : "raised no question"} (${JSON.stringify(asked.slice(0, 2))}); it ${ran ? "ran" : "did not run"}`);
    else { const j = floorSeen.slice(from2).find(x => x.command && x.command.includes(marker)); say(j ? "PASS" : "INFO", `${which}: the command ${j ? `reached Vyre's terminal and the floor said ${j.decision}` : "did not reach Vyre's terminal"}; it ${ran ? "ran" : "did not run"}`); }
    try { fs.rmSync(marker, { force: true }); } catch {}
    say("INFO", `${which}: the model said ${scrub(t2.said).slice(0, 160)}`);
    // 3. a Vyre tool, through the real MCP bridge
    asked.length = 0;
    const t3 = await turn("Call the Vyre tool named waiting_count (waiting.count) and tell me the number it returns.");
    save("turn-vyre-mcp-tool");
    if (capture) {
      // A plan and a file edit, so plans, edit tool calls and diffs are in the fixture set.
      const t4 = await turn("First write a two-step plan. Then create a file named hello.txt in the current folder containing the single word hello, and show me the change as a diff.");
      save("turn-plan-and-edit");
      say("INFO", `${which}: the plan-and-edit turn ${t4.done ? "finished" : "did not finish"} (${scrub(t4.said).slice(0, 120)})`);
    }
    const c = vyred.calls.at(-1);
    say(c && c.caller === "mcp:agent:juno" ? "PASS" : "INFO", `${which}: the real model ${c ? `called the Vyre tool and vyred saw ${c.caller} ${c.url}` : "did not call the Vyre tool"}${/\b2\b/.test(t3.said) ? " and read its answer back" : ""}; questions raised ${JSON.stringify(asked.slice(0, 2))}`);
  } finally { try { await proc.stop(3000); } catch {} vyred.close(); }
}

/**
 * Fixture text without anything of the account: its folder, the working folder, bearer tokens, key shapes, addresses and long opaque ids.
 * @param {string} text @param {[string, string][]} paths
 */
function scrubWire(text, paths) {
  let t = text;
  for (const [from, to] of paths) if (from) t = t.split(from).join(to);
  // The machine's own names: the checkout, the user and the host.
  t = t.split(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")).join("<REPO>");
  for (const [from, to] of [[os.homedir(), "/home/user"], [os.userInfo().username, "user"], [os.hostname(), "<HOST>"]]) if (from && from.length > 2) t = t.split(from).join(to);
  return t
    .replace(/Bearer [A-Za-z0-9._~+\/=-]{8,}/g, "Bearer [token]")
    .replace(/\b(sk|xai|rq_live|ghp|gho|github_pat)[-_][A-Za-z0-9_-]{12,}/g, "[key]")
    .replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, "user@example.org")
    .replace(/"hostname":"[^"]*"/g, '"hostname":"<HOST>"')
    .replace(/"label":"ChatGPT [A-Za-z ]+"/g, '"label":"ChatGPT"').replace(/"plan":"[a-z]+"/g, '"plan":"plan"')
    .replace(/"(agentId|agent_id|agentInstanceId|instanceId|userId|user_id|accountId|account_id|organizationId|teamId)":"[0-9a-f-]{36}"/g, '"$1":"00000000-0000-0000-0000-000000000000"')
    .replace(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, "[jwt]");
}
const realIdx = process.argv.indexOf("--real-home");
// Real accounts, real spend: never a Mac (the person's own machine), whatever the home path says.
if (realIdx > 0 && process.platform === "darwin") { console.error("provider-tool-proof: --real-home runs real turns on signed-in accounts and is for the Linux test box only, not a Mac."); process.exit(2); }
const capIdx = process.argv.indexOf("--capture");
const capture = capIdx > 0 ? path.resolve(process.argv[capIdx + 1]) : null;
const realHome = realIdx > 0 ? process.argv[realIdx + 1] : null;
for (const which of ["codex", "grok"]) {
  try { await (realHome ? proveReal(which, realHome) : prove(which)); } catch (e) { say("FAIL", `${which}: ${scrub(/** @type {Error} */ (e).message)}`); }
}
console.log(`\n${out.filter(l => l.startsWith("PASS")).length} PASS, ${out.filter(l => l.startsWith("FAIL")).length} FAIL, ${out.filter(l => l.startsWith("INFO")).length} INFO`);
process.exit(0);
