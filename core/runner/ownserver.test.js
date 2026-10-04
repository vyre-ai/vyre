// A session on the person's own server: sealed at every turn into the checkpoint store, and put back to the last whole turn after a crash.
import "../../scripts/mac-test-guard.mjs";
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
const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(SCRATCH, "own-")));
const rm = d => fs.rmSync(d, { recursive: true, force: true });
const mk = (t, fsx) => {
  const dir = tmp(); t.after(() => rm(dir));
  const store = createCheckpointStore({ space: SPACE, root: path.join(dir, "store"), authorize: async () => ({ effect: "allow" }) });
  const file = path.join(dir, "proj", `${S}.jsonl`); fs.mkdirSync(path.dirname(file), { recursive: true });
  const seal = () => createTurnSeal({ port: store.port(() => chain), session: S, file, root: dir, fs: fsx });
  return { dir, store, file, seal, port: store.port(() => chain) };
};
const line = n => JSON.stringify({ type: "user", n });

test("each turn is sealed: complete lines only, a torn tail waits, and the checkpoint names the turn", async t => {
  const h = mk(t), s = h.seal();
  fs.writeFileSync(h.file, line(1) + "\n" + line(2) + "\n" + '{"type":"asst');             // turn 1 and half a line of turn 2
  assert.deepEqual(await s.seal({ state: { cwd: "/srv/p" } }), { turn: 1, seq: 2 });
  fs.appendFileSync(h.file, 'ant","n":3}\n' + line(4) + "\n");
  assert.deepEqual(await s.seal({ state: { cwd: "/srv/p" } }), { turn: 2, seq: 4 });
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
  const s = createTurnSeal({ port: h.port, session: S, file: h.file, root: h.dir, fs: fsx });
  await s.seal({ state: {} });
  assert.ok(order.indexOf("fsync") >= 0 && order.indexOf("fsync") < order.indexOf("checkpoint"), order.join(","));
});

test("after a crash the file goes back to exactly the last whole turn, and the new process carries on from it", async t => {
  const h = mk(t), s = h.seal();
  fs.writeFileSync(h.file, line(1) + "\n" + line(2) + "\n");
  await s.seal({ state: { id: S } });
  fs.appendFileSync(h.file, line(3) + "\n" + '{"torn":'); // turn 2 started, never sealed, and the power went out mid-line
  const again = h.seal();                                 // a restarted vyred: no memory of the old cursor
  const r = await again.recover();
  assert.deepEqual(r, { turn: 1, seq: 2, state: { id: S } });
  assert.equal(fs.readFileSync(h.file, "utf8"), line(1) + "\n" + line(2) + "\n");
  assert.deepEqual(fs.readdirSync(path.dirname(h.file)).filter(f => /tmp-/.test(f)), [], "no temp file left");
  fs.appendFileSync(h.file, line(5) + "\n");
  assert.deepEqual(await again.seal({ state: {} }), { turn: 2, seq: 3 });
});

test("a restarted process that never recovered picks up from the store's checkpoint without sealing a line twice", async t => {
  const h = mk(t);
  fs.writeFileSync(h.file, line(1) + "\n" + line(2) + "\n");
  await h.seal().seal({ state: {} });
  fs.appendFileSync(h.file, line(3) + "\n");
  assert.deepEqual(await h.seal().seal({ state: {} }), { turn: 2, seq: 3 });
  assert.equal((await h.port.getTranscript(S, 1)).length, 3);
});

test("a file the provider rewrote is refused as a continuation, and the last checkpoint stands", async t => {
  const h = mk(t), s = h.seal();
  fs.writeFileSync(h.file, line(1) + "\n" + line(2) + "\n");
  await s.seal({ state: {} });
  fs.writeFileSync(h.file, line(9) + "\n" + line(8) + "\n" + line(7) + "\n");               // compaction: different lines, longer file
  await assert.rejects(h.seal().seal({ state: {} }), e => e.code === "rewritten");
  fs.writeFileSync(h.file, line(1) + "\n");                                                   // shorter than the checkpoint
  await assert.rejects(s.seal({ state: {} }), e => e.code === "rewritten");
  assert.equal((await h.port.getCheckpoint(S)).turn, 1);
});

