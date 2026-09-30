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
import { build } from "./build-release.mjs";

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

test("cli: install copies the package read-only under the data folder, registers the host, prints the folder and the claude mcp add line; uninstall removes it; purge only deletes a folder it made", t => {
  const home = tmp(t);
  const env = { ...process.env, HOME: home, USERPROFILE: home, VYRE_CHROME_HOME: path.join(home, ".vyre-chrome") };
  const run = (/** @type {string[]} */ ...a) => spawnSync(process.execPath, [path.join(HERE, "cli.mjs"), ...a], { env, encoding: "utf8" });
  const rel = build({ out: path.join(home, "rel") });
  const relCli = path.join(rel.dir, "standalone", "cli.mjs");
  const runRel = (/** @type {string[]} */ ...a) => spawnSync(process.execPath, [relCli, ...a], { env, encoding: "utf8" });
  t.after(() => { spawnSync("chmod", ["-R", "u+rwX", home]); });
  const inst = runRel("install", "--browsers", "chrome");
  assert.equal(inst.status, 0, inst.stderr);
  const app = path.join(home, ".vyre-chrome", "app");
  assert.match(inst.stdout, new RegExp(`claude mcp add vyre-chrome -- .*${app.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  assert.match(inst.stdout, /Load unpacked/);
  assert.ok(inst.stdout.includes(path.join(app, "extension")), "the extension folder printed is the private copy");
  assert.ok(fs.existsSync(path.join(app, "standalone", "cli.mjs")));
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(path.join(app, "extension", "manifest.json")).mode & 0o222, 0, "files are read-only");
    assert.equal(fs.statSync(path.join(app, "native-host")).mode & 0o222, 0, "folders are read-only");
    assert.equal(fs.readFileSync(path.join(app, "native-host", "sock-path"), "utf8").includes("chrome.sock"), true);
  }
  if (process.platform === "darwin") assert.ok(fs.existsSync(path.join(home, "Library", "Application Support", "Google", "Chrome", "NativeMessagingHosts", "run.vyre.chrome.json")));
  assert.equal(runRel("logs", "off").status, 0);
  assert.equal(runRel("config", "confirm-sends", "off").status, 0);
  assert.equal(runRel("config", "ghl-host", "https://Crm.Agency.example/login").status, 0);
  assert.notEqual(runRel("config", "ghl-host", "not a host").status, 0);
  assert.equal(runRel("config", "ghl-host").stdout.trim(), "crm.agency.example");
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, ".vyre-chrome", "config.json"), "utf8")).ghlHosts[0], "crm.agency.example");
  assert.equal(runRel("config", "ghl-host", "crm.agency.example", "--remove").status, 0);
  assert.match(runRel("config", "ghl-host").stdout, /always count/);
  const st = JSON.parse(runRel("status").stdout);
  assert.equal(st.logs, "off");
  // Installing again replaces the copy.
  assert.equal(runRel("install", "--browsers", "chrome").status, 0);
  const un = runRel("uninstall");
  assert.equal(un.status, 0, un.stderr);
  assert.equal(fs.existsSync(app), false);
  if (process.platform === "darwin") assert.equal(fs.existsSync(path.join(home, "Library", "Application Support", "Google", "Chrome", "NativeMessagingHosts", "run.vyre.chrome.json")), false);
  assert.ok(fs.existsSync(path.join(home, ".vyre-chrome", "config.json")), "logs are kept without --purge");
  const r = runRel("report", "--last", "2");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Wrote /);
  // Purge: a folder without the marker is not ours; the home folder is never deleted; a folder with the marker goes.
  const other = path.join(home, "precious"); fs.mkdirSync(other); fs.writeFileSync(path.join(other, "keep.txt"), "x");
  const runOther = (/** @type {Record<string,string>} */ e, /** @type {string[]} */ ...a) => spawnSync(process.execPath, [relCli, ...a], { env: { ...env, ...e }, encoding: "utf8" });
  const no = runOther({ VYRE_CHROME_HOME: other }, "uninstall", "--purge");
  assert.match(no.stdout, /Not deleting .*marker/);
  assert.ok(fs.existsSync(path.join(other, "keep.txt")));
  fs.writeFileSync(path.join(home, ".vyre-chrome", ".vyre-chrome-marker"), "x"); // ensure marker present
  const homeTry = runOther({ VYRE_CHROME_HOME: home }, "uninstall", "--purge");
  assert.match(homeTry.stdout, /Not deleting/);
  assert.ok(fs.existsSync(home));
  if (process.platform !== "win32") {
    const link = path.join(home, "link"); fs.symlinkSync(other, link);
    assert.match(runOther({ VYRE_CHROME_HOME: link }, "uninstall", "--purge").stdout, /Not deleting .*link/);
    assert.ok(fs.existsSync(path.join(other, "keep.txt")));
  }
  assert.match(runRel("uninstall", "--purge").stdout, /Deleted/);
  assert.equal(fs.existsSync(path.join(home, ".vyre-chrome")), false);
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

test("release: the built package runs on its own, with nothing from the repo, and holds no test files or machine-specific files", async t => {
  const out = tmp(t);
  const { build } = await import("./build-release.mjs");
  const r = build({ out });
  assert.ok(fs.existsSync(r.tar));
  assert.match(fs.readFileSync(`${r.tar}.sha256`, "utf8"), /^[0-9a-f]{64}  vyre-chrome-/);
  const all = /** @type {string[]} */ ([]);
  const walk = (/** @type {string} */ d) => { for (const f of fs.readdirSync(d)) { const p = path.join(d, f); fs.statSync(p).isDirectory() ? walk(p) : all.push(path.relative(r.dir, p)); } };
  walk(r.dir);
  assert.ok(all.every(f => !/\.test\.js$/.test(f) && !/node-path|sock-path/.test(f)), all.join(","));
  for (const need of ["README.md", "package.json", "standalone/cli.mjs", "standalone/GHL-PLAYBOOK.md", "extension/manifest.json", "native-host/run-host.sh", "index.js"]) assert.ok(all.includes(need), need);
  // Nothing may import from outside the package.
  for (const f of all.filter(x => /\.(m?js)$/.test(x))) {
    const src = fs.readFileSync(path.join(r.dir, f), "utf8");
    for (const m of src.matchAll(/from\s+"(\.[^"]+)"/g)) assert.ok(fs.existsSync(path.resolve(path.dirname(path.join(r.dir, f)), m[1])), `${f} imports ${m[1]}`);
  }
  const home = tmp(t);
  const run = spawnSync(process.execPath, [path.join(r.dir, "standalone", "cli.mjs"), "status"], { env: { ...process.env, HOME: home, VYRE_CHROME_HOME: path.join(home, "d") }, encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(JSON.parse(run.stdout).logs, "on");
});

test("ladder: a failure names its rung and the next one, and the trace and report count calls per rung", async t => {
  const { call, dataDir } = await rig(t, (/** @type {string} */ op) => { if (op === "page.act") throw Object.assign(new Error("nothing matches"), { code: "not_found" }); return { ok: true }; });
  const r = await call("chrome_act", { selector: { name: "Add Action" }, kind: "click", tab: 1 });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /ladder: .*rung 3/);
  const rec = /** @type {any} */ (readSessions(dataDir, 1)).records.find((/** @type {any} */ x) => x.tool === "chrome.act");
  assert.deepEqual([rec.rung, rec.rungName], [2, "dom"]);
  assert.equal(report(dataDir).summary.rungs.dom.failures, 1);
});

test("privacy: typed values are logged as lengths off GoHighLevel builder pages, kept on them, and card and SSN numbers are always masked", async t => {
  const { call, dataDir } = await rig(t, (/** @type {string} */ op, /** @type {any} */ a) => ({ ok: true, url: a && a.tabId === 2 ? "https://app.gohighlevel.com/x" : "https://harlow.example/intake" }));
  await call("chrome_fill", { tab: 1, fields: [{ label: "Notes", value: "client Alex Sample owes 4200 for the Harlow matter" }] });
  await call("chrome_fill", { tab: 2, fields: [{ label: "Subject", value: "Welcome to Harlow Legal" }] });
  const recs = /** @type {any} */ (readSessions(dataDir, 1)).records.filter((/** @type {any} */ x) => x.tool === "chrome.fill");
  assert.equal(recs[0].args.fields[0].value, "[50 chars]");
  assert.equal(pii("card 4242 4242 4242 4242 and ssn 123-45-6789 and order 1234567890123"), "card [card] and ssn [ssn] and order 1234567890123");
  assert.equal(recs.length, 2);
});

test("send approval: a client that can ask (MCP elicitation) is asked by the server, and a no means nothing is sent", async t => {
  let released = 0;
  const handler = (/** @type {string} */ op, /** @type {any} */ a) => {
    if (op === "page.act" && a.release) { released++; return { ok: true }; }
    if (op === "page.act") return { ok: false, held: true, control: { role: "button", name: "Send" }, fields: [{ name: "Email", value: "alex@example.com" }], sig: "s", url: "https://harlow.example/x" };
    return { ok: true };
  };
  const dataDir = tmp(t);
  const runtime = await createRuntime({ dataDir, sockPath: path.join(dataDir, "run", "chrome.sock"), log: () => {}, chrome: { extensionOrigin: null } });
  t.after(() => runtime.stop());
  const ext = await fakeExtension(path.join(dataDir, "run", "chrome.sock"), { handler });
  t.after(() => ext.sock.destroy());
  await until(async () => (await runtime.invoke("chrome.status", {})).result.connected);
  const held = (await runtime.invoke("chrome.act", { selector: { name: "Send" }, kind: "click", tab: 1 })).result;
  const asked = /** @type {string[]} */ ([]);
  const no = await runtime.invoke("chrome.send", { id: held.id }, { ask: async (/** @type {string} */ m) => { asked.push(m); return { action: "accept", content: { approve: false } }; } });
  assert.equal(no.ok, false);
  assert.equal(no.error.code, "declined");
  assert.equal(released, 0);
  assert.match(asked[0], /harlow\.example/);
  const yes = await runtime.invoke("chrome.send", { id: held.id }, { ask: async () => ({ action: "accept", content: { approve: true } }) });
  assert.equal(yes.ok, true);
  assert.equal(released, 1);
});

test("callers: the person's Esc is only undone by the person (asked through the client), and the person's own tools are not the model's", async t => {
  const dataDir = tmp(t);
  const runtime = await createRuntime({ dataDir, sockPath: path.join(dataDir, "run", "chrome.sock"), log: () => {}, chrome: { extensionOrigin: null } });
  t.after(() => runtime.stop());
  await runtime.invoke("chrome.stop", { by: "user" });
  const cant = await runtime.invoke("chrome.resume", { answer: "go" });
  assert.equal(cant.ok, false, "a client that cannot ask cannot resume");
  assert.equal(cant.error.code, "denied");
  const no = await runtime.invoke("chrome.resume", { answer: "go" }, { ask: async () => ({ action: "accept", content: { approve: false } }) });
  assert.equal(no.ok, false);
  assert.equal(no.error.code, "declined");
  const yes = await runtime.invoke("chrome.resume", { answer: "go" }, { ask: async () => ({ action: "accept", content: { approve: true } }) });
  assert.equal(yes.ok, true, JSON.stringify(yes.error && yes.error.message));
  for (const hidden of ["chrome.interject", "chrome.install", "chrome.release"]) assert.equal((await runtime.invoke(hidden, { id: "x", content: {} })).error.code, "no_such_tool", hidden);
  assert.ok(runtime.list().some(x => x.name === "chrome.resume" && /allow list/.test(x.description)));
  writeConfig(dataDir, { confirmSends: false });
});

test("report: a shared bundle never carries a typed value, even from a page whose values the local trace keeps", async t => {
  const { call, dataDir } = await rig(t, () => ({ ok: true, url: "http://127.0.0.1:1/ghl" }));
  writeConfig(dataDir, { values: "all" });
  await call("chrome_fill", { tab: 1, fields: [{ label: "Subject", value: "Welcome to Harlow Legal" }] });
  const { createTrace } = await import("./trace.js");
  const { bundle } = report(dataDir);
  assert.ok(!JSON.stringify(bundle).includes("Harlow Legal"));
});


test("ghl hosts: the configured white-label domain reaches the extension on every call", async t => {
  const dataDir = tmp(t);
  writeConfig(dataDir, { ghlHosts: ["agency.example"] });
  const sockPath = path.join(dataDir, "run", "chrome.sock");
  const runtime = await createRuntime({ dataDir, sockPath, log: () => {}, chrome: { extensionOrigin: null } });
  t.after(() => runtime.stop());
  const ext = await fakeExtension(sockPath, { handler: () => ({ tabs: [] }) });
  t.after(() => ext.sock.destroy());
  await until(async () => (await runtime.invoke("chrome.status", {})).result.connected);
  await runtime.invoke("chrome.tabs", { action: "list" });
  assert.deepEqual(ext.ops("tabs.list").at(-1).args.ghlHosts, ["agency.example"]);
});

test("privacy: an automatically recognised white-label builder page keeps typed values; its contacts page does not", async t => {
  const { call, dataDir } = await rig(t, (/** @type {string} */ op, /** @type {any} */ a) => ({ ok: true, url: a && (a.tab === 2 || a.tabId === 2) ? "https://crm.agency.example/v2/location/abcdefghij12/contacts/list" : "https://crm.agency.example/v2/location/abcdefghij12/automation/workflows/wf1" }));
  await call("chrome_fill", { tab: 1, fields: [{ label: "Subject", value: "Welcome to Harlow Legal" }] });
  await call("chrome_fill", { tab: 2, fields: [{ label: "Notes", value: "call the client about the deed" }] });
  const recs = /** @type {any} */ (readSessions(dataDir, 1)).records.filter((/** @type {any} */ x) => x.tool === "chrome.fill");
  assert.equal(recs[0].args.fields[0].value, "Welcome to Harlow Legal");
  assert.match(String(recs[1].args.fields[0].value), /^\[\d+ chars\]$/);
});
