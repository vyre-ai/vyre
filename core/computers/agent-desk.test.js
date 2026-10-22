// @ts-check
// The agent's own desk, end to end: a real vyred, the computers module, hands-chrome, Files, and agentd's
// relay. Chrome, the screen and the folder are the real modules. The container is the fake driver with
// execIn, and the helpers behind the relay are the real CDP, RFB and file shapes on stdio.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn as nodeSpawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { start } from "../daemon/index.js";
import { call } from "../daemon/client.js";
import { tempHome, present } from "../../test/helpers.js";
import { FakeDriver } from "./driver/fake.js";
import { createRelay, Tickets, RELAY_PORT } from "./image/agentd-relay.js";
import { validateRun } from "./image/agentd.js";

process.env.VYRE_SESSION_SANDBOX_OFF = "1";

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "test", "fixtures");
const CDP = path.join(FIX, "desk-cdp.js");
const VNC = path.join(FIX, "desk-vnc.js");
const FS = path.join(FIX, "desk-fs.js");

/** Top-level tests run together. The relay's port is the one the module dials, so these take it one at a time. */
let gate = Promise.resolve();
/** @param {string} name @param {(t: import("node:test").TestContext) => Promise<void>} fn */
function solo(name, fn) {
  test(name, { timeout: 120_000 }, async (t) => {
    const wait = gate;
    /** @type {() => void} */ let open = () => {};
    gate = new Promise(r => { open = r; });
    await wait;
    try { await fn(t); } finally { open(); }
  });
}

/**
 * @param {import("node:test").TestContext} t
 */
async function boot(t) {
  const root = tempHome(t);
  const fsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "desk-fs-"));
  const note = path.join(fsRoot, "navigated");
  /** @type {string[]} */ const spawns = [];
  /** @type {any[]} */ const execs = [];
  /** @type {string[]} */ const childErr = [];
  /** @type {string[]} */ const logs = [];
  const tickets = new Tickets();
  const helper = http.createServer((_q, res) => { res.writeHead(200); res.end("ok"); });
  await new Promise(r => helper.listen(0, "127.0.0.1", () => r(null)));
  const helperPort = /** @type {any} */ (helper.address()).port;
  /** @param {string[]} argv */
  const spawn = (argv) => {
    spawns.push(argv.join(" "));
    const last = String(argv[argv.length - 1] || "");
    const env = { ...process.env };
    /** @type {string[]} */ let args;
    if (last === "cdp") { env.DESK_CDP_NOTE = note; args = [CDP]; }
    else if (last === "vnc") args = [VNC];
    else if (last.endsWith("agentd-fs.js")) {
      const re = argv.find(a => String(a).startsWith("--reuid="));
      env.DESK_UID = re ? String(re).slice("--reuid=".length) : "";
      env.DESK_FS_ROOT = fsRoot;
      args = [FS];
    } else args = ["-e", "process.stdin.resume()"];
    const child = nodeSpawn(process.execPath, args, { env, stdio: ["pipe", "pipe", "pipe"] });
    let err = "";
    child.stderr.on("data", d => { err += d; });
    child.on("exit", code => { if (code) childErr.push(`${last} exit ${code}: ${err.slice(0, 400)}`); });
    return child;
  };
  const relay = createRelay({ tickets, spawn, peer: () => "127.0.0.1" });
  await new Promise((resolve, reject) => {
    relay.once("error", reject);
    relay.listen(RELAY_PORT, "127.0.0.1", () => { relay.off("error", reject); resolve(null); });
  });
  const drv = FakeDriver.for(root);
  drv.local = { host: "127.0.0.1", ports: { helper: helperPort, vnc: 5900 } };
  drv.execIn = async (_id, input) => {
    const msg = JSON.parse(String(input));
    const body = msg.body || {};
    if (msg.action === "ticket") {
      const kind = body.kind === "cdp" || body.kind === "run" || body.kind === "fs" ? body.kind : (body.session ? "term" : "vnc");
      const spec = kind === "fs" ? body.fs : kind === "run" ? { argv: body.argv, cwd: body.cwd, env: body.env } : null;
      tickets.add(body.ticket, { user: body.user, uid: body.uid, display: body.display }, kind, kind === "term" ? body.session : null, spec);
    } else if (msg.action === "exec") {
      execs.push(body);
      validateRun({ user: body.user, uid: body.uid, display: body.display }, { argv: body.argv, cwd: body.cwd, env: body.env });
    }
    const out = msg.action === "exec"
      ? { code: 0, signal: null, stdout: "", stderr: "", truncated: false }
      : msg.action === "terminals" ? { sessions: [{ name: "desk", windows: 1 }] } : {};
    return { stdout: JSON.stringify({ status: 200, body: out }) };
  };
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ role: "box", computers: {
    driver: "fake", sweepMs: 0, waitMs: 100, browse: "desktop", agentUsers: true, agentdWaitMs: 8000,
    local: { host: "127.0.0.1", ports: { helper: helperPort, vnc: 5900 } },
  } }));
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    if (daemon) await daemon.stop().catch(() => {});
    await new Promise(r => relay.close(() => r(null)));
    await new Promise(r => helper.close(() => r(null)));
    fs.rmSync(fsRoot, { recursive: true, force: true });
  };
  // Registered before start, and called again at the end of the test: the next test must have the relay's port before this one is marked done.
  t.after(() => { FakeDriver.forget(root); return stop(); });
  /** @type {any} */ let daemon = null;
  try {
    daemon = await start({ presence: present, root, log: (m, x) => logs.push(m + (x ? " " + JSON.stringify(x) : "")) });
  } catch (e) {
    await stop();
    throw e;
  }
  const why = () => `${logs.slice(-30).join("\n")}\n${spawns.join("\n")}\n${childErr.join("\n")}`;
  const person = async (tool, input = {}) => call(tool, input, { root, caller: "cli" });
  const agent = async (tool, input = {}) => daemon.registry.call(tool, input, "mcp:agent:kit");
  return { root, fsRoot, note, spawns, execs, logs, why, person, agent, stop, daemon };
}

