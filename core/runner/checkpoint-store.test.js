// The space-side checkpoint store: whole or nothing, fsynced, capped, authorized per call, and the two-machine hand-over.
import "./testing/hosted-guard.js";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { SCRATCH } from "../../test/scratch.mjs";
import { createCheckpointStore, ACTIONS } from "./checkpoint-store.js";
import { createCheckpointServer, remoteSync } from "./checkpoint-wire.js";
import { createSessionSync, restore, localReaderFor } from "./sync.js";

const SPACE = "spc_harlow000001", OTHER = "spc_northwind0001";
const chain = (space = SPACE, who = "per_alex") => ({ space, hops: [{ actor: { kind: "person", id: who, space } }], labels: { trust: "member", red: "internal", source_spaces: [space] } });
const allow = async () => ({ effect: "allow" });
const tmp = () => fs.mkdtempSync(path.join(SCRATCH, "cps-"));
const rm = d => fs.rmSync(d, { recursive: true, force: true });
const sha = b => crypto.createHash("sha256").update(b).digest("hex");
const mk = (root, extra = {}) => createCheckpointStore({ space: SPACE, root, authorize: allow, ...extra });
const A = chain();
const enospc = () => Object.assign(new Error("no space"), { code: "ENOSPC" });
const left = root => { const out = []; const w = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (e.isDirectory()) w(path.join(d, e.name)); else if (/\.tmp-/.test(e.name)) out.push(e.name); } }; w(root); return out; };

/** One whole checkpoint through the store's own calls: a file, two lines, the record. */
async function turn(S, s, n, text, prev = {}) {
  const f = Buffer.from(text), r = await S.putFile(A, s, "files/doc.txt", f);
  await S.appendTranscript(A, s, [{ seq: n * 2 - 1, line: `a${n}` }, { seq: n * 2, line: `r${n}` }]);
  return S.putCheckpoint(A, s, { turn: n, seq: n * 2, manifest: { ...prev, "files/doc.txt": { hash: sha(f), version: r.version, len: f.length } }, state: { n } });
}

test("store: a session's checkpoints round-trip through the runner's own sync and restore", async () => {
  const root = tmp(), a = tmp(), b = tmp();
  try {
    const S = mk(root), port = S.port(() => A);
    for (const d of ["work/files", "work/home/.claude", "state"]) fs.mkdirSync(path.join(a, d), { recursive: true });
    const sy = createSessionSync({ space: port, session: "s1", work: path.join(a, "work"), state: path.join(a, "state"), reader: localReaderFor(path.join(a, "work")), seal: s => s });
    fs.writeFileSync(path.join(a, "work/files/doc.txt"), "v1");
    await sy.line('{"type":"result"}'); assert.equal(await sy.checkpoint(), true);
    await new Promise(r => setTimeout(r, 1100));
    fs.writeFileSync(path.join(a, "work/files/doc.txt"), "v2"); fs.writeFileSync(path.join(a, "work/files/gone.txt"), "x");
    await sy.line('{"type":"result"}'); assert.equal(await sy.checkpoint(), true);
    await new Promise(r => setTimeout(r, 1100));
    fs.rmSync(path.join(a, "work/files/gone.txt"));
    await sy.line('{"type":"result"}'); assert.equal(await sy.checkpoint(), true);
    fs.mkdirSync(path.join(b, "work/files"), { recursive: true });
    const got = await restore({ space: mk(root).port(() => A), session: "s1", work: path.join(b, "work"), state: path.join(b, "state"), verify: () => true });   // a store reopened from disk
    assert.equal(got.turn, 3);
    assert.equal(fs.readFileSync(path.join(b, "work/files/doc.txt"), "utf8"), "v2");
    assert.equal(fs.existsSync(path.join(b, "work/files/gone.txt")), false);
    assert.equal(fs.readFileSync(path.join(b, "state/s1/transcript.jsonl"), "utf8").split("\n").filter(Boolean).length, 3);
    assert.deepEqual(left(root), []);
  } finally { rm(root); rm(a); rm(b); }
});