test("nothing sealed yet: recover answers null and touches nothing; a missing transcript is not_found", async t => {
  const h = mk(t);
  fs.writeFileSync(h.file, line(1) + "\n");
  assert.equal(await h.seal().recover(), null);
  assert.equal(fs.readFileSync(h.file, "utf8"), line(1) + "\n");
  fs.rmSync(h.file);
  await assert.rejects(h.seal().seal({ state: {} }), e => e.code === "not_found");
});

test("a store that refuses (quota) fails the seal and leaves the last checkpoint", async t => {
  const dir = tmp(); t.after(() => rm(dir));
  const store = createCheckpointStore({ space: SPACE, root: path.join(dir, "store"), authorize: async () => ({ effect: "allow" }), caps: { sessionBytes: 400 } });
  const file = path.join(dir, "proj", `${S}.jsonl`); fs.mkdirSync(path.dirname(file));
  const s = createTurnSeal({ port: store.port(() => chain), session: S, file, root: dir });
  fs.writeFileSync(file, line(1) + "\n");
  await s.seal({ state: {} });
  fs.appendFileSync(file, (line(2) + "\n").repeat(40));
  await assert.rejects(s.seal({ state: {} }), e => e.code === "quota");
  assert.equal((await store.port(() => chain).getCheckpoint(S)).turn, 1);
});

