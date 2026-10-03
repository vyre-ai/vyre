// @ts-check
// One Vyre-owned session's socket (core/daemon/threadsock.js): the caller is vyred's to bind,
// only the session's own processes get in, and nothing person-only or human-only is reachable.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { start } from "../core/daemon/index.js";
import { openThreadSocket, belongs } from "../core/daemon/threadsock.js";
import { tempHome } from "./helpers.js";
const realManifest = JSON.parse(fs.readFileSync(new URL("../core/switchboard/module.json", import.meta.url), "utf8"));
import { SCRATCH } from "./scratch.mjs";

/** A client process that makes one call on the socket and prints the answer. */
function client(socket, tool, input, headers = {}) {
  const js = `import http from "node:http";
const data = JSON.stringify(${JSON.stringify(input)});
const req = http.request({ socketPath: ${JSON.stringify(socket)}, path: "/v1/tools/${tool}", method: "POST",
  headers: { "content-type": "application/json", "content-length": Buffer.byteLength(data), ...${JSON.stringify(headers)} } }, res => {
  let out = ""; res.on("data", c => (out += c)); res.on("end", () => { process.stdout.write(JSON.stringify({ status: res.statusCode, body: JSON.parse(out) })); });
});
req.end(data);`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", js], { stdio: ["ignore", "pipe", "inherit"] });
  let out = "";
  child.stdout.on("data", d => (out += d));
  return { pid: /** @type {number} */ (child.pid), done: new Promise(r => child.on("exit", () => r(JSON.parse(out || "{}")))) };
}