test("store: every call is authorized as the session's chain: another space, a denial and a bad session id all read as not found", async () => {
  const root = tmp();
  try {
    const seen = [];
    const S = mk(root, { authorize: async i => { seen.push([i.action, i.resource]); return { effect: i.action === ACTIONS.write ? "allow" : "deny" }; } });
    await S.appendTranscript(A, "s1", [{ seq: 1, line: "x" }]);
    assert.deepEqual(seen[0], [ACTIONS.write, `vyre://${SPACE}/session/s1`]);
    await assert.rejects(() => S.getCheckpoint(A, "s1"), { code: "not_found" });          // read denied
    await assert.rejects(() => S.getTranscript(A, "s1", 1), { code: "not_found" });
    const S2 = mk(root);
    await assert.rejects(() => S2.appendTranscript(chain(OTHER), "s1", []), { code: "not_found" });
    await assert.rejects(() => S2.appendTranscript(null, "s1", []), { code: "not_found" });
    for (const bad of ["../x", "a/b", "", "x".repeat(101)]) await assert.rejects(() => S2.getCheckpoint(A, bad), { code: "not_found" });
    assert.deepEqual(fs.readdirSync(root).sort(), ["s1"], "nothing was created for a refused call");
  } finally { rm(root); }
});

test("store: a checkpoint is visible only once complete: a missing file, a wrong hash or a short transcript is refused and the last one stays", async () => {
  const root = tmp();
  try {
    const S = mk(root);
    await turn(S, "s1", 1, "one");
    const prev = (await S.getCheckpoint(A, "s1")).manifest;
    await assert.rejects(() => S.putCheckpoint(A, "s1", { turn: 2, seq: 2, manifest: { ...prev, "files/doc.txt": { hash: sha("two"), version: 9, len: 3 } }, state: {} }), { code: "incomplete" });
    const r = await S.putFile(A, "s1", "files/doc.txt", Buffer.from("two"));
    await assert.rejects(() => S.putCheckpoint(A, "s1", { turn: 2, seq: 2, manifest: { "files/doc.txt": { hash: sha("TWO"), version: r.version, len: 3 } }, state: {} }), { code: "incomplete" });
    await assert.rejects(() => S.putCheckpoint(A, "s1", { turn: 2, seq: 40, manifest: { "files/doc.txt": { hash: sha("two"), version: r.version, len: 3 } }, state: {} }), { code: "incomplete" });
    const cp = await S.getCheckpoint(A, "s1");
    assert.equal(cp.turn, 1); assert.equal(cp.manifest["files/doc.txt"].version, 1);
    assert.equal((await S.getFile(A, "s1", "files/doc.txt", 1)).toString(), "one");
    await S.appendTranscript(A, "s1", [{ seq: 3, line: "a2" }]);
    assert.deepEqual(await S.putCheckpoint(A, "s1", { turn: 2, seq: 3, manifest: { "files/doc.txt": { hash: sha("two"), version: r.version, len: 3 } }, state: {} }), { ok: true });
  } finally { rm(root); }
});

test("store: a crash between the record and the commit leaves the last complete checkpoint, and a restart sweeps the temp files", async () => {
  const root = tmp();
  try {
    const S = mk(root);
    await turn(S, "s1", 1, "one");
    const prev = (await S.getCheckpoint(A, "s1")).manifest;
    // The process dies when it is about to replace CURRENT (the cp/2.json record is already on disk).
    const dying = { ...fs, renameSync: (from, to) => { if (path.basename(to) === "CURRENT") throw Object.assign(new Error("killed"), { code: "EKILL" }); return fs.renameSync(from, to); } };
    const D = mk(root, { fs: dying });
    await assert.rejects(() => turn(D, "s1", 2, "two", prev), { code: "EKILL" });
    assert.ok(fs.existsSync(path.join(root, "s1/cp/2.json")), "the record of the dead checkpoint is on disk");
    const again = mk(root);                                              // restart
    const cp = await again.getCheckpoint(A, "s1");
    assert.equal(cp.turn, 1, "still the last complete checkpoint");
    assert.deepEqual(left(root), []);
    // A new machine resumes from checkpoint 1 and takes turn 2 over; the dead one's file version and lines are replaced, not merged.
    await again.appendTranscript(A, "s1", [{ seq: 3, line: "other-a2" }, { seq: 4, line: "other-r2" }]);
    const f = Buffer.from("two-again"), r = await again.putFile(A, "s1", "files/doc.txt", f);
    await again.putCheckpoint(A, "s1", { turn: 2, seq: 4, manifest: { "files/doc.txt": { hash: sha(f), version: r.version, len: f.length } }, state: {} });
    assert.deepEqual((await again.getTranscript(A, "s1", 3)).map(e => e.line), ["other-a2", "other-r2"]);
  } finally { rm(root); }
});

