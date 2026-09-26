// @ts-check
// Secret-shaped fixtures are split in two, so the repository's own secret scan does not flag this file.
// The clipboard store against a fake helper: nothing here reads or writes a real pasteboard, and
// every file lives in a temp dir.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Clips, looksSecret, label, age, NOTE, TEXT_MAX } from "./clips.js";

function tmp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-clips-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, "sub", "clips.json");
}

/** A helper that records what it is asked, and hands out pasteboard counts. */
function fakeHelper() {
  const h = {
    count: 100,
    /** @type {any[]} */ writes: [],
    /** @type {any[]} */ watches: [],
    /** @type {((item: any) => void) | null} */ onClip: null,
    watchClips(on, opts = {}) { h.watches.push({ on, ...opts }); return Promise.resolve({ watching: on, count: h.count }); },
    writeClip(what) { h.writes.push(what); h.count++; return Promise.resolve({ ok: true, count: h.count }); },
    /** The helper saw a copy. */
    copy(item) { h.count++; h.onClip?.({ count: h.count, at: clock.t, ...item }); },
  };
  return h;
}
const clock = { t: 1_800_000_000_000 };
const now = () => clock.t;

test("clips: watching routes the helper's items into the store, newest first", async t => {
  const helper = fakeHelper();
  const c = new Clips({ file: tmp(t), helper, now });
  assert.deepEqual(await c.start(), { watching: true, count: 100 });
  assert.deepEqual(helper.watches, [{ on: true }]);
  helper.copy({ text: "first", app: "Notes" });
  clock.t += 1000;
  helper.copy({ text: "second", app: "Safari" });
  helper.copy({ files: ["/Users/someone/Documents/report.pdf", "/tmp/b.txt"], app: "Finder" });
  helper.copy({ image: true, app: "Preview" });
  assert.deepEqual(c.list().map(x => x.kind), ["image", "files", "text", "text"]);
  assert.deepEqual(c.list().map(label), ["Image", "report.pdf and 1 more", "second", "first"]);
  await c.stop();
  assert.equal(helper.onClip, null);
  assert.deepEqual(helper.watches.at(-1), { on: false });
});

test("clips: the same text copied again moves to the top instead of repeating", t => {
  const c = new Clips({ file: tmp(t), helper: fakeHelper(), now });
  const t0 = clock.t;
  c.add({ count: 1, at: t0 + 1, text: "alpha" });
  c.add({ count: 2, at: t0 + 2, text: "beta" });
  c.add({ count: 3, at: t0 + 3, text: "alpha", app: "Mail" });
  assert.deepEqual(c.list().map(x => [x.text, x.t - t0, x.app]), [["alpha", 3, "Mail"], ["beta", 2, undefined]]);
});

test("clips: capped by count and by age", t => {
  const c = new Clips({ file: tmp(t), helper: fakeHelper(), now, max: 3, days: 7 });
  for (let i = 0; i < 5; i++) c.add({ count: i, at: clock.t, text: "item " + i });
  assert.deepEqual(c.list().map(x => x.text), ["item 4", "item 3", "item 2"]);
  const d = new Clips({ file: tmp(t), helper: fakeHelper(), now, days: 7 });
  d.add({ count: 1, at: clock.t - 8 * 86400_000, text: "last week and a day" });
  d.add({ count: 2, at: clock.t - 6 * 86400_000, text: "six days" });
  assert.deepEqual(d.list().map(x => x.text), ["six days"]);
  clock.t += 2 * 86400_000;
  assert.deepEqual(d.list(), [], "ages out while running, too");
});

test("clips: long text is kept to the storage cap and labelled on one short line", t => {
  const c = new Clips({ file: tmp(t), helper: fakeHelper(), now });
  const long = "word ".repeat(10_000);
  const x = c.add({ count: 1, at: 1, text: "line one\n\n  line two " + long });
  assert.ok(x && x.text && x.text.length === TEXT_MAX);
  const l = label(/** @type {any} */ (x));
  assert.ok(l.startsWith("line one line two word"));
  assert.ok(l.length <= 200 && l.endsWith("…"));
});

