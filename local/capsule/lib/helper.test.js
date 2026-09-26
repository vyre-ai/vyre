// @ts-check
// The helper client against a fake bin/local (a tiny node script speaking the same protocol), and,
// when the real binary is built, against it for `define` and the Contacts STATUS only. A real
// contacts query is never run here: it could put a permission dialog on the screen.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LocalHelper, NOT_BUILT, toResults, toDefineResult, firstSentence } from "./helper.js";
import { iconFile } from "./icons.js";

const FAKE = `
const mode = process.env.FAKE_MODE || "ok";
const fs = require("node:fs");
if (process.env.FAKE_COUNT) fs.appendFileSync(process.env.FAKE_COUNT, "x");
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", d => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const req = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
    if (mode === "crash") process.exit(1);
    const say = o => process.stdout.write(JSON.stringify({ id: req.id, ...o }) + "\\n");
    if (req.op === "status") say({ status: "notDetermined" });
    else if (req.op === "define" && req.q === "slow") setTimeout(() => say({ word: "slow", definition: "late" }), 500);
    else if (req.op === "define") say({ word: req.q, definition: "def of " + req.q });
    else if (req.op === "icons") setTimeout(() => say({ icons: Object.fromEntries(req.items.map(i => [i.key, req.dir + "/" + i.key + ".png"])), size: req.size }), 400);
    else if (req.op === "clip.watch") {
      say({ watching: !!req.on, count: 7 });
      if (req.on) setTimeout(() => {
        process.stdout.write(JSON.stringify({ event: "clip", item: { count: 8, at: 1, text: "from fake", board: req.board } }) + "\\n");
        if (mode === "clipdie") setTimeout(() => process.exit(1), 30);
      }, 20);
    }
    else if (req.op === "clip.write") say({ ok: true, count: 9, wrote: req });
    else if (req.op === "front") say({ front: mode === "nofront" ? null : { bundle: "com.example.app", pid: 42, name: "Example" } });
    else if (req.op === "contacts") say({ contacts: [{ id: "A1", name: "Ann Lee", org: "", emails: ["ann@example.com"], phones: [] }].slice(0, req.limit) });
  }
});
process.stdin.on("end", () => process.exit(0));
`;

/** A fake binary and a spawn that runs it with node. */
function fake(t, mode = "ok") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-local-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bin = path.join(dir, "local.cjs");
  fs.writeFileSync(bin, FAKE);
  const count = path.join(dir, "spawns");
  const env = { ...process.env, FAKE_MODE: mode, FAKE_COUNT: count };
  /** @type {any} */
  const fakeSpawn = (b, args, opts) => spawn(process.execPath, [b, ...args], { ...opts, env });
  return { bin, fakeSpawn, spawns: () => (fs.existsSync(count) ? fs.readFileSync(count, "utf8").length : 0) };
}

test("helper: requests and answers are matched by id over one process", async t => {
  const { bin, fakeSpawn, spawns } = fake(t);
  const h = new LocalHelper(bin, { spawn: fakeSpawn, timeoutMs: 2000 });
  t.after(() => h.close());
  const [a, b, c] = await Promise.all([h.define("serendipity"), h.status(), h.contacts("ann", { limit: 1 })]);
  assert.deepEqual(a, { word: "serendipity", definition: "def of serendipity" });
  assert.deepEqual(b, { status: "notDetermined" });
  assert.equal(c.contacts[0].name, "Ann Lee");
  assert.deepEqual(await h.define("x"), { word: "x", definition: "def of x" });
  assert.equal(spawns(), 1, "one child for every request");
});

test("helper: a slow answer times out as { error }, and the late line is dropped", async t => {
  const { bin, fakeSpawn } = fake(t);
  const h = new LocalHelper(bin, { spawn: fakeSpawn, timeoutMs: 300 });
  t.after(() => h.close());
  await h.status();                                   // warm, so the timeout measures the answer
  assert.deepEqual(await h.define("slow"), { error: "timeout" });
  await new Promise(r => setTimeout(r, 350));         // the late answer arrives and is ignored
  assert.deepEqual(await h.define("ok"), { word: "ok", definition: "def of ok" });
});

