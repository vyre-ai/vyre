#!/usr/bin/env node
// @ts-check
// A stand-in for an ACP agent (`grok acp`, codex-acp ...), for tests: ndjson JSON-RPC over stdio.
// What it does depends on the prompt, as core/switchboard/testing/fake-claude.js does:
//   "bash <command>"   asks permission (kind execute) and says "Ran it." or "I was not allowed to."
//   "readfile <path>"  asks the client for fs/read_text_file and says what came back (or the error)
//   "writefile <path> <text>"  the same through fs/write_text_file
//   "term <command>"   runs it through terminal/create and says its output
//   "detach"           starts a setsid-detached `sleep` (its pid to $FAKE_ACP_PIDFILE) and says so
//   "mode"             says its current mode
//   anything else      echoes "echo: <prompt>"
// A cancel during a permission question ends the turn with stopReason "cancelled".
// FAKE_ACP_STORE: a folder where sessions live (so session/load works from a new process).
// FAKE_ACP_LOG: one line per launch (argv, HOME, client capabilities) and per set_mode.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import readline from "node:readline";
import { spawn } from "node:child_process";

const store = process.env.FAKE_ACP_STORE || "";
const log = o => { if (process.env.FAKE_ACP_LOG) fs.appendFileSync(process.env.FAKE_ACP_LOG, JSON.stringify(o) + "\n"); };
const out = o => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...o }) + "\n");
let nextId = 1000, session = "", mode = process.env.FAKE_ACP_START_MODE || "default", cancelled = false, clientCaps = /** @type {any} */ ({});
const waits = new Map();
const call = (method, params) => new Promise((resolve, reject) => { const id = nextId++; waits.set(id, { resolve, reject }); out({ id, method, params }); });
const say = t => out({ method: "session/update", params: { sessionId: session, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: t } } } });
let authed = false;
const MODES = { availableModes: [{ id: "default", name: "Default" }, { id: "plan", name: "Plan" }, { id: "bypassPermissions", name: "Bypass permissions" }, { id: "agent-full-access", name: "Full access" }, ...(process.env.FAKE_ACP_EXTRA_MODE ? [{ id: process.env.FAKE_ACP_EXTRA_MODE, name: process.env.FAKE_ACP_EXTRA_MODE }] : [])] };

async function prompt(id, blocks) {
  const t = blocks.map(b => b.text || "").join("");
  cancelled = false;
  let m;
  if ((m = /^bash (.+)$/.exec(t))) {
    const tc = { toolCallId: `call-${crypto.randomUUID().slice(0, 8)}`, title: `Run ${m[1]}`, kind: "execute", status: "pending", rawInput: { command: m[1] } };
    out({ method: "session/update", params: { sessionId: session, update: { sessionUpdate: "tool_call", ...tc } } });
    const r = await call("session/request_permission", { sessionId: session, toolCall: tc, options: [
      { optionId: "always", name: "Always", kind: "allow_always" }, { optionId: "once", name: "Once", kind: "allow_once" }, { optionId: "no", name: "No", kind: "reject_once" }] });
    const oc = r.outcome || {};
    if (oc.outcome === "cancelled") return out({ id, result: { stopReason: "cancelled" } });
    if (oc.optionId === "once") {
      out({ method: "session/update", params: { sessionId: session, update: { sessionUpdate: "tool_call_update", toolCallId: tc.toolCallId, status: "completed", content: [{ type: "content", content: { type: "text", text: "ok" } }] } } });
      say("Ran it.");
    } else say("I was not allowed to.");
  } else if (t === "plan") {
    out({ method: "session/update", params: { sessionId: session, update: { sessionUpdate: "plan", entries: [{ content: "read it", priority: "high", status: "completed" }, { content: "change it", priority: "high", status: "in_progress" }, { content: "test it", priority: "low", status: "pending" }] } } });
    const tc = { toolCallId: `call-${crypto.randomUUID().slice(0, 8)}`, title: "Delete build", kind: "delete", status: "completed", rawInput: { path: "/w/build" } };
    out({ method: "session/update", params: { sessionId: session, update: { sessionUpdate: "tool_call", ...tc } } });
    say("planned");
  } else if ((m = /^readfile (.+)$/.exec(t))) {
    try { say("read: " + (await call("fs/read_text_file", { sessionId: session, path: m[1] })).content); } catch (e) { say("read failed: " + e.message); }
  } else if ((m = /^writefile (\S+) (.*)$/.exec(t))) {
    try { await call("fs/write_text_file", { sessionId: session, path: m[1], content: m[2] }); say("wrote"); } catch (e) { say("write failed: " + e.message); }
  } else if ((m = /^term (.+)$/.exec(t))) {
    try {
      const { terminalId } = await call("terminal/create", { sessionId: session, command: "/bin/sh", args: ["-c", m[1]] });
      await call("terminal/wait_for_exit", { sessionId: session, terminalId });
      say("term: " + (await call("terminal/output", { sessionId: session, terminalId })).output.trim());
      await call("terminal/release", { sessionId: session, terminalId });
    } catch (e) { say("term failed: " + e.message); }
  } else if (t === "detach") {
    const c = spawn("sleep", ["60"], { detached: true, stdio: "ignore" });
    c.unref();
    if (process.env.FAKE_ACP_PIDFILE) fs.writeFileSync(process.env.FAKE_ACP_PIDFILE, String(c.pid));
    say("detached");
  } else if ((m = /^switchmode (\S+)$/.exec(t))) {
    mode = m[1];                                                     // the agent changes its own mode, and says so
    out({ method: "session/update", params: { sessionId: session, update: { sessionUpdate: "current_mode_update", currentModeId: m[1] } } });
    await new Promise(r => setTimeout(r, 300));
    say("switched");
  } else if (t === "mode") say("mode: " + mode);
  else say("echo: " + t);
  out({ id, result: { stopReason: "end_turn" } });
}

