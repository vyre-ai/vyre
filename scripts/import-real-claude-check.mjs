#!/usr/bin/env node
// import-real-claude-check: the Claude Code import against a REAL Claude Code's own transcript.
//   node scripts/import-real-claude-check.mjs [claude-binary]
// Runs `claude -p` once with a throwaway HOME and CLAUDE_CONFIG_DIR, its API pointed at a local mock
// of the Messages API (no account, no network, a made-up key), then scans the projects folder it
// wrote with the import's own scan code. Nothing touches a person's ~/.claude.
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { sessionFiles, cwdOf } from "../core/import/scan.js";

const bin = process.argv[2] || "claude";
const REPLY = "pong from the mock";
const sse = (type, data) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
const message = { id: "msg_1", type: "message", role: "assistant", model: "mock", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } };
const seen = [];
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", c => { body += c; });
  req.on("end", () => {
    seen.push(`${req.method} ${req.url.split("?")[0]}`);
    if (!req.url.startsWith("/v1/messages")) { res.writeHead(404, { "content-type": "application/json" }).end("{}"); return; }
    let stream = true;
    try { stream = JSON.parse(body).stream !== false; } catch { /* default to a stream */ }
    if (!stream) { res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ...message, content: [{ type: "text", text: REPLY }], stop_reason: "end_turn" })); return; }
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(sse("message_start", { message }));
    res.write(sse("content_block_start", { index: 0, content_block: { type: "text", text: "" } }));
    res.write(sse("content_block_delta", { index: 0, delta: { type: "text_delta", text: REPLY } }));
    res.write(sse("content_block_stop", { index: 0 }));
    res.write(sse("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } }));
    res.end(sse("message_stop", {}));
  });
});
await new Promise(r => server.listen(0, "127.0.0.1", r));
const port = /** @type {any} */ (server.address()).port;

const home = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-claude-home-"));
const work = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-claude-work-"));
let failed = "";
try {
  const env = { PATH: process.env.PATH, HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: path.join(home, ".claude"), ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`, ANTHROPIC_API_KEY: "sk-ant-mock", DISABLE_AUTOUPDATER: "1", DISABLE_TELEMETRY: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" };
  const r = await new Promise(res => {
    const out = [];
    const c = spawn(bin, ["-p", "ping", "--model", "mock"], { cwd: work, env, stdio: ["ignore", "pipe", "pipe"] });
    c.stdout.on("data", d => out.push(d)); c.stderr.on("data", d => out.push(d));
    const timer = setTimeout(() => c.kill("SIGKILL"), 90_000);
    c.on("close", code => { clearTimeout(timer); res({ code, out: Buffer.concat(out).toString() }); });
  });
  console.log("claude -p exit", r.code, "requests:", seen.join(", ") || "none");
  const projects = path.join(env.CLAUDE_CONFIG_DIR, "projects");
  const files = sessionFiles(projects);
  if (files.length < 1) throw new Error(`scan found no session files (claude output: ${r.out.slice(-400)})`);
  const f = files.find(x => cwdOf(x.file)) || files[0];
  const cwd = cwdOf(f.file);
  if (!cwd || fs.realpathSync(cwd) !== fs.realpathSync(work)) throw new Error(`cwdOf read ${cwd}, wanted ${work}`);
  const rows = fs.readFileSync(f.file, "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l));
  if (!rows.some(x => x.type === "user" && JSON.stringify(x.message?.content).includes("ping"))) throw new Error("the prompt is not a user line in the transcript");
  if (!rows.some(x => x.type === "assistant" && JSON.stringify(x.message?.content).includes(REPLY))) throw new Error("the reply is not an assistant line in the transcript");
  console.log(`ok: ${files.length} session file(s), ${rows.length} lines, folder read by the import's scan`);
} catch (e) {
  failed = String(e?.message || e);
  try { for (const f of fs.readdirSync(home, { recursive: true })) console.log("  claude home:", f); } catch { /* none */ }
}
server.close();
fs.rmSync(home, { recursive: true, force: true });
fs.rmSync(work, { recursive: true, force: true });
if (failed) { console.error("FAIL:", failed); process.exit(1); }
