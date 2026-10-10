// The server carries on a chat that ran on a computer: the lender's last whole turn becomes the chat's own transcript here, its files are put in the chat's folder without overwriting anything, and a turn that was cut is not in it.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { SCRATCH } from "../../test/scratch.mjs";
import { createCheckpointStore } from "./checkpoint-store.js";
import { createResumeLent } from "./resume-lent.js";
import { coverOf } from "./sync.js";

const SPACE = "spc_harlow000001", LENT = "ses_lent0000001", NATIVE = "7c1f0a52-0000-4000-8000-000000000001";
const chain = { space: SPACE, hops: [{ actor: { kind: "person", id: "per_alex", space: SPACE } }], labels: { trust: "member", red: "internal", source_spaces: [SPACE] } };
const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(SCRATCH, "rl-")));
const line = (/** @type {number} */ n) => JSON.stringify({ type: "user", n });

/** A lender's store with `whole` lines checkpointed and `extra` more lines that were sent after (the cut turn), and a server with a project folder. */
async function world(/** @type {any} */ t, { whole = 4, extra = 2, files = /** @type {Record<string, string>} */ ({}) } = {}) {
  const dir = tmp(); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const lent = createCheckpointStore({ space: SPACE, root: path.join(dir, "lent"), authorize: async () => ({ effect: "allow" }) }).port(() => chain);
  const own = createCheckpointStore({ space: SPACE, root: path.join(dir, "own"), authorize: async () => ({ effect: "allow" }) }).port(() => chain);
  const entries = []; for (let n = 1; n <= whole + extra; n++) entries.push({ seq: n, line: line(n) });
  await lent.appendTranscript(LENT, entries);
  /** @type {Record<string, any>} */ const manifest = {};
  for (const [rel, text] of Object.entries(files)) { const r = await lent.putFile(LENT, `files/${rel}`, Buffer.from(text)); manifest[`files/${rel}`] = { hash: crypto.createHash("sha256").update(text).digest("hex"), version: r.version, len: text.length }; }
  if (whole) await lent.putCheckpoint(LENT, { turn: 1, seq: whole, manifest, state: {} });
  const cwd = path.join(dir, "project"); fs.mkdirSync(cwd, { recursive: true });
  const root = path.join(dir, "claude", "projects"); fs.mkdirSync(root, { recursive: true });
  const file = path.join(root, cwd.replace(/[^A-Za-z0-9]/g, "-"), `${NATIVE}.jsonl`);
  /** @type {any[]} */ const said = [];
  const resume = createResumeLent({ target: async thread => (thread === "thread_a" ? { file, root, native: NATIVE, cwd } : null), port: () => own, say: (type, p) => said.push([type, p]) });
  const view = { checkpoint: () => lent.getCheckpoint(LENT), transcript: (/** @type {number} */ f, /** @type {number} */ l) => lent.getTranscript(LENT, f, l), file: (/** @type {string} */ rel, /** @type {number} */ v) => lent.getFile(LENT, rel, v) };
  const go = (/** @type {any} */ over = {}) => resume({ space: SPACE, session: LENT, thread: "thread_a", chat: null, view, ...over });
  return { dir, cwd, file, own, go, said };
}

test("the lender's last whole turn becomes the chat's own transcript here, and the cut turn is not in it", async t => {
  const w = await world(t, { whole: 4, extra: 2 });
  const r = await w.go();
  assert.deepEqual([r.resumed, r.lines], [true, 4]);
  assert.equal(fs.readFileSync(w.file, "utf8"), [1, 2, 3, 4].map(line).join("\n") + "\n", "exactly the checkpointed lines, whole");
  assert.ok(!fs.readdirSync(path.dirname(w.file)).some(n => n.endsWith(".tmp")), "no temp file is left");
  const cp = await w.own.getCheckpoint(NATIVE);
  assert.deepEqual([cp.turn, cp.seq], [1, 4], "this server's own store holds the same turn, so a later recover lands on it");
  assert.equal(w.said[0][0], "runner.resumed");
});

test("a chat with no whole turn acknowledged has nothing to carry: the file is not made", async t => {
  const w = await world(t, { whole: 0, extra: 3 });
  const r = await w.go();
  assert.equal(r.resumed, false);
  assert.ok(!fs.existsSync(w.file));
});

test("a chat this server has no place for is refused, so the session stays owed and is not lost", async t => {
  const w = await world(t);
  await assert.rejects(() => w.go({ thread: "thread_unknown" }), (/** @type {any} */ e) => e.code === "unavailable");
});

test("a transcript the home does not hold whole is refused rather than half-written", async t => {
  const w = await world(t, { whole: 4, extra: 0 });
  await assert.rejects(() => w.go({ view: { checkpoint: async () => ({ turn: 2, seq: 9, manifest: {} }), transcript: async (/** @type {number} */ f) => (f === 1 ? [{ seq: 1, line: line(1) }] : []), file: async () => null } }), (/** @type {any} */ e) => e.code === "unavailable");
  assert.ok(!fs.existsSync(w.file));
});

test("the files the session changed are put in the chat's folder when absent or identical; a different file there is never overwritten and is reported", async t => {
  const w = await world(t, { files: { "notes/a.txt": "from the Mac", "same.txt": "same", "clash.txt": "the Mac's", "../escape.txt": "x" } });
  fs.writeFileSync(path.join(w.cwd, "same.txt"), "same");
  fs.writeFileSync(path.join(w.cwd, "clash.txt"), "the server's own");
  const r = await w.go();
  assert.equal(fs.readFileSync(path.join(w.cwd, "notes", "a.txt"), "utf8"), "from the Mac");
  assert.equal(fs.readFileSync(path.join(w.cwd, "clash.txt"), "utf8"), "the server's own", "never overwritten");
  assert.deepEqual([r.files, r.conflicts], [1, ["clash.txt"]]);
  assert.ok(!fs.existsSync(path.join(path.dirname(w.cwd), "escape.txt")), "a path that climbs out of the folder is ignored");
});

test("a checkpoint whose cover does not match the transcript the home holds is not carried on (trust row 21); one that matches is", async t => {
  const w = await world(t, { whole: 3, extra: 0 });
  const view = (/** @type {any} */ cover) => ({ checkpoint: async () => ({ turn: 1, seq: 3, manifest: {}, state: { cover } }), transcript: async (/** @type {number} */ f, /** @type {number} */ l) => [1, 2, 3].slice(f - 1, f - 1 + l).map(n => ({ seq: n, line: line(n) })), file: async () => null });
  const entries = [1, 2, 3].map(n => ({ seq: n, line: line(n) }));
  const good = coverOf({}, entries, 3, 1);
  await assert.rejects(() => w.go({ view: view({ ...good, transcript: "0".repeat(64) }) }), (/** @type {any} */ e) => e.code === "unavailable" && /does not match/.test(e.message));
  assert.ok(!fs.existsSync(w.file), "nothing was written");
  assert.equal((await w.go({ view: view(good) })).resumed, true);
});
