// A session on the person's own server: sealed at every turn into the checkpoint store, and put back to the last whole turn after a crash.
import "./testing/hosted-guard.js";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { SCRATCH } from "../../test/scratch.mjs";
import { createCheckpointStore } from "./checkpoint-store.js";
import { createTurnSeal } from "./ownserver.js";

const SPACE = "spc_harlow000001", S = "7c1f0a52-0000-4000-8000-000000000001";
const chain = { space: SPACE, hops: [{ actor: { kind: "person", id: "per_alex", space: SPACE } }], labels: { trust: "member", red: "internal", source_spaces: [SPACE] } };
const tmp = () => fs.mkdtempSync(path.join(SCRATCH, "own-"));
const rm = d => fs.rmSync(d, { recursive: true, force: true });
const mk = (t, fsx) => {
  const dir = tmp(); t.after(() => rm(dir));
  const store = createCheckpointStore({ space: SPACE, root: path.join(dir, "store"), authorize: async () => ({ effect: "allow" }) });
  const file = path.join(dir, "proj", `${S}.jsonl`); fs.mkdirSync(path.dirname(file), { recursive: true });
  const seal = () => createTurnSeal({ port: store.port(() => chain), session: S, file, fs: fsx });
  return { dir, store, file, seal, port: store.port(() => chain) };
};
const line = n => JSON.stringify({ type: "user", n });

test("each turn is sealed: complete lines only, a torn tail waits, and the checkpoint names the turn", async t => {
  const h = mk(t), s = h.seal();
  fs.writeFileSync(h.file, line(1) + "\n" + line(2) + "\n" + '{"type":"asst');             // turn 1 and half a line of turn 2
  assert.deepEqual(await s.seal({ turn: 1, state: { cwd: "/srv/p" } }), { turn: 1, seq: 2 });
  fs.appendFileSync(h.file, 'ant","n":3}\n' + line(4) + "\n");
  assert.deepEqual(await s.seal({ turn: 2, state: { cwd: "/srv/p" } }), { turn: 2, seq: 4 });
  const cp = await h.port.getCheckpoint(S);
  assert.equal(cp.turn, 2); assert.equal(cp.seq, 4); assert.deepEqual(cp.state, { cwd: "/srv/p" });
  assert.deepEqual((await h.port.getTranscript(S, 1)).map(e => e.line), fs.readFileSync(h.file, "utf8").trim().split("\n"));
});

test("the file is fsynced before the checkpoint is written", async t => {
  const order = [];
  const fsx = { ...fs, fsyncSync: fd => { order.push("fsync"); return fs.fsyncSync(fd); } };
  const h = mk(t, fsx), real = h.port.putCheckpoint;
  h.port.putCheckpoint = async (...a) => { order.push("checkpoint"); return real(...a); };
  fs.writeFileSync(h.file, line(1) + "\n");
  const s = createTurnSeal({ port: h.port, session: S, file: h.file, fs: fsx });
  await s.seal({ turn: 1, state: {} });
  assert.ok(order.indexOf("fsync") >= 0 && order.indexOf("fsync") < order.indexOf("checkpoint"), order.join(","));
});

test("after a crash the file goes back to exactly the last whole turn, and the new process carries on from it", async t => {
  const h = mk(t), s = h.seal();
  fs.writeFileSync(h.file, line(1) + "\n" + line(2) + "\n");
  await s.seal({ turn: 1, state: { id: S } });
  fs.appendFileSync(h.file, line(3) + "\n" + '{"torn":'); // turn 2 started, never sealed, and the power went out mid-line
  const again = h.seal();                                 // a restarted vyred: no memory of the old cursor
  const r = await again.recover();
  assert.deepEqual(r, { turn: 1, seq: 2, state: { id: S } });
  assert.equal(fs.readFileSync(h.file, "utf8"), line(1) + "\n" + line(2) + "\n");
  assert.deepEqual(fs.readdirSync(path.dirname(h.file)).filter(f => /tmp-/.test(f)), [], "no temp file left");
  fs.appendFileSync(h.file, line(5) + "\n");
  assert.deepEqual(await again.seal({ turn: 2, state: {} }), { turn: 2, seq: 3 });
});

