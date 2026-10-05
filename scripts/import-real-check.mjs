#!/usr/bin/env node
// import-real-check: the Codex import against a REAL Codex CLI's own session file.
//   node scripts/import-real-check.mjs [codex-binary]
// Runs `codex exec` once in a throwaway CODEX_HOME and folder, with the model provider pointed at a
// local mock of the Responses API (no account, no network, no key), then lists, reads the head of and
// converts the rollout file Codex wrote, with the same code the import uses. Nothing touches a
// person's ~/.codex. Exit 0 only when the import read the real file correctly.
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import * as codex from "../core/sessions/drivers/codex/import.js";

const bin = process.argv[2] || "codex";
const REPLY = "pong from the mock";
const sse = (type, data) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
const seen = [];
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", c => { body += c; });
  req.on("end", () => {
    seen.push(`${req.method} ${req.url}`);
    if (!req.url.includes("/responses")) { res.writeHead(404).end(); return; }
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(sse("response.created", { response: { id: "resp_1" } }));
    res.write(sse("response.output_item.done", { item: { type: "message", role: "assistant", id: "msg_1", content: [{ type: "output_text", text: REPLY }] } }));
    res.end(sse("response.completed", { response: { id: "resp_1", usage: { input_tokens: 1, input_tokens_details: null, output_tokens: 1, output_tokens_details: null, total_tokens: 2 } } }));
  });
});
await new Promise(r => server.listen(0, "127.0.0.1", r));
const port = /** @type {any} */ (server.address()).port;

const home = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-codex-home-"));
const work = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-codex-work-"));
fs.writeFileSync(path.join(home, "config.toml"), [
  'model = "mock"', 'model_provider = "mock"', '',
  "[model_providers.mock]", 'name = "mock"', `base_url = "http://127.0.0.1:${port}/v1"`, 'wire_api = "responses"', 'env_key = "MOCK_KEY"', '',
].join("\n"));
let failed = "";
try {
  const v = spawnSync(bin, ["--version"], { encoding: "utf8" });
  console.log("codex:", (v.stdout || v.stderr).trim());
  const env = { PATH: process.env.PATH, CODEX_HOME: home, HOME: work, MOCK_KEY: "x" };
  // Async, so this process's mock server can answer while codex runs.
  const r = await new Promise(res => {
    const out = [];
    {
      const c = spawn(bin, ["exec", "--skip-git-repo-check", "ping"], { cwd: work, env, stdio: ["ignore", "pipe", "pipe"] });
      c.stdout.on("data", d => out.push(d)); c.stderr.on("data", d => out.push(d));
      const timer = setTimeout(() => c.kill("SIGKILL"), 90_000);
      c.on("close", code => { clearTimeout(timer); res({ code, out: Buffer.concat(out).toString() }); });
    }
  });
  console.log("codex exec exit", r.code, "requests:", seen.join(", ") || "none");
  const files = codex.list(home);
  if (files.length !== 1) throw new Error(`list found ${files.length} session files, wanted 1 (codex output: ${r.out.slice(-400)})`);
  const f = files[0];
  const cwd = codex.head(home, f.file);
  if (!cwd || fs.realpathSync(cwd) !== fs.realpathSync(work)) throw new Error(`head read folder ${cwd}, wanted ${work}`);
  const c = codex.convert(home, f.file);
  const rows = c.text.trim().split("\n").map(l => JSON.parse(l));
  const user = rows.find(x => x.type === "user" && !x.isMeta && JSON.stringify(x.message.content).includes("ping"));
  const asst = rows.find(x => x.type === "assistant" && JSON.stringify(x.message.content).includes(REPLY));
  if (!user) throw new Error("the prompt did not come through as a user turn");
  if (!asst) throw new Error("the reply did not come through as an assistant turn");
  if (c.turns < 1) throw new Error("no turns counted");
  console.log(`ok: ${rows.length} converted lines, ${c.turns} turn(s), folder and both sides of the exchange read from Codex's own file`);
} catch (e) {
  failed = String(e?.message || e);
  try { for (const f of fs.readdirSync(home, { recursive: true })) console.log("  codex home:", f); } catch { /* none */ }
}
server.close();
fs.rmSync(home, { recursive: true, force: true });
fs.rmSync(work, { recursive: true, force: true });
if (failed) { console.error("FAIL:", failed); process.exit(1); }
