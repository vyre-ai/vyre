#!/usr/bin/env node
// @ts-check
// What can be proved about the real Codex, Grok and Claude CLIs with no account and no model key,
// on a hosted runner (never the person's Mac): run by .github/workflows/proof-wire.yml.
//
//   1. SIGN-IN: Vyre's own Signins class runs each CLI's real login command in a temp HOME and must
//      reach an address on the provider's own host and (codex, grok) a one-time code. The login is
//      never completed; the process is killed. The code is printed by length only.
//   2. ACP WIRE: Vyre's own ACP driver (drivers/acp.js, through the codex and grok entries) starts
//      the real agent in ACP mode in a temp HOME with a fake key, and reports how far it gets:
//      initialize, session/new (the init message), and what a first prompt comes back with.
//
// It prints one line per fact: PASS, FAIL or INFO. A missing binary is FAIL "not installed", never
// a skipped check. Exit 0 always: this is a measurement, read the lines.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import http from "node:http";
import { Signins, LOGINS, signinAddressOk } from "../core/sessions/signin.js";
import { codexProvider } from "../core/sessions/drivers/codex.js";
import { grokProvider } from "../core/sessions/drivers/grok.js";
import { rules } from "../core/harness/rules.js";

const out = [];
const say = (kind, what) => { out.push(`${kind} ${what}`); console.log(`${kind} ${what}`); };
const scrub = s => String(s).replace(/sk-[A-Za-z0-9_-]{6,}/g, "[key]").replace(/\s+/g, " ").slice(0, 300);
const where = bin => { try { return execFileSync("which", [bin], { encoding: "utf8" }).trim(); } catch { return null; } };
const version = (bin, arg = "--version") => { try { return execFileSync(bin, [arg], { encoding: "utf8", timeout: 20000 }).trim().split("\n")[0]; } catch (e) { return `(${scrub(/** @type {Error} */ (e).message)})`; } };
const tmp = p => fs.mkdtempSync(path.join(os.tmpdir(), p));

// ---------------------------------------------------------------- 1. sign-in
for (const provider of ["codex", "grok", "claude"]) {
  const how = LOGINS[provider];
  const bin = where(how.bin);
  if (!bin) { say("FAIL", `signin ${provider}: \`${how.bin}\` is not installed on this runner`); continue; }
  say("INFO", `signin ${provider}: ${bin} ${version(how.bin)}`);
  const home = tmp(`proof-${provider}-home-`);
  const signins = new Signins({ spawn: (b, args) => spawn(b, args, { env: { PATH: process.env.PATH, HOME: home, TERM: "dumb", NO_COLOR: "1", BROWSER: "none", CI: "" }, stdio: ["pipe", "pipe", "pipe"] }) });
  try {
    const started = await Promise.race([signins.start({ provider, account: { id: "proof" } }), new Promise(r => setTimeout(() => r({ step: "timeout" }), 45_000))]);
    const s = /** @type {any} */ (started);
    if (s.step === "code" || s.step === "url") {
      say(signinAddressOk(provider, s.url) ? "PASS" : "FAIL", `signin ${provider}: step ${s.step}, address host ${new URL(s.url).hostname}${s.code ? `, one-time code of ${String(s.code).length} characters` : " (this login asks for the code to be pasted back)"}`);
      if (provider !== "claude") say(s.code ? "PASS" : "FAIL", `signin ${provider}: a code was read from the command's output`);
    } else say("FAIL", `signin ${provider}: step ${s.step}${s.message ? `: ${scrub(s.message)}` : ""}`);
  } catch (e) { say("FAIL", `signin ${provider}: ${scrub(/** @type {Error} */ (e).message)}`); }
  signins.stop();
}