test("store: a full disk refuses the call with storage_full, leaves nothing half-written, and the next call works", async () => {
  const root = tmp();
  try {
    let fullNow = false;
    const S = mk(root, { fs: { ...fs, writeSync: (...x) => { if (fullNow) throw enospc(); return fs.writeSync(...x); } } });
    await turn(S, "s1", 1, "one");
    const before = await S.usage(A, "s1");
    fullNow = true;
    await assert.rejects(() => S.putFile(A, "s1", "files/big", Buffer.alloc(1000)), { code: "storage_full" });
    await assert.rejects(() => S.appendTranscript(A, "s1", [{ seq: 3, line: "x" }]), { code: "storage_full" });
    assert.deepEqual(left(root), []);
    assert.equal((await S.usage(A, "s1")).bytes, before.bytes);
    assert.equal((await S.getCheckpoint(A, "s1")).turn, 1);
    fullNow = false;
    await S.appendTranscript(A, "s1", [{ seq: 3, line: "x" }]);
    const t = fs.readFileSync(path.join(root, "s1/transcript.log"), "utf8");
    assert.deepEqual(t.split("\n").filter(Boolean).map(l => JSON.parse(l).seq), [1, 2, 3]);
  } finally { rm(root); }
});

test("store: the per-session cap and the per-file cap refuse with quota before anything is written", async () => {
  const root = tmp();
  try {
    const S = mk(root, { caps: { sessionBytes: 3000, fileBytes: 1500 } });
    await S.putFile(A, "s1", "files/a", Buffer.alloc(1200));
    await assert.rejects(() => S.putFile(A, "s1", "files/b", Buffer.alloc(1600)), { code: "quota" });
    await S.putFile(A, "s1", "files/c", Buffer.alloc(1500));
    const used = (await S.usage(A, "s1")).bytes;
    await assert.rejects(() => S.putFile(A, "s1", "files/d", Buffer.alloc(900)), { code: "quota" });
    await assert.rejects(() => S.appendTranscript(A, "s1", [{ seq: 1, line: "y".repeat(500) }]), { code: "quota" });
    assert.equal((await S.usage(A, "s1")).bytes, used);
    assert.equal(fs.existsSync(path.join(root, "s1/transcript.log")), false);
    assert.deepEqual(left(root), []);
    // the cap survives a restart: usage is counted from the disk
    assert.equal((await mk(root, { caps: { sessionBytes: 3000 } }).usage(A, "s1")).bytes, used);
  } finally { rm(root); }
});

