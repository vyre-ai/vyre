#!/usr/bin/env node
// @ts-check
// Does a session's Bash see the Claude credential its Claude Code was given? (ADR 0030, e2e's
// "should" 5, a blocker for the SDK default.) The real bundled Claude Code, through the driver,
// against a fake Messages API (cc-plugin's fake-api.mjs), with fake credentials only: one turn
// runs `env` in Bash, and the tool result is searched for the credential's value.
//
//   VYRE_SESSIONS_SDK_DIR=<SDK with its bundled binary> node scripts/sessions-proof/env-leak.mjs

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fakeApi } from "./fake-api.mjs";
import { load, bundledBinary } from "../../core/sessions/sdk.js";
import { run } from "../../core/sessions/claude.js";

const dir = process.env.VYRE_SESSIONS_SDK_DIR || "";
const sdk = await load(dir);
if (!sdk || !bundledBinary(dir)) { console.error("env-leak: need VYRE_SESSIONS_SDK_DIR with the bundled binary"); process.exit(2); }

/** One session with this credential in its env; returns what `env` printed in Bash. */
async function probe(name, value, extraEnv = {}) {
  const api = await fakeApi([
    () => ({ type: "tool_use", id: "t1", name: "Bash", input: { command: "env; echo END", description: "print the environment" } }),
    () => ({ type: "text", text: "done" }),
  ]);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-env-leak-"));
  const env = { PATH: process.env.PATH, HOME: home, CLAUDE_CONFIG_DIR: path.join(home, ".claude"), ANTHROPIC_BASE_URL: api.url,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", [name]: value, ...extraEnv };
  let done;
  const finished = new Promise(r => { done = r; });
  const s = run(sdk, { id: crypto.randomUUID(), cwd: home, env, bin: bundledBinary(dir), settings: false,
    onMessage: m => {
      if (m.type === "control_request" && m.request?.subtype === "can_use_tool") s.write({ type: "control_response", response: { request_id: m.request_id, response: { behavior: "allow", updatedInput: m.request.input } } });
      if (m.type === "result") done(m);
    }, onExit: () => done(null) });
  s.write({ type: "user", message: { role: "user", content: "print the environment" }, parent_tool_use_id: null, session_id: "" });
  const result = await Promise.race([finished, new Promise(r => setTimeout(() => r("timeout"), 60_000))]);
  await s.stop(2000);
  api.server.close();
  fs.rmSync(home, { recursive: true, force: true });
  const tr = api.log.map(l => l.body).flatMap(b => (b.messages || []).flatMap(m => Array.isArray(m.content) ? m.content : []))
    .filter(c => c.type === "tool_result").map(c => typeof c.content === "string" ? c.content : JSON.stringify(c.content)).join("\n");
  return { credential: name, result: result === "timeout" ? "timeout" : result ? (result.is_error ? `error: ${String(result.result).slice(0, 120)}` : "ok") : "exited",
    requests: api.log.length, bash_ran: /END/.test(tr), value_in_bash_env: tr.includes(value),
    names_in_bash_env: tr.split("\n").map(l => l.split("=")[0]).filter(k => /ANTHROPIC|CLAUDE/.test(k)) };
}

const KEY = "sk-ant-api03-fakeFAKEfake0000000000000000000000000000000000000000000000000000000000000000000-AAAAAAAA";
const OAT = "sk-ant-oat01-fakeFAKEfake0000000000000000000000000000000000000000000000000000000000000000000-AAAAAAAA";
const out = [];
out.push(await probe("ANTHROPIC_API_KEY", KEY));
out.push(await probe("CLAUDE_CODE_OAUTH_TOKEN", OAT));
// With no credential at all, the turn must fail: so the runs above authenticated with what they were given.
out.push({ control: "no credential", ...(await probe("UNRELATED", "nothing")) });
// Claude Code's own switch: scrub credentials from every subprocess it starts.
out.push({ scrub: "1", ...(await probe("ANTHROPIC_API_KEY", KEY, { CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: "1" })) });
console.log(JSON.stringify(out.map(({ names_in_bash_env, ...o }) => o), null, 2));
