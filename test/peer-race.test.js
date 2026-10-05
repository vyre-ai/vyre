// @ts-check
// reviewer-2, 30 Sep: a forged "cli" label under a claude survived the relabel, 20 of 20 on a Mac.
// The macOS process table is shared for 250 ms, a process forked inside that window is not in it,
// and the walk read "not in the table" as "nobody above". These pin the fix: a miss is never
// served from the shared snapshot, retries read fresh, a peer that already exited is a model's,
// and only a definite answer is kept for a connection.

import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { tempHome, writeModule } from "./helpers.js";
import { start, above, asTaken } from "../core/daemon/index.js";
import { processTable, readPeerPid, insideClaude, setPeerHosting } from "../core/daemon/peer.js";

// These prove the production rules: vyred hosted in the test process is not the person's anchor here
// (setPeerHosting(true) is called by the helpers for the other tests' own clients; the control below sets it).
setPeerHosting(false);

/** The kernel-verified leader a chain may top out at on this platform (login is forgeable on macOS). */
const LEADER = process.platform === "darwin" ? "/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal" : "/usr/bin/login";

/** A macOS-shaped snapshot: pid -> row. */
const rows = obj => new Map(Object.entries(obj).map(([k, v]) => [Number(k), { pgid: Number(k), ...v }]));
const BASE = { 400: { ppid: 1, args: "node --test" } };
const WITH_CALLER = { ...BASE, 700: { ppid: 1, args: "node /usr/local/bin/claude" }, 710: { ppid: 700, args: "vyre call probe.mine" } };

test("peer race: a pid the shared snapshot lacks is read again, and found", () => {
  const cache = { at: 0, rows: null };
  let reads = 0;
  const read = () => { reads++; return reads === 1 ? rows(BASE) : rows(WITH_CALLER); };
  const first = processTable({ platform: "darwin", read, cache });
  assert.equal(first(400)?.args, "node --test");
  // A second walk inside the 250 ms window is served the shared snapshot, which lacks 710.
  const second = processTable({ platform: "darwin", read, cache });
  assert.equal(reads, 1, "the second walk shared the snapshot");
  assert.equal(second(710)?.args, "vyre call probe.mine", "a miss reads the table again");
  assert.equal(reads, 2);
  // Once read fresh, a pid still missing is really gone: no more reads for it.
  assert.equal(second(999), null);
  assert.equal(reads, 2);
});

test("peer race: fresh skips the shared snapshot, and an empty read is never kept", () => {
  const cache = { at: 0, rows: null };
  let reads = 0;
  const read = () => { reads++; return reads === 1 ? new Map() : rows(WITH_CALLER); };
  assert.equal(processTable({ platform: "darwin", read, cache })(710), null, "a failed read is a miss, not a table");
  assert.equal(cache.rows, null, "and is not kept");
  const a = processTable({ platform: "darwin", read, cache });
  const b = processTable({ platform: "darwin", read, cache, fresh: true });
  assert.equal(b(710)?.ppid, 700);
  assert.equal(a(710)?.ppid, 700);
});

/** A registry stub above() needs: no threads, no presence. */
const registry = { call: async () => ({ data: {} }), deps: {} };

test("peer race: a caller missing from the shared snapshot is still found under the claude", async () => {
  const cache = { at: Date.now(), rows: rows(BASE) };            // the stale snapshot, fresh enough to be shared
  let reads = 0;
  const read = () => { reads++; return rows(WITH_CALLER); };
  const w = await above({}, registry, "cli", { peerPid: async () => 710, processTable: o => processTable({ ...o, platform: "darwin", read, cache }) });
  assert.equal(w.inside, true, JSON.stringify(w));
  assert.ok(reads >= 1);
});

test("peer race: retries read a fresh table", async () => {
  const seen = [];
  const w = await above({}, registry, "cli", {
    peerPid: async () => 710, delayMs: 1, alive: () => true,
    processTable: o => { seen.push(Boolean(o.fresh)); return () => null; },
    insideClaude: () => ({ inside: false, unknown: true }),
  });
  assert.deepEqual(seen, [false, true, true], "only the first look may share a snapshot");
  assert.equal(w.unknown, true);
});