// ---------------------------------------------------------------- 2. ACP wire
/** @param {string} name @param {any} provider @param {Record<string, string>} env */
async function acp(name, provider, env, expectNoInit = null) {
  const cwd = tmp(`proof-${name}-work-`);
  /** @type {any[]} */ const got = [];
  let exited = null;
  const proc = provider.run({ id: crypto.randomUUID(), resume: false, cwd, env, onSpawn() {}, onExit: (code, signal, err) => { exited = { code, signal, err: scrub(err || "") }; },
    onMessage: m => { got.push(m); if (m.type === "control_request") proc.write({ type: "control_response", response: { request_id: m.request_id, response: { behavior: "deny" } } }); } });
  const until = async (test, ms) => { const end = Date.now() + ms; while (Date.now() < end) { const f = got.find(test); if (f) return f; if (exited) return null; await new Promise(r => setTimeout(r, 100)); } return null; };
  const init = await until(m => m.type === "system" && m.subtype === "init", 60_000);
  if (init) {
    say("PASS", `acp ${name}: initialize and session/new answered; model ${init.model || "(none said)"}, modes [${(init.modes || []).join(", ")}]`);
    say(!(init.modes || []).some(x => /bypass|yolo|dangerous|never|auto-?approve/i.test(String(x))) ? "PASS" : "FAIL", `acp ${name}: no bypass-shaped mode is offered`);
    proc.write({ type: "user", message: { role: "user", content: "Reply with exactly the words PROOF-OK." } });
    const res = await until(m => m.type === "result", 90_000);
    if (res) say(!res.is_error && /PROOF-OK/.test(String(res.result)) ? "PASS" : "INFO", `acp ${name}: a first prompt came back as ${res.is_error ? "an error" : "a result"}: ${scrub(res.result || "")}`);
    else say("INFO", `acp ${name}: a first prompt was sent and nothing came back in 90 s${exited ? `; the agent exited ${JSON.stringify(exited)}` : ""}`);
  } else {
    const errRes = got.find(m => m.type === "result");
    if (expectNoInit && errRes && expectNoInit.test(String(errRes.result))) { say("PASS", `acp ${name}: as expected with no account, the driver says: ${scrub(errRes.result)}`); try { await proc.stop(3000); } catch {} return; }
    say("FAIL", `acp ${name}: no init within 60 s${errRes ? `; the driver said: ${scrub(errRes.result || "")}` : ""}${exited ? `; the agent exited ${JSON.stringify(exited)}` : ""}`);
  }
  try { await proc.stop(3000); } catch {}
}

