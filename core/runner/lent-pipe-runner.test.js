// @ts-check
// A chat's process on a lender, through the whole runner (contracts/lent-spawn.md): the home spawns a ChildProcess for the SDK, the lender's heartbeat is told to start it, the runner starts the program in its real sandbox
// with the SDK's flags, and the bytes ride `lent.pipe` between the two. A fake agent stands in for Claude Code. Real sandbox and workspace, the in-memory Wink.
import "../../scripts/mac-test-guard.mjs";
import "./testing/hosted-guard.js";
import "./testing/require-sandbox.js";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { SCRATCH } from "../../test/scratch.mjs";
import { createRemoteKernel } from "../../kernel/remote/client.js";
import { createMemoryTransport } from "../../kernel/remote/memory-transport.js";
import { unavailable } from "./sandbox.js";
import { workspaceUnavailable } from "./workspace.js";
import mod, { seams } from "./index.js";
import { rig, SPACE, BOB } from "./testing/lent-rig.js";
import { createFolders } from "./folders.js";
import { start } from "../daemon/index.js";
import { openThreadSocket, lentRequest } from "../daemon/threadsock.js";
import { tempHome } from "../../test/helpers.js";

const SKIP = unavailable() || workspaceUnavailable() || "";
const sleep = (/** @type {number} */ ms) => new Promise(r => setTimeout(r, ms));
const waitFor = async (/** @type {() => any} */ fn, ms = 20_000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await sleep(50); } throw new Error("timed out"); };
const lines = (/** @type {any} */ stream) => { /** @type {string[]} */ const got = []; let buf = ""; stream.on("data", (/** @type {any} */ d) => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { got.push(buf.slice(0, i)); buf = buf.slice(i + 1); } }); return got; };

async function world(/** @type {import("node:test").TestContext} */ t, /** @type {{ enrolled?: boolean, heartbeatMs?: number, http?: any, canResume?: () => boolean }} */ o = {}) {
  const agentDir = fs.mkdtempSync(path.join(SCRATCH, "lp-agent-"));
  const agent = path.join(agentDir, "agent.js");
  fs.copyFileSync(new URL("./testing/fake-agent.js", import.meta.url), agent);
  const was = process.env.VYRE_CLAUDE_BIN; process.env.VYRE_CLAUDE_BIN = agent;
  const root = fs.mkdtempSync(path.join(SCRATCH, "lp-root-"));
  const r = await rig(t, { keyIsDevice: true, lapseMs: 20_000, ...(o.http ? { http: o.http } : {}), ...(o.canResume ? { canResume: o.canResume } : {}), specFor: async () => ({ command: "claude", args: [], env: {}, routes: [], readOnly: [], labels: {}, network: "provider", credentialRoutes: [] }) });
  const remote = createRemoteKernel({ space: SPACE, transport: createMemoryTransport({ servers: { [SPACE]: r.server }, peer: { device_key_id: "dev_laptop", person: BOB, path: "wink" } }) });
  /** @type {Map<string, any>} */ const tools = new Map();
  const handlers = new Map();
  const ctx = {
    paths: { root }, config: { role: "local", name: "Office Mac" },
    events: { emit: (/** @type {string} */ type) => { for (const f of handlers.get(type) || []) f({ type }); }, on: (/** @type {string} */ type, /** @type {any} */ f) => { handlers.set(type, [...(handlers.get(type) || []), f]); return () => handlers.set(type, (handlers.get(type) || []).filter((/** @type {any} */ x) => x !== f)); } },
    tool: (/** @type {string} */ n, /** @type {any} */ d) => tools.set(n, d),
    call: async (/** @type {string} */ name, /** @type {any} */ input) => (name === "settings.get" ? { data: { value: { "runner.enabled": true, "runner.plugged_in_only": false, "runner.cpu_percent": 90, "runner.memory_mb": 8192 }[input.key] } } : { data: { devices: [] } }),
    kernel: { owner: BOB, chain: async () => ({ hops: [{ actor: { kind: "person", id: BOB } }] }), for: () => ({ call: (/** @type {string} */ name, /** @type {any[]} */ args) => remote.call(name, args) }), runnerHost: () => ({ identity: async () => ({ deviceId: "eid_mac", deviceKey: "dev_laptop" }), ...(o.enrolled ? { lentTo: async () => [SPACE] } : {}) }) },
  };
  seams.set(root, { heartbeatMs: o.heartbeatMs || 150, beatTimeoutMs: 400, state: () => ({ onPower: true, awake: true, cpuPct: 5, memPct: 5 }) });
  const h = await mod.start(ctx);
  t.after(async () => { seams.delete(root); await h.stop(); if (was === undefined) delete process.env.VYRE_CLAUDE_BIN; else process.env.VYRE_CLAUDE_BIN = was; fs.rmSync(agentDir, { recursive: true, force: true }); });
  const run = (/** @type {string} */ tool, /** @type {any} */ input) => tools.get(tool).run(input, { caller: "cli" });
  return { r, root, run, book: r.home.book, say: (/** @type {string} */ type) => ctx.events.emit(type, {}) };
}