test("peer race: an unreadable peer that already exited is a model's; a live one stays unknown", async () => {
  const deps = alive => ({ peerPid: async () => 4242, delayMs: 1, alive, processTable: () => () => null, insideClaude: () => ({ inside: false, unknown: true }) });
  const gone = await above({}, registry, "cli", deps(() => false));
  assert.equal(gone.inside, true);
  assert.equal(gone.exited, true);
  const live = await above({}, registry, "cli", deps(() => true));
  assert.equal(live.inside, false);
  assert.equal(live.unknown, true);
});

test("peer race: fail closed, an empty ps read or a pid a fresh table lacks is a model's, a docker exec is not", async () => {
  const one = read => above({}, registry, "cli", { peerPid: async () => 710, delayMs: 1, alive: () => true, processTable: o => processTable({ ...o, platform: "darwin", read, cache: { at: 0, rows: null } }) });
  const empty = await one(() => new Map());
  assert.equal(empty.inside, true, "an empty or timed-out read");
  assert.equal(empty.unreadable ?? empty.exited, true);
  const missing = await one(() => rows(BASE));
  assert.equal(missing.inside, true, "a pid missing from a fresh table");
  // A chain that is whole and holds no claude is read to the top, not failed closed.
  const person = await above({}, registry, "cli", { peerPid: async () => 710, delayMs: 1, alive: () => true,
    processTable: o => processTable({ ...o, platform: "darwin", read: () => rows({ ...BASE, 700: { ppid: 1, args: "/usr/bin/login -pf alex" }, 710: { ppid: 700, args: "vyre call probe.mine" } }), cache: { at: 0, rows: null } }),
    insideClaude: (pid, o) => insideClaude(pid, { ...o, exe: () => LEADER, started: () => "t" }) });
  assert.equal(person.inside, false, JSON.stringify(person));
  assert.equal(person.unreadable, undefined, "a whole chain is not an unreadable one");
  assert.equal(person.exited, undefined);
  // A docker exec (a process whose parent is itself) says nothing about who is above: not taken as a model's on that alone.
  const docker = await above({}, registry, "cli", { peerPid: async () => 5, alive: () => true, delayMs: 1, processTable: () => pid => (pid === 5 ? { ppid: 5, args: "vyre call x" } : null) });
  assert.equal(docker.inside, false);
  assert.equal(docker.unknown, true);
});

test("peer race: only a definite answer is kept for the connection", async () => {
  const socket = {};
  let n = 0;
  const deps = { peerPid: async () => 4242, delayMs: 1, alive: () => true, processTable: () => () => null,
    insideClaude: () => (++n <= 3 ? { inside: false, unknown: true } : { inside: true, by: 700 }) };  // three looks per answer: first, two retries
  const first = await asTaken("cli", socket, registry, undefined, deps);
  const mini = (/** @type {any} */ v) => ({ caller: v.caller, model: v.model });
  assert.deepEqual(mini(first), { caller: "cli", model: false }, "unknown keeps the label for this call");
  const second = await asTaken("cli", socket, registry, undefined, deps);
  assert.deepEqual(mini(second), { caller: "mcp", model: true }, "and is asked again on the next call");
  n = 0;
  const outside = {};
  const clean = { ...deps, insideClaude: () => ({ inside: false }) };
  await asTaken("cli", outside, registry, undefined, clean);
  const again = await asTaken("cli", outside, registry, undefined, { ...deps, insideClaude: () => ({ inside: true }) });
  assert.equal(again.model, false, "a definite outside answer is kept");
  // An unreadable chain is a model's for that call, but not kept: a stalled ps must not brand the
  // connection for life.
  const flaky = {};
  let reads = 0;
  const fdeps = { ...deps, insideClaude: () => (++reads <= 3 ? { inside: false, unknown: true, unreadable: true } : { inside: false }) };
  const one = await asTaken("cli", flaky, registry, undefined, fdeps);
  assert.equal(one.model, true, "unreadable is a model's this time");
  await new Promise(r => setImmediate(r));
  const two = await asTaken("cli", flaky, registry, undefined, fdeps);
  assert.deepEqual(mini(two), { caller: "cli", model: false }, "and is asked again, not kept");
});

