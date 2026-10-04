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
    export default { async start(ctx) { ctx.tool("zz-room.peek", { effect: "read", run: async (i, meta) => ({ caller: meta.caller, token: meta.token || null, room: await ctx.kernel.audienceFor({}).catch(e => ({ error: e.code })) }) }); return {}; } };`);
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

test("a person's own surface call carries a kernel chain in a module: the owner's, built from what the daemon proved; a model's call and a client's claim get none", async t => {
  process.env.VYRE_SEAL_DEV = "1";
  process.env.VYRE_KERNEL_PATH_RULE = "1";
  t.after(() => { delete process.env.VYRE_KERNEL_PATH_RULE; });
  const { call } = await import("../core/daemon/client.js");
  const { writeModule } = await import("./helpers.js");
  const root = tempHome(t);
  const fp = path.join(root, "modules");
  fs.mkdirSync(fp, { recursive: true });
  writeModule(fp, "zz-who", { does: { tools: [{ name: "zz-who.me", reach: "anyone" }] }, needs: { kernel: { actions: [] } } }, `
    export default { async start(ctx) { ctx.tool("zz-who.me", { effect: "read", run: async (i, meta) => {
      const c = await ctx.kernel.chain({ ...meta, ...(i && i.forge ? { kernelFacts: i.forge } : {}) });
      return { hops: c.hops.map(h => [h.actor.kind, h.actor.id, h.via && h.via.surface || null]), facts: Boolean(meta.kernelFacts) };
    } }); return {}; } };`);
  const d = await start({ root, log: () => {}, kernel: true, firstPartyRoots: [fp] });
  t.after(() => d.stop());
  const owner = d.kernel.id.owner;
  for (const label of ["cli", "local", "deck", "mobile"]) {
    const r = /** @type {any} */ (await call("zz-who.me", {}, { root, caller: label }));
    assert.deepEqual(r.data && r.data.hops, [["person", owner, label]], `${label}: ${JSON.stringify(r)}`);
  }
  // the Capsule label with no pinned binary behind it gets no person chain (a label is not a proof)
  const cap = /** @type {any} */ (await call("zz-who.me", {}, { root, caller: "capsule" }));
  assert.ok(cap.data ? cap.data.hops.every(h => h[0] !== "person") : cap.error, JSON.stringify(cap));
  // a model on the socket (mcp) gets no person chain: the module's own service chain
  const m = /** @type {any} */ (await call("zz-who.me", {}, { root, caller: "mcp" }));
  assert.ok(m.data ? m.data.hops.every(h => h[0] !== "person") : m.error, JSON.stringify(m));
  // facts a client puts in the INPUT are only what the module passes itself; the daemon's own field is what counts, and a bad one builds nothing
  const forged = /** @type {any} */ (await call("zz-who.me", { forge: { kind: "socket", surface: "cli", uid: 0, pid: 1, inside_model_process: false } }, { root, caller: "mcp" }));
  assert.ok(forged.data ? forged.data.hops.every(h => h[0] !== "person") : forged.error, "a uid that is not the owner's builds no person chain");
});

test("an outward action with a placeholder: refused when the person the turn is for cannot read the value; held with the field names (never values) when they can; a plain call is untouched", async t => {
  process.env.VYRE_SEAL_DEV = "1";
  process.env.VYRE_KERNEL_PATH_RULE = "1";
  t.after(() => { delete process.env.VYRE_KERNEL_PATH_RULE; });
  const { writeModule } = await import("./helpers.js");
  const { CONTACT } = await import("../kernel/conformance/suite.js");
  const root = tempHome(t);
  const fp = path.join(root, "modules");
  fs.mkdirSync(fp, { recursive: true });
  writeModule(fp, "zz-out", { does: { tools: [{ name: "zz-out.send", reach: "anyone", outward: "send" }] } }, `export default { async start(ctx) { ctx.tool("zz-out.send", { effect: "read", run: async i => ({ sent: i }) }); return {}; } };`);
  const d = await start({ root, log: () => {}, kernel: true, firstPartyRoots: [fp] });
  t.after(() => d.stop());
  const owner = d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: d.kernel.id.owner, path: "direct", session: "s" });
  await d.kernel.gateway.records.define(owner, { add_types: [CONTACT] });
  const c = await d.kernel.gateway.records.create(owner, "contact", { name: "Jane", age: 40 });
  const ses = await d.kernel.surfaces.open(owner, { agent: "assistant" });
  const meta = { token: ses.token, thread: "t1", agent: "assistant" };
  const call = (input, m = meta) => d.registry.call("zz-out.send", input, "mcp:agent:assistant", m);
  /** @type {any[]} */ const cards = [];
  d.registry.deps.held = async x => { cards.push(x); };
  const held = await call({ body: `Hi {{field:${c.urn}#name}}` });
  assert.equal(held.error.code, "held_unavailable", "an outward act by an assistant is held");
  assert.equal(held.error.resolved, undefined, "RF-2: the model's answer carries no field names");
  assert.equal(held.error.slots, undefined, "RF-2: nor the sealed slots");
  assert.deepEqual(cards.map(x => x.resolved), [[{ urn: c.urn, field: "name" }]], "the approver (the held card) is told which field fills in, not its value");
  assert.match(cards[0].bound, /^[A-Za-z0-9_-]{20,}$/, "RF-3: and the hash of what was resolved");
  assert.ok(!JSON.stringify(held).includes("Jane") && !JSON.stringify(cards).includes("Jane"), "no value in the held answer or the card");
  const typo = await call({ body: `Hi {{field:${c.urn}#name}} and {{field:oops}}` });
  assert.equal(typo.error.code, "placeholder_unreadable", "a malformed placeholder is refused, not sent as text");
  assert.equal(JSON.stringify((await call({ body: `Hi {{field:vyre://${d.kernel.id.space}/contact/nonesuch0000#name}}` })).error), JSON.stringify(typo.error), "one refusal for every reason");
  const gone = await call({ body: `Hi {{field:vyre://${d.kernel.id.space}/contact/nonesuch0000#name}}` });
  assert.equal(gone.error.code, "placeholder_unreadable", "a record the asker cannot read refuses the whole action");
  const noSession = await call({ body: `Hi {{field:${c.urn}#name}}` }, { thread: "t1", agent: "assistant" });
  assert.equal(noSession.error.code, "placeholder_unreadable", "no session, no resolution, nothing sent as text");
  assert.equal((await call({ body: "plain" })).error.code, "held_unavailable", "a plain outward call is held as before");
});