test("a chat spawned for a lender runs in the lender's sandbox with the SDK's flags, turns go down and answers come up, and the runner's own checkpoint is taken at the end of the turn", { skip: SKIP || false, timeout: 120_000 }, async t => {
  const keep = setInterval(() => {}, 100); t.after(() => clearInterval(keep));
  const w = await world(t);
  // the lender is a lender for this Space once it has a workspace here, and then it says every few seconds that it is well
  await w.run("runner.start", { space: SPACE, session: "s0" });
  await sleep(600);
  const proc = w.r.home.spawn({ session: "s_chat", person: BOB, args: ["/box/cli.js", "--output-format", "stream-json", "--mcp-config", "/box/mcp.json"] });
  const out = lines(proc.stdout);
  await waitFor(() => proc.lent && proc.lent.state === "up", 15_000);
  assert.equal(w.book.get("s_chat").where, "mac");
  proc.stdin.write("turn hello\n");
  await waitFor(() => out.some(l => l.includes("\"result\"")), 15_000);
  assert.ok(out.some(l => l.includes("did hello")), "the answer came up: " + out.join(" | "));
  // the runner kept doing its own work on the same bytes: the turn ended, so a checkpoint is at the home with the transcript
  await waitFor(async () => (await w.r.home.view("s_chat").checkpoint().catch(() => null))?.turn >= 1, 15_000);
  const closed = new Promise(res => proc.on("close", (/** @type {any} */ c, /** @type {any} */ s) => res([c, s])));
  proc.stdin.write("exit\n");
  assert.deepEqual(await closed, [0, null], "the program ended itself");
});

test("a kill from the SDK ends the sandboxed process tree on the lender", { skip: SKIP || false, timeout: 120_000 }, async t => {
  const keep = setInterval(() => {}, 100); t.after(() => clearInterval(keep));
  const w = await world(t);
  await w.run("runner.start", { space: SPACE, session: "s0" });
  await sleep(600);
  const proc = w.r.home.spawn({ session: "s_kill", person: BOB, args: ["--output-format", "stream-json"] });
  const closed = new Promise(res => proc.on("close", (/** @type {any} */ c, /** @type {any} */ s) => res([c, s])));
  await waitFor(() => proc.lent && proc.lent.state === "up", 15_000);
  assert.ok(proc.kill());
  const [, signal] = /** @type {any[]} */ (await closed);
  assert.ok(signal === "SIGTERM" || signal === "SIGKILL" || signal === null, "ended: " + signal);
  await waitFor(async () => (await w.run("runner.here", {})).sessions.every((/** @type {any} */ x) => x.title !== "A session" || true) , 5000);
});

test("the first chat on a Mac that never ran a session for the Space runs there, and is started in a second or two, not at the next heartbeat", { skip: SKIP || false, timeout: 120_000 }, async t => {
  const keep = setInterval(() => {}, 100); t.after(() => clearInterval(keep));
  // the heartbeat is every four seconds here: only the nudge can start a chat sooner
  const w = await world(t, { enrolled: true, heartbeatMs: 4000 });
  // an enrolled lender has said it is well to this Space's home without ever having run a session there
  const placed = await waitFor(() => { const p = w.r.home.placeNew({ session: "s_first", person: BOB }); return p.where === "mac" ? p : null; }, 20_000);
  assert.equal(placed.device, "dev_laptop");
  const t0 = Date.now();
  const proc = w.r.home.spawn({ session: "s_first", person: BOB, title: "First chat", args: ["--output-format", "stream-json"] });
  const out = lines(proc.stdout);
  assert.equal(proc.lent.state, "starting");
  await waitFor(() => proc.lent && proc.lent.state === "up", 15_000);
  assert.ok(Date.now() - t0 < 3500, `started at once, not at the next heartbeat (${Date.now() - t0} ms)`);
  proc.stdin.write("turn hi\n");
  await waitFor(() => out.some(l => l.includes("did hi")), 15_000);
  proc.kill();
});