test("peer race: a named server keeps its label when the chain is unreadable", async () => {
  const r = await above({}, registry, "cli", { peerPid: async () => 5, alive: () => true, delayMs: 1,
    insideClaude: () => ({ inside: false, unknown: true, unreadable: true, server: { exe: "/usr/bin/sshd", pid: 9, started: "t" } }) });
  assert.equal(r.inside, false);
  assert.equal(r.unknown, true);
});

test("peer race: a socket that closed before or during the read gives no pid (its fd number may be another descriptor's)", { skip: process.platform === "win32" }, async t => {
  const file = path.join(tempHome(t), "fd");
  fs.writeFileSync(file, "");
  const fd = fs.openSync(file, "r");
  t.after(() => { try { fs.closeSync(fd); } catch {} });
  const seam = { bin: "/bin/sh", args: ["-c", "sleep 0.2; echo 4242"] };
  const open = { destroyed: false, _handle: { fd } };
  assert.equal(await readPeerPid(/** @type {any} */ (open), seam), 4242, "an open socket is read");
  assert.equal(await readPeerPid(/** @type {any} */ ({ destroyed: true, _handle: null }), seam), null, "destroyed before: no helper starts");
  const closing = { destroyed: false, _handle: { fd } };
  setTimeout(() => { closing.destroyed = true; closing._handle = /** @type {any} */ (null); }, 50);
  assert.equal(await readPeerPid(/** @type {any} */ (closing), seam), null, "closed while the helper ran: its answer is thrown away");
});

test("peer race: a peer that is vyred itself is a misread and a model's; only a test hosting vyred lets it through", async () => {
  const deps = { peerPid: async () => process.pid, delayMs: 1, alive: () => true, processTable: () => () => ({ ppid: 1, args: "node" }) };
  const r = await above({}, registry, "cli", deps);
  assert.equal(r.inside, true);
  assert.equal(r.self, true);
  setPeerHosting(true);
  try { assert.equal((await above({}, registry, "cli", deps)).inside, false, "a test hosting vyred lets its own client through"); }
  finally { setPeerHosting(false); }
});

test("peer race: a chain through an exited, unreaped process (no command line) is unreadable, so a model's", async () => {
  // ps prints a zombie as "(node)", /proc as an empty cmdline; the fake claude above a forger that
  // quit was one, and the walk read "no claude above" (fire-and-forget forger on a busy Mac, 30 Sep).
  for (const args of ["(node)", ""]) {
    const r = await above({}, registry, "cli", { peerPid: async () => 20, alive: () => true, delayMs: 1,
      processTable: () => pid => ({ 20: { ppid: 10, args }, 10: { ppid: 1, args }, 1: { ppid: 0, args: "init" } }[pid] || null) });
    assert.equal(r.inside, true, JSON.stringify(args));
    assert.equal(r.unreadable, true);
  }
  // Parentheses in the middle of a real command line are not an unreaped process (reviewer-2).
  const paren = insideClaude(20, { look: pid => ({ 20: { ppid: 10, args: "node app.js (x)" }, 10: { ppid: 1, pgid: 10, args: "/usr/bin/login -pf alex" } }[pid] || null), exe: () => LEADER, started: () => "t", uid: () => 501, self: 1 });
  assert.notEqual(paren.unreadable, true, JSON.stringify(paren));
  const live = await above({}, registry, "cli", { peerPid: async () => 20, alive: () => true, delayMs: 1,
    processTable: () => pid => ({ 20: { ppid: 10, args: "vyre call x", pgid: 10 }, 10: { ppid: 1, args: "/usr/bin/login -pf alex", pgid: 10 } }[pid] || null),
    insideClaude: (pid, o) => insideClaude(pid, { ...o, exe: () => LEADER, started: () => "t" }) });
  assert.equal(live.unreadable, undefined, "readable args are not this case");
});