test("helper: icons waits longer than a lookup and passes the batch through", async t => {
  const { bin, fakeSpawn } = fake(t);
  const h = new LocalHelper(bin, { spawn: fakeSpawn, timeoutMs: 300 });
  t.after(() => h.close());
  await h.status();
  const a = await h.icons([{ key: "k1", kind: "app", path: "/A.app" }], { dir: "/cache" });
  assert.deepEqual(a, { icons: { k1: "/cache/k1.png" }, size: 64 }, "400 ms is inside the icons timeout");
  assert.deepEqual(await h.icons([{ key: "k2", kind: "app" }], { dir: "/cache", timeoutMs: 100 }), { error: "timeout" });
});

test("helper: a crash answers { error } and the next call after the backoff restarts it", async t => {
  const { bin, fakeSpawn, spawns } = fake(t, "crash");
  let clock = 1000;
  const h = new LocalHelper(bin, { spawn: fakeSpawn, timeoutMs: 2000, now: () => clock });
  t.after(() => h.close());
  assert.deepEqual(await h.define("a"), { error: "helper stopped" });
  assert.deepEqual(await h.define("b"), { error: "restarting" }, "no respawn inside the backoff");
  assert.equal(spawns(), 1);
  clock += 300;
  assert.deepEqual(await h.define("c"), { error: "helper stopped" });
  assert.equal(spawns(), 2, "restarted once the backoff passed");
  clock += 300;
  assert.deepEqual(await h.define("d"), { error: "restarting" }, "the backoff grows");
  clock += 1000;
  await h.define("e");
  assert.equal(spawns(), 3);
});

test("helper: a missing binary answers every call without spawning", async () => {
  let spawned = 0;
  /** @type {any} */
  const never = () => { spawned++; throw new Error("no"); };
  const h = new LocalHelper("/nonexistent/bin/local", { spawn: never });
  for (const r of await Promise.all([h.status(), h.define("x"), h.contacts("ann")])) assert.deepEqual(r, { error: NOT_BUILT });
  assert.equal(spawned, 0);
});

test("helper: status and define never send a contacts request", async t => {
  const { bin } = fake(t);
  /** @type {string[]} */
  const sent = [];
  /** @type {any} */
  const spy = (b, args, opts) => {
    const c = spawn(process.execPath, [b, ...args], opts);
    const w = c.stdin.write.bind(c.stdin);
    c.stdin.write = (s, ...r) => { sent.push(JSON.parse(String(s)).op); return w(s, ...r); };
    return c;
  };
  const h = new LocalHelper(bin, { spawn: spy, timeoutMs: 2000 });
  t.after(() => h.close());
  await h.status(); await h.define("x");
  assert.deepEqual(sent, ["status", "define"]);
});

test("helper: contacts and definitions become launcher rows", () => {
  assert.deepEqual(toResults([
    { id: "A1", name: "Ann Lee", org: "Harlow Legal", emails: ["ann@example.com"], phones: [] },
    { id: "B2", name: "Bo Reyes", org: "", emails: ["bo@example.com"], phones: [] },
  ]), [
    { kind: "contact", id: "contact:A1", label: "Ann Lee", sub: "Harlow Legal", last: 0, target: "addressbook://A1" },
    { kind: "contact", id: "contact:B2", label: "Bo Reyes", sub: "bo@example.com", last: 0, target: "addressbook://B2" },
  ]);
  const text = "serendipity ser·en·dip·i·ty | ˌserənˈdipədē | noun the occurrence and development of events by chance in a happy or beneficial way: a fortunate stroke of serendipity.";
  assert.equal(firstSentence(text), "the occurrence and development of events by chance in a happy or beneficial way");
  assert.deepEqual(toDefineResult({ word: "no way", definition: text }), {
    kind: "define", id: "define:no way", label: "no way",
    sub: "the occurrence and development of events by chance in a happy or beneficial way", target: "dict://no%20way",
  });
  assert.equal(toDefineResult({ word: "qzx", definition: null }), null);
});

