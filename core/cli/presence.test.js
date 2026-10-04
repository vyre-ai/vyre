// @ts-check
// The CLI's presence flow against a fake vyred on a unix socket in a temp home.

import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tempHome } from "../../test/helpers.js";
import * as config from "../config/index.js";
import { callAsPerson, NO_TERMINAL } from "./presence.js";

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "bin", "vyre");

/** A fake vyred: system.echo is plain, gate.approve needs presence, and the tty code is ABC123. */
async function fakeVyred(t, { methods = ["touchid", "tty"] } = {}) {
  const root = tempHome(t);
  const socket = config.paths(root).socket;
  if (path.dirname(socket) !== root) config.privateSocketDir();
  const seen = { calls: /** @type {{ tool: string, proof?: string }[]} */ ([]), challenges: /** @type {any[]} */ ([]) };
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", c => { raw += c; });
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : {};
      const send = (status, obj) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
      if (req.url === "/v1/presence/challenge") { seen.challenges.push(body); return send(200, { data: { challenge: "ch1" } }); }
      const tool = decodeURIComponent(String(req.url).replace("/v1/tools/", ""));
      const proof = /** @type {string|undefined} */ (req.headers["x-vyre-presence"]);
      seen.calls.push({ tool, proof });
      if (tool === "system.echo") return send(200, { data: body });
      if (tool === "system.fail") return send(400, { error: { code: "bad_input", message: "no" } });
      if (proof === "touchid" && methods.includes("touchid")) return send(200, { data: { approved: body.id, by: "touchid" } });
      if (proof === "tty id=ch1 code=ABC123") return send(200, { data: { approved: body.id, by: "tty" } });
      send(403, { error: { code: "presence_required", message: "a person must approve this", methods } });
    });
  });
  await new Promise(r => server.listen(socket, () => r(undefined)));
  t.after(() => new Promise(r => server.close(() => r(undefined))));
  return { root, seen };
}

/** A fake terminal that answers prompts from a list. */
function fakeIO(answers = [], { noTty = false } = {}) {
  const io = {
    printed: /** @type {string[]} */ ([]), prompts: 0, closed: false,
    openTty() { if (noTty) throw Object.assign(new Error("Device not configured"), { code: "ENXIO" }); return 99; },
    ttyName: () => "/dev/ttys042",
    prompt: async () => { io.prompts++; return answers.shift() ?? ""; },
    print(/** @type {string} */ s) { io.printed.push(s); },
    close() { io.closed = true; },
  };
  return io;
}

test("presence: a plain tool passes straight through, and other errors come back as they are", async t => {
  const { root, seen } = await fakeVyred(t);
  const io = fakeIO();
  assert.deepEqual(await callAsPerson("system.echo", { text: "hi" }, { root, io }), { data: { text: "hi" } });
  assert.deepEqual((await callAsPerson("system.fail", {}, { root, io })).error.code, "bad_input");
  assert.equal(seen.calls.length, 2);
  assert.equal(io.prompts, 0);
  assert.deepEqual(io.printed, []);
});

test("presence: presence_required, then touchid, then success", async t => {
  const { root, seen } = await fakeVyred(t);
  const io = fakeIO();
  const r = await callAsPerson("gate.approve", { id: 7 }, { root, io });
  assert.deepEqual(r, { data: { approved: 7, by: "touchid" } });
  assert.deepEqual(seen.calls.map(c => c.proof), [undefined, "touchid"]);
  assert.match(io.printed[0], /Confirm on this Mac \(Touch ID or password\)/);
  assert.equal(seen.challenges.length, 0);
});

test("presence: the tty flow with a correct code, and --tty skips touchid", async t => {
  const { root, seen } = await fakeVyred(t);
  const io = fakeIO(["ABC123\n"]);
  const r = await callAsPerson("gate.approve", { id: 7 }, { root, io, tty: true });
  assert.deepEqual(r, { data: { approved: 7, by: "tty" } });
  assert.deepEqual(seen.challenges, [{ tool: "gate.approve", input: { id: 7 }, method: "tty", tty: "/dev/ttys042" }]);
  assert.deepEqual(seen.calls.map(c => c.proof), [undefined, "tty id=ch1 code=ABC123"]);
  assert.ok(io.closed);
});

test("presence: a wrong code, then a right one, on the same challenge", async t => {
  const { root, seen } = await fakeVyred(t, { methods: ["tty"] });
  const io = fakeIO(["WRONG1", " ABC 123 "]);
  const r = await callAsPerson("gate.approve", { id: 7 }, { root, io });
  assert.deepEqual(r, { data: { approved: 7, by: "tty" } });
  assert.equal(seen.challenges.length, 1);
  assert.equal(io.prompts, 2);
  assert.match(io.printed.join("\n"), /did not match/);
});

test("presence: three wrong codes give up with presence_required", async t => {
  const { root, seen } = await fakeVyred(t, { methods: ["tty"] });
  const io = fakeIO(["a", "b", "c", "ABC123"]);
  const r = await callAsPerson("gate.approve", { id: 7 }, { root, io });
  assert.equal(r.error.code, "presence_required");
  assert.equal(io.prompts, 3);
  assert.equal(seen.challenges.length, 1);
});

test("presence: no terminal is refused without asking for a challenge", async t => {
  const { root, seen } = await fakeVyred(t, { methods: ["tty"] });
  const io = fakeIO([], { noTty: true });
  const r = await callAsPerson("gate.approve", { id: 7 }, { root, io });
  assert.equal(r.error.code, "no_terminal");
  assert.equal(r.error.message, NO_TERMINAL);
  assert.equal(seen.challenges.length, 0);
  assert.equal(io.prompts, 0);
});

test("presence: `vyre call` from a process with no controlling terminal is refused", async t => {
  const { root, seen } = await fakeVyred(t, { methods: ["tty"] });
  // detached puts the child in its own session, so it has no controlling terminal even when
  // these tests run from one. That is the model's Bash.
  const child = spawn(process.execPath, [BIN, "call", "gate.approve", '{"id":7}'], {
    detached: true, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, VYRE_HOME: root, NO_COLOR: "1" },
  });
  child.stdin.end("ABC123\n");
  let output = "";
  child.stdout.on("data", c => { output += c; });
  child.stderr.on("data", c => { output += c; });
  const code = await new Promise(r => child.on("close", r));
  assert.notEqual(code, 0);
  assert.match(output, /needs a person at a terminal/);
  assert.equal(seen.challenges.length, 0);
  assert.deepEqual(seen.calls.map(c => c.proof), [undefined]);
});

test("presence: `vyre presence code` prints the code and how long it lasts", async t => {
  const root = tempHome(t);
  const socket = config.paths(root).socket;
  if (path.dirname(socket) !== root) config.privateSocketDir();
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: { code: "K7Q2ZP" } }));
  });
  await new Promise(r => server.listen(socket, () => r(undefined)));
  t.after(() => new Promise(r => server.close(() => r(undefined))));
  const child = spawn(process.execPath, [BIN, "presence", "code"], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, VYRE_HOME: root, NO_COLOR: "1" } });
  let output = "";
  child.stdout.on("data", c => { output += c; });
  assert.equal(await new Promise(r => child.on("close", r)), 0);
  assert.match(output, /K7Q2ZP/);
  assert.match(output, /10 minutes/);
});