/** A forger: a node script run under a fake `claude`, saying it is the person's cli. */
function forger(dir, socket, i, { fireAndForget = false } = {}) {
  const js = path.join(dir, `forge-${i}.mjs`);
  fs.writeFileSync(js, `import http from "node:http";
const data = "{}";
const req = http.request({ socketPath: ${JSON.stringify(socket)}, path: "/v1/tools/probe.mine", method: "POST",
  headers: { "content-type": "application/json", "content-length": 2, "x-vyre-caller": "cli" } }, res => { res.resume(); res.on("end", () => process.exit(0)); });
req.on("error", () => process.exit(0));
req.end(data);
${fireAndForget ? "setTimeout(() => process.exit(0), 0);" : ""}
`);
  fs.mkdirSync(path.join(dir, `f${i}`));
  const fake = path.join(dir, `f${i}`, "claude");
  fs.writeFileSync(fake, `#!${process.execPath}
const c = require("node:child_process").spawn(process.execPath, [${JSON.stringify(js)}], { stdio: "ignore" });
c.on("exit", code => process.exit(code ?? 1));
`, { mode: 0o755 });
  return new Promise(resolve => { const p = spawn(process.execPath, [fake], { stdio: "ignore" }); p.on("close", resolve); });
}

async function vyredWithProbe(t) {
  const root = tempHome(t);
  globalThis.__probeMineRan = 0;
  writeModule(path.join(root, "modules"), "probe", { does: { tools: ["probe.mine"] } }, `export default { async start(ctx) {
    ctx.tool("probe.mine", { effect: "read", input: { type: "object" }, callers: ["cli", "local", "deck", "capsule"], run: async () => { globalThis.__probeMineRan++; return { ok: true }; } });
    return {};
  } };`);
  const d = await start({ root, log: () => {}, firstPartyRoots: [path.join(root, "modules")] });
  t.after(() => d.stop());
  return { d, dir: fs.mkdtempSync(path.join(root, "forge-")) };
}

test("peer race: 200 forgers under a claude, in bursts, never reach a person's tool as cli", { timeout: 180_000, skip: process.platform === "win32" }, async t => {
  const { d, dir } = await vyredWithProbe(t);
  for (let batch = 0; batch < 8; batch++) await Promise.all(Array.from({ length: 25 }, (_, i) => forger(dir, d.paths.socket, batch * 25 + i)));
  assert.equal(globalThis.__probeMineRan, 0, "a forged cli label from under a claude ran a person's tool");
  // The control: the same call from a plain process outside any claude is the person's and runs.
  const js = path.join(dir, "person.mjs");
  fs.writeFileSync(js, `import http from "node:http";
const req = http.request({ socketPath: ${JSON.stringify(d.paths.socket)}, path: "/v1/tools/probe.mine", method: "POST", headers: { "content-type": "application/json", "content-length": 2, "x-vyre-caller": "cli" } }, res => { res.resume(); res.on("end", () => process.exit(0)); });
req.end("{}");`);
  // The person's own client is this test's child: a test hosting vyred is the one seam that lets it through.
  setPeerHosting(true);
  try { await new Promise(r => spawn(process.execPath, [js], { stdio: "ignore" }).on("close", r)); }
  finally { setPeerHosting(false); }
  assert.equal(globalThis.__probeMineRan, 1, "the person's own cli still runs the tool");
});

test("peer race: a forger that sends and exits before the check is a model's, not the person's", { timeout: 120_000, skip: process.platform === "win32" }, async t => {
  const { d, dir } = await vyredWithProbe(t);
  await Promise.all(Array.from({ length: 40 }, (_, i) => forger(dir, d.paths.socket, i, { fireAndForget: true })));
  await new Promise(r => setTimeout(r, 500));
  assert.equal(globalThis.__probeMineRan, 0, "a fire-and-forget forger ran a person's tool");
});

test("peer race: when Vyre could not tell who called, it says which half failed (the kernel gave no pid, or the chain was unreadable)", async () => {
  const noPid = await asTaken("cli", {}, registry, undefined, { peerPid: async () => null, delayMs: 1, peerRetryMs: 1, alive: () => true });
  assert.equal(noPid.couldNotTell, true);
  assert.equal(noPid.why, "peer_pid_unread");
  const unreadable = await asTaken("cli", {}, registry, undefined, { peerPid: async () => 4242, delayMs: 1, alive: () => true, processTable: () => () => null, insideClaude: () => ({ inside: false, unknown: true, unreadable: true }) });
  assert.equal(unreadable.couldNotTell, true);
  assert.equal(unreadable.why, "process_chain_unreadable");
  const fine = await asTaken("cli", {}, registry, undefined, { peerPid: async () => 4242, delayMs: 1, alive: () => true, insideClaude: () => ({ inside: false }) });
  assert.equal(fine.couldNotTell, false);
  assert.equal(fine.why, undefined);
});
