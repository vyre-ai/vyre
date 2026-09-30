// @ts-check
// The standalone package end to end with no Chrome and no Vyre: the real chrome module behind the
// real MCP server and the real trace, a fake extension on the socket, everything in temp folders.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRuntime } from "./runtime.js";
import { serve, wireName } from "./mcp.js";
import { report, readSessions, pii, safeArgs, rotate, writeConfig } from "./trace.js";
import { fakeExtension, until } from "../fake-extension.js";
import { extensionIdFromKey } from "../native-host/install.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const tmp = (/** @type {any} */ t) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "vc-sa-")); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };

/** A runtime plus an MCP client over in-memory streams. */
async function rig(/** @type {any} */ t, /** @type {any} */ handler = null) {
  const dataDir = tmp(t);
  const sockPath = path.join(dataDir, "run", "chrome.sock");
  const runtime = await createRuntime({ dataDir, sockPath, log: () => {}, chrome: { extensionOrigin: null } });
  t.after(() => runtime.stop());
  const stdin = new PassThrough(), stdout = new PassThrough();
  serve({ runtime, stdin, stdout, version: "9.9.9" });
  let n = 0; const waiting = new Map();
  let buf = "";
  stdout.on("data", d => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); waiting.get(m.id)?.(m); } });
  const rpc = (/** @type {string} */ method, /** @type {any} */ params) => new Promise(res => { const id = ++n; waiting.set(id, res); stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"); });
  const call = async (/** @type {string} */ name, /** @type {any} */ args) => (/** @type {any} */ (await rpc("tools/call", { name, arguments: args }))).result;
  const ext = await fakeExtension(sockPath, { handler: handler || ((op) => (op === "tabs.list" ? { tabs: [{ id: 1, url: "https://app.example.com/x", title: "App" }] } : { ok: true })) });
  await until(async () => (await call("chrome_status", {})).content[0].text.includes('"connected":true'));
  return { dataDir, runtime, rpc, call, ext, stdin };
}

test("mcp: initialize, tool names have no dots, the person's own tools and the release are not offered, chrome_send is", async t => {
  const { rpc } = await rig(t);
  const init = /** @type {any} */ (await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "x", version: "1" } }));
  assert.equal(init.result.serverInfo.name, "vyre-chrome");
  assert.equal(init.result.protocolVersion, "2025-06-18");
  const list = /** @type {any} */ (await rpc("tools/list", {})).result.tools;
  const names = list.map((/** @type {any} */ x) => x.name);
  for (const n of names) assert.match(n, /^[A-Za-z0-9_-]{1,64}$/, n);
  for (const want of ["chrome_tabs", "chrome_snapshot", "chrome_act", "chrome_fill", "chrome_batch", "chrome_ghl", "chrome_send", "chrome_stop", "chrome_resume", "chrome_status"]) assert.ok(names.includes(want), want);
  for (const no of ["chrome_release", "chrome_interject", "chrome_install"]) assert.ok(!names.includes(no), no);
  assert.ok(list.every((/** @type {any} */ x) => !/at the Gate/.test(x.description)), "no mention of a Gate in a world with none");
  assert.equal(wireName("chrome.snapshot"), "chrome_snapshot");
});

test("mcp: a call reaches the extension, the answer is redacted, and the trace records it with timings and no result body", async t => {
  const { call, dataDir, runtime } = await rig(t);
  const r = await call("chrome_tabs", { action: "list" });
  assert.equal(r.isError, undefined);
  assert.equal(JSON.parse(r.content[0].text).tabs[0].id, 1);
  const { records } = /** @type {any} */ (readSessions(dataDir, 1));
  const c = records.find((/** @type {any} */ x) => x.kind === "call" && x.tool === "chrome.tabs");
  assert.ok(c, JSON.stringify(records.map((/** @type {any} */ x) => x.tool)));
  assert.equal(c.ok, true);
  assert.equal(typeof c.runMs, "number");
  assert.equal(typeof c.queueMs, "number");
  assert.ok(!JSON.stringify(c).includes("App"), "the result body is not logged");
  assert.equal(path.basename(runtime.trace.file()).startsWith("session-"), true);
  const mode = fs.statSync(runtime.trace.file()).mode & 0o777;
  if (process.platform !== "win32") assert.equal(mode, 0o600);
});

