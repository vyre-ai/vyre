// @ts-check
// vyred's side of an agent's folder: one ticket per operation, the bytes over the relay, the answer back with a cap. A local stand-in for the relay serves each connection with the real helper
// (image/agentd-fs.js) on a temp home, so this is the wire the computer speaks. And the tool: only the files module may call computers.agent.files, and a server with no agent computers says so.

import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { PassThrough } from "node:stream";
import { makeAgentFiles, READ_MAX } from "./agent-files.js";
import { serveFs } from "./image/agentd-fs.js";
import { validateFs } from "./image/agentd.js";
import { start } from "../daemon/index.js";
import { tempHome, present } from "../../test/helpers.js";
import { FakeDriver } from "./driver/fake.js";
import { SCRATCH } from "../../test/scratch.mjs";

/** agentd holds the operation only when it passes validateFs; a refusal comes back the way agentd-ctl.js words it. @param {any} spec */
const held = spec => { try { return validateFs(spec); } catch (e) { throw new Error(`the agent computer could not ticket (400: ${/** @type {Error} */ (e).message})`); } };

/** A relay stand-in: a ticket names an agent and its checked operation; the connection is served by the helper on that agent's own home. */
async function relay(t) {
  const top = fs.mkdtempSync(path.join(SCRATCH, "agent-files-"));
  t.after(() => fs.rmSync(top, { recursive: true, force: true }));
  const homeOf = (/** @type {string} */ agent) => { const h = path.join(top, agent); fs.mkdirSync(path.join(h, "Inbox"), { recursive: true }); return h; };
  /** @type {Map<string, { agent: string, spec: any }>} */ const tickets = new Map();
  const server = net.createServer(sock => {
    let buf = Buffer.alloc(0);
    const onData = (/** @type {Buffer} */ c) => {
      buf = Buffer.concat([buf, c]); const nl = buf.indexOf(10); if (nl < 0) return;
      sock.off("data", onData); sock.pause();
      const got = tickets.get(buf.subarray(0, nl).toString()); tickets.delete(buf.subarray(0, nl).toString());
      if (!got) return void sock.destroy();
      // the relay writes the operation as the helper's first line, then what the caller sent after its ticket
      const input = new PassThrough();
      input.write(JSON.stringify(got.spec) + "\n"); input.write(buf.subarray(nl + 1)); sock.pipe(input);
      serveFs({ root: homeOf(got.agent), input, output: sock }).then(() => sock.end(), () => sock.destroy());
    };
    sock.on("data", onData); sock.on("error", () => {});
  });
  await new Promise(r => server.listen(0, "127.0.0.1", () => r(undefined)));
  t.after(() => new Promise(r => server.close(() => r(undefined))));
  const port = /** @type {any} */ (server.address()).port;
  const files = makeAgentFiles({ ready: async () => {}, ticket: async (agent, hello, spec) => { tickets.set(hello, { agent, spec: held(spec) }); }, where: async () => ({ host: "127.0.0.1", port }) });
  return { files, homeOf, tickets };
}

test("write, list, read, mkdir, move and trash travel over the relay to the agent's home and back", async t => {
  const r = await relay(t);
  const home = r.homeOf("ada");
  assert.deepEqual(await r.files.write("ada", "Inbox/hello.txt", Buffer.from("hi there")), { size: 8 });
  assert.equal(fs.readFileSync(path.join(home, "Inbox", "hello.txt"), "utf8"), "hi there");
  const list = await r.files.list("ada", "Inbox");
  assert.deepEqual(list.entries.map((/** @type {any} */ e) => [e.name, e.kind, e.size]), [["hello.txt", "file", 8]]);
  assert.equal((await r.files.read("ada", "Inbox/hello.txt")).toString(), "hi there");
  await r.files.mkdir("ada", "Inbox/later");
  await r.files.move("ada", "Inbox/hello.txt", "Inbox/later/hello.txt");
  assert.ok(fs.existsSync(path.join(home, "Inbox", "later", "hello.txt")));
  await r.files.trash("ada", "Inbox/later/hello.txt");
  assert.ok(!fs.existsSync(path.join(home, "Inbox", "later", "hello.txt")));
  await assert.rejects(r.files.write("ada", "Inbox/later", Buffer.from("x")), (/** @type {any} */ e) => e.code === "conflict", "an existing name is a conflict, never overwritten");
  await assert.rejects(r.files.read("ada", "../bea/Inbox/x"), (/** @type {any} */ e) => e.code === "bad_input", "a path out of the home is refused before it is held");
  await assert.rejects(r.files.read("ada", "Inbox/none.txt"), (/** @type {any} */ e) => e.code === "not_found");
  assert.equal(r.tickets.size, 0, "every ticket was spent once");
});

test("a read is capped: a file over the cap is refused as too large, never cut", async t => {
  const r = await relay(t);
  fs.writeFileSync(path.join(r.homeOf("ada"), "Inbox", "big.bin"), Buffer.alloc(2048, 7));
  assert.equal((await r.files.read("ada", "Inbox/big.bin", { max: 4096 })).length, 2048);
  await assert.rejects(r.files.read("ada", "Inbox/big.bin", { max: 1024 }), (/** @type {any} */ e) => e.code === "too_large");
  assert.ok(READ_MAX >= 8 * 1024 * 1024);
});

test("one agent's operations reach only its own home", async t => {
  const r = await relay(t);
  await r.files.write("ada", "Inbox/mine.txt", Buffer.from("ada's"));
  r.homeOf("bea");
  await assert.rejects(r.files.read("bea", "Inbox/mine.txt"), (/** @type {any} */ e) => e.code === "not_found", "bea's operation is served on bea's home");
});

test("computers.agent.files: only the files module may call it, and a server with no agent computers says so plainly", async t => {
  const root = tempHome(t);
  t.after(() => FakeDriver.forget(root));
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ role: "box", computers: { driver: "fake", sweepMs: 0, waitMs: 100, browse: "desktop" } }));
  const d = await start({ presence: present, root, log: () => {} });
  t.after(() => d.stop());
  const asFiles = await d.registry.call("computers.agent.files", { agent: "kit", op: "list", path: "" }, "module:files");
  assert.equal(asFiles.error && asFiles.error.code, "unavailable");
  assert.match(asFiles.error.message, /Agent computers are not set up on this server/);
  const other = await d.registry.call("computers.agent.files", { agent: "kit", op: "list", path: "" }, "module:hands-chrome");
  assert.equal(other.error && other.error.code, "denied", "another module is refused");
  const person = await d.registry.call("computers.agent.files", { agent: "kit", op: "list", path: "" }, "cli");
  assert.ok(person.error, "a person's surface cannot reach it directly: Files checks the person first");
  const agent = await d.registry.call("computers.agent.files", { agent: "kit", op: "list", path: "" }, "mcp:agent:pax");
  assert.ok(agent.error, "nor can an agent");
});