test("helper: clip events go to onClip, never to a pending answer", async t => {
  const { bin, fakeSpawn } = fake(t);
  /** @type {any[]} */
  const got = [];
  const h = new LocalHelper(bin, { spawn: fakeSpawn, timeoutMs: 2000, onClip: item => got.push(item) });
  t.after(() => h.close());
  assert.deepEqual(await h.watchClips(true, { board: "vyre-x" }), { watching: true, count: 7 });
  await new Promise(r => setTimeout(r, 80));
  assert.deepEqual(got, [{ count: 8, at: 1, text: "from fake", board: "vyre-x" }]);
  const w = await h.writeClip({ text: "hi", board: "vyre-x" });
  assert.deepEqual(w, { ok: true, count: 9, wrote: { id: w.wrote.id, op: "clip.write", text: "hi", board: "vyre-x" } });
  assert.deepEqual(await h.watchClips(false), { watching: false, count: 7 });
  h.onClip = () => { throw new Error("a throwing callback does not break the reader"); };
  assert.deepEqual(await h.define("x"), { word: "x", definition: "def of x" });
});

test("helper: a helper that dies while watching is restarted and told to watch again", async t => {
  const { bin, fakeSpawn, spawns } = fake(t, "clipdie");
  let n = 0;
  const h = new LocalHelper(bin, { spawn: fakeSpawn, timeoutMs: 2000, onClip: () => { n++; } });
  t.after(() => h.close());
  await h.watchClips(true);
  const until = Date.now() + 3000;
  while (n < 2 && Date.now() < until) await new Promise(r => setTimeout(r, 25));
  assert.ok(n >= 2, "the watch resumed in the restarted helper");
  assert.ok(spawns() >= 2);
  h.clipWatch = null;                       // stop before close so no further respawn is queued
});

test("helper: watching with no binary does not spin", async () => {
  let spawned = 0;
  /** @type {any} */
  const never = () => { spawned++; throw new Error("no"); };
  const h = new LocalHelper("/nonexistent/bin/local", { spawn: never });
  assert.deepEqual(await h.watchClips(true), { error: NOT_BUILT });
  await new Promise(r => setTimeout(r, 60));
  assert.equal(spawned, 0);
  assert.equal(h.rewatchTimer, null);
  h.close();
});

test("helper: front answers the app in front, or null", async t => {
  const { bin, fakeSpawn } = fake(t);
  const h = new LocalHelper(bin, { spawn: fakeSpawn, timeoutMs: 2000 });
  t.after(() => h.close());
  assert.deepEqual(await h.front(), { bundle: "com.example.app", pid: 42, name: "Example" });
  const none = fake(t, "nofront");
  const h2 = new LocalHelper(none.bin, { spawn: none.fakeSpawn, timeoutMs: 2000 });
  t.after(() => h2.close());
  assert.equal(await h2.front(), null);
  assert.equal(await new LocalHelper("/nonexistent/bin/local").front(), null, "not built is null, not a throw");
});

const REAL = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "local");

test("helper: the real binary defines a word and reports Contacts status", { skip: !fs.existsSync(REAL) && "bin/local not built" }, async t => {
  const once = JSON.parse(execFileSync(REAL, ["contacts", "--status"], { encoding: "utf8" }));
  assert.ok(["authorized", "denied", "restricted", "notDetermined", "limited"].includes(once.status));
  const h = new LocalHelper(REAL, { timeoutMs: 2000 });
  t.after(() => h.close());
  const d = await h.define("serendipity");
  assert.equal(d.word, "serendipity");
  assert.match(d.definition, /chance/);
  assert.ok(d.definition.length <= 610);
  assert.equal((await h.define("qzxqzxq")).definition, null);
  assert.deepEqual(await h.status(), once);
});

test("helper: the real binary names icon files as icons.js does", { skip: !fs.existsSync(REAL) && "bin/local not built" }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-local-icons-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const h = new LocalHelper(REAL);
  t.after(() => h.close());
  const key = "app:/System/Applications/Calculator.app@1";
  let a = await h.icons([{ key, kind: "app", path: "/System/Applications/Calculator.app" }, { key: "nope", kind: "file", path: "/nonexistent" }], { dir });
  if (a.error === "timeout") a = await h.icons([{ key, kind: "app", path: "/System/Applications/Calculator.app" }, { key: "nope", kind: "file", path: "/nonexistent" }], { dir });
  assert.equal(a.icons[key], path.join(dir, iconFile(key)));
  assert.equal(a.icons.nope, null);
});