/** @param {string[]} spawns @param {string} kind @param {string} reuid */
function spawned(spawns, kind, reuid) {
  return spawns.some(s => s.includes(`--reuid=${reuid}`) && s.trimEnd().endsWith(kind));
}

solo("asking an agent to open a site uses its own Chrome, and the live screen is that Chrome", async (t) => {
  const s = await boot(t);
  try {
    const made = await s.daemon.registry.call("agents.create", { name: "kit", kind: "agent", projects: [], computer: true }, "local");
    assert.equal(made.error, undefined, JSON.stringify(made.error));
    const opened = await s.agent("chrome.open", { url: "https://example.com/" });
    assert.equal(opened.error, undefined, JSON.stringify(opened.error) + "\n" + s.why());
    assert.equal(opened.data.url, "https://example.com/");
    assert.equal(fs.readFileSync(s.note, "utf8"), "https://example.com/");
    const cdp = s.spawns.find(line => line.trimEnd().endsWith("cdp")) || "";
    const reuid = /--reuid=(\d+)/.exec(cdp);
    assert.ok(reuid && Number(reuid[1]) >= 21000, `Chrome was not the agent's browser uid\n${cdp}\n${s.why()}`);
    assert.ok(!s.spawns.some(line => /fake-kit/.test(line)), s.why());
    const watch = await s.person("computers.agent.watch", { agent: "kit" });
    assert.equal(watch.error, undefined, JSON.stringify(watch.error) + "\n" + s.why());
    assert.match(watch.data.path, /^\/v1\/streams\/computers\/glass\?ticket=/);
    const up = await new Promise((resolve, reject) => {
      const sock = net.connect(s.daemon.paths.socket);
      const timer = setTimeout(() => { sock.destroy(); reject(new Error("glass upgrade timed out\n" + s.why())); }, 20_000);
      /** @type {Buffer[]} */ const parts = [];
      sock.on("data", d => {
        parts.push(d);
        const text = Buffer.concat(parts).toString("latin1");
        if (!text.includes("\r\n\r\n")) return;
        clearTimeout(timer);
        resolve({ head: text.split("\r\n")[0], sock });
      });
      sock.on("error", e => { clearTimeout(timer); reject(e); });
      sock.write(`GET ${watch.data.path} HTTP/1.1\r\nHost: vyred\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\nX-Vyre-Caller: cli\r\n\r\n`);
    });
    assert.match(/** @type {any} */ (up).head, /^HTTP\/1\.1 101 /, /** @type {any} */ (up).head + "\n" + s.why());
    const t0 = Date.now();
    while (!spawned(s.spawns, "vnc", reuid[1])) {
      if (Date.now() - t0 > 10_000) assert.fail(`the live screen did not open the agent's display\n${s.why()}`);
      await new Promise(r => setTimeout(r, 50));
    }
    /** @type {any} */ (up).sock.destroy();
  } finally { await s.stop(); }
});