test("mcp: a send is held with an id, chrome_send does it once, and only what this session held", async t => {
  let released = 0;
  const { call, ext } = await rig(t, (/** @type {string} */ op, /** @type {any} */ a) => {
    if (op === "page.act" && a.release) { released++; return { ok: true, sent: true }; }
    if (op === "page.act") return { ok: false, held: true, control: { role: "button", name: "Send inquiry" }, fields: [{ name: "Email", value: "alex@example.com" }], sig: "s1", url: "https://harlow.example/intake" };
    return { ok: true };
  });
  const held = JSON.parse((await call("chrome_act", { selector: { role: "button", name: "Send inquiry" }, kind: "click", tab: 1 })).content[0].text);
  assert.equal(held.held, true);
  assert.match(held.why, /chrome_send/);
  assert.equal(released, 0, "nothing was sent yet");
  const sent = await call("chrome_send", { id: held.id });
  assert.equal(sent.isError, undefined, JSON.stringify(sent));
  assert.equal(released, 1);
  assert.equal(ext.ops("page.act").at(-1).args.release.sig, "s1");
  const again = await call("chrome_send", { id: held.id });
  assert.equal(again.isError, true);
  assert.match(again.content[0].text, /not_found|already sent/);
  const forged = await call("chrome_send", { id: "0123456789abcdef01" });
  assert.equal(forged.isError, true);
});

test("mcp: an unknown tool and bad JSON are answered, not crashed on; the person's own tools are refused", async t => {
  const { rpc, call, stdin } = await rig(t);
  assert.equal(/** @type {any} */ (await rpc("tools/call", { name: "nope", arguments: {} })).error.code, -32602);
  assert.equal(/** @type {any} */ (await rpc("bogus/method", {})).error.code, -32601);
  assert.equal(/** @type {any} */ (await rpc("tools/call", { name: "chrome_release", arguments: { id: "x", content: {} } })).error.code, -32602);
  stdin.write("{not json\n");
  const r = await call("chrome_status", {});
  assert.equal(r.isError, undefined, "still serving");
});

test("mcp: a page the floor forbids is refused before anything reaches Chrome, and the trace says so", async t => {
  const { call, ext, dataDir } = await rig(t);
  const r = await call("chrome_tabs", { action: "open", url: "https://chase.com/accounts" });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /blocked/);
  assert.equal(ext.ops("tabs.open").length, 0);
  const { records } = /** @type {any} */ (readSessions(dataDir, 1));
  assert.equal(records.find((/** @type {any} */ x) => x.kind === "call" && x.ok === false).error.code, "blocked");
});

test("trace: secrets are always masked, contact details are masked but field names stay, workflow text stays readable", () => {
  assert.equal(pii("mail alex@example.com or call +1 (415) 555-0134 now"), "mail [email] or call [phone] now");
  assert.equal(pii("workflow: 3 steps, order 1234567890123"), "workflow: 3 steps, order 1234567890123");
  const a = safeArgs({ fields: [
    { selector: { name: "Password" }, value: "hunter2hunter2" },
    { selector: { name: "Email" }, value: "alex@example.com" },
    { label: "Email subject", value: "Welcome to Harlow Legal, book your call" },
  ], token: "abc", url: "https://x.test/?token=abcdefghijklmnop&q=1" });
  assert.equal(a.fields[0].value, "[redacted:by-name]");
  assert.equal(a.fields[1].value, "[email]");
  assert.equal(a.fields[1].selector.name, "Email", "the field's name stays");
  assert.equal(a.fields[2].value, "Welcome to Harlow Legal, book your call");
  assert.equal(a.token, "[redacted:by-name]");
  assert.ok(!JSON.stringify(a).includes("abcdefghijklmnop"));
});

