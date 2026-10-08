// @ts-check
// clipboard tests. None of them touches the person's clipboard: the helper path runs a fake (or
// the real Swift helper on a private named pasteboard), and the pbcopy path runs fake pbcopy and
// pbpaste found first on PATH. The value is a canary that must never show up in a result.

import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Clipboard } from "./clipboard.js";
import { Helper } from "./mac/helper.js";
import { writeFakes, writeFakePb } from "./mac/fakes.js";
import { SCRATCH } from "../../test/scratch.mjs";

const canary = () => `fixture-canary-${crypto.randomBytes(12).toString("hex")}`;
const sha = v => crypto.createHash("sha256").update(v).digest("hex");
const wait = ms => new Promise(r => setTimeout(r, ms));

function tmp(t) {
  const dir = fs.mkdtempSync(path.join(SCRATCH, "vyre-clip-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Fake timers: the 90 s clear fires when the test says so. */
function timers() {
  const due = new Map(); let id = 0;
  return { due, set: (fn, ms) => { due.set(++id, { fn, ms }); return id; }, clear: t => { due.delete(t); }, fire: () => { for (const [k, v] of [...due]) { due.delete(k); v.fn(); } } };
}

async function until(fn, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return; await wait(20); }
  throw new Error("timed out waiting");
}

test("helper path: copy returns when it clears, never the value; clears after 90 s only if unchanged", async t => {
  const dir = tmp(t);
  const f = writeFakes(dir);
  const tm = timers();
  let empties = 0;
  const clip = new Clipboard({ helper: new Helper({ name: "clip", dir, command: f.helpers.clip }), platform: "darwin", now: () => 5000, timers: tm, onEmpty: () => { empties++; } });
  t.after(() => clip.stop());
  const v = canary();
  const out = await clip.copy(v);
  assert.deepEqual(out, { clearsAt: 5000 + 90_000, via: "helper" });
  assert.ok(!JSON.stringify(out).includes(v));
  // the fake helper rewrites its state file as it goes: a read that lands mid-write sees nothing yet
  const st = () => { try { return JSON.parse(fs.readFileSync(f.state.clip, "utf8")); } catch { return {}; } };
  assert.equal(st().hash, sha(v), "the helper got the value on stdin");
  assert.equal(tm.due.size, 1, "one timer, for the clear");
  tm.fire();
  await until(() => st().hash === null);
  assert.equal(clip.holding(), false);
  assert.equal(empties, 1);

  // Something else copied in between: the clear leaves it alone.
  await clip.copy(canary());
  const bumped = await clip.request({ op: "bump" });
  assert.equal(bumped.ok, true);
  assert.deepEqual(await clip.clear("lock"), { cleared: false });
  await until(() => st().hash === "someone-else");
});

test("helper path: closing the helper's stdin clears what it copied (a crash still wipes it)", async t => {
  const dir = tmp(t);
  const f = writeFakes(dir);
  const clip = new Clipboard({ helper: new Helper({ name: "clip", dir, command: f.helpers.clip }), platform: "darwin", timers: timers() });
  await clip.copy(canary());
  clip.stopChild();
  // The fake helper rewrites its state file; a read can land on an empty or half-written file (seen on a hosted runner), so a read that does
  // not parse is retried, never counted as the answer.
  const st = () => { try { return JSON.parse(fs.readFileSync(f.state.clip, "utf8")); } catch { return null; } };
  await until(() => { const s = st(); return Boolean(s) && s.eofCleared === true; });
  let last = null;
  await until(() => { last = st(); return last !== null; });
  assert.equal(/** @type {any} */ (last).hash, null);
});

test("pbcopy fallback: stdin in, hash kept, compare with pbpaste before clearing", async t => {
  const dir = tmp(t);
  const board = path.join(dir, "board");
  const env = { ...process.env, ...writeFakePb(path.join(dir, "bin"), board) };
  const tm = timers();
  const clip = new Clipboard({ helper: null, platform: "darwin", env, timers: tm });
  const v = canary();
  const out = await clip.copy(v);
  assert.equal(out.via, "pbcopy");
  assert.match(out.warning || "", /clipboard managers/);
  assert.ok(!JSON.stringify(out).includes(v));
  assert.equal(fs.readFileSync(board, "utf8"), v, "pbcopy got it on stdin");
  assert.deepEqual(await clip.clear("timeout"), { cleared: true });
  assert.equal(fs.readFileSync(board, "utf8"), "");

  await clip.copy(canary());
  fs.writeFileSync(board, "something the person copied");
  assert.deepEqual(await clip.clear("timeout"), { cleared: false });
  assert.equal(fs.readFileSync(board, "utf8"), "something the person copied");
});

test("a helper that cannot run falls back to pbcopy", async t => {
  const dir = tmp(t);
  const board = path.join(dir, "board");
  const env = { ...process.env, ...writeFakePb(path.join(dir, "bin"), board) };
  const broken = new Helper({ name: "clip", dir, command: [path.join(dir, "missing-binary")] });
  const clip = new Clipboard({ helper: broken, platform: "darwin", env, timers: timers() });
  const v = canary();
  const out = await clip.copy(v);
  assert.equal(out.via, "pbcopy");
  await clip.stop();
  assert.equal(fs.readFileSync(board, "utf8"), "");
});

test("off a Mac, copy is refused with words a person can act on", async () => {
  const clip = new Clipboard({ platform: "linux" });
  const v = canary();
  await assert.rejects(clip.copy(v), e => /works on a Mac only/.test(e.message) && !e.message.includes(v));
});

const real = process.platform === "darwin" && fs.existsSync("/usr/bin/swiftc");

test("the real Swift helper builds, copies to a private pasteboard, and clears it", { skip: !real }, async t => {
  // Not tmp(t): after hooks run in the order they were added, and the release below starts the
  // helper again, which rebuilds it into a folder already removed. Release first, then remove.
  const dir = fs.mkdtempSync(path.join(SCRATCH, "vyre-clip-"));
  const out = path.join(dir, "helpers");
  const helper = new Helper({ name: "clip", dir: out });
  /** @type {Clipboard|null} */
  let clip = null;
  t.after(async () => {
    if (clip) { try { await clip.request({ op: "release" }); } catch { /* gone */ } clip.stopChild(); }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const built = await helper.ensure();
  assert.ok(fs.existsSync(built.path));
  const name = `vyre-test-${crypto.randomBytes(8).toString("hex")}`;
  clip = new Clipboard({ helper, platform: "darwin", pasteboard: name, timers: timers() });
  const v = canary();
  const r = await clip.copy(v);
  assert.equal(r.via, "helper");
  assert.equal((await clip.request({ op: "hash" })).sha256, sha(v));
  assert.deepEqual(await clip.clear("timeout"), { cleared: true });
  assert.equal((await clip.request({ op: "hash" })).sha256, null);

  // A swapped binary is thrown away and rebuilt before it runs.
  clip.stopChild();
  fs.writeFileSync(built.path, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  const w = canary();
  const again = await clip.copy(w);
  assert.equal(again.via, "helper");
  assert.equal((await clip.request({ op: "hash" })).sha256, sha(w), "the rebuilt helper did the copy");
  await clip.clear("stop");
});

test("the watch and type helpers build with swiftc", { skip: !real }, async t => {
  const dir = tmp(t);
  for (const name of /** @type {const} */ (["watch", "type"])) {
    const h = await new Helper({ name, dir: path.join(dir, "helpers") }).ensure();
    assert.ok(fs.statSync(h.path).size > 0, name);
  }
});

test("a build folder others can read is refused", { skip: process.platform !== "darwin" }, async t => {
  const dir = tmp(t);
  const out = path.join(dir, "open");
  fs.mkdirSync(out, { mode: 0o755 });
  fs.chmodSync(out, 0o755);
  await assert.rejects(new Helper({ name: "clip", dir: out, swiftc: "/usr/bin/true" }).ensure(), /not a private folder/);
});

test("a private pasteboard never falls back to pbcopy, so the real clipboard is untouched", async t => {
  const dir = tmp(t);
  // A fake pbcopy that records anything written: it must stay empty.
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  const log = path.join(dir, "pbcopy.log");
  fs.writeFileSync(path.join(bin, "pbcopy"), `#!/bin/sh\ncat >> ${JSON.stringify(log)}\n`, { mode: 0o755 });
  const clip = new Clipboard({ helper: null, platform: "darwin", pasteboard: "vyre-test-private", env: { ...process.env, PATH: bin + ":" + process.env.PATH }, timers: timers() });
  const v = canary();
  await assert.rejects(clip.copy(v), e => /private pasteboard needs the clipboard helper/.test(e.message) && !e.message.includes(v));
  assert.ok(!fs.existsSync(log), "pbcopy was not run");
});

test("vault.clipboard.pasteboard is read from config, and only a plausible name", async () => {
  const { privatePasteboard } = await import("./tools/surfaces.js");
  assert.equal(privatePasteboard({ vault: { clipboard: { pasteboard: "vyre-demo" } } }), "vyre-demo");
  assert.equal(privatePasteboard({ vault: { clipboard: { pasteboard: "bad name; rm" } } }), undefined);
  assert.equal(privatePasteboard({}), undefined);
});