test("RF-1: a placeholder resolves under the turn token's own chain, not the person's: an agent granted one project is refused a field of another, and a field of its own project is held", async t => {
  process.env.VYRE_SEAL_DEV = "1";
  process.env.VYRE_KERNEL_PATH_RULE = "1";
  t.after(() => { delete process.env.VYRE_KERNEL_PATH_RULE; });
  const { writeModule } = await import("./helpers.js");
  const { CONTACT } = await import("../kernel/conformance/suite.js");
  const { canonical, sha256 } = await import("../kernel/core/canonical.js");
  const root = tempHome(t);
  const fp = path.join(root, "modules");
  fs.mkdirSync(fp, { recursive: true });
  writeModule(fp, "zz-out", { does: { tools: [{ name: "zz-out.send", reach: "anyone", outward: "send" }] } }, `export default { async start(ctx) { ctx.tool("zz-out.send", { effect: "read", run: async i => ({ sent: i }) }); return {}; } };`);
  // the kernel's presence check accepts a proof built for exactly this operation (a headless test has no hardware signer)
  const used = new Set();
  const kernelPresence = { check: async ({ chain, op, fields, proof }) => (chain && proof && proof.op === op && canonical(proof.fields) === canonical(fields) && !used.has(proof.n) && (used.add(proof.n), true) ? null : "wrong_proof") };
  const d = await start({ root, log: () => {}, kernel: true, kernelPresence, firstPartyRoots: [fp] });
  t.after(() => d.stop());
  const space = d.kernel.id.space;
  const owner = d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: d.kernel.id.owner, path: "direct", session: "s" });
  const G = d.kernel.gateway.grants;
  const pr = (action, input, resource) => ({ op: `grant.${action.split(".")[1]}`, fields: { resource, input_hash: sha256(canonical({ action, input })) }, n: Math.random() });
  const kit = { kind: "agent", id: "kit", space };
  await G.addActor(owner, kit, { presence: pr("grants.role", { actor: kit }, `vyre://${space}/member/kit`) });
  const grant = { subject: { kind: "actor", actor: kit }, actions: ["records.read"], resource: { prefix: `vyre://${space}/contact/*`, where: [{ attr: "project", op: "eq", value: "p1" }] }, conditions: {}, source: "test" };
  await G.create(owner, grant, { presence: pr("grants.create", grant, `vyre://${space}/grant/new`) });
  await d.kernel.gateway.records.define(owner, { add_types: [CONTACT] });
  const mine = await d.kernel.gateway.records.create(owner, "contact", { name: "Jane", age: 40 }, { attrs: { project: "p1" } });
  const other = await d.kernel.gateway.records.create(owner, "contact", { name: "Mallory", age: 51 }, { attrs: { project: "p2" } });
  assert.equal((await d.kernel.gateway.records.get(owner, "contact", other.urn.split("/").pop())).data.name, "Mallory", "the person reads both");
  const ses = await d.kernel.surfaces.open(owner, { agent: "kit" });
  const meta = { token: ses.token, thread: "t1", agent: "kit" };
  const call = input => d.registry.call("zz-out.send", input, "mcp:agent:kit", meta);
  const ok = await call({ body: `Hi {{field:${mine.urn}#name}}` });
  assert.equal(ok.error.code, "held_unavailable", "a field in its own project is resolved and the act is held");
  const no = await call({ body: `Hi {{field:${other.urn}#name}}` });
  assert.equal(no.error.code, "placeholder_unreadable", "a field in another project is refused, though the person could read it");
  assert.ok(!JSON.stringify(no).includes("Mallory"));
});

