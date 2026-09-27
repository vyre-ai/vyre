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
  assert.equal(fs.statSync(sock.path).mode & 0o777, 0o660);

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