const SECRETS = [
  "sk" + "-proj-abcdefghijklmnopqrstuvwxyz0123456789",
  "sk_live_51Habcdefghijklmnop",
  "gh" + "p_abcdefghijklmnopqrstuvwxyz0123456789",
  "github_pat_11ABCDEFG0123456789_abcdefghijklmnop",
  "glpat-abcdefghij0123456789",
  "xo" + "xb-1234567890-0987654321-abcdefghijklmnop",
  "AK" + "IAIOSFODNN7EXAMPLE",
  "AIzaSyA-abcdefghijklmnopqrstuvwxyz01234",
  "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
  "-----BEGIN OPENSSH PRIVATE " + "KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----",
  "-----BEGIN RSA PRIVATE " + "KEY-----\nMIIEpAIBAAKCAQEA\n-----END RSA PRIVATE KEY-----",
  "-----BEGIN PGP PRIVATE KEY BLOCK-----",
  "export OPENAI_API_KEY=abc123def456ghi789",
  "DB_PASSWORD=correcthorsebattery",
  '{"token": "abcdef123456"}',
  "password: hunter2hunter2",
  "curl -H 'Authorization: Bearer abcdefghijklmnop0123456789' https://api.example.com",
  "postgres://admin:s3cretpass@db.example.com:5432/app",
  "https://example.com/reset?token=abc123def456ghi",
  "https://bucket.s3.amazonaws.com/f?X-Amz-Signature=abcdef0123456789",
  "482913",
  "4829 1375",
  "482 913",
  "12345678",
  "4111 1111 1111 1111",
  "4111-1111-1111-1111",
  "Zx9Qm2Lp8Rt4Vw7Ns1Kd",
  "a8Fk2LmQ9zX3pR7tV1wY5nB0cD4eG6hJ",
  "550e8400-e29b-41d4-a716-446655440000",
  "da39a3ee5e6b4b0d3255bfef95601890afd80709",
  "here is the key a8Fk2LmQ9zX3pR7tV1wY5nB0cD4eG6hJk2Lm for later",
  "sk" + "-ant-api03-abcdefghijklmnopqrstuvwxyz",
  "npm_abcdefghijklmnopqrstuvwxyz0123456789",
  "hf_abcdefghijklmnopqrstuvwxyz01234567",
];
const PLAIN = [
  "hello world",
  "Meeting moved to Thursday at 3pm.",
  "https://example.com/docs/getting-started",
  "/Users/someone/Projects/app/src/index.js",
  "~/Downloads/invoice-2026-03.pdf",
  "someone@example.com",
  "+1 555 123 4567",
  "5551234567",
  "2026",
  "12345",
  "ask-questions-first",
  "task-list and risk-free",
  "const total = items.reduce((a, b) => a + b, 0);",
  "The quick brown fox jumps over the lazy dog 42 times.",
  "npm install --save-dev typescript",
  "tokens are counted per request",
  "supercalifragilistic",
  "Invoice 4111 is due",
  "version 1.2.3",
];

test("clips: anything that looks like a secret is never recorded", t => {
  for (const s of SECRETS) assert.equal(looksSecret(s), true, `should skip: ${s}`);
  for (const s of PLAIN) assert.equal(looksSecret(s), false, `should keep: ${s}`);
  const c = new Clips({ file: tmp(t), helper: fakeHelper(), now });
  for (const s of SECRETS) assert.equal(c.add({ count: 1, at: 1, text: s }), null);
  assert.deepEqual(c.list(), []);
  c.flush();
  assert.equal(fs.readFileSync(c.file, "utf8").includes("hunter2"), false);
});

test("clips: persisted as 0600 JSON that a new store reads back", async t => {
  const file = tmp(t);
  const c = new Clips({ file, helper: fakeHelper(), now, delayMs: 10 });
  c.add({ count: 1, at: clock.t, text: "keep me", app: "Notes" });
  c.add({ count: 2, at: clock.t, files: ["/tmp/a.txt"] });
  assert.equal(fs.existsSync(file), false, "debounced, not written per copy");
  await new Promise(r => setTimeout(r, 40));
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(file)).mode & 0o077, 0, "folder is the user's alone");
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ["clips.json"], "no temp file left behind");
  const d = new Clips({ file, helper: fakeHelper(), now });
  assert.deepEqual(d.list().map(x => x.text ?? x.files), [["/tmp/a.txt"], "keep me"]);
  fs.writeFileSync(file, "{not json");
  assert.deepEqual(new Clips({ file, helper: fakeHelper(), now }).list(), [], "a broken file is an empty history");
});