test("helper: the real binary names the app in front without asking for anything", { skip: !fs.existsSync(REAL) && "bin/local not built" }, async t => {
  const h = new LocalHelper(REAL, { timeoutMs: 2000 });
  t.after(() => h.close());
  const f = await h.front();
  if (f !== null) {
    assert.equal(typeof f.bundle, "string");
    assert.ok(Number.isInteger(f.pid) && f.pid > 0);
    assert.equal(typeof f.name, "string");
  }
});

/** Raw requests to a real `local serve`, for the test-only ops the client does not expose. */
function raw() {
  const c = spawn(REAL, ["serve"], { stdio: ["pipe", "pipe", "ignore"] });
  let buf = "", id = 1000;
  /** @type {Map<number, (v: any) => void>} */
  const waiting = new Map();
  c.stdout.setEncoding("utf8");
  c.stdout.on("data", d => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
      waiting.get(m.id)?.(m); waiting.delete(m.id);
    }
  });
  /** @param {any} req @returns {Promise<any>} */
  const ask = req => new Promise(r => {
    const n = id++;
    const timer = setTimeout(() => { waiting.delete(n); r({ error: "timeout" }); }, 3000);
    waiting.set(n, m => { clearTimeout(timer); r(m); });
    c.stdin.write(JSON.stringify({ id: n, ...req }) + "\n");
  });
  const close = () => { c.stdin.end(); c.kill(); };
  return { ask, close };
}

// A private named pasteboard only. The general pasteboard, the one the user copies to, is never
// read or written here: the test-only ops refuse it, and every other request names the board.
test("helper: the real binary watches and writes a private pasteboard", { skip: !fs.existsSync(REAL) && "bin/local not built" }, async t => {
  const board = `vyre-test-${process.pid}`;
  const { ask: other, close } = raw();
  t.after(async () => { await other({ op: "clip.release", board }); close(); });
  /** @type {any[]} */
  const got = [];
  const h = new LocalHelper(REAL, { timeoutMs: 2000, onClip: item => got.push(item) });
  t.after(() => h.close());
  const until = async (/** @type {() => boolean} */ f) => { const end = Date.now() + 3000; while (!f() && Date.now() < end) await new Promise(r => setTimeout(r, 25)); };

  assert.deepEqual(await other({ op: "clip.put", types: { "public.utf8-plain-text": "x" } }).then(a => a.error), "a vyre- board is required");
  assert.equal((await h.writeClip({ text: "x", board: "not-ours" })).error, "bad board");

  assert.equal((await h.watchClips(true, { board, ms: 100 })).watching, true);
  await other({ op: "clip.put", board, types: { "public.utf8-plain-text": "hello from a test" } });
  await until(() => got.length > 0);
  assert.equal(got.length, 1);
  assert.equal(got[0].text, "hello from a test");
  assert.equal(typeof got[0].count, "number");

  for (const marker of ["org.nspasteboard.ConcealedType", "org.nspasteboard.TransientType", "org.nspasteboard.AutoGeneratedType", "com.agilebits.onepassword"]) {
    await other({ op: "clip.put", board, types: { "public.utf8-plain-text": "secret", [marker]: "" } });
    assert.equal((await other({ op: "clip.peek", board })).skipped, "marked", marker);
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-clip-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "a.txt");
  fs.writeFileSync(file, "a");
  const w = await h.writeClip({ files: [file], board });
  assert.equal(w.ok, true);
  const peek = await other({ op: "clip.peek", board });
  assert.equal(peek.skipped, "own", "the Capsule's own write is marked as its own");
  const w2 = await h.writeClip({ text: "picked", board });
  assert.ok(w2.count > w.count);
  await new Promise(r => setTimeout(r, 300));
  assert.equal(got.length, 1, "neither the markers nor the Capsule's writes came back as items");
  assert.equal((await h.watchClips(false)).watching, false);
});