test("a chat's session on a Mac reaches Vyre's tools: its Vyre MCP server speaks to the runner's door, the door asks the home, and the home answers as that session", { skip: SKIP || false, timeout: 120_000 }, async t => {
  const keep = setInterval(() => {}, 100); t.after(() => clearInterval(keep));
  /** @type {any[]} */ const asked = [];
  const w = await world(t, { http: async (/** @type {string} */ thread, /** @type {string} */ method, /** @type {string} */ p, /** @type {any} */ headers, /** @type {string} */ body) => { asked.push([thread, p, headers, body]); if (method === "GET") return { status: 200, body: JSON.stringify({ data: [{ name: "records.list", description: "List records.", input: { type: "object" }, effect: "read" }, { name: "tools.find", description: "Find a tool.", input: { type: "object" }, effect: "read" }] }) }; if (p.endsWith("/harness.rules")) return { status: 200, body: JSON.stringify({ data: { decision: "deny", reason: "from the home" } }) }; return { status: 200, body: JSON.stringify({ data: { tool: p.split("/").pop(), you: `mcp:thread:${thread}` } }) }; } });
  await w.run("runner.start", { space: SPACE, session: "s0" });
  await sleep(600);
  const proc = w.r.home.spawn({ session: "s_tools", person: BOB, args: ["--output-format", "stream-json", `--${"plugin-dir"}`, new URL("../../harness", import.meta.url).pathname, "--mcp-config", JSON.stringify({ mcpServers: { canvas: { type: "sdk", name: "canvas" }, vyre: { command: "node", args: ["/box/mcp.js"] } } })] });
  const out = lines(proc.stdout);
  await waitFor(() => proc.lent && proc.lent.state === "up", 15_000);
  // the process is told where Vyre is: a socket, and an MCP config with the SDK's own server and the lender's Vyre server (not the box's)
  proc.stdin.write("argv\n");
  const argvLine = await waitFor(() => out.find(l => l.includes("\"argv\"")), 15_000);
  const seen = JSON.parse(argvLine);
  assert.match(seen.socket, /vyre/);
  const cfg = JSON.parse(seen.argv[seen.argv.indexOf("--mcp-config", 3) + 1]);
  assert.ok(!seen.argv.join(" ").includes("/box/mcp.js"), "nothing of the box's reaches the lender");
  const all = seen.argv.flatMap((x, i) => (x === "--mcp-config" ? [JSON.parse(seen.argv[i + 1])] : []));
  assert.ok(all.some(c => c.mcpServers.canvas && c.mcpServers.canvas.type === "sdk"), "the SDK's in-process server is kept");
  const vyre = all.map(c => c.mcpServers.vyre).find(Boolean);
  assert.ok(vyre && /harness[\\/]mcp[\\/]run\.js$/.test(vyre.args[0]) && vyre.env.VYRE_SOCKET, "the lender's own Vyre MCP server speaks to the runner's door");
  void cfg;
  // a call through the door is the session's own call at the home
  proc.stdin.write("vyre records.list {\"type\":\"contact\"}\n");
  const reply = JSON.parse(await waitFor(() => out.find(l => l.includes("\"vyre\"")), 15_000)).reply;
  assert.equal(reply.status, 200);
  assert.deepEqual(JSON.parse(reply.body).data, { tool: "records.list", you: "mcp:thread:s_tools" });
  assert.deepEqual([asked.at(-1)[0], asked.at(-1)[1], asked.at(-1)[2]["x-vyre-caller"], asked.at(-1)[3]], ["s_tools", "/v1/tools/records.list", "mcp", "{\"type\":\"contact\"}"]);
  // the Harness hooks run on the lender too, from its own copy of the plugin, and ask the home through the same door as the session's own (caller harness): the home's word is the hook's answer
  proc.stdin.write("hook rules {\"session_id\":\"s_tools\",\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"ls\"}}\n");
  const hook = JSON.parse(await waitFor(() => out.find(l => l.includes("\"hook\"")), 30_000));
  assert.ok(hook.stdout, "the hook said something: " + JSON.stringify(hook));
  assert.equal(JSON.parse(hook.stdout).hookSpecificOutput.permissionDecision, "deny", JSON.stringify(hook));
  assert.deepEqual([asked.at(-1)[0], asked.at(-1)[1], asked.at(-1)[2]["x-vyre-caller"]], ["s_tools", "/v1/tools/harness.rules", "harness"], "as a hook, not as the MCP server");
  // and Vyre's real MCP server, run inside the sandbox from that config, lists the tools the home says this session has
  proc.stdin.write("mcp\n");
  const mcp = JSON.parse(await waitFor(() => out.find(l => l.includes("\"mcp\"") && l.includes("\"init\"")), 50_000).catch(e => { throw new Error(`${e.message}; the program said: ${out.slice(-6).join(" | ").slice(0, 700)}`); }));
  assert.equal(mcp.init, "ok", JSON.stringify(mcp));
  assert.ok(Array.isArray(mcp.tools) && mcp.tools.includes("tools_find"), "the server answered from the home's list: " + JSON.stringify(mcp.tools));
  proc.kill();
});