test("the runner module seals a finished turn when the sessions side names its transcript, and says so in an event", async t => {
  const { default: mod, seams } = await import("./index.js");
  const h = mk(t);
  const root = path.join(h.dir, "mod"); fs.mkdirSync(root);
  const handlers = []; const events = [];
  const ports = { device: "dev_kit", vault: {}, sync: {}, grants: () => ({}), ownServer: { port: () => h.port, resolve: async e => (e.payload.session === S ? { space: SPACE, session: S, file: h.file, root: h.dir, state: { cwd: "/srv/p" } } : null) } };
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

test("RN-3: the file must be this session's own transcript: a secret file, a path with .., a link, another session's file and a link as the project folder are all refused and nothing is read or written", async t => {
  const h = mk(t), secret = path.join(h.dir, "id_ed25519"); fs.writeFileSync(secret, "PRIVATE-KEY\n");
  const other = path.join(h.dir, "proj", "11111111-0000-4000-8000-000000000002.jsonl"); fs.writeFileSync(other, line(1) + "\n");
  fs.writeFileSync(h.file, line(1) + "\n");
  const link = path.join(h.dir, "proj", "link.jsonl"); fs.symlinkSync(secret, link);
  const viaLink = path.join(h.dir, "projlink"); fs.symlinkSync(path.join(h.dir, "proj"), viaLink);
  const reads = []; const fsx = { ...fs, openSync: (f, ...a) => { reads.push(String(f)); return fs.openSync(f, ...a); } };
  for (const file of [secret, h.dir + "/proj/../id_ed25519", h.dir + "/proj/x/../" + S + ".jsonl", other, link, path.join(viaLink, `${S}.jsonl`), "/etc/passwd", "relative.jsonl"]) {
    const s = createTurnSeal({ port: h.port, session: S, file, root: h.dir, fs: fsx });
    await assert.rejects(s.seal({ state: {} }), e => e.code === "refused", `seal refused for ${file}`);
    await assert.rejects(s.recover(), e => e.code === "refused", `recover refused for ${file}`);
  }
  // the session's own name but as a symlink to a secret
  const own2 = path.join(h.dir, "proj2"); fs.mkdirSync(own2); fs.symlinkSync(secret, path.join(own2, `${S}.jsonl`));
  await assert.rejects(createTurnSeal({ port: h.port, session: S, file: path.join(own2, `${S}.jsonl`), root: h.dir, fs: fsx }).seal({ state: {} }), e => e.code === "refused");
  assert.deepEqual(reads.filter(f => !f.includes("/store/")), [], "no file was even opened");
  assert.equal(fs.readFileSync(secret, "utf8"), "PRIVATE-KEY\n");
  assert.equal(await h.port.getCheckpoint(S), null, "nothing reached the store");
});

test("a second finished event for a turn already sealed is not a failure: the same checkpoint comes back", async t => {
  const h = mk(t), s = h.seal();
  fs.writeFileSync(h.file, line(1) + "\n");
  assert.deepEqual(await s.seal({ state: {} }), { turn: 1, seq: 1 });
  assert.deepEqual(await s.seal({ state: {} }), { turn: 1, seq: 1, unchanged: true });
  assert.equal((await h.port.getCheckpoint(S)).turn, 1);
});

test("RN-4: a lent computer cannot push the turn number far ahead: a checkpoint more than one past the last is refused and the next honest turn still seals", async t => {
  const h = mk(t), s = h.seal();
  fs.writeFileSync(h.file, line(1) + "\n");
  await s.seal({ state: {} });
  await h.port.appendTranscript(S, [{ seq: 2, line: "x" }]);
  await assert.rejects(h.port.putCheckpoint(S, { turn: 1000, seq: 2, manifest: {}, state: {} }), e => e.code === "bad_input");
  await assert.rejects(h.port.putCheckpoint(S, { turn: Number.MAX_SAFE_INTEGER, seq: 2, manifest: {}, state: {} }), e => e.code === "bad_input");
  fs.appendFileSync(h.file, line(2) + "\n");
  assert.deepEqual(await h.seal().seal({ state: {} }), { turn: 2, seq: 2 }, "the line a lent machine added after the checkpoint is replaced by the owner's and the turn follows");
});

test("RN-1: a 100 MB transcript, sealed in 50 turns: memory stays flat and each turn reads about the new bytes", { timeout: 300_000 }, async t => {
  const h = mk(t);
  const big = JSON.stringify({ type: "assistant", text: "x".repeat(1000) });
  const fd = fs.openSync(h.file, "w"); const blockLines = (big + "\n").repeat(1000); for (let i = 0; i < 100; i++) fs.writeSync(fd, Buffer.from(blockLines).subarray(0)); fs.closeSync(fd);   // ~100 MB
  let readBytes = 0;
  const fsx = { ...fs, readSync: (fd, b, off, len, pos) => { const n = fs.readSync(fd, b, off, len, pos); readBytes += n; return n; } };
  const s = createTurnSeal({ port: h.port, session: S, file: h.file, root: h.dir, fs: fsx });
  await s.seal({ state: {} });
  global.gc?.();
  const base = process.memoryUsage().rss; let peak = base;
  const perTurn = [];
  for (let i = 0; i < 50; i++) {
    fs.appendFileSync(h.file, (big + "\n").repeat(100));      // ~100 KB of new lines
    readBytes = 0; await s.seal({ state: {} }); perTurn.push(readBytes);
    peak = Math.max(peak, process.memoryUsage().rss);
  }
  assert.ok(peak - base < 30 * 1024 * 1024, `rss grew ${((peak - base) / 1048576).toFixed(1)} MB over 50 turns`);
  assert.ok(Math.max(...perTurn) < 3 * 100 * 1024, `a turn read ${Math.max(...perTurn)} bytes for about 100 KB of new lines`);
  const cp = await h.port.getCheckpoint(S); assert.equal(cp.turn, 51); assert.equal(cp.seq, 100_000 + 5000);
});

test("RN-3b: the file swapped for a link between the check and the open is never read, and a folder swapped before the recover rename is never written into", async t => {
  const h = mk(t), secret = path.join(h.dir, "daemon-only"); fs.writeFileSync(secret, "TOP-SECRET-LINE\n");
  fs.writeFileSync(h.file, line(1) + "\n");
  let swapped = false;
  const fsx = { ...fs, openSync: (p, ...a) => { if (!swapped && p === h.file) { swapped = true; fs.rmSync(h.file); fs.symlinkSync(secret, h.file); } return fs.openSync(p, ...a); } };
  await assert.rejects(createTurnSeal({ port: h.port, session: S, file: h.file, root: h.dir, fs: fsx }).seal({ state: {} }), e => e.code === "refused");
  assert.equal(await h.port.getCheckpoint(S), null);
  assert.deepEqual((await h.port.getTranscript(S, 1)).map(e => e.line), [], "nothing of the secret was stored");
  // a different file with the same name put in place (not a link): identity differs from what was checked
  fs.rmSync(h.file); fs.writeFileSync(h.file, line(1) + "\n"); fs.linkSync(h.file, h.file + ".keep");   // the old file stays alive, so its inode number cannot be reused by the new one
  let n = 0;
  const fsy = { ...fs, openSync: (p, ...a) => { if (n++ === 0 && p === h.file) { fs.rmSync(h.file); fs.writeFileSync(h.file, "TOP-SECRET-LINE\n"); } return fs.openSync(p, ...a); } };
  await assert.rejects(createTurnSeal({ port: h.port, session: S, file: h.file, root: h.dir, fs: fsy }).seal({ state: {} }), e => e.code === "refused");
  // the project folder swapped for a link to another folder right before recover's rename
  fs.rmSync(h.file); fs.rmSync(h.file + ".keep"); fs.writeFileSync(h.file, line(1) + "\n"); await h.seal().seal({ state: {} });
  const elsewhere = path.join(h.dir, "elsewhere"); fs.mkdirSync(elsewhere);
  const proj = path.dirname(h.file), moved = proj + "-real";
  let opens = 0;
  const fsw = { ...fs, openSync: (p, ...a) => { if (String(p).includes(".tmp-") && opens++ === 0) { fs.renameSync(proj, moved); fs.symlinkSync(elsewhere, proj); } return fs.openSync(p, ...a); } };
  await assert.rejects(createTurnSeal({ port: h.port, session: S, file: h.file, root: h.dir, fs: fsw }).recover(), e => e.code === "refused");
  assert.deepEqual(fs.readdirSync(elsewhere), [], "nothing was written into the folder the session chose");
});

test("RN-3b loop: another process swaps the transcript and its folder for links to a secret while the owner seals 300 turns; no line of the secret is ever stored", { timeout: 120_000 }, async t => {
  const { spawn } = await import("node:child_process");
  const h = mk(t), secret = path.join(h.dir, "daemon-only"); fs.writeFileSync(secret, "TOP-SECRET-LINE\n");
  const secretDir = path.join(h.dir, "secretdir"); fs.mkdirSync(secretDir); fs.writeFileSync(path.join(secretDir, `${S}.jsonl`), "TOP-SECRET-LINE\n");
  const proj = path.dirname(h.file), real = h.file + ".real";
  fs.writeFileSync(h.file, line(0) + "\n"); fs.copyFileSync(h.file, real);
  const swapper = spawn(process.execPath, ["-e", `const fs=require("fs");const [f,real,sec,proj,sd]=process.argv.slice(1);let i=0;
    setInterval(()=>{for(let k=0;k<50;k++){try{if(i++%2){fs.rmSync(f,{force:true});fs.symlinkSync(sec,f)}else{fs.rmSync(f,{force:true});fs.copyFileSync(real,f)}}catch{}}},1);`, h.file, real, secret, proj, secretDir], { stdio: "ignore" });
  t.after(() => swapper.kill("SIGKILL"));
  const s = h.seal(); let sealed = 0;
  for (let i = 1; i <= 300; i++) {
    try { fs.appendFileSync(real, line(i) + "\n"); } catch {}
    try { await s.seal({ state: {} }); sealed++; } catch (e) { assert.ok(["refused", "rewritten", "not_found"].includes(e.code), `unexpected ${e.code}: ${e.message}`); }
  }
  swapper.kill("SIGKILL");
  const stored = (await h.port.getTranscript(S, 1)).map(e => e.line);
  assert.ok(!stored.some(l => l.includes("TOP-SECRET")), "a line of the secret was stored");
  assert.ok(sealed > 0, "at least some seals went through between swaps");
});