test("trace: strategy, fallback, retries, waited time, new tab and the failing step come from the result and the error detail", async t => {
  const { call, dataDir } = await rig(t, (/** @type {string} */ op) => {
    if (op === "page.act") return { ok: true, trace: { strategy: "role+name", fallback: true, waitedMs: 420, retries: 2, newTab: false } };
    if (op === "batch.run") { const e = Object.assign(new Error("step 2 failed"), { code: "not_found", detail: { host: "app.example.com", path: "/w/1", trace: { strategy: "text", fallback: true, waitedMs: 8000, retries: 3 }, dom: "<button>Save</button> alex@example.com", step: 2 } }); throw e; }
    return { ok: true };
  });
  await call("chrome_act", { selector: { name: "Add Action" }, kind: "click", tab: 1 });
  const bad = await call("chrome_batch", { steps: [{ op: "page.act", args: {} }], tab: 1 });
  assert.equal(bad.isError, true);
  const recs = /** @type {any} */ (readSessions(dataDir, 1)).records.filter((/** @type {any} */ x) => x.kind === "call");
  const ok = recs.find((/** @type {any} */ x) => x.tool === "chrome.act");
  assert.deepEqual([ok.strategy, ok.fallback, ok.waitMs, ok.retries], ["role+name", true, 420, 2]);
  const fail = recs.find((/** @type {any} */ x) => x.tool === "chrome.batch");
  assert.equal(fail.ok, false);
  assert.equal(fail.error.code, "not_found");
  assert.equal(fail.error.step, 2);
  assert.equal(fail.host, "app.example.com");
  assert.ok(!fail.error.dom.includes("alex@example.com"), "contact details in the snippet are masked");
  assert.equal(fail.fallback, true);
});

test("trace: report summarises slowest steps, failures by kind and fallback rate; the bundle is masked; logs off writes nothing", async t => {
  const { call, dataDir, runtime } = await rig(t, (/** @type {string} */ op) => {
    if (op === "page.act") return { ok: true, trace: { strategy: "name", fallback: true, waitedMs: 10 } };
    return { ok: true };
  });
  await call("chrome_act", { selector: { name: "x" }, kind: "click", tab: 1 });
  await call("chrome_tabs", { action: "open", url: "https://chase.com/" });
  const { summary, bundle } = report(dataDir, { last: 3 });
  assert.equal(summary.failuresByKind.blocked, 1);
  assert.ok(summary.calls >= 3);
  assert.equal(summary.fallbackRate > 0, true);
  assert.ok(summary.slowest.length > 0);
  assert.ok(bundle.records.length >= summary.calls);
  writeConfig(dataDir, { logs: "off" });
  // The running session re-reads the config after a short interval; a fresh one honours it at once.
  const { createTrace } = await import("./trace.js");
  const tr = createTrace({ dataDir });
  assert.equal(tr.write({ kind: "call", tool: "x" }), false);
  assert.ok(runtime.trace.file());
});

test("trace: the size cap deletes the oldest logs and keeps the newest", t => {
  const d = tmp(t); const logs = path.join(d, "logs"); fs.mkdirSync(logs);
  for (let i = 0; i < 5; i++) { const f = path.join(logs, `session-2026-0${i}.jsonl`); fs.writeFileSync(f, "x".repeat(1000)); fs.utimesSync(f, new Date(2026, 0, 1 + i), new Date(2026, 0, 1 + i)); }
  const removed = rotate(logs, 2500);
  assert.equal(removed, 3);
  assert.deepEqual(fs.readdirSync(logs).sort(), ["session-2026-03.jsonl", "session-2026-04.jsonl"]);
});