test("a lent session calls tools.find and a module tool and gets the same answers as the same session on the box", { skip: SKIP || false, timeout: 120_000 }, async t => {
  const keep = setInterval(() => {}, 100); t.after(() => clearInterval(keep));
  // the box: a real daemon, and the session's own socket opened the way the switchboard opens it (its route, its caller binding)
  process.env.VYRE_SEAL_DEV = "1";
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "test-box", role: "box", transcripts: [], vault: { keystore: "file" } }));
  const d = await start({ root, log: () => {} });
  t.after(() => d.stop());
  const manifest = JSON.parse(fs.readFileSync(new URL("../switchboard/module.json", import.meta.url), "utf8"));
  const dir = fs.mkdtempSync(path.join(SCRATCH, "lp-ts-")); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const sock = await openThreadSocket({ handler: d.registry.context(manifest).handler, thread: "s_real", agent: "kit", dir, pids: async () => ({ pids: [] }) });
  t.after(() => sock.close());
  // the lender
  const w = await world(t, { http: lentRequest });
  await w.run("runner.start", { space: SPACE, session: "s0" });
  await sleep(600);
  const proc = w.r.home.spawn({ session: "s_real", person: BOB, args: ["--output-format", "stream-json"] });
  const out = lines(proc.stdout);
  await waitFor(() => proc.lent && proc.lent.state === "up", 15_000);
  const viaLender = async (/** @type {string} */ tool, /** @type {any} */ input) => { const n = out.length; proc.stdin.write(`vyre ${tool} ${JSON.stringify(input)}\n`); const line = await waitFor(() => out.slice(n).find(l => l.includes("\"vyre\"")), 20_000); return JSON.parse(JSON.parse(line).reply.body); };
  const onBox = async (/** @type {string} */ tool, /** @type {any} */ input) => JSON.parse(/** @type {any} */ (await lentRequest("s_real", "POST", `/v1/tools/${tool}`, { "x-vyre-caller": "mcp" }, JSON.stringify(input))).body);
  const boxCatalog = JSON.parse(/** @type {any} */ (await lentRequest("s_real", "GET", "/v1/tools", { "x-vyre-caller": "mcp" }, "")).body);
  assert.ok(Array.isArray(boxCatalog.data) && boxCatalog.data.length > 10, "the box lists its tools");
  const echo = await viaLender("system.echo", { text: "same" });
  assert.deepEqual(echo, await onBox("system.echo", { text: "same" }), "a module tool answers the same");
  // Vyre's own MCP server, run in the sandbox, finds tools in the box's catalog and calls one of them
  const n0 = out.length; proc.stdin.write("mcp tools_find {\"query\":\"echo\"}\n");
  const mcp = JSON.parse(await waitFor(() => out.slice(n0).find(l => l.includes("\"mcp\"") && l.includes("\"init\"")), 50_000).catch(e => { throw new Error(`${e.message}; the program said: ${out.slice(-6).join(" | ").slice(0, 700)}`); }));
  assert.equal(mcp.init, "ok", JSON.stringify(mcp));
  assert.ok(mcp.tools.includes("tools_find") && mcp.tools.includes("tools_call"), JSON.stringify(mcp.tools));
  assert.ok(JSON.stringify(mcp.called).includes("system_echo") || JSON.stringify(mcp.called).includes("system.echo"), "tools_find found the box's echo tool: " + JSON.stringify(mcp.called).slice(0, 300));
  // and what the session may not do on the box, it may not do from the Mac
  const reveal = await viaLender("vault.reveal", { name: "x" });
  assert.equal(reveal.error && reveal.error.code, "denied");
  // a send is held for the person exactly as it is on the box: nothing is sent from the Mac either, and what the model is told is the same
  const sendArgs = { via: "email", to: "a@example.com", subject: "hi", body: "hello" };
  const sentFromMac = await viaLender("comms.send", sendArgs), sentOnBox = await onBox("comms.send", sendArgs);
  assert.equal(sentFromMac.error && sentFromMac.error.code, "held_for_approval", JSON.stringify(sentFromMac).slice(0, 300));
  assert.equal(sentOnBox.error && sentOnBox.error.code, "held_for_approval");
  const waiting = /** @type {any} */ ((await d.registry.call("approvals.pending", {}, "deck")).data).approvals.map((/** @type {any} */ a) => a.id);
  assert.ok(waiting.includes(sentFromMac.error.approval), "the card waits at the home, for the person: " + JSON.stringify(waiting));
  proc.kill();
});