test("threadsock: the session's own processes, as the caller vyred bound, and never a person's tool", async t => {
  const root = tempHome(t);
  const d = await start({ root, log: () => {} });
  t.after(() => d.stop());
  // A tool that says who it saw: the caller and the thread and agent vyred vouched for.
  d.registry.tools.set("probe.whoami", { module: "system", description: "", input: { type: "object" }, internal: false, callers: null, hook: false, presence: false,
    run: async (_, meta) => ({ caller: meta.caller, thread: meta.thread || null, agent: meta.agent || null }) });
  const dir = fs.mkdtempSync(path.join(SCRATCH, "ts-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const ctx = d.registry.context(realManifest);
  /** @type {number[]} */ const inThread = [];
  const sock = await openThreadSocket({ handler: ctx.handler, thread: "t1", agent: "kit", dir, pids: async () => ({ pids: inThread }) });
  assert.equal(fs.statSync(sock.path).mode & 0o777, 0o600, "a private folder: the socket is the person's user alone");
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);

  // A process of the session: its call is kit's, whatever it claims to be.
  const a = client(sock.path, "probe.whoami", {}, { "x-vyre-caller": "cli" });
  inThread.push(a.pid);
  assert.deepEqual((await a.done).body.data, { caller: "mcp:agent:kit", thread: "t1", agent: "kit" });
  const h = client(sock.path, "probe.whoami", {}, { "x-vyre-caller": "harness" });
  inThread.push(h.pid);
  assert.equal((await h.done).body.data.caller, "harness:agent:kit");

  // Person-only and human-only tools are refused before anything else.
  for (const tool of ["threads.answer", "gate.approve", "vault.reveal", "presence.person.start", "agents.create"]) {
    const c = client(sock.path, tool, {});
    inThread.push(c.pid);
    const r = await c.done;
    assert.equal(r.status, 403, tool);
  }

  // A process outside the session is refused, even with the socket's name.
  const o = client(sock.path, "probe.whoami", {});
  assert.equal((await o.done).status, 403);

  await sock.close();
  assert.ok(!fs.existsSync(sock.path), "gone when the thread stops");
});

test("threadsock: belonging is the session's process, group, session or an ancestor", () => {
  const tree = { 10: { ppid: 1, pgid: 10, sid: 10, args: "tini" }, 11: { ppid: 10, pgid: 10, sid: 10, args: "claude" },
    12: { ppid: 1, pgid: 10, sid: 10, args: "orphan" }, 20: { ppid: 1, pgid: 20, sid: 20, args: "other" }, 21: { ppid: 20, pgid: 20, sid: 20, args: "x" } };
  const look = pid => tree[pid] || null;
  assert.ok(belongs(11, { pids: [10] }, look));
  assert.ok(belongs(12, { pids: [10], pgids: [10] }, look), "an orphan keeps the group");
  assert.ok(!belongs(21, { pids: [10], pgids: [10], sids: [10] }, look));
  assert.ok(!belongs(11, { pids: [] }, look));
});

test("threadsock: a session's call id reaches the tool; other callers' and malformed ids never do", async t => {
  const root = tempHome(t);
  const d = await start({ root, log: () => {} });
  t.after(() => d.stop());
  const tool = { module: "system", description: "", input: { type: "object" }, internal: false, callers: null, hook: false, presence: false };
  d.registry.tools.set("probe.call", { ...tool, run: async (_, meta) => ({ call: meta.call ?? null, thread: meta.thread || null }) });
  // A stand-in for the Switchboard's check of a session's key.
  d.registry.tools.set("threads.vouch", { ...tool, internal: true, run: async ({ session, key }) => (session === "s1" && key === "k1" ? { thread: "t9" } : {}) });
  const dir = fs.mkdtempSync(path.join(SCRATCH, "ts-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const ctx = d.registry.context(realManifest);
  /** @type {number[]} */ const inThread = [];
  const sock = await openThreadSocket({ handler: ctx.handler, thread: "t1", dir, pids: async () => ({ pids: inThread }) });
  t.after(() => sock.close());
  const on = async (/** @type {Record<string, string>} */ headers) => { const c = client(sock.path, "probe.call", {}, headers); inThread.push(c.pid); return (await c.done).body.data; };

  assert.deepEqual(await on({ "x-vyre-call-id": "toolu_01AbC-9" }), { call: "toolu_01AbC-9", thread: "t1" }, "the session's own socket");
  assert.deepEqual(await on({ "x-vyre-call-id": "not an id!" }), { call: null, thread: "t1" }, "malformed: dropped");
  assert.deepEqual(await on({ "x-vyre-call-id": "x".repeat(129) }), { call: null, thread: "t1" }, "too long: dropped");

  // vyred's own socket: with a session it vouched for, the id rides along; without one, never.
  const { request } = await import("../core/daemon/client.js");
  const bound = await request("POST", "/v1/tools/probe.call", {}, { root, caller: "mcp", session: { id: "s1", key: "k1" }, headers: { "x-vyre-call-id": "toolu_02" } });
  assert.deepEqual(bound.data, { call: "toolu_02", thread: "t9" });
  const cli = await request("POST", "/v1/tools/probe.call", {}, { root, caller: "cli", headers: { "x-vyre-call-id": "toolu_03" } });
  assert.deepEqual(cli.data, { call: null, thread: null }, "a caller with no thread never sets it");
});

test("threadsock: a real session's call arrives with its own kernel token, in its own chat; a header the client sends is dropped; no valid token refuses the call", async t => {
  process.env.VYRE_SEAL_DEV = "1";
  process.env.VYRE_KERNEL_PATH_RULE = "1";
  t.after(() => { delete process.env.VYRE_KERNEL_PATH_RULE; });
  const root = tempHome(t);
  const fp = path.join(root, "modules");
  fs.mkdirSync(fp, { recursive: true });
  const { writeModule } = await import("./helpers.js");
  writeModule(fp, "zz-room", { does: { tools: [{ name: "zz-room.peek", reach: "anyone" }] }, needs: { kernel: { actions: [] } } }, `
    export default { async start(ctx) { ctx.tool("zz-room.peek", { run: async (i, meta) => ({ caller: meta.caller, token: meta.token || null, room: await ctx.kernel.audienceFor({}).catch(e => ({ error: e.code })) }) }); return {}; } };`);
  const d = await start({ root, log: () => {}, kernel: true, firstPartyRoots: [fp] });
  t.after(() => d.stop());
  const ctx = d.registry.context(realManifest);
  assert.equal(typeof ctx.kernelSession, "function", "the Switchboard is handed the session credential maker");
  assert.equal(typeof d.registry.context({ name: "other", version: "0.1.0", does: { tools: [] } }).kernelSession, "undefined", "and nobody else");
  // the confined spawner for its sessions is composed here too, for the Switchboard alone
  const sbx = ctx.sandbox;
  assert.ok(sbx && typeof sbx.sandbox.planHome === "function" && typeof sbx.sandbox.selfTest === "function" && typeof sbx.sandbox.launch === "function", "the runner's home sandbox");
  assert.equal(typeof sbx.probes, "function");
  assert.equal(typeof d.registry.context({ name: "other", version: "0.1.0", does: { tools: [] } }).sandbox, "undefined");
  const owner = d.kernel.id.owner;
  const person = d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: owner, path: "direct" });
  const chat = await d.kernel.gateway.grants.chats.create(person, {});
  const dir = fs.mkdtempSync(path.join(SCRATCH, "ts-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  /** @type {number[]} */ const inThread = [];
  const ks = await ctx.kernelSession({ thread: "t1", agent: "kit", rec: { chat: chat.id } });
  const sock = await openThreadSocket({ handler: ctx.handler, thread: "t1", agent: "kit", dir, kernelToken: ks.token, pids: async () => ({ pids: inThread }) });
  t.after(() => sock.close());
  // the client claims to be a CLI and sends another token of its own: the caller is the session's agent, the token is the session's
  const a = client(sock.path, "zz-room.peek", {}, { "x-vyre-caller": "cli", "x-vyre-kernel-session": "forged.token" });
  inThread.push(a.pid);
  const got = (await a.done).body.data;
  assert.equal(got.caller, "mcp:agent:kit", "whatever the client claims, the listener names the agent");
  assert.match(got.token, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  assert.notEqual(got.token, "forged.token");
  assert.deepEqual(got.room, { group: false }, "the session's own chat, a chat of one person");
  // ended: the kernel stops honouring the token, the socket refuses and nothing is sent unstamped
  await ks.end();
  const b = client(sock.path, "zz-room.peek", {});
  inThread.push(b.pid);
  assert.equal((await b.done).status, 401);
});

test("R-1: on the person's own socket no thread or agent label proves anything; an assistant reaches the open tools only through its session's socket, and ask-first tools are held for it", async t => {
  const { call } = await import("../core/daemon/client.js");
  const root = tempHome(t);
  const d = await start({ root, log: () => {} });
  t.after(() => d.stop());
  // the label walk: whatever a client puts in its caller label, the person's socket gives it nothing it could not get as a plain model
  for (const label of ["mcp:thread:fake", "harness:thread:fake", "cli:thread:fake", "local:thread:fake", "deck:thread:fake", "mcp:agent:kit", "harness:agent:kit", "cli:agent:kit", "cli agent:kit", "mcp:thread:", "mcp"]) {
    const r = /** @type {any} */ (await call("mentions.kinds", {}, { root, caller: label }));
    assert.ok(!r.data, `${label} reached an open person tool: ${JSON.stringify(r).slice(0, 120)}`);
    for (const tool of ["files.send", "hooks.open", "bridges.kit.install", "agents.delete"]) { const k = /** @type {any} */ (await call(tool, {}, { root, caller: label })); assert.ok(!k.data, `${label} reached ask-first ${tool}`); }
  }
  // through a session's own socket the daemon bound the thread: open tools answer, ask-first tools are held, person-only tools are refused
  const dir = fs.mkdtempSync(path.join(SCRATCH, "ts-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const ctx = d.registry.context(realManifest);
  /** @type {number[]} */ const inThread = [];
  const sock = await openThreadSocket({ handler: ctx.handler, thread: "t1", agent: "kit", dir, pids: async () => ({ pids: inThread }) });
  t.after(() => sock.close());
  const open = client(sock.path, "mentions.kinds", {});
  inThread.push(open.pid);
  const o = await open.done;
  assert.equal(o.status, 200, JSON.stringify(o).slice(0, 200));
  const { ASK_FIRST } = await import("../core/modules/agent-reach.js");
  const { PERSON_ONLY, HUMAN_ONLY } = await import("../core/presence/index.js");
  const askTool = [...ASK_FIRST.keys()].find(n => !PERSON_ONLY.has(n) && !HUMAN_ONLY.has(n));
  assert.ok(askTool, "an ask-first tool the session socket itself does not refuse");
  const held = client(sock.path, askTool, {});
  inThread.push(held.pid);
  const h = await held.done;
  assert.equal(h.body && h.body.error && h.body.error.code, "held_unavailable", "an ask-first tool is held for a proven assistant, not run");
  const only = client(sock.path, "relay.pair.ticket", {});
  inThread.push(only.pid);
  assert.notEqual((await only.done).status, 200, "a person-only tool stays the person's");
});

test("a REAL daemon boot hands the Switchboard (the module named in its own manifest, `threads`) its kernel session maker and its sandbox by declaration, nobody else, and a missing sandbox is a refusal", async t => {
  process.env.VYRE_SEAL_DEV = "1";
  process.env.VYRE_KERNEL_PATH_RULE = "1";
  t.after(() => { delete process.env.VYRE_KERNEL_PATH_RULE; });
  const root = tempHome(t);
  const d = await start({ root, log: () => {}, kernel: true });
  t.after(() => d.stop());
  assert.equal(realManifest.name, "threads", "the real manifest name");
  assert.deepEqual(realManifest.needs.daemon, ["kernelSession", "sandbox", "credentials"], "it declares what it needs from the daemon");
  const row = d.registry.status().find(m => m.name === "threads");
  assert.equal(row && row.state, "running", JSON.stringify(row));
  const real = d.registry.context(realManifest);
  assert.equal(typeof real.kernelSession, "function");
  assert.equal(typeof real.sandbox.sandbox.selfTest, "function");
  // E-5: the probe targets are REAL, made for each self-test and torn down after it
  assert.equal(typeof real.sandbox.probes, "function");
  const probes = await real.sandbox.probes();
  const net = await import("node:net");
  const reach = (/** @type {any} */ o) => new Promise(r => { const c = net.connect(o); c.once("connect", () => { c.destroy(); r("connected"); }); c.once("error", () => r("refused")); });
  assert.equal(await reach({ path: probes.otherSocket }), "connected", "another session's socket stand-in is a real listening socket");
  assert.equal(await reach({ port: probes.daemonPorts[0], host: "127.0.0.1" }), "connected", "the loopback port is a real listener");
  await probes.release();
  assert.equal(await reach({ path: probes.otherSocket }), "refused", "torn down afterwards");
  assert.equal(await reach({ port: probes.daemonPorts[0], host: "127.0.0.1" }), "refused");
  // a module that does not declare it gets neither, whatever its name
  for (const name of ["switchboard", "other"]) { const c = d.registry.context({ name, version: "0.1.0", does: { tools: [] } }); assert.equal(c.kernelSession, undefined, name); assert.equal(c.sandbox, undefined, name); }
  // the Switchboard itself: with no sandbox dep and a session credential maker on macOS or Linux, a session is refused, not started unconfined
  const { Switchboard } = await import("../core/switchboard/index.js");
  const sb = Object.create(Switchboard.prototype);
  sb.deps = { kernelSession: async () => null, sandbox: null };
  sb.socks = new Map();
  if (process.platform !== "win32") await assert.rejects(() => sb.sandboxFor("t1", { cwd: root }, {}), { code: "sandbox_failed" });
  sb.deps = { sandbox: null };
  assert.equal(await sb.sandboxFor("t1", { cwd: root }, {}), undefined, "with the kernel off nothing changes");
  sb.deps = { kernelSession: async () => null, sandbox: { off: true } };
  assert.equal(await sb.sandboxFor("t1", { cwd: root }, {}), undefined, "a development opt-out is explicit");
});

test("helpers: `absent` presence stops a tool that declares presence, and leaves the rest alone", async t => {
  const { absent } = await import("./helpers.js");
  const root = tempHome(t);
  const d = await start({ root, log: () => {}, presence: absent });
  t.after(() => d.stop());
  // flows.approve declares presence: with no person present the call is refused and nothing is approved
  const r = await d.registry.call("flows.approve", { id: "fl_x", version: 1, hash: "h" }, "cli");
  assert.ok(r.error, JSON.stringify(r));
  assert.ok(["presence_required", "unavailable", "not_found", "denied"].includes(r.error.code), r.error.code);
  const ok = await d.registry.call("mentions.kinds", {}, "cli");
  assert.ok(ok.data, "a tool with no presence declared still runs");
});