test("cli: install registers the host in a temp home and prints the extension folder and the claude mcp add line; uninstall removes it; logs off is remembered", t => {
  const home = tmp(t);
  const hostDir = path.join(home, "host"); fs.mkdirSync(hostDir);
  for (const f of ["host.js", "stdio.js", "run-host.sh", "run-host.cmd", "install.js"]) fs.copyFileSync(path.join(HERE, "..", "native-host", f), path.join(hostDir, f));
  const env = { ...process.env, HOME: home, USERPROFILE: home, VYRE_CHROME_HOME: path.join(home, ".vyre-chrome"), VYRE_CHROME_HOST_DIR: hostDir };
  const run = (/** @type {string[]} */ ...a) => spawnSync(process.execPath, [path.join(HERE, "cli.mjs"), ...a], { env, encoding: "utf8" });
  const inst = run("install", "--browsers", "chrome");
  assert.equal(inst.status, 0, inst.stderr);
  assert.match(inst.stdout, /claude mcp add vyre-chrome -- /);
  assert.match(inst.stdout, /Load unpacked/);
  assert.match(inst.stdout, /logs/);
  if (process.platform === "darwin") {
    const manifest = path.join(home, "Library", "Application Support", "Google", "Chrome", "NativeMessagingHosts", "run.vyre.chrome.json");
    assert.ok(fs.existsSync(manifest), manifest);
  }
  assert.equal(fs.readFileSync(path.join(hostDir, "sock-path"), "utf8").includes("chrome.sock") || process.platform === "win32", true);
  assert.equal(run("logs", "off").status, 0);
  assert.equal(JSON.parse(run("status").stdout).logs, "off");
  const un = run("uninstall");
  assert.equal(un.status, 0, un.stderr);
  assert.equal(fs.existsSync(path.join(hostDir, "sock-path")), false);
  if (process.platform === "darwin") assert.equal(fs.existsSync(path.join(home, "Library", "Application Support", "Google", "Chrome", "NativeMessagingHosts", "run.vyre.chrome.json")), false);
  assert.ok(fs.existsSync(path.join(home, ".vyre-chrome", "config.json")), "logs are kept without --purge");
  const r = run("report", "--last", "2");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Wrote /);
});

test("cli: `mcp` as a real process speaks only protocol on stdout, serves a call from a fake extension, and exits when stdin closes", async t => {
  const home = tmp(t);
  const dataDir = path.join(home, "d");
  const sock = path.join(dataDir, "run", "chrome.sock");
  const { spawn } = await import("node:child_process");
  const p = spawn(process.execPath, [path.join(HERE, "cli.mjs"), "mcp"], { env: { ...process.env, HOME: home, VYRE_CHROME_HOME: dataDir }, stdio: ["pipe", "pipe", "pipe"] });
  t.after(() => { try { p.kill(); } catch { /* gone */ } });
  let out = ""; p.stdout.on("data", d => { out += d; });
  const exited = new Promise(r => p.on("exit", c => r(c)));
  await until(() => fs.existsSync(sock), 5000);
  // The real process pins the extension's origin, as the host would report it.
  const key = JSON.parse(fs.readFileSync(path.join(HERE, "..", "extension", "manifest.json"), "utf8")).key;
  const ext = await fakeExtension(sock, { hello: false, handler: () => ({ tabs: [] }) });
  t.after(() => ext.sock.destroy());
  await ext.send({ event: "host", origin: `chrome-extension://${extensionIdFromKey(key)}/` });
  await ext.hello();
  p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } }) + "\n");
  p.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  await until(() => out.includes('"serverInfo"'), 5000);
  await until(async () => { p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "chrome_tabs", arguments: { action: "list" } } }) + "\n"); await new Promise(r => setTimeout(r, 50)); return /"id":2/.test(out) && !/no_extension/.test(out.split("\n").filter(l => /"id":2/.test(l)).pop() || ""); }, 5000);
  for (const line of out.split("\n").filter(Boolean)) assert.doesNotThrow(() => JSON.parse(line), "stdout carries only JSON-RPC lines");
  p.stdin.end();
  assert.equal(await exited, 0);
});
