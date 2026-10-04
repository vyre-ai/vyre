// @ts-check
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Hands } from "./hands.js";
import { makeRunner, responsibleApp, grantMessage } from "./runner.js";
import { fakeApp } from "./fake.js";
import { SCRATCH } from "../../test/scratch.mjs";

const nosleep = async () => {};
const calculator = () => ({
  texts: ["0"],
  elements: [
    { path: "/0/0/7", role: "AXButton", name: "7", container: "keypad", enabled: true, frame: { x: 10, y: 10, w: 40, h: 40 } },
    { path: "/0/0/8", role: "AXButton", name: "8", container: "keypad", enabled: true },
    { path: "/0/0/9", role: "AXButton", name: "Clear", container: "keypad", enabled: false },
  ],
});
const pressShows = (/** @type {any} */ req, /** @type {any} */ s) => { s.texts = [s.elements.find(e => e.path === req.path).name]; return { acted: true }; };

test("hands: observe returns bounded elements, each with a selector to hand back", async () => {
  const f = fakeApp(calculator());
  const o = await new Hands({ run: f.run }).observe({ app: "Calculator", limit: 50 });
  assert.equal(o.elements.length, 3);
  assert.deepEqual(o.elements[0].selector, { role: "AXButton", name: "7", container: "keypad", path: "/0/0/7" });
  // The place is looked up first, without reading it, and the snap is pinned to the pid it found.
  assert.deepEqual(f.calls[0], { cmd: "where", app: "Calculator" });
  assert.deepEqual(f.calls[1], { cmd: "snap", pid: 4242, limit: 50 });
});

test("hands: a press that changes the screen is verified by the observation after it", async () => {
  const events = [];
  const f = fakeApp(calculator(), pressShows);
  const r = await new Hands({ run: f.run, sleep: nosleep, emit: (t, p) => events.push([t, p]) })
    .act({ selector: { role: "AXButton", name: "7" }, kind: "press" });
  assert.equal(r.acted, true);
  assert.equal(r.verified, true);
  assert.equal(r.changes?.textChanged, true);
  assert.deepEqual(f.calls.map(c => c.cmd), ["where", "snap", "act", "snap"], "act did not observe before and after");
  assert.equal(events[0][0], "hands.acted");
  assert.equal(events[0][1].verified, true);
});

test("hands: the API saying yes is not proof; nothing changing is reported plainly", async () => {
  const f = fakeApp(calculator());   // the app accepts every press and does nothing
  const r = await new Hands({ run: f.run, sleep: nosleep }).act({ selector: { role: "AXButton", name: "8" }, kind: "press" });
  assert.equal(r.acted, true);
  assert.equal(r.verified, false);
  assert.match(r.reason, /nothing observed changed/);
  assert.ok(f.calls.filter(c => c.cmd === "snap").length >= 2, "it kept looking for the effect");
});

test("hands: acts on the control where it is now, not where an old observation put it", async () => {
  const f = fakeApp(calculator(), pressShows);
  f.state.elements[0].path = "/0/1/7";     // a sidebar opened and renumbered the tree
  const r = await new Hands({ run: f.run, sleep: nosleep }).act({ selector: { role: "AXButton", name: "7", container: "keypad", path: "/0/0/7" }, kind: "press" });
  assert.equal(r.verified, true);
  assert.equal(f.calls.find(c => c.cmd === "act").path, "/0/1/7");
});

test("hands: the app is pinned by pid after the first look, so a focus change cannot redirect it", async () => {
  const f = fakeApp(calculator(), pressShows);
  await new Hands({ run: f.run, sleep: nosleep }).act({ selector: { role: "AXButton", name: "7" }, kind: "press" });
  for (const c of f.calls.slice(1)) assert.equal(c.pid, 4242);
});

test("hands: a control that is gone or disabled is not touched, and the answer says why", async () => {
  const f = fakeApp(calculator());
  const h = new Hands({ run: f.run, sleep: nosleep });
  const gone = await h.act({ selector: { role: "AXButton", name: "Equals" }, kind: "press" });
  assert.deepEqual([gone.acted, gone.verified, gone.after], [false, false, null]);
  assert.match(gone.reason, /nothing was done/);
  const off = await h.act({ selector: { role: "AXButton", name: "Clear" }, kind: "press" });
  assert.match(off.reason, /disabled/);
  assert.ok(!f.calls.some(c => c.cmd === "act"));
});