readline.createInterface({ input: process.stdin }).on("line", async line => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.method === undefined && waits.has(m.id)) { const w = waits.get(m.id); waits.delete(m.id); return m.error ? w.reject(Object.assign(new Error(m.error.message), { code: m.error.code })) : w.resolve(m.result || {}); }
  if (m.method === "initialize") {
    clientCaps = m.params.clientCapabilities || {};
    log({ launch: process.argv.slice(2), home: process.env.HOME || null, clientCaps });
    // FAKE_ACP_AUTH: like the real codex-acp and Grok, session/new answers "Authentication required" (-32000) until authenticate {methodId} was called.
    return out({ id: m.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true }, authMethods: process.env.FAKE_ACP_AUTH ? [{ id: "api-key", name: "API Key" }, { id: "chat-gpt", name: "ChatGPT" }, ...(clientCaps && clientCaps.auth && clientCaps.auth._meta && clientCaps.auth._meta.gateway ? [{ id: "gateway", name: "Custom model gateway" }] : [])] : [] } });
  }
  if (m.method === "authenticate") {
    log({ authenticate: m.params && m.params.methodId, gateway: m.params && m.params._meta && m.params._meta.gateway ? { baseUrl: m.params._meta.gateway.baseUrl, headers: Object.keys(m.params._meta.gateway.headers || {}), providerName: m.params._meta.gateway.providerName } : undefined });
    if (process.env.FAKE_ACP_AUTH === "hang") return;                                   // waits for a browser sign-in
    authed = process.env.FAKE_ACP_AUTH !== "refuse";
    return out({ id: m.id, ...(authed ? { result: {} } : { error: { code: -32000, message: process.env.FAKE_ACP_AUTH_ERR || "sign-in refused" } }) });
  }
  if (m.method === "session/new" && process.env.FAKE_ACP_AUTH && !authed) return out({ id: m.id, error: { code: -32000, message: "Authentication required" } });
  if (m.method === "session/new") {
    session = "fake-" + crypto.randomUUID().slice(0, 8);
    if (store) fs.writeFileSync(path.join(store, session), m.params.cwd);
    return out({ id: m.id, result: { sessionId: session, modes: { ...MODES, currentModeId: mode } } });
  }
  if (m.method === "session/load") {
    if (!store || !fs.existsSync(path.join(store, m.params.sessionId))) return out({ id: m.id, error: { code: -32602, message: "no such session" } });
    session = m.params.sessionId;
    return out({ id: m.id, result: { modes: { ...MODES, currentModeId: mode } } });
  }
  if (m.method === "session/set_mode") { log({ set_mode: m.params.modeId }); if (process.env.FAKE_ACP_NO_SETMODE) return out({ id: m.id, error: { code: -32601, message: "no" } }); mode = m.params.modeId; return out({ id: m.id, result: {} }); }
  if (m.method === "session/prompt") return prompt(m.id, m.params.prompt || []);
  if (m.method === "session/cancel") { cancelled = true; return; }
  if (m.id !== undefined) out({ id: m.id, error: { code: -32601, message: "no such method" } });
});