/** The raw ACP exchange, no Vyre driver: what initialize answers (auth methods above all) and what session/new says. */
async function raw(name, bin, args, env, home, gateway = null) {
  const child = spawn(bin, args, { env, stdio: ["pipe", "pipe", "pipe"], cwd: home });
  let buf = "", err = "";
  const waits = new Map();
  child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
  child.stderr.on("data", c => { err = (err + c).slice(-600); });
  child.stdout.on("data", c => { buf += c; let i; while ((i = buf.indexOf("\n")) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); try { const m = JSON.parse(line); if (m.id !== undefined && !m.method && waits.has(m.id)) { waits.get(m.id)(m); waits.delete(m.id); } } catch {} } });
  let n = 0;
  const ask = (method, params) => new Promise(resolve => { const id = ++n; waits.set(id, resolve); child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"); setTimeout(() => { if (waits.delete(id)) resolve({ timeout: true }); }, 30_000); });
  try {
    const init = /** @type {any} */ (await ask("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true, ...(gateway ? { auth: { _meta: { gateway: true } } } : {}) }, clientInfo: { name: "vyre-proof", version: "0" } }));
    const r = init.result || {};
    say("INFO", `raw ${name}: initialize ${init.error ? `error ${init.error.code} ${scrub(init.error.message)}` : `ok; agent ${JSON.stringify(r.agentInfo || {})}; authMethods ${JSON.stringify((r.authMethods || []).map(m => ({ id: m.id, name: m.name, type: m.type })))}; capability keys ${Object.keys(r.agentCapabilities || {}).join(",")}`}${init.timeout ? " (timed out)" : ""}`);
    const sn = /** @type {any} */ (await ask("session/new", { cwd: home, mcpServers: [] }));
    say("INFO", `raw ${name}: session/new ${sn.error ? `error ${sn.error.code} ${scrub(sn.error.message)} ${scrub(JSON.stringify(sn.error.data || ""))}` : `ok; keys ${Object.keys(sn.result || {}).join(",")}; modes ${JSON.stringify(((sn.result || {}).modes || {}).availableModes?.map(x => x.id) || null)}; current mode ${JSON.stringify(((sn.result || {}).modes || {}).currentModeId)}; configOptions ${scrub(JSON.stringify((sn.result || {}).configOptions || null)).slice(0, 240)}`}${sn.timeout ? " (timed out)" : ""}`);
    for (const m of (gateway ? (r.authMethods || []).filter(x => x.id === "gateway") : (r.authMethods || []).slice(0, 4))) {
      const au = /** @type {any} */ (await ask("authenticate", { methodId: m.id, ...(m.id === "gateway" ? { _meta: { gateway } } : {}) }));
      say("INFO", `raw ${name}: authenticate ${m.id} -> ${au.error ? `error ${au.error.code} ${scrub(au.error.message)}` : "ok"}${au.timeout ? " (timed out)" : ""}`);
      if (!au.error) {
        const s2 = /** @type {any} */ (await ask("session/new", { cwd: home, mcpServers: [] }));
        say("INFO", `raw ${name}: session/new after authenticate ${m.id} -> ${s2.error ? `error ${s2.error.code} ${scrub(s2.error.message)}` : `ok; modes ${JSON.stringify(((s2.result || {}).modes || {}).availableModes?.map(x => x.id) || null)}; current mode ${JSON.stringify(((s2.result || {}).modes || {}).currentModeId)}`}`);
        if (!s2.error && s2.result) {
          const pr = /** @type {any} */ (await ask("session/prompt", { sessionId: s2.result.sessionId, prompt: [{ type: "text", text: "Reply with exactly the words PROOF-OK." }] }));
          say("INFO", `raw ${name}: session/prompt -> ${pr.error ? `error ${pr.error.code} ${scrub(pr.error.message)} data ${scrub(JSON.stringify(pr.error.data || ""))}` : `ok ${scrub(JSON.stringify(pr.result))}`}${pr.timeout ? " (timed out)" : ""}${err ? `; stderr ${scrub(err)}` : ""}`);
        }
        break;
      }
    }
  } catch (e) { say("INFO", `raw ${name}: ${scrub(/** @type {Error} */ (e).message)}${err ? `; stderr ${scrub(err)}` : ""}`); }
  try { child.kill("SIGKILL"); } catch {}
}

/** A local stand-in for a model endpoint: answers OpenAI's Responses API with one streamed message, and logs what it was asked. */
function mockModel(reply) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", c => { body += c; });
    req.on("end", () => {
      let j = {}; try { j = JSON.parse(body); } catch {}
      seen.push({ method: req.method, url: req.url, keys: Object.keys(j).slice(0, 12), model: j.model, stream: j.stream, auth: Boolean(req.headers.authorization) });
      if (req.method === "POST" && /\/responses$/.test(String(req.url).split("?")[0])) {
        const msg = { type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text: reply, annotations: [] }] };
        const ev = (type, data) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        res.write(ev("response.created", { response: { id: "resp_1", object: "response", status: "in_progress", model: j.model || "mock", output: [] } }));
        res.write(ev("response.output_item.added", { output_index: 0, item: { ...msg, status: "in_progress", content: [] } }));
        res.write(ev("response.content_part.added", { item_id: "msg_1", output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } }));
        res.write(ev("response.output_text.delta", { item_id: "msg_1", output_index: 0, content_index: 0, delta: reply }));
        res.write(ev("response.output_text.done", { item_id: "msg_1", output_index: 0, content_index: 0, text: reply }));
        res.write(ev("response.output_item.done", { output_index: 0, item: msg }));
        res.write(ev("response.completed", { response: { id: "resp_1", object: "response", status: "completed", model: j.model || "mock", output: [msg], usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 } } }));
        res.end();
      } else if (req.method === "POST" && /\/chat\/completions$/.test(String(req.url).split("?")[0])) {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        const chunk = (delta, finish) => `data: ${JSON.stringify({ id: "chatcmpl-1", object: "chat.completion.chunk", created: 1, model: j.model || "mock", choices: [{ index: 0, delta, finish_reason: finish || null }] })}\n\n`;
        res.write(chunk({ role: "assistant", content: "" }));
        res.write(chunk({ content: reply }));
        res.write(chunk({}, "stop"));
        res.write(`data: ${JSON.stringify({ id: "chatcmpl-1", object: "chat.completion.chunk", created: 1, model: j.model || "mock", choices: [], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } })}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
      } else { res.writeHead(404, { "content-type": "application/json" }); res.end(JSON.stringify({ error: { message: `mock: no ${req.method} ${req.url}` } })); }
    });
  });
  return new Promise(resolve => server.listen(0, "127.0.0.1", () => resolve({ port: /** @type {any} */ (server.address()).port, seen, close: () => server.close() })));
}

const floorHome = tmp("proof-floor-");
const floor = c => rules({ tool: c.tool, input: c.input, cwd: c.cwd, home: path.join(floorHome, ".vyre") });
if (where("codex-acp")) {
  say("INFO", `acp codex: ${where("codex-acp")} ${version("codex-acp")}; codex ${where("codex") ? version("codex") : "(not installed)"}`);
  const home = tmp("proof-codex-acp-home-");
  fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
  await raw("codex, NO -c flags", "codex-acp", [], { PATH: process.env.PATH || "", HOME: home, CODEX_HOME: path.join(home, ".codex"), OPENAI_API_KEY: "sk-proof-not-a-real-key" }, home);
  await new Promise(r => setTimeout(r, 1000));
  try { fs.rmSync(path.join(home, ".codex"), { recursive: true, force: true, maxRetries: 5 }); fs.mkdirSync(path.join(home, ".codex"), { recursive: true }); } catch {}
  await raw("codex", "codex-acp", ["-c", "approval_policy=untrusted", "-c", "sandbox_mode=workspace-write"], { PATH: process.env.PATH || "", HOME: home, CODEX_HOME: path.join(home, ".codex"), OPENAI_API_KEY: "sk-proof-not-a-real-key" }, home);
  await new Promise(r => setTimeout(r, 1000));
  try { fs.rmSync(path.join(home, ".codex"), { recursive: true, force: true, maxRetries: 5 }); } catch {}
  await acp("codex", codexProvider({ floor }), { PATH: process.env.PATH || "", HOME: home, OPENAI_API_KEY: "sk-proof-not-a-real-key" });
  // A real turn through the real codex, with a local stand-in for the model (no account, no key).
  const mock = /** @type {any} */ (await mockModel("PROOF-OK"));
  const mhome = tmp("proof-codex-mock-home-");
  const custom = { id: "mockmodel", baseUrl: `http://127.0.0.1:${mock.port}/v1`, envKey: "MOCK_MODEL_KEY", model: "mock-model" };
  fs.mkdirSync(path.join(mhome, ".codex"), { recursive: true });
  const cflags = ["-c", "approval_policy=untrusted", "-c", "sandbox_mode=workspace-write", "-c", 'model_provider="mockmodel"', "-c", 'model="mock-model"', "-c", 'model_providers.mockmodel.name="mockmodel"', "-c", `model_providers.mockmodel.base_url="${custom.baseUrl}"`, "-c", 'model_providers.mockmodel.env_key="MOCK_MODEL_KEY"'];
  await raw("codex (model stood in, -c flags)", "codex-acp", cflags, { PATH: process.env.PATH || "", HOME: mhome, CODEX_HOME: path.join(mhome, ".codex"), MOCK_MODEL_KEY: "mock-key", OPENAI_API_KEY: "mock-key" }, mhome);
  say("INFO", `raw codex (-c flags): the stand-in was asked ${JSON.stringify(mock.seen.slice(0, 4))}`);
  mock.seen.length = 0;
  await raw("codex (model stood in, gateway auth)", "codex-acp", ["-c", "approval_policy=untrusted", "-c", "sandbox_mode=workspace-write"], { PATH: process.env.PATH || "", HOME: mhome, CODEX_HOME: path.join(mhome, ".codex") }, mhome, { baseUrl: custom.baseUrl, headers: { Authorization: "Bearer mock-key" }, providerName: "mockmodel" });
  say("INFO", `raw codex (gateway auth): the stand-in was asked ${JSON.stringify(mock.seen.slice(0, 6))}`);
  mock.seen.length = 0;
  await new Promise(r => setTimeout(r, 1000));
  try { fs.rmSync(path.join(mhome, ".codex"), { recursive: true, force: true, maxRetries: 5 }); } catch {}
  await acp("codex (model stood in)", codexProvider({ floor, custom }), { PATH: process.env.PATH || "", HOME: mhome, MOCK_MODEL_KEY: "mock-key" });
  say("INFO", `acp codex (model stood in): the stand-in was asked ${JSON.stringify(mock.seen.slice(0, 6))}`);
  mock.close();
} else say("FAIL", "acp codex: `codex-acp` is not installed on this runner");
if (where("grok")) {
  say("INFO", `acp grok: ${where("grok")} ${version("grok")}`);
  const home = tmp("proof-grok-acp-home-");
  await raw("grok", "grok", ["--no-auto-update", "agent", "stdio"], { PATH: process.env.PATH || "", HOME: home, XAI_API_KEY: "xai-proof-not-a-real-key" }, home);
  await acp("grok, no login and no custom endpoint", grokProvider({ floor, home }), { PATH: process.env.PATH || "", HOME: home, XAI_API_KEY: "xai-proof-not-a-real-key" }, /sign this account in first/);
  // Grok on a custom endpoint (config.toml base_url + env_key): does it still want a browser login?
  const gmock = /** @type {any} */ (await mockModel("PROOF-OK"));
  const ghome = tmp("proof-grok-mock-home-");
  fs.mkdirSync(path.join(ghome, ".grok"), { recursive: true });
  fs.writeFileSync(path.join(ghome, ".grok", "config.toml"), `[models]\ndefault = "proof"\n\n[model.proof]\nmodel = "mock-model"\nbase_url = "http://127.0.0.1:${gmock.port}/v1"\nenv_key = "MOCK_MODEL_KEY"\nname = "proof"\n`);
  await raw("grok (model stood in, config.toml)", "grok", ["--no-auto-update", "-m", "proof", "agent", "stdio"], { PATH: process.env.PATH || "", HOME: ghome, MOCK_MODEL_KEY: "mock-key" }, ghome);
  say("INFO", `raw grok (config.toml): the stand-in was asked ${JSON.stringify(gmock.seen.slice(0, 4))}`);
  gmock.seen.length = 0;
  // The same, through Vyre's own ACP driver and Grok entry.
  await acp("grok (model stood in)", grokProvider({ floor, home: ghome }), { PATH: process.env.PATH || "", HOME: ghome, MOCK_MODEL_KEY: "mock-key" });
  say("INFO", `acp grok (model stood in): the stand-in was asked ${JSON.stringify(gmock.seen.slice(0, 4).map(x => [x.method, x.url, x.model]))}`);
  gmock.close();
} else say("FAIL", "acp grok: `grok` is not installed on this runner");

console.log(`\n${out.filter(l => l.startsWith("PASS")).length} PASS, ${out.filter(l => l.startsWith("FAIL")).length} FAIL, ${out.filter(l => l.startsWith("INFO")).length} INFO`);
process.exit(0);
