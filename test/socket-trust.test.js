// Inverted socket trust: a person's label on the socket (cli, local, deck, capsule, mobile) is only a claim, and
// a child that left the claude ancestry (setsid, nohup, a launchd or cron job an agent wrote) sends the same
// label. It is kept only for a peer that proves it is the person: the pinned Capsule, a terminal login that
// `who` lists with the peer in its foreground process group, or a server the person already proved. Everything
// else is capped at mcp, silently (reviewer-2, 2 Oct 2026). Unit level, with the daemon's own seams: no daemon,
// no terminal needed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { asTaken } from "../core/daemon/index.js";
import { setSocketTrust, socketTrust } from "../core/daemon/peer.js";
import "./helpers.js";

const registry = pin => ({ call: async () => ({ data: { pids: [] } }), deps: { presence: { capsulePin: () => pin || null, who: async () => ["ttys001"] } } });
const deps = (over = {}) => ({ peerPid: async () => 50, alive: () => true, delayMs: 1, insideClaude: () => ({ inside: false }),
  terminal: async () => null, foreground: () => null, ...over });
const strict = async fn => { const was = socketTrust(); setSocketTrust("strict"); try { await fn(); } finally { setSocketTrust(was); } };
const person = ["cli", "local", "deck", "capsule", "mobile"];

test("a detached child (no terminal) claiming a person label is capped at mcp", () => strict(async () => {
  for (const label of person) {
    const r = await asTaken(label, {}, registry(), undefined, deps());
    assert.deepEqual([r.caller, r.model, r.capped], ["mcp", true, true], label);
  }
  // Inside a session it becomes that session's own label, as before.
  assert.equal((await asTaken("cli", {}, registry(), "t1", deps())).caller, "mcp:thread:t1");
}));

test("the person's own terminal login, in the foreground, keeps cli and local", () => strict(async () => {
  const term = deps({ terminal: async () => ({ key: "ttys001#812@t", tty: "ttys001" }), foreground: () => ({ pgid: 900, tpgid: 900 }) });
  for (const label of ["cli", "local"]) assert.deepEqual(await asTaken(label, {}, registry(), undefined, term), { caller: label, model: false }, label);
}));

test("a nohup or background child on the person's terminal has the tty but not the foreground group: capped", () => strict(async () => {
  const bg = deps({ terminal: async () => ({ key: "ttys001#812@t", tty: "ttys001" }), foreground: () => ({ pgid: 901, tpgid: 900 }) });
  const r = await asTaken("cli", {}, registry(), undefined, bg);
  assert.deepEqual([r.caller, r.capped], ["mcp", true]);
  // A terminal with no readable process group is not proof either.
  assert.equal((await asTaken("cli", {}, registry(), undefined, deps({ terminal: async () => ({ key: "k", tty: "t" }), foreground: () => null }))).caller, "mcp");
}));

test("the pinned Capsule keeps its label; another binary claiming it does not", () => strict(async () => {
  const pin = { cdhash: "a".repeat(40) };
  const seam = h => ({ started: () => "t1", cdhash: () => h });
  const cap = h => deps({ insideClaude: () => ({ inside: false, unknown: true }), capsuleSeam: seam(h) });
  assert.deepEqual(await asTaken("capsule", {}, registry(pin), undefined, cap("a".repeat(40))), { caller: "capsule", model: false });
  assert.equal((await asTaken("capsule", {}, registry(pin), undefined, cap("b".repeat(40)))).caller, "mcp", "a different build");
  assert.equal((await asTaken("cli", {}, registry(pin), undefined, cap("a".repeat(40)))).caller, "mcp", "the Capsule's shape under another label proves nothing");
}));

test("labels that are not a person's are untouched, and the label mode keeps the old behaviour", async () => {
  await strict(async () => {
    for (const label of ["mcp", "harness", "mcp:agent:kit", "anonymous"]) assert.equal((await asTaken(label, {}, registry(), undefined, deps())).caller, label, label);
  });
  const was = socketTrust();
  setSocketTrust("label");
  try { assert.equal((await asTaken("cli", {}, registry(), undefined, deps())).caller, "cli", "tests host vyred without a terminal"); }
  finally { setSocketTrust(was); }
});