test("store: a torn transcript tail (killed in the middle of an append) is cut off at the next start, and numbering continues", async () => {
  const root = tmp();
  try {
    const S = mk(root);
    await S.appendTranscript(A, "s1", [{ seq: 1, line: "a" }, { seq: 2, line: "b" }]);
    fs.appendFileSync(path.join(root, "s1/transcript.log"), '{"seq":3,"line":"par');
    const S2 = mk(root);
    assert.deepEqual((await S2.getTranscript(A, "s1", 1)).map(e => e.seq), [1, 2]);
    assert.deepEqual(await S2.appendTranscript(A, "s1", [{ seq: 3, line: "c" }]), { acked: 3 });
    assert.deepEqual(fs.readFileSync(path.join(root, "s1/transcript.log"), "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l).seq), [1, 2, 3]);
    await assert.rejects(() => S2.appendTranscript(A, "s1", [{ seq: 9, line: "z" }]), { code: "gap" });
  } finally { rm(root); }
});

test("store: history cannot fork: a committed line is never replaced and a machine behind the newest checkpoint is refused", async () => {
  const root = tmp();
  try {
    const S = mk(root);
    await turn(S, "s1", 1, "one");
    await assert.rejects(() => S.appendTranscript(A, "s1", [{ seq: 2, line: "different" }]), { code: "conflict" });
    assert.deepEqual(await S.appendTranscript(A, "s1", [{ seq: 2, line: "r1" }]), { acked: 2 }, "the same line again is acknowledged");
    const prev = (await S.getCheckpoint(A, "s1")).manifest;
    await turn(S, "s1", 2, "two", prev);
    await assert.rejects(() => turn(S, "s1", 2, "zombie", prev), { code: "stale" });   // a lender that lost its lease cannot commit over the new owner
  } finally { rm(root); }
});

test("wire: a runner on another computer checkpoints and resumes over the token-authenticated link; a bad token reads nothing", async () => {
  const root = tmp(), a = tmp(), b = tmp();
  const S = mk(root);
  const server = createCheckpointServer({ store: S, authenticate: t => (t === "tok-alex" ? A : t === "tok-other" ? chain(OTHER) : null) });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    const sync = remoteSync({ url, token: () => "tok-alex" });
    for (const d of ["work/files", "work/home/.claude", "state"]) fs.mkdirSync(path.join(a, d), { recursive: true });
    const sy = createSessionSync({ space: sync, session: "s1", work: path.join(a, "work"), state: path.join(a, "state"), reader: localReaderFor(path.join(a, "work")), seal: s => s });
    const bin = crypto.randomBytes(5000); fs.writeFileSync(path.join(a, "work/files/blob.bin"), bin);
    await sy.line('{"type":"result"}'); assert.equal(await sy.checkpoint(), true);
    fs.mkdirSync(path.join(b, "work/files"), { recursive: true });
    const got = await restore({ space: remoteSync({ url, token: () => "tok-alex" }), session: "s1", work: path.join(b, "work"), state: path.join(b, "state"), verify: () => true });
    assert.equal(got.turn, 1);
    assert.ok(fs.readFileSync(path.join(b, "work/files/blob.bin")).equals(bin), "binary bytes survive the wire");
    await assert.rejects(() => remoteSync({ url, token: () => "nope" }).getCheckpoint("s1"), { code: "denied" });
    await assert.rejects(() => remoteSync({ url, token: () => "tok-other" }).getCheckpoint("s1"), { code: "not_found" });
    await assert.rejects(() => remoteSync({ url, token: () => "tok-alex" }).putFile("s1", "../" + "x".repeat(2000), Buffer.alloc(1)), { code: "bad_input" });
    await assert.rejects(() => remoteSync({ url, token: () => "tok-alex" }).getFile("s1", "files/blob.bin", 99), { code: "not_found" });
  } finally { server.close(); rm(root); rm(a); rm(b); }
});

test("RN-1: the store keeps no transcript in memory: lines come from disk by offset, a replaced tail cuts the file, and a restarted store reads the same", async () => {
  const dir = tmp(), S1 = mk(dir);
  try {
    const entries = Array.from({ length: 1000 }, (_, i) => ({ seq: i + 1, line: `line-${i + 1}` }));
    await S1.appendTranscript(A, "big", entries.slice(0, 600)); await S1.appendTranscript(A, "big", entries.slice(600));
    assert.deepEqual((await S1.getTranscript(A, "big", 998)).map(e => e.seq), [998, 999, 1000]);
    assert.deepEqual((await S1.getTranscript(A, "big", 300, 3)).map(e => e.line), ["line-300", "line-301", "line-302"], "a page");
    await S1.putCheckpoint(A, "big", { turn: 1, seq: 500, manifest: {}, state: {} });
    // a machine that resumed from checkpoint 1 replaces what came after it
    await S1.appendTranscript(A, "big", [{ seq: 501, line: "new-501" }, { seq: 502, line: "new-502" }]);
    assert.equal((await S1.getTranscript(A, "big", 1)).length, 502);
    assert.equal((await S1.getTranscript(A, "big", 501))[0].line, "new-501");
    await assert.rejects(S1.appendTranscript(A, "big", [{ seq: 400, line: "other" }]), { code: "conflict" });
    const S2 = mk(dir);
    assert.deepEqual((await S2.getTranscript(A, "big", 500, 3)).map(e => e.line), ["line-500", "new-501", "new-502"]);
    assert.deepEqual(await S2.appendTranscript(A, "big", [{ seq: 503, line: "z" }]), { acked: 503 });
  } finally { rm(dir); }
});

test("RN-4: a checkpoint can follow the last by one turn only", async () => {
  const dir = tmp(), S = mk(dir);
  try {
    await S.appendTranscript(A, "t", [{ seq: 1, line: "a" }]);
    await assert.rejects(S.putCheckpoint(A, "t", { turn: 5, seq: 1, manifest: {}, state: {} }), { code: "bad_input" });
    await S.putCheckpoint(A, "t", { turn: 1, seq: 1, manifest: {}, state: {} });
    await assert.rejects(S.putCheckpoint(A, "t", { turn: 1000, seq: 1, manifest: {}, state: {} }), { code: "bad_input" });
    await S.putCheckpoint(A, "t", { turn: 2, seq: 1, manifest: {}, state: {} });
  } finally { rm(dir); }
});
