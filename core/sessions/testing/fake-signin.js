#!/usr/bin/env node
// @ts-check
// A stand-in for the three sign-in CLIs the inference door's sign-in drivers run (core/sessions/drivers/signin-door.js), for tests. Which one it is comes from its arguments:
//   claude  `-p ... --system-prompt <rules>`, the conversation on stdin, one JSON result on stdout; its credential on descriptor 3 (CLAUDE_CODE_*_FILE_DESCRIPTOR) or in the environment
//   codex   `exec --json ... -`, the conversation on stdin, JSON events on stdout and --output-last-message; its credential in OPENAI_API_KEY or $CODEX_HOME/auth.json (a login)
//   grok    `agent stdio`, ACP over stdio; its credential in XAI_API_KEY or $HOME/.grok/auth.json (a login)
// What it says depends on the words it was sent:
//   EXPIRED        fails as an expired sign-in does
//   SLOW           waits 10 seconds first
//   BADJSON-ONCE   answers in prose the first time and in JSON when the rule is said again after the text; BADJSON-ALWAYS answers in prose every time
//   TOOLTRY        (grok) asks permission to run a command first, and notes the answer
//   a classify rule ("Answer with exactly one of these words ...: a, b") answers the first label the text names, else the last label; a JSON rule answers {"name":"Ada","amount":42}
// FAKE_SIGNIN_LOG: one JSON line per launch: which CLI, a sha256 of the credential it got (never the credential), whether any environment variable held it, HOME, cwd, CODEX_HOME, its flags, and the names
// (never the values) of its environment variables.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import readline from "node:readline";

const argv = process.argv.slice(2);
const sha = (/** @type {string} */ v) => crypto.createHash("sha256").update(v).digest("hex");
const log = (/** @type {any} */ o) => { if (process.env.FAKE_SIGNIN_LOG) fs.appendFileSync(process.env.FAKE_SIGNIN_LOG, JSON.stringify({ at: Date.now(), pid: process.pid, ...o }) + "\n"); };
const readAll = () => new Promise(r => { let s = ""; process.stdin.setEncoding("utf8"); process.stdin.on("data", d => (s += d)); process.stdin.on("end", () => r(s)); });
const sleep = (/** @type {number} */ ms) => new Promise(r => setTimeout(r, ms));
const envHolds = (/** @type {string|null} */ v) => Boolean(v) && Object.values(process.env).some(x => x === v);
const fdCred = () => {
  for (const k of ["CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR", "CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR"]) if (process.env[k]) { try { return { via: k, value: fs.readFileSync(Number(process.env[k]), "utf8") }; } catch { return { via: k, value: null }; } }
  for (const k of ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY"]) if (process.env[k]) return { via: k, value: String(process.env[k]) };
  return { via: null, value: null };
};
const fileCred = (/** @type {string} */ f) => { try { return fs.readFileSync(f, "utf8").trim(); } catch { return null; } };

/** The answer to `text` under `rules`. `base`: how many times the JSON rule is in the text of a first ask (Claude: none, it rides in --system-prompt; Codex and Grok: once, at the head). @param {string} rules @param {string} text @param {number} base */
function answer(rules, text, base) {
  const all = `${rules}\n${text}`;
  const said = text.split("Answer with ONE JSON object only").length - 1;
  if (/BADJSON-ALWAYS/.test(text) || (/BADJSON-ONCE/.test(text) && said <= base)) return "Sure! The name in that text is Ada and the amount is 42.";
  const m = /Answer with exactly one of these words and nothing else: ([^.\n]+)\./.exec(all) || /Answer with exactly one of: ([^.\n]+)\./.exec(all);
  if (m) { const labels = m[1].split(",").map(s => s.trim()).filter(Boolean); const pick = /LABEL=([a-z_]+)/.exec(text); return pick && labels.includes(pick[1]) ? pick[1] : labels[0]; }
  if (/ONE JSON object/.test(all)) return JSON.stringify({ name: "Ada", amount: 42 });
  return "ok";
}

async function claude() {
  if (argv.includes("--version")) { process.stdout.write("2.1.0 (Claude Code)\n"); return; }
  const cred = fdCred();
  const rules = argv[argv.indexOf("--system-prompt") + 1] || "";
  const text = String(await readAll());
  const toolsAt = argv.indexOf("--tools");
  log({ cli: "claude", marker: (/MARK-[a-z0-9]+/.exec(text) || [null])[0], got: cred.value ? sha(cred.value) : null, via: cred.via, env_holds: envHolds(cred.value), home: process.env.HOME, cwd: process.cwd(),
    no_tools: toolsAt >= 0 && argv[toolsAt + 1] === "", strict_mcp: argv.includes("--strict-mcp-config"), no_persist: argv.includes("--no-session-persistence"), env: Object.keys(process.env).sort() });
  if (/SLOW/.test(text)) await sleep(10_000);
  if (/EXPIRED/.test(text) || !cred.value) {
    process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: true, result: "Failed to authenticate. API Error: 401 OAuth token has expired. Please obtain a new token or run /login." }) + "\n");
    process.exitCode = 1; return;
  }
  process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: answer(rules, text, 0), usage: { input_tokens: 5, cache_read_input_tokens: 1, output_tokens: 2 }, total_cost_usd: 0.01 }) + "\n");
}