solo("asking an agent to run a command uses its Terminal, and a file it makes shows in its Files", async (t) => {
  const s = await boot(t);
  try {
    const made = await s.daemon.registry.call("agents.create", { name: "kit", kind: "agent", projects: [], computer: true }, "local");
    assert.equal(made.error, undefined, JSON.stringify(made.error));
    const uid = String(made.data.uid || "");
    assert.match(uid, /^agt_[A-Za-z0-9_-]+$/);
    const ran = await s.agent("computers.agent.terminal.run", { command: "echo hello-from-kit" });
    assert.equal(ran.error, undefined, JSON.stringify(ran.error) + "\n" + s.why());
    assert.equal(ran.data.session, "desk");
    const desk = s.execs.find(e => (e.argv || []).includes("new-session"));
    assert.ok(desk && Number.isInteger(desk.uid), JSON.stringify(s.execs));
    const home = `/var/lib/vyre/agents/ag${desk.uid}/home`;
    const argv = s.execs.map(e => (e.argv || []).join(" "));
    assert.ok(argv.some(a => a.includes("/usr/bin/tmux") && a.includes("new-session") && a.includes("-s desk") && a.includes(`-c ${home}`)), argv.join("\n") + "\n" + s.why());
    assert.ok(argv.some(a => a.includes("send-keys") && a.includes("-t desk") && a.includes("echo hello-from-kit") && a.endsWith("Enter")), argv.join("\n"));
    const wrote = await s.agent("computers.agent.file.make", { path: "Work/note.txt", text: "hello from kit" });
    assert.equal(wrote.error, undefined, JSON.stringify(wrote.error) + "\n" + s.why());
    const fsLine = s.spawns.find(line => line.includes("agentd-fs.js")) || "";
    assert.match(fsLine, new RegExp(`--reuid=${desk.uid}(?:\\s|$)`), fsLine + "\n" + s.why());
    assert.equal(fs.readFileSync(path.join(s.fsRoot, `ag${desk.uid}`, "Work", "note.txt"), "utf8"), "hello from kit");
    let listed = /** @type {any} */ (null);
    for (let n = 0; n < 10; n++) {
      listed = await s.person("files.drive.space.list", { prefix: `agents/${uid}/Work` });
      if (!listed.error) break;
      await new Promise(r => setTimeout(r, 200));
    }
    assert.equal(listed.error, undefined, JSON.stringify(listed.error) + "\n" + s.why());
    const hit = (listed.data.entries || []).find((/** @type {any} */ e) => e.name === "note.txt");
    assert.ok(hit, JSON.stringify(listed.data));
    assert.equal(hit.path, `agents/${uid}/Work/note.txt`);
  } finally { await s.stop(); }
});