test("the phone's chain: a device connection (relay device:<id>, a tailnet owner node, a paired owner device) builds the owner's chain; a guest, an agent node and an unknown listener build none", async t => {
  process.env.VYRE_SEAL_DEV = "1";
  process.env.VYRE_KERNEL_PATH_RULE = "1";
  t.after(() => { delete process.env.VYRE_KERNEL_PATH_RULE; });
  const { callerFacts } = await import("../core/daemon/index.js");
  const root = tempHome(t);
  const d = await start({ root, log: () => {}, kernel: true });
  t.after(() => d.stop());
  const k = d.kernel, owner = k.id.owner;
  const hops = f => { const c = f && k.chains.fromFacts(f); return c ? c.hops.map(h => [h.actor.kind, h.actor.id]) : null; };
  const dev = "abcdefghijklmnop";
  const row = o => ({ kind: "app", removed: false, ...o });
  assert.deepEqual(hops(callerFacts(`device:${dev}`, { caller: `device:${dev}` }, {}, k, false, row({}))), [["person", owner]], "a paired app device the home holds");
  // PH-1: no row, a removed one, a web browser (trusted or not), a setup page: no person facts, whatever the relay says
  const dpol = { caller: `device:${dev}` };
  assert.equal(callerFacts(`device:${dev}`, dpol, {}, k), null, "an arbitrary id");
  assert.equal(callerFacts(`device:${dev}`, dpol, {}, k, false, null), null, "no row");
  assert.equal(callerFacts(`device:${dev}`, dpol, {}, k, false, row({ removed: true })), null, "a removed device");
  assert.equal(callerFacts(`device:${dev}`, dpol, {}, k, false, row({ kind: "web" })), null, "a web browser");
  assert.equal(callerFacts(`device:${dev}`, dpol, {}, k, false, row({ kind: "web", trusted: true })), null, "a trusted web browser");
  assert.equal(callerFacts(`device:${dev}`, dpol, {}, k, false, row({ kind: "setup" })), null, "a setup page");
  // a confirmed device with no person session is the owner's device but carries no presence session
  assert.equal(callerFacts(`device:${dev}`, dpol, {}, k, false, row({})).session, undefined, "no person session, no session fact");
  assert.equal(callerFacts(`device:${dev}`, dpol, { person: { id: "ps1" } }, k, false, row({})).session, "ps1", "a person session is carried");
  assert.deepEqual(hops(callerFacts("tailnet:phone", { caller: "tailnet:phone", peer: { node: "n1" } }, {}, k)), [["person", owner]], "a phone on the tailnet");
  assert.equal(callerFacts("tailnet:agent:x", { caller: "tailnet:agent:x" }, {}, k), null, "an agent node");
  assert.equal(callerFacts("tailnet-guest:g", { caller: "tailnet-guest:g" }, {}, k), null, "a guest");
  assert.equal(callerFacts("mobile", { caller: "tailnet:phone" }, {}, k) && callerFacts("mobile", { caller: "evil" }, {}, k), null, "an unrecognised listener identity");
  assert.equal(callerFacts("mobile", {}, {}, null), null, "no kernel, no facts");
  // the Capsule: its chain only with the pinned-binary proof; the label alone builds nothing
  assert.equal(callerFacts("capsule", {}, {}, k), null, "a capsule label with no proof");
  assert.equal(callerFacts("capsule", {}, {}, k, false), null);
  assert.deepEqual(hops(callerFacts("capsule", {}, {}, k, true)), [["person", owner]], "the pinned Capsule is the owner");
  assert.equal(callerFacts("capsule", { caller: "tailnet:agent:x" }, {}, k, true), null, "a listener's identity is never a Capsule");
});