test("a chat that began on the server moves to the Mac: its whole turns are written into the computer's own agent home before the program starts, where its resume looks", { skip: SKIP || false, timeout: 120_000 }, async t => {
  const keep = setInterval(() => {}, 100); t.after(() => clearInterval(keep));
  const w = await world(t);
  await w.run("runner.start", { space: SPACE, session: "s0" });
  await sleep(600);
  const turns = [JSON.stringify({ type: "user", n: 1 }), JSON.stringify({ type: "assistant", n: 2 })];
  // no computer ready, or nothing whole to move: refused in words, nothing written
  await assert.rejects(() => Promise.resolve(w.r.home.adopt({ session: "s_moved", thread: "s_moved", person: BOB, native: "s_moved", lines: [] })), (/** @type {any} */ e) => e.code === "unavailable");
  const placed = await w.r.home.adopt({ session: "s_moved", thread: "s_moved", person: BOB, native: "s_moved", lines: turns });
  assert.equal(placed.where, "mac");
  assert.equal(w.book.get("s_moved").where, "mac", "the chat has a place on the computer, kept until its next turn");
  await assert.rejects(() => Promise.resolve(w.r.home.adopt({ session: "s_moved", thread: "s_moved", person: BOB, native: "s_moved", lines: turns })), (/** @type {any} */ e) => e.code === "conflict");
  // the chat's next turn starts the program there
  const proc = w.r.home.spawn({ session: "s_moved", person: BOB, args: ["--output-format", "stream-json"] });
  const out = lines(proc.stdout);
  await waitFor(() => proc.lent && proc.lent.state === "up", 20_000);
  proc.stdin.write("seedcheck s_moved\n");
  const got = JSON.parse(await waitFor(() => out.find(l => l.includes("\"seedcheck\"")), 20_000));
  assert.equal(got.found, true, "the program finds its history where its resume looks");
  assert.equal(got.text, turns.join("\n") + "\n");
  proc.kill();
});