test("clips: clear and remove", t => {
  const file = tmp(t);
  const c = new Clips({ file, helper: fakeHelper(), now });
  const a = c.add({ count: 1, at: clock.t, text: "one" });
  c.add({ count: 2, at: clock.t, text: "two" });
  assert.equal(c.remove("clip:" + a?.h), true);
  assert.equal(c.remove("clip:nope"), false);
  assert.deepEqual(c.list().map(x => x.text), ["two"]);
  c.clear();
  assert.deepEqual(c.list(), []);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")).items, [], "clear writes at once");
});

test("clips: search ranks with match() and returns launcher rows", t => {
  const c = new Clips({ file: tmp(t), helper: fakeHelper(), now });
  c.add({ count: 1, at: clock.t - 3 * 3600_000, text: "the quarterly report draft", app: "Pages" });
  c.add({ count: 2, at: clock.t - 120_000, text: "report card" });
  c.add({ count: 3, at: clock.t, text: "unrelated note" });
  const r = c.search("report");
  assert.deepEqual(r.map(x => x.label), ["report card", "the quarterly report draft"], "prefix beats a later word");
  assert.deepEqual(r[0], { kind: "clip", id: r[0].id, label: "report card", sub: "2 min ago", last: clock.t - 120_000, target: "", score: 0.9 });
  assert.match(r[0].id, /^clip:[0-9a-f]{16}$/);
  assert.equal(r[1].sub, "Pages · 3 h ago");
  assert.equal(r[1].score, 0.8);
  assert.deepEqual(c.search("rpt"), [], "scattered letters in a long text do not count");
  assert.deepEqual(c.search("r"), [], "one letter is too little to search clips");
});

test("clips: a clipboard prefix lists recent clips in order, above everything", t => {
  const c = new Clips({ file: tmp(t), helper: fakeHelper(), now });
  for (const s of ["oldest", "middle", "newest"]) c.add({ count: 1, at: clock.t, text: s });
  for (const q of ["clipboard", "clip", "clips", "paste", "Paste "]) {
    const r = c.search(q, 2);
    assert.deepEqual(r.map(x => x.label), ["newest", "middle"], q);
    assert.ok(r[0].score > r[1].score && r[1].score > 2);
  }
  assert.deepEqual(c.search("clip old").map(x => x.label), ["oldest"]);
});

test("clips: pick writes through the helper, and the Capsule's own write is not recorded again", async t => {
  const helper = fakeHelper();
  const c = new Clips({ file: tmp(t), helper, now });
  await c.start();
  helper.copy({ text: "older" });
  helper.copy({ text: "newer" });
  const older = c.list()[1];
  clock.t += 5000;
  assert.deepEqual(await c.pick("clip:" + older.h), { ok: true, note: NOTE });
  assert.deepEqual(helper.writes, [{ text: "older" }]);
  assert.deepEqual(c.list().map(x => x.text), ["older", "newer"], "picked moves to the top");
  // Should the helper ever report its own write, the store drops it by count.
  helper.onClip?.({ count: helper.count, at: clock.t, text: "older" });
  assert.equal(c.list().length, 2);
  assert.equal(c.list()[0].t, clock.t);
  helper.copy({ files: ["/tmp/x.txt"] });
  await c.pick(c.search("clip")[0].id);
  assert.deepEqual(helper.writes.at(-1), { files: ["/tmp/x.txt"] });
  helper.copy({ image: true });
  assert.match(String((/** @type {any} */ (await c.pick(c.search("clip")[0].id))).error), /image/);
  assert.match(String((/** @type {any} */ (await c.pick("clip:gone"))).error), /gone/);
  await c.stop();
});

test("clips: a failed write says so", async t => {
  const helper = fakeHelper();
  helper.writeClip = () => Promise.resolve({ error: "timeout" });
  const c = new Clips({ file: tmp(t), helper, now });
  const x = c.add({ count: 1, at: clock.t, text: "hi" });
  assert.deepEqual(await c.pick("clip:" + x?.h), { error: "Could not copy: timeout" });
});

test("clips: age reads short", () => {
  assert.equal(age(5_000), "just now");
  assert.equal(age(5 * 60_000), "5 min ago");
  assert.equal(age(2 * 3600_000), "2 h ago");
  assert.equal(age(3 * 86400_000), "3 d ago");
});

test("clips: the source names nothing that sends", () => {
  const src = fs.readFileSync(new URL("./clips.js", import.meta.url), "utf8").replace(/^\s*\/\/.*$/gm, "");
  for (const bad of [/console\./, /from "node:(?:http|https|net|dgram|child_process)"/, /vyred|fetch\(|emit\(/]) assert.doesNotMatch(src, bad);
});
