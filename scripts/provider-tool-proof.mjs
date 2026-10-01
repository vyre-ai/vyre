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

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { codexProvider } from "../core/sessions/drivers/codex.js";
import { grokProvider } from "../core/sessions/drivers/grok.js";
import { rules } from "../core/harness/rules.js";
import { mockModel, shellArgs } from "./proof-mock-model.mjs";

const out = [];
const say = (kind, what) => { out.push(`${kind} ${what}`); console.log(`${kind} ${what}`); };
const tmp = p => fs.mkdtempSync(path.join(os.tmpdir(), p));
const where = bin => { try { return execFileSync("which", [bin], { encoding: "utf8" }).trim(); } catch { return null; } };
const scrub = s => String(s).replace(/\s+/g, " ").slice(0, 240);

const floorHome = tmp("proof-tool-floor-");
const vyreHome = path.join(floorHome, ".vyre");
fs.mkdirSync(path.join(vyreHome, "vault"), { recursive: true });
fs.writeFileSync(path.join(vyreHome, "vault", "key"), "not-a-real-key");
const floorFor = cwd => c => rules({ tool: c.tool, input: c.input, cwd: c.cwd || cwd, home: vyreHome });

/** @param {string} which */
async function prove(which) {
  const bin = which === "codex" ? "codex-acp" : "grok";
  if (!where(bin)) { say("FAIL", `${which}: \`${bin}\` is not installed on this runner`); return; }
  const work = tmp(`proof-tool-${which}-work-`);
  const home = tmp(`proof-tool-${which}-home-`);
  /** What the stand-in does next, set per step. */
  const scen = { mode: "text", cmd: "", text: "PROOF-OK" };
  const mock = /** @type {any} */ (await mockModel(req => {
    if (scen.mode === "hang") return { hang: true, text: "late" };
    if (scen.mode === "tool" && !req.hasToolResult) {
      // Only the main request has a shell-like tool (Grok also sends a title request with one tool, session_title): anything else gets text.
      const t = req.tools.find(x => /terminal|shell|exec|bash|run_?command|local_shell/i.test(String(x.name || (x.function && x.function.name) || x.type || "")));
      if (!t) return { text: "noted" };
      const name = String(t.name || (t.function && t.function.name) || t.type);
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
  const threadId = crypto.randomUUID();
  /** @type {any[]} */ let got = [];
  /** @type {((m: any) => void)|null} */ let onAsk = null;
  const floor = floorFor(work);
  const start = (resume) => {
    got = [];
    const proc = provider.run({ id: threadId, resume, cwd: work, env, onSpawn() {}, onExit() {}, onMessage: m => {
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

  // tool + ask + allow
  const markAllow = path.join(work, "marker-allow"), markDeny = path.join(work, "marker-deny");
  scen.mode = "tool"; scen.cmd = `touch ${markAllow}`;
  /** @type {any} */ let ask = null;
  onAsk = m => { ask = m; say(fs.existsSync(markAllow) ? "FAIL" : "PASS", `${which}: a permission question reached Vyre before the command ran (tool ${m.request.tool_name}, command ${scrub(JSON.stringify(m.request.input).slice(0, 160))})`); answer(proc, m, "allow"); };
  const done1 = await turn(proc, "Run the touch command with your shell tool.");
  say(ask ? "PASS" : "FAIL", `${which}: the shell tool call was asked about, not auto-approved`);
  say(done1 && fs.existsSync(markAllow) ? "PASS" : "FAIL", `${which}: an allowed command ran (marker ${fs.existsSync(markAllow) ? "exists" : "missing"}) and the turn finished${done1 ? "" : " (no result in time)"}`);
  say("INFO", `${which}: what the stand-in was asked ${JSON.stringify(mock.seen.slice(0, 4).map(x => ({ url: x.url, keys: x.keys, toolTypes: x.toolTypes, toolChoice: x.toolChoice, toolNames: (x.toolNames || []).slice(0, 4) })))}`);
  say("INFO", `${which}: the stand-in saw tools ${JSON.stringify([...mock.seen].sort((a, b) => (b.toolNames || []).length - (a.toolNames || []).length)[0]?.toolNames || [])}`);

  // deny
  scen.cmd = `touch ${markDeny}`; ask = null;
  onAsk = m => { ask = m; answer(proc, m, "deny"); };
  const done2 = await turn(proc, "Run the second touch command.");
  await new Promise(r => setTimeout(r, 500));
  say(ask && !fs.existsSync(markDeny) ? "PASS" : "FAIL", `${which}: a denied command did not run (asked ${Boolean(ask)}, marker ${fs.existsSync(markDeny) ? "exists" : "missing"})`);
  say(done2 ? "PASS" : "FAIL", `${which}: the turn finished after the denial`);

  // floor: a command that reads Vyre's own vault is judged by the floor
  scen.cmd = `cat ${path.join(vyreHome, "vault", "key")}`; ask = null; let judged = null;
  onAsk = m => { ask = m; const cmd = m.request.input && (m.request.input.command || (Array.isArray(m.request.input.cmd) ? m.request.input.cmd.join(" ") : m.request.input.cmd)); judged = floor({ tool: "Bash", input: { command: Array.isArray(cmd) ? cmd.join(" ") : String(cmd || "") }, cwd: work }); answer(proc, m, judged && judged.decision === "deny" ? "deny" : "allow"); };
  await turn(proc, "Read the key file with your shell tool.");
  say(ask && judged && judged.decision === "deny" ? "PASS" : "FAIL", `${which}: the floor denies a command that reads Vyre's own vault (${ask ? `asked; the floor said ${judged ? judged.decision : "nothing"}` : "no question reached Vyre"})`);

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
  mock.close();
}

for (const which of ["codex", "grok"]) {
  try { await prove(which); } catch (e) { say("FAIL", `${which}: ${scrub(/** @type {Error} */ (e).message)}`); }
}
console.log(`\n${out.filter(l => l.startsWith("PASS")).length} PASS, ${out.filter(l => l.startsWith("FAIL")).length} FAIL, ${out.filter(l => l.startsWith("INFO")).length} INFO`);
process.exit(0);
