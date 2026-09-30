// @ts-check
// reviewer-2, 30 Sep: a forged "cli" label under a claude survived the relabel, 20 of 20 on a Mac.
// The macOS process table is shared for 250 ms, a process forked inside that window is not in it,
// and the walk read "not in the table" as "nobody above". These pin the fix: a miss is never
// served from the shared snapshot, retries read fresh, a peer that already exited is a model's,
// and only a definite answer is kept for a connection.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { tempHome, writeModule } from "./helpers.js";
import { start, above, asTaken } from "../core/daemon/index.js";
import { processTable } from "../core/daemon/peer.js";

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

test("peer race: only a definite answer is kept for the connection", async () => {
  const socket = {};
  let n = 0;
  const deps = { peerPid: async () => 4242, delayMs: 1, alive: () => true, processTable: () => () => null,
    insideClaude: () => (++n <= 3 ? { inside: false, unknown: true } : { inside: true, by: 700 }) };  // three looks per answer: first, two retries
  const first = await asTaken("cli", socket, registry, undefined, deps);
  assert.deepEqual(first, { caller: "cli", model: false }, "unknown keeps the label for this call");
  const second = await asTaken("cli", socket, registry, undefined, deps);
  assert.deepEqual(second, { caller: "mcp", model: true }, "and is asked again on the next call");
  n = 0;
  const outside = {};
  const clean = { ...deps, insideClaude: () => ({ inside: false }) };
  await asTaken("cli", outside, registry, undefined, clean);
  const again = await asTaken("cli", outside, registry, undefined, { ...deps, insideClaude: () => ({ inside: true }) });
  assert.equal(again.model, false, "a definite outside answer is kept");
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
    ctx.tool("probe.mine", { input: { type: "object" }, callers: ["cli", "local", "deck", "capsule"], run: async () => { globalThis.__probeMineRan++; return { ok: true }; } });
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
});

test("peer race: a forger that sends and exits before the check is a model's, not the person's", { timeout: 120_000, skip: process.platform === "win32" }, async t => {
  const { d, dir } = await vyredWithProbe(t);
  await Promise.all(Array.from({ length: 40 }, (_, i) => forger(dir, d.paths.socket, i, { fireAndForget: true })));
  await new Promise(r => setTimeout(r, 500));
  assert.equal(globalThis.__probeMineRan, 0, "a fire-and-forget forger ran a person's tool");
});
