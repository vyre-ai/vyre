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

/**
 * A fake vyred: system.echo is plain, gate.approve is a moment that answers presence_required with its request until it is called with the approved card (x-vyre-approval: ap_1), approvals.ask makes
 * the card, approvals.local-yes confirms it here (`how`: "touchid" at once, "tty" with the code ABC123, "phone" refuses so the card waits for the phone), approvals.status says where it stands.
 * @param {any} t @param {{ how?: "touchid" | "tty" | "phone", reveal?: boolean }} [o]
 */
async function fakeVyred(t, { how = "touchid" } = {}) {
  const root = tempHome(t);
  const socket = config.paths(root).socket;
  if (path.dirname(socket) !== root) config.privateSocketDir();
  const seen = { calls: /** @type {{ tool: string, approval?: string, body: any }[]} */ ([]), phonePolls: 0 };
  let approved = false;
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", c => { raw += c; });
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : {};
      const send = (status, obj) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
      const tool = decodeURIComponent(String(req.url).replace("/v1/tools/", ""));
      const approval = /** @type {string|undefined} */ (req.headers["x-vyre-approval"]);
      seen.calls.push({ tool, approval, body });
      if (tool === "system.echo") return send(200, { data: body });
      if (tool === "system.fail") return send(400, { error: { code: "bad_input", message: "no" } });
      if (tool === "approvals.ask") return send(200, { data: { id: "ap_1", line: "An assistant wants to approve a held send", expires_in_s: 300 } });
      if (tool === "approvals.local-yes") {
        if (how === "phone") return send(403, { error: { code: "presence_required", message: "this computer cannot confirm that: approve it in Vyre on your phone" } });
        if (how === "touchid") { approved = true; return send(200, { data: { answered: "approved" } }); }
        if (!body.challenge) return send(200, { data: { need: "code", challenge: "ch1" } });
        if (body.challenge === "ch1" && body.code === "ABC123") { approved = true; return send(200, { data: { answered: "approved" } }); }
        return send(403, { error: { code: "presence_required", message: "wrong code" } });
      }
      if (tool === "approvals.status") { seen.phonePolls++; if (seen.phonePolls >= 2) approved = true; return send(200, { data: { state: approved ? "approved" : "waiting", approval: "ap_1" } }); }
      if (tool === "gate.approve" && approval === "ap_1" && approved) return send(200, { data: { approved: body.id } });
      send(403, { error: { code: "presence_required", message: "gate.approve needs your yes", methods: [], moment: "outward", request: { op: "gate.approve", fields: body } } });
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

test("presence: a moment asks a card, confirms it here, and calls again with the approved card", async t => {
  const { root, seen } = await fakeVyred(t, { how: "touchid" });
  const io = fakeIO();
  const r = await callAsPerson("gate.approve", { id: 7 }, { root, io });
  assert.deepEqual(r, { data: { approved: 7 } });
  assert.deepEqual(seen.calls.map(c => c.tool), ["gate.approve", "approvals.ask", "approvals.local-yes", "gate.approve"]);
  assert.deepEqual(seen.calls[1].body, { moment: "outward", request: { op: "gate.approve", fields: { id: 7 } } });
  assert.equal(seen.calls[3].approval, "ap_1");
  assert.match(io.printed[0], /wants to approve a held send/);
  assert.equal(io.prompts, 0);
});

test("presence: a reveal asks for the five-minute reuse", async t => {
  const { root, seen } = await fakeVyred(t, { how: "touchid" });
  await callAsPerson("vault.reveal", { name: "k" }, { root, io: fakeIO() });
  assert.equal(seen.calls.find(c => c.tool === "approvals.ask")?.body.reuse, true);
  const { root: other, seen: seen2 } = await fakeVyred(t, { how: "touchid" });
  await callAsPerson("gate.approve", { id: 7 }, { root: other, io: fakeIO() });
  assert.equal(seen2.calls.find(c => c.tool === "approvals.ask")?.body.reuse, undefined, "a send does not ask for a window");
});

test("presence: the terminal code, a wrong one and then a right one, on the same challenge", async t => {
  const { root, seen } = await fakeVyred(t, { how: "tty" });
  const io = fakeIO(["WRONG1", " ABC 123 "]);
  const r = await callAsPerson("gate.approve", { id: 7 }, { root, io });
  assert.deepEqual(r, { data: { approved: 7 } });
  assert.equal(io.prompts, 2);
  assert.match(io.printed.join("\n"), /did not match/);
  assert.deepEqual(seen.calls.filter(c => c.tool === "approvals.local-yes").map(c => c.body), [{ id: "ap_1", tty: "/dev/ttys042" }, { id: "ap_1", challenge: "ch1", code: "WRONG1" }, { id: "ap_1", challenge: "ch1", code: "ABC123" }]);
  assert.ok(io.closed);
});

test("presence: three wrong codes give up with presence_required", async t => {
  const { root } = await fakeVyred(t, { how: "tty" });
  const io = fakeIO(["a", "b", "c", "ABC123"]);
  const r = await callAsPerson("gate.approve", { id: 7 }, { root, io });
  assert.equal(r.error.code, "presence_required");
  assert.equal(io.prompts, 3);
});

test("presence: a server with no screen of its own waits for the phone, then calls again", async t => {
  const { root, seen } = await fakeVyred(t, { how: "phone" });
  const io = fakeIO();
  const r = await callAsPerson("gate.approve", { id: 7 }, { root, io, pollMs: 5 });
  assert.deepEqual(r, { data: { approved: 7 } });
  assert.ok(seen.phonePolls >= 2);
  assert.match(io.printed.join("\n"), /on your phone/);
});

test("presence: no terminal is refused without asking for a card", async t => {
  const { root, seen } = await fakeVyred(t);
  const io = fakeIO([], { noTty: true });
  const r = await callAsPerson("gate.approve", { id: 7 }, { root, io });
  assert.equal(r.error.code, "no_terminal");
  assert.equal(r.error.message, NO_TERMINAL);
  assert.deepEqual(seen.calls.map(c => c.tool), ["gate.approve"]);
  assert.equal(io.prompts, 0);
});

test("presence: `vyre call` from a process with no controlling terminal is refused", async t => {
  const { root, seen } = await fakeVyred(t, { how: "tty" });
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
  assert.deepEqual(seen.calls.map(c => c.tool), ["gate.approve"]);
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