async function codex() {
  const home = process.env.CODEX_HOME || path.join(process.env.HOME || "", ".codex");
  const key = process.env.OPENAI_API_KEY || process.env.CODEX_API_KEY || null;
  const login = fileCred(path.join(home, "auth.json"));
  const value = key || login;
  const text = String(await readAll());
  const flag = (/** @type {string} */ f) => (argv.indexOf(f) >= 0 ? argv[argv.indexOf(f) + 1] : null);
  const cs = argv.filter((_, i) => argv[i - 1] === "-c");
  log({ cli: "codex", marker: (/MARK-[a-z0-9]+/.exec(text) || [null])[0], got: value ? sha(value) : null, via: key ? "env" : login ? "codex_home" : null, home: process.env.HOME, codex_home: process.env.CODEX_HOME || null, cwd: process.cwd(),
    sandbox: flag("--sandbox"), configs: cs, stdin_prompt: argv[argv.length - 1] === "-", env: Object.keys(process.env).sort() });
  const out = (/** @type {any} */ e) => process.stdout.write(JSON.stringify(e) + "\n");
  out({ type: "thread.started", thread_id: "t1" });
  if (/SLOW/.test(text)) await sleep(10_000);
  if (/EXPIRED/.test(text) || !value || value === "expired") { out({ type: "error", message: "unexpected status 401 Unauthorized: Your access token could not be refreshed. Please log out and sign in again." }); out({ type: "turn.failed", error: { message: "401 Unauthorized" } }); process.exitCode = 1; return; }
  const a = answer(text, text, 1);
  out({ type: "item.completed", item: { id: "i1", type: "agent_message", text: a } });
  out({ type: "turn.completed", usage: { input_tokens: 9, cached_input_tokens: 0, output_tokens: 4 } });
  const last = flag("--output-last-message");
  if (last) fs.writeFileSync(last, a);
}

async function grok() {
  const key = process.env.XAI_API_KEY || null;
  const login = fileCred(path.join(process.env.HOME || "", ".grok", "auth.json"));
  let authed = false, session = "", next = 500;
  /** @type {Map<number, (v: any) => void>} */ const waits = new Map();
  const out = (/** @type {any} */ o) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...o }) + "\n");
  const call = (/** @type {string} */ method, /** @type {any} */ params) => new Promise(r => { const id = next++; waits.set(id, r); out({ id, method, params }); });
  const say = (/** @type {string} */ t) => out({ method: "session/update", params: { sessionId: session, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: t } } } });
  /** @type {any} */ let caps = null;
  const rl = readline.createInterface({ input: process.stdin });
  rl.on("line", async line => {
    /** @type {any} */ let m; try { m = JSON.parse(line); } catch { return; }
    if (m.id !== undefined && m.method === undefined) { const w = waits.get(m.id); if (w) { waits.delete(m.id); w(m.result || m.error); } return; }
    const p = m.params || {};
    if (m.method === "initialize") { caps = p.clientCapabilities; return out({ id: m.id, result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [{ id: "grok.com", name: "grok.com" }, { id: "xai.api_key", name: "API key" }] } }); }
    if (m.method === "authenticate") {
      if (p.methodId === "xai.api_key" && key) { authed = true; return out({ id: m.id, result: {} }); }
      if (p.methodId === "grok.com" && login && login !== "expired") { authed = true; return out({ id: m.id, result: {} }); }
      return out({ id: m.id, error: { code: -32000, message: "Authentication failed: your session has expired" } });
    }
    if (m.method === "session/new") {
      if (!authed) return out({ id: m.id, error: { code: -32000, message: "Authentication required" } });
      session = "s-" + crypto.randomUUID().slice(0, 8);
      log({ cli: "grok", phase: "new", mcp_servers: p.mcpServers, caps });
      return out({ id: m.id, result: { sessionId: session } });
    }
    if (m.method === "session/prompt") {
      const text = (p.prompt || []).map((/** @type {any} */ b) => b.text || "").join("");
      const value = key || login;
      /** @type {any} */ let perm = null;
      if (/TOOLTRY/.test(text)) perm = await call("session/request_permission", { sessionId: session, toolCall: { toolCallId: "c1", title: "Run ls", kind: "execute" }, options: [{ optionId: "once", name: "Once", kind: "allow_once" }] });
      log({ cli: "grok", marker: (/MARK-[a-z0-9]+/.exec(text) || [null])[0], got: value ? sha(value) : null, via: key ? "env" : "home", home: process.env.HOME, cwd: process.cwd(), permission: perm, env: Object.keys(process.env).sort() });
      if (/SLOW/.test(text)) await sleep(10_000);
      say(answer(text, text, 1));
      return out({ id: m.id, result: { stopReason: "end_turn", usage: { inputTokens: 7, outputTokens: 3, cachedReadTokens: 0 } } });
    }
    if (m.id !== undefined) out({ id: m.id, error: { code: -32601, message: "unknown" } });
  });
  rl.on("close", () => process.exit(0));
}

if (argv[0] === "exec") await codex();
else if (argv.includes("agent") && argv.includes("stdio")) await grok();
else await claude();