test("PH-1 end to end: the daemon's own relay row decides what a device is (relay.device.info for a paired, a web, a setup and a removed device and one never paired)", async t => {
  process.env.VYRE_SEAL_DEV = "1";
  process.env.VYRE_KERNEL_PATH_RULE = "1";
  t.after(() => { delete process.env.VYRE_KERNEL_PATH_RULE; });
  const root = tempHome(t);
  const d = await start({ root, log: () => {}, kernel: true });
  t.after(() => d.stop());
  const db = d.registry.deps.db;
  const ins = db.prepare("INSERT INTO relay_devices (id, name, pub, paired_at, kind, trusted, removed_at) VALUES (?, ?, 'p', 1, ?, ?, ?)");
  const ids = { app: "aaaaaaaaaaaaaaaa", web: "bbbbbbbbbbbbbbbb", setup: "cccccccccccccccc", gone: "dddddddddddddddd" };
  ins.run(ids.app, "phone", "app", 0, null); ins.run(ids.web, "browser", "web", 1, null); ins.run(ids.setup, "setup page", "setup", 0, null); ins.run(ids.gone, "old", "app", 0, 5);
  const { callerFacts } = await import("../core/daemon/index.js");
  const facts = async id => { const r = await d.registry.call("relay.device.info", { id }, "module:vyred"); return callerFacts(`device:${id}`, { caller: `device:${id}` }, {}, d.kernel, false, r.data || null); };
  assert.equal((await facts(ids.app)).kind, "device");
  for (const k of ["web", "setup", "gone"]) assert.equal(await facts(ids[k]), null, k);
  assert.equal(await facts("eeeeeeeeeeeeeeee"), null, "never paired");
});