test("hands: when the helper finds a different control at the path, nothing is claimed", async () => {
  const f = fakeApp(calculator());
  const run = async (/** @type {any} */ req) => {
    const out = await f.run(req);
    if (req.cmd === "snap" && f.calls.length === 2) f.state.elements[0].name = "Seven";   // renamed between looking and reaching
    return out;
  };
  const r = await new Hands({ run, sleep: nosleep }).act({ selector: { role: "AXButton", name: "7" }, kind: "press" });
  assert.equal(r.acted, false);
  assert.equal(r.verified, false);
  assert.match(r.reason, /nothing was done/);
});

test("hands: set is verified on the value, and the event never carries the text", async () => {
  const events = [];
  const f = fakeApp({ elements: [{ path: "/0/0/0", role: "AXTextArea", name: "text entry area", value: "", enabled: true }] },
    (req, s) => { s.elements[0].value = req.value; return { acted: true }; });
  const r = await new Hands({ run: f.run, sleep: nosleep, emit: (t, p) => events.push(p) })
    .act({ selector: { role: "AXTextArea", name: "text entry area" }, kind: "set", value: "hunter2-is-not-a-password" });
  assert.equal(r.verified, true);
  assert.equal(r.after?.target?.value, "hunter2-is-not-a-password");
  assert.ok(!JSON.stringify(events).includes("hunter2"), "typed text reached the event log");
});

test("hands: bad input is refused before anything runs", async () => {
  const f = fakeApp(calculator());
  const h = new Hands({ run: f.run });
  await assert.rejects(h.act({ selector: { role: "AXButton" }, kind: "type" }), /needs a value/);
  await assert.rejects(h.act({ selector: { role: "AXButton" }, kind: "drag" }), /kind must be/);
  assert.equal(f.calls.length, 0);
});

test("runner: the app to grant is the outermost app bundle above this process", () => {
  const tree = { 30: { ppid: 20, command: "/usr/local/bin/node" }, 20: { ppid: 10, command: "/bin/zsh" },
    10: { ppid: 1, command: "/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal" } };
  assert.equal(responsibleApp({ pid: 30, ps: pid => tree[pid] || null }), "Terminal");
  assert.equal(responsibleApp({ pid: 30, ps: () => null, fallback: "/usr/local/bin/node" }), "/usr/local/bin/node");
  assert.equal(grantMessage("Terminal"), "grant Accessibility to Terminal in System Settings > Privacy & Security > Accessibility");
});

const mac = process.platform === "darwin";

test("runner: a missing helper says to run the build script", { skip: !mac }, async () => {
  const run = makeRunner({ bin: path.join(os.tmpdir(), "vyre-no-such-helper") });
  await assert.rejects(run({ cmd: "trust" }), e => /** @type {any} */ (e).code === "not_built" && /build\.sh/.test(e.message));
});

test("runner: a missing grant names the app to grant and where", { skip: !mac }, async t => {
  const dir = fs.mkdtempSync(path.join(SCRATCH, "vyre-hands-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bin = path.join(dir, "ax");
  fs.writeFileSync(bin, `#!/bin/sh\ncat >/dev/null\necho '{"error":"not allowed","code":"not_trusted"}'\nexit 2\n`, { mode: 0o755 });
  const run = makeRunner({ bin, responsible: () => "Terminal" });
  await assert.rejects(run({ cmd: "snap" }), /grant Accessibility to Terminal in System Settings > Privacy & Security > Accessibility/);
});

test("runner: the request travels on stdin, not in argv", { skip: !mac }, async t => {
  const dir = fs.mkdtempSync(path.join(SCRATCH, "vyre-hands-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bin = path.join(dir, "ax");
  fs.writeFileSync(bin, `#!/bin/sh\nread -r line\nprintf '{"argc":%s,"got":%s}\\n' "$#" "$line"\n`, { mode: 0o755 });
  const r = await makeRunner({ bin })({ cmd: "act", value: "Harlow Legal" });
  assert.equal(r.argc, 0);
  assert.equal(r.got.value, "Harlow Legal");
});
