#!/usr/bin/env node
// @ts-check
// Can a session's Bash read the credential its Claude Code was given? One real `claude` binary against a fake Messages API (fake-api.mjs), fake credentials only. Each case delivers a fake
// secret one way; one turn runs `env`, the process's own environment and a read of the config folder in Bash, and the tool result is searched for the secret. A control case (no credential) must
// not authenticate, so the cases above it did authenticate with what they were given.
//
//   CLAUDE_BIN=/usr/bin/claude node scripts/sessions-proof/sealed-credential.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fakeApi } from "./fake-api.mjs";

const BIN = process.env.CLAUDE_BIN || "claude";
const KEY = "sk-ant-api03-fakeFAKEfake0000000000000000000000000000000000000000000000000000000000000000000-AAAAAAAA";
const OAT = "sk-ant-oat01-fakeFAKEfake0000000000000000000000000000000000000000000000000000000000000000000-AAAAAAAA";
const CMD = "env; echo ---PROC; tr '\\0' '\\n' < /proc/$PPID/environ; echo ---CONFIG; ls -a \"$CLAUDE_CONFIG_DIR\"; cat \"$CLAUDE_CONFIG_DIR\"/.credentials.json 2>&1; echo END";

/** @param {string} name @param {{ env?: Record<string,string>, fd3?: string, file?: string }} how @param {string} secret */
async function probe(name, how, secret) {
  const api = await fakeApi([() => ({ type: "tool_use", id: "t1", name: "Bash", input: { command: CMD, description: "print the environment" } }), () => ({ type: "text", text: "done" })]);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-sealed-"));
  const cfg = path.join(home, ".claude");
  fs.mkdirSync(cfg, { recursive: true });
  if (how.file) fs.writeFileSync(path.join(cfg, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: how.file, refreshToken: "r", expiresAt: Date.now() + 3600e3, scopes: ["user:inference"] } }), { mode: 0o600 });
  const env = { PATH: process.env.PATH || "", HOME: home, CLAUDE_CONFIG_DIR: cfg, ANTHROPIC_BASE_URL: api.url, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", ...(how.env || {}) };
  const child = spawn(BIN, ["-p", "print the environment", "--output-format", "json", "--dangerously-skip-permissions"], { cwd: home, env, stdio: ["ignore", "pipe", "pipe", how.fd3 !== undefined ? "pipe" : "ignore"] });
  if (how.fd3 !== undefined) { const fd = /** @type {any} */ (child.stdio[3]); fd.on("error", () => {}); fd.end(how.fd3); }
  let out = ""; child.stdout.on("data", d => { out += d; }); child.stderr.on("data", () => {});
  const code = await Promise.race([new Promise(r => child.on("exit", r)), new Promise(r => setTimeout(() => { child.kill("SIGKILL"); r("timeout"); }, 60_000))]);
  api.server.close();
  fs.rmSync(home, { recursive: true, force: true });
  const tr = api.log.map(l => l.body).flatMap(b => (b.messages || []).flatMap((/** @type {any} */ m) => Array.isArray(m.content) ? m.content : [])).filter((/** @type {any} */ c) => c.type === "tool_result").map((/** @type {any} */ c) => typeof c.content === "string" ? c.content : JSON.stringify(c.content)).join("\n");
  let ok = false; try { ok = !JSON.parse(out).is_error; } catch { /* not json */ }
  const part = (/** @type {string} */ a, /** @type {string} */ b) => { const i = tr.indexOf(a), j = tr.indexOf(b); return i < 0 ? "" : tr.slice(i, j < 0 ? undefined : j); };
  return { case: name, turn: code === "timeout" ? "timeout" : ok ? "ok" : "error", requests: api.log.length, bash_ran: /END/.test(tr),
    secret_in_bash_env: tr.slice(0, Math.max(0, tr.indexOf("---PROC"))).includes(secret), secret_in_proc_environ: part("---PROC", "---CONFIG").includes(secret), secret_in_config_dir: part("---CONFIG", "END").includes(secret) };
}

const out = [];
out.push(await probe("api key in env", { env: { ANTHROPIC_API_KEY: KEY } }, KEY));
out.push(await probe("api key on fd 3", { env: { CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR: "3" }, fd3: KEY }, KEY));
out.push(await probe("setup token in env", { env: { CLAUDE_CODE_OAUTH_TOKEN: OAT } }, OAT));
out.push(await probe("setup token in env, subprocess scrub", { env: { CLAUDE_CODE_OAUTH_TOKEN: OAT, CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: "1" } }, OAT));
out.push(await probe("setup token on fd 3", { env: { CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR: "3" }, fd3: OAT }, OAT));
out.push(await probe("signed-in account file in the config folder", { file: OAT }, OAT));
out.push(await probe("control: no credential", { env: {} }, "nothing-to-find"));
console.log(JSON.stringify(out, null, 2));