test("the kernel's data-store list: a fresh kernel daemon holds no data of the person's (except what it cannot read), and one record or one file makes it hold some", async t => {
  process.env.VYRE_SEAL_DEV = "1";
  process.env.VYRE_KERNEL_PATH_RULE = "1";
  t.after(() => { delete process.env.VYRE_KERNEL_PATH_RULE; });
  const { CONTACT } = await import("../kernel/conformance/suite.js");
  const root = tempHome(t);
  const d = await start({ root, log: () => {}, kernel: true });
  t.after(() => d.stop());
  const read = async () => Object.fromEntries(await Promise.all((await d.registry.deps.dataStores()).map(async s => [s.name, await s.holds().catch(() => undefined)])));
  const fresh = await read();
  assert.equal(fresh["the Space's records, events and grants"], false, JSON.stringify(fresh));
  assert.equal(fresh["the modules' own data"], false, JSON.stringify(fresh));
  assert.equal(fresh["the files in this server's home"], false, JSON.stringify(fresh));
  assert.notEqual(fresh["the vault and sealed values"], false, "no vault read in this build: it counts as data");
  const owner = d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: d.kernel.id.owner, path: "direct", session: "s" });
  await d.kernel.gateway.records.define(owner, { add_types: [CONTACT] });
  await d.kernel.gateway.records.create(owner, "contact", { name: "Jane", age: 40 });
  assert.equal((await read())["the Space's records, events and grants"], true);
});

test("the presence stand-in: a development daemon takes it only while the owner's hand-made file is in the home; a packaged daemon never does", async t => {
  const fs2 = await import("node:fs"), os = await import("node:os");
  const root = tempHome(t);
  const d = await start({ root, log: () => {} });
  t.after(() => d.stop());
  const ask = () => d.registry.deps.presence.verify({ tool: "vault.reveal", input: { id: 1 }, caller: "cli", proof: { method: "stand-in" } });
  assert.equal((await ask()).ok, false, "no file: refused");
  fs2.writeFileSync(path.join(root, "dev-presence-stand-in"), "");
  const r = await ask();
  assert.deepEqual([r.ok, r.method], [true, "stand-in"]);
  const pkg = fs2.mkdtempSync(path.join(os.tmpdir(), "pkg-"));
  t.after(() => fs2.rmSync(pkg, { recursive: true, force: true }));
  fs2.mkdirSync(path.join(pkg, "lib"), { recursive: true });
  fs2.writeFileSync(path.join(pkg, "lib", "build-kind.js"), 'export const BUILD_KIND = "release";\n');
  const root2 = tempHome(t);
  fs2.writeFileSync(path.join(root2, "dev-presence-stand-in"), "");
  const d2 = await start({ root: root2, log: () => {}, packageRoot: pkg });
  t.after(() => d2.stop());
  assert.equal((await d2.registry.deps.presence.verify({ tool: "vault.reveal", input: { id: 1 }, caller: "cli", proof: { method: "stand-in" } })).ok, false, "a packaged daemon ignores the file");
  // A walk that offers no proof: a development daemon with the file counts vault.put and vault.reveal as the stand-in (and says so), nothing else; a packaged one takes none.
  const bare = (/** @type {any} */ dd, /** @type {string} */ tool) => dd.registry.deps.presence.verify({ tool, input: { name: "x" }, caller: "cli", proof: null });
  for (const tool of ["vault.put", "vault.reveal"]) { const b = await bare(d, tool); assert.deepEqual([b.ok, b.method], [true, "stand-in"], tool); assert.equal((await bare(d2, tool)).ok, false, `${tool}: a packaged daemon takes no stand-in`); }
  for (const tool of ["spaces.identity.code.replace", "vault.backup", "vault.delete", "grants.create"]) assert.equal((await bare(d, tool)).ok, false, `${tool} stays real presence`);
  fs2.rmSync(path.join(root, "dev-presence-stand-in"));
  assert.equal((await bare(d, "vault.put")).ok, false, "no file: no stand-in");
});