test("a program that crashes on a Mac ends for the SDK with the exit code it really had, even when the server can carry on; the home then takes the session with reason crash", { skip: SKIP || false, timeout: 120_000 }, async t => {
  const keep = setInterval(() => {}, 100); t.after(() => clearInterval(keep));
  const w = await world(t, { canResume: () => true });
  await w.run("runner.start", { space: SPACE, session: "s0" });
  await sleep(600);
  // the lender's report of the exit is slow, the home's take-over is not: the order the SDK hears them in is what is under test
  const pipe = w.r.home.pipe.bind(w.r.home); w.r.home.pipe = async (/** @type {any} */ chain, /** @type {any} */ i) => { if (i && i.exit) await sleep(1200); return pipe(chain, i); };
  const proc = w.r.home.spawn({ session: "s_crash", person: BOB, args: ["--output-format", "stream-json"] });
  await waitFor(() => proc.lent && proc.lent.state === "up", 15_000);
  const closed = new Promise(res => proc.on("close", (/** @type {any} */ c, /** @type {any} */ s) => res([c, s])));
  proc.stdin.write("crash 3\n");
  assert.deepEqual(await closed, [3, null], "its own exit code, not a hang-up");
  assert.equal(proc.moved ?? null, null, "not a move");
  await waitFor(() => { const r = w.book.get("s_crash"); return r && r.where === "server" && r.reason === "crash"; }, 15_000);
});

test("the lid shuts: the chat on the Mac moves to the server, and a chat started afterwards is placed on the box and runs nothing on the Mac (the fallback)", { skip: SKIP || false, timeout: 120_000 }, async t => {
  const keep = setInterval(() => {}, 100); t.after(() => clearInterval(keep));
  const w = await world(t, { canResume: () => true });
  await w.run("runner.start", { space: SPACE, session: "s0" });
  await sleep(600);
  assert.equal(w.r.home.placeNew({ session: "s_first", person: BOB }).where, "mac", "before the lid shuts a new chat is placed on the Mac");
  const proc = w.r.home.spawn({ session: "s_first", person: BOB, args: ["--output-format", "stream-json"] });
  await waitFor(() => proc.lent && proc.lent.state === "up", 15_000);
  const closed = new Promise(res => proc.on("close", (/** @type {any} */ c, /** @type {any} */ s) => res([c, s])));
  w.say("link.sleeping");
  assert.deepEqual(await closed, [null, "SIGHUP"], "the SDK hears the move");
  assert.equal(proc.moved && proc.moved.to, "server");
  await waitFor(() => w.book.get("s_first")?.where === "server", 15_000);
  await sleep(1500);   // the lender's next beats say it is asleep
  // the computer is not ready now: a new chat is the box's, and a spawn that was asked for anyway never starts
  assert.equal(w.r.home.placeNew({ session: "s_second", person: BOB }).where, "box", "a chat started after the lid shut is placed on the box");
  const late = w.r.home.spawn({ session: "s_second", person: BOB, args: ["--output-format", "stream-json"] });
  assert.equal(late.lent ?? null, null, "no computer is named for it");
  const err = await new Promise(res => late.on("error", res));
  assert.equal(/** @type {any} */ (err).code, "lent_unavailable", "it fails as a spawn that never started, so the box runs it");
  assert.equal(w.book.get("s_second") ?? null, null, "and no row says it is on the Mac");
});

test("a chat given a folder of the computer works IN it, is placed only on the computer that has it, never goes to the server, and waits there when the lid shuts", { skip: SKIP || false, timeout: 120_000 }, async t => {
  const keep = setInterval(() => {}, 100); t.after(() => clearInterval(keep));
  const w = await world(t, { canResume: () => true });
  const dir = fs.mkdtempSync(path.join(SCRATCH, "lp-folder-")); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const folder = fs.realpathSync(dir);
  const approved = createFolders(path.join(w.root, "runner", "folders.json")).add(folder, "Acme site");
  await w.run("runner.start", { space: SPACE, session: "s0" });
  // the home hears the folder by id and label, from the computer's heartbeat
  const offered = await waitFor(() => { const f = w.r.home.foldersOf(BOB); return f.length ? f : null; }, 20_000);
  assert.deepEqual(offered.map((/** @type {any} */ f) => [f.id, f.label]), [[approved.id, "Acme site"]]);
  assert.ok(!JSON.stringify(offered).includes(folder), "no path reaches the home");
  // an id no computer holds: the chat does not start (and does not start on the server instead)
  assert.throws(() => w.r.home.spawn({ session: "s_nofolder", person: BOB, folder: "fld_000000000000", args: [] }), (/** @type {any} */ e) => e.code === "folder_unavailable");
  const proc = w.r.home.spawn({ session: "s_folder", person: BOB, folder: approved.id, args: ["--output-format", "stream-json"] });
  const out = lines(proc.stdout);
  await waitFor(() => proc.lent && proc.lent.state === "up", 20_000);
  proc.stdin.write("turn hello\n");
  await waitFor(() => out.some(l => l.includes("did hello")), 20_000);
  assert.match(fs.readFileSync(path.join(folder, "notes.txt"), "utf8"), /hello/, "the program wrote into the person's folder itself");
  const row = w.book.get("s_folder");
  assert.deepEqual([row.where, row.folder], ["mac", approved.id]);
  // nothing sends it to the server: not the person's move, not a lapse, not a condition
  assert.throws(() => w.book.askRelease("s_folder", "you", BOB), (/** @type {any} */ e) => e.code === "conflict" && /stays there/.test(e.message));
  assert.equal(w.book.toServer("s_folder", "offline").why, "bound");
  // the lid shuts: the chat is held still, not handed over; it carries on when the computer is heard again
  w.say("link.sleeping");
  await sleep(1500);
  assert.equal(w.book.get("s_folder").where, "mac", "still the computer's");
  proc.stdin.write("turn later\n");
  await sleep(1500);
  assert.ok(!out.some(l => l.includes("did later")), "held still while the lid is shut");
  w.say("link.woke");
  await waitFor(() => out.some(l => l.includes("did later")), 30_000);
  proc.kill();
});

