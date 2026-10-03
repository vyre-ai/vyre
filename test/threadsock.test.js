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
  const ctx = d.registry.context({ name: "switchboard", version: "0.1.0", does: { tools: [] } });
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
  const ctx = d.registry.context({ name: "switchboard", version: "0.1.0", does: { tools: [] } });
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

test("threadsock: the session's own token rides every call from the listener, a client header never replaces it, and a revoked session's socket closes", async t => {
  const root = tempHome(t);
  const d = await start({ root, log: () => {} });
  t.after(() => d.stop());
  d.registry.tools.set("probe.token", { module: "system", description: "", input: { type: "object" }, internal: false, callers: null, hook: false, presence: false,
    run: async (_, meta) => ({ caller: meta.caller, token: meta.token || null }) });
  const dir = fs.mkdtempSync(path.join(SCRATCH, "ts-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const ctx = d.registry.context({ name: "switchboard", version: "0.1.0", does: { tools: [] } });
  /** @type {number[]} */ const inThread = [];
  let live = true;
  const sock = await openThreadSocket({ handler: ctx.handler, thread: "t1", agent: "kit", dir, token: "own.token", valid: async () => live, pids: async () => ({ pids: inThread }) });
  // the client says it is a CLI and sends another session's token: the caller is still kit's, the token is the session's own
  const a = client(sock.path, "probe.token", {}, { "x-vyre-caller": "cli", "x-vyre-kernel-session": "other.token" });
  inThread.push(a.pid);
  assert.deepEqual((await a.done).body.data, { caller: "cli:agent:kit", token: "own.token" });
  // revoked: the next call is refused and the socket file is gone
  live = false;
  const b = client(sock.path, "probe.token", {});
  inThread.push(b.pid);
  assert.equal((await b.done).status, 403);
  await new Promise(r => setTimeout(r, 100));
  assert.equal(fs.existsSync(sock.path), false, "the socket is removed once the session is revoked");
});