test("a restarted process that never recovered picks up from the store's checkpoint without sealing a line twice", async t => {
  const h = mk(t);
  fs.writeFileSync(h.file, line(1) + "\n" + line(2) + "\n");
  await h.seal().seal({ turn: 1, state: {} });
  fs.appendFileSync(h.file, line(3) + "\n");
  assert.deepEqual(await h.seal().seal({ turn: 2, state: {} }), { turn: 2, seq: 3 });
  assert.equal((await h.port.getTranscript(S, 1)).length, 3);
});

test("a file the provider rewrote is refused as a continuation, and the last checkpoint stands", async t => {
  const h = mk(t), s = h.seal();
  fs.writeFileSync(h.file, line(1) + "\n" + line(2) + "\n");
  await s.seal({ turn: 1, state: {} });
  fs.writeFileSync(h.file, line(9) + "\n" + line(8) + "\n" + line(7) + "\n");               // compaction: different lines, longer file
  await assert.rejects(h.seal().seal({ turn: 2, state: {} }), e => e.code === "rewritten");
  fs.writeFileSync(h.file, line(1) + "\n");                                                   // shorter than the checkpoint
  await assert.rejects(s.seal({ turn: 2, state: {} }), e => e.code === "rewritten");
  assert.equal((await h.port.getCheckpoint(S)).turn, 1);
});

test("nothing sealed yet: recover answers null and touches nothing; a missing transcript is not_found", async t => {
  const h = mk(t);
  fs.writeFileSync(h.file, line(1) + "\n");
  assert.equal(await h.seal().recover(), null);
  assert.equal(fs.readFileSync(h.file, "utf8"), line(1) + "\n");
  fs.rmSync(h.file);
  await assert.rejects(h.seal().seal({ turn: 1, state: {} }), e => e.code === "not_found");
});

test("a store that refuses (quota) fails the seal and leaves the last checkpoint", async t => {
  const dir = tmp(); t.after(() => rm(dir));
  const store = createCheckpointStore({ space: SPACE, root: path.join(dir, "store"), authorize: async () => ({ effect: "allow" }), caps: { sessionBytes: 400 } });
  const file = path.join(dir, `${S}.jsonl`);
  const s = createTurnSeal({ port: store.port(() => chain), session: S, file });
  fs.writeFileSync(file, line(1) + "\n");
  await s.seal({ turn: 1, state: {} });
  fs.appendFileSync(file, (line(2) + "\n").repeat(40));
  await assert.rejects(s.seal({ turn: 2, state: {} }), e => e.code === "quota");
  assert.equal((await store.port(() => chain).getCheckpoint(S)).turn, 1);
});

test("the runner module seals a finished turn when the sessions side names its transcript, and says so in an event", async t => {
  const { default: mod, seams } = await import("./index.js");
  const h = mk(t);
  const root = path.join(h.dir, "mod"); fs.mkdirSync(root);
  const handlers = []; const events = [];
  const ports = { device: "dev_kit", vault: {}, sync: {}, grants: () => ({}), ownServer: { port: () => h.port, resolve: async e => (e.payload.session === S ? { space: SPACE, session: S, file: h.file, turn: e.payload.turn, state: { cwd: "/srv/p" } } : null) } };
  seams.set(root, { ports }); t.after(() => seams.delete(root));
  const ctx = { paths: { root }, tool() {}, events: { emit: (type, p) => events.push([type, p]), on: (pat, fn) => { handlers.push([pat, fn]); return () => {}; } } };
  const run = await mod.start(ctx); t.after(() => run.stop());
  const [pat, fn] = handlers.find(x => x[0] === "thread.finished");
  fs.writeFileSync(h.file, line(1) + "\n" + line(2) + "\n");
  await fn({ type: "thread.finished", payload: { session: "someone-else", turn: 1 } });   // not a session of this space: ignored
  assert.equal(events.length, 0);
  await fn({ type: "thread.finished", payload: { session: S, turn: 1 } });
  assert.deepEqual(events.map(e => e[0]), ["runner.sealed"]);
  assert.equal((await h.port.getCheckpoint(S)).seq, 2);
  fs.writeFileSync(h.file, line(7) + "\n");                                                  // history rewritten: said plainly, nothing breaks
  await fn({ type: "thread.finished", payload: { session: S, turn: 2 } });
  assert.deepEqual(events.map(e => e[0]), ["runner.sealed", "runner.seal-failed"]);
  assert.equal(events[1][1].code, "rewritten");
});