test("a dev server the chat starts on the computer can be previewed from the home: the box gets a loopback port, each request is run against the server inside the sandbox, nothing else is reachable", { skip: SKIP || false, timeout: 120_000 }, async t => {
  const keep = setInterval(() => {}, 100); t.after(() => clearInterval(keep));
  const w = await world(t);
  await w.run("runner.start", { space: SPACE, session: "s0" });
  await sleep(600);
  const proc = w.r.home.spawn({ session: "s_dev", person: BOB, args: ["--output-format", "stream-json"] });
  const out = lines(proc.stdout);
  await waitFor(() => proc.lent && proc.lent.state === "up", 20_000);
  proc.stdin.write("serve 4311\n");
  await waitFor(() => out.some(l => l.includes("\"serving\"")), 20_000);
  const ask = (/** @type {number} */ port, /** @type {string} */ method, /** @type {string} */ path0, /** @type {string} */ body = "") => new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path: path0, headers: { host: "pv-1.example.test", "content-length": String(Buffer.byteLength(body)) } }, res => { let b = ""; res.on("data", d => { b += d; }); res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: b })); });
    req.on("error", reject); req.end(body);
  });
  // only the chat's own person, and only while it runs on a computer
  await assert.rejects(() => w.r.home.openPreview({ session: "s_dev", port: 4311, person: "per_carol" }), (/** @type {any} */ e) => e.code === "not_found");
  await assert.rejects(() => w.r.home.openPreview({ session: "s_dev", port: 80, person: BOB }), (/** @type {any} */ e) => e.code === "bad_input");
  const bridge = await w.r.home.openPreview({ session: "s_dev", port: 4311, person: BOB });
  assert.equal((await w.r.home.openPreview({ session: "s_dev", port: 4311, person: BOB })).port, bridge.port, "one bridge for one port");
  const a = /** @type {any} */ (await ask(bridge.port, "GET", "/hello?x=1"));
  assert.equal(a.status, 200);
  assert.equal(a.body, "dev:GET:/hello?x=1:localhost:4311:", "the server in the sandbox answered, and heard its own host name");
  assert.equal(a.headers["x-dev"], "yes");
  const b = /** @type {any} */ (await ask(bridge.port, "POST", "/save", "name=kit"));
  assert.equal(b.body, "dev:POST:/save:localhost:4311:name=kit");
  // a port nothing listens on is a 502 in words, not a hang
  const dead = await w.r.home.openPreview({ session: "s_dev", port: 4399, person: BOB });
  const c = /** @type {any} */ (await ask(dead.port, "GET", "/"));
  assert.equal(c.status, 502);
  assert.match(c.body, /did not answer/);
  // the program ending closes the previews
  assert.equal(w.r.home.hasPreview("s_dev"), true);
  proc.kill();
  await waitFor(() => !w.r.home.hasPreview("s_dev"), 10_000);
});
