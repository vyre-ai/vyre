// @ts-check
// The term module inside a real Registry: who may open a terminal (no passkey for the owner), the files
// guard on cwd, one-use tickets, and on Linux a real shell over a real WebSocket (echo, resize,
// close ending the whole session, and the end after the keep time with no socket). ADR 0029 R4: the
// byte-offset ring (replay after an offset, trimmed at line ends, the cut marker), the fallback to a
// plain pty without dtach, and with a real dtach a shell that survives a vyred stop and start.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Registry, discover } from "../modules/index.js";
import { open } from "../store/index.js";
import { Events } from "../events/index.js";
import * as config from "../config/index.js";
import { tempHome } from "../../test/helpers.js";
import { SCRATCH } from "../../test/scratch.mjs";
import { encodeClientFrame } from "../computers/ws.js";
import { Ring } from "./ring.js";
import { findDtach } from "./dtach.js";

const CORE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LINUX = process.platform === "linux";
const DECK = "deck:abc123";
const DTACH = findDtach();
const NO_DTACH = !LINUX ? "the pty runs on the box (util-linux script)" : !DTACH ? "no dtach on the PATH: put one there (or VYRE_DTACH_BIN) to run it" : false;
/** keep_hours for a keep of ms milliseconds. */
const keep = ms => ms / 3_600_000;

/** A presence verifier that passes only a call carrying a proof, so a presence gate here would bite. */
const presence = {
  required: (_tool, def) => Boolean(def && def.presence),
  verify: async ({ proof }) => proof ? { ok: true, method: "test" } : { ok: false, code: "presence_required", message: "needs a person", methods: ["passkey"] },
};

/**
 * A Registry running only the term module. o.root and o.work reuse a home (a vyred restart);
 * o.dtach false starts it with no dtach, as on a Mac. Terminals still open at the end are closed,
 * so no shell outlives the test.
 */
async function registry(t, term = {}, o = {}) {
  const root = o.root || tempHome(t);
  const p = config.ensure(root);
  let work = o.work;
  if (!work) {
    work = fs.mkdtempSync(path.join(SCRATCH, "vyre-term-work-"));
    fs.mkdirSync(path.join(work, "proj"));
    const w = work;
    t.after(() => fs.rmSync(w, { recursive: true, force: true }));
  }
  const db = open(p.db);
  const events = new Events(db);
  const reg = new Registry({ db, events, config: { role: "box", files: { roots: [work] }, term: { shell: "/bin/sh", ...term } }, paths: p, log: () => {}, presence: /** @type {any} */ (presence) });
  const prev = process.env.VYRE_DTACH_BIN;
  if (o.dtach === false) process.env.VYRE_DTACH_BIN = "";
  try { await reg.start(discover([CORE]).filter(f => f.manifest && f.manifest.name === "term"), { role: "box" }); }
  finally { if (o.dtach === false) { if (prev === undefined) delete process.env.VYRE_DTACH_BIN; else process.env.VYRE_DTACH_BIN = prev; } }
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    await reg.stop();
    db.close();
  };
  t.after(async () => {
    if (!stopped) {
      const handle = reg.modules.get("term")?.handle;
      for (const id of handle ? [...handle.terms.keys()] : []) await reg.call("term.close", { term: id }, "deck");
    }
    await stop();
  });
  assert.equal(reg.modules.get("term")?.state, "running", reg.modules.get("term")?.error);
  return { reg, work, events, root, stop, handle: reg.modules.get("term")?.handle };
}

/** The person session vyred's router sets for a signed-in Deck over the tailnet (core/presence/person.js). */
const PERSON = { id: "s1", kind: "cookie" };
const ok = async (reg, tool, input, caller = "deck", meta = {}) => {
  const r = await reg.call(tool, input, caller, meta);
  if (r.error) throw new Error(`${tool}: ${r.error.code} ${r.error.message}`);
  return r.data;
};

/** An HTTP server that hands /v1/streams/<m>/<n> upgrades to the registry, as vyred does. */
async function server(t, reg) {
  const s = http.createServer((_q, r) => { r.writeHead(404); r.end(); });
  s.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url || "/", "http://vyred");
    const m = /^\/v1\/streams\/([a-z-]+)\/([a-z-]+)$/.exec(url.pathname);
    const u = m && reg.upgrades.get(`${m[1]}/${m[2]}`);
    if (!u) { socket.end("HTTP/1.1 404 Not Found\r\n\r\n"); return; }
    u.handler(req, socket, head, { caller: "deck", url });
  });
  await new Promise(r => s.listen(0, "127.0.0.1", () => r(undefined)));
  t.after(() => { s.closeAllConnections(); s.close(); });
  return /** @type {any} */ (s.address()).port;
}

/** A tiny WebSocket client: the status line, then server frames as text. */
function connect(port, p) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, "127.0.0.1");
    let buf = Buffer.alloc(0), upgraded = false, text = "";
    const waiters = [];
    const c = {
      sock, status: 0, closed: false, closeCode: 0,
      /** Text frames from the box, parsed: {"t":"at"} and {"t":"cut"}. */
      msgs: /** @type {any[]} */ ([]),
      /** Everything in order: binary as { b: string }, text frames as they are. */
      log: /** @type {any[]} */ ([]),
      get text() { return text; },
      reset() { text = ""; c.msgs.length = 0; c.log.length = 0; },
      untilMsg: (pred, ms = 8000) => new Promise((res, rej) => {
        const check = () => { const m = c.msgs.find(pred); if (m) { res(m); return true; } return false; };
        if (check()) return;
        const timer = setTimeout(() => rej(new Error(`timed out waiting for a message in ${JSON.stringify(c.msgs)}`)), ms);
        waiters.push(() => { if (check()) { clearTimeout(timer); return true; } return false; });
      }),
      send: obj => sock.write(encodeClientFrame(Buffer.from(JSON.stringify(obj)), 1)),
      until: (re, ms = 8000) => new Promise((res, rej) => {
        const check = () => { const m = re.exec(text); if (m) { res(m); return true; } return false; };
        if (check()) return;
        const timer = setTimeout(() => rej(new Error(`timed out waiting for ${re} in ${JSON.stringify(text.slice(-400))}`)), ms);
        waiters.push(() => { if (check()) { clearTimeout(timer); return true; } return false; });
      }),
    };
    sock.on("connect", () => sock.write(`GET ${p} HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`));
    sock.on("data", chunk => {
      buf = Buffer.concat([buf, chunk]);
      if (!upgraded) {
        const i = buf.indexOf("\r\n\r\n");
        if (i < 0) return;
        c.status = Number(/HTTP\/1\.1 (\d+)/.exec(buf.subarray(0, i).toString())?.[1]);
        buf = buf.subarray(i + 4);
        upgraded = true;
        resolve(c);
        if (c.status !== 101) return;
      }
      for (;;) {
        if (buf.length < 2) break;
        let len = buf[1] & 0x7f, off = 2;
        if (len === 126) { if (buf.length < 4) break; len = buf.readUInt16BE(2); off = 4; }
        else if (len === 127) { if (buf.length < 10) break; len = Number(buf.readBigUInt64BE(2)); off = 10; }
        if (buf.length < off + len) break;
        const op = buf[0] & 0x0f;
        if (op === 2) { const b = buf.subarray(off, off + len).toString("utf8"); text += b; c.log.push({ b }); }
        if (op === 1) { const m = JSON.parse(buf.subarray(off, off + len).toString("utf8")); c.msgs.push(m); c.log.push(m); }
        if (op === 8 && len >= 2) c.closeCode = buf.readUInt16BE(off);
        buf = buf.subarray(off + len);
      }
      for (let i = waiters.length - 1; i >= 0; i--) if (waiters[i]()) waiters.splice(i, 1);
    });
    sock.on("close", () => { c.closed = true; });
    sock.on("error", e => { if (!upgraded) reject(e); });
  });
}

/** The bytes a client got in binary frames before a given text frame. */
const bytesBefore = (c, m) => c.log.slice(0, c.log.indexOf(m)).reduce((n, x) => n + (x.b === undefined ? 0 : Buffer.byteLength(x.b, "utf8")), 0);
/** Output has settled for over a second, so the last at frame counts every byte: that frame. */
const lastAt = async c => { await wait(1300); const all = c.msgs.filter(m => m.t === "at"); return all[all.length - 1]; };

const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const wait = ms => new Promise(r => setTimeout(r, ms));

test("term: a surface is <kind>:<name>; the CLI opens as cli:<name>, and a bare kind says what is missing", async t => {
  const { reg, work } = await registry(t);
  const bare = await reg.call("term.open", { cwd: work, surface: "cli" }, "cli");
  assert.equal(bare.error?.code, "bad_input");
  assert.match(bare.error.message, /"cli" needs a name after it, such as cli:<tty or pid>/);
  assert.match((await reg.call("term.open", { cwd: work, surface: "laptop" }, "cli")).error?.message, /deck, phone, capsule, glass or cli/);
  const o = await ok(reg, "term.open", { cwd: work, surface: "cli:ttys007" }, "cli");
  await ok(reg, "term.attach", { term: o.term, surface: "cli:ttys007" }, "cli");
  assert.equal((await reg.call("term.attach", { term: o.term, surface: "cli:ttys008" }, "cli")).error?.code, "not_found", "another terminal is another screen");
});

test("term: only a person's surfaces may use it; a tailnet guest and an agent are refused", async t => {
  const { reg, work } = await registry(t);
  for (const caller of ["tailnet-guest:someone@example.com", "mcp", "mcp:agent:kit", "anonymous"]) {
    const r = await reg.call("term.open", { cwd: work, surface: DECK }, caller);
    assert.ok(r.error, `${caller} should be refused`);
    assert.ok(["denied", "no_such_tool"].includes(r.error.code), `${caller}: ${r.error.code}`);
  }
  assert.ok(!reg.listTools("tailnet-guest:x").some(x => x.name.startsWith("term.")));
});

test("term: the owner opens a terminal with no passkey, and only the screen that opened it reattaches", async t => {
  const { reg, work } = await registry(t);
  // No proof on the call, and none asked for (no nagging).
  const o = await ok(reg, "term.open", { cwd: work, surface: DECK }, "deck");
  assert.ok(o.ticket && o.term);
  assert.ok(!reg.listTools("deck").some(x => x.name.startsWith("term.") && x.presence));
  assert.ok(!reg.listTools("deck").some(x => x.name === "term.unlock"));
  // Another screen, another caller or another tailnet node cannot pick it up.
  assert.equal((await reg.call("term.attach", { term: o.term, surface: "phone:zzz999" }, "deck")).error?.code, "not_found");
  assert.equal((await reg.call("term.attach", { term: o.term, surface: DECK }, "cli")).error?.code, "not_found");
  const p = await ok(reg, "term.open", { cwd: work, surface: DECK }, "tailnet:alex", { peer: { stableId: "nPhone" }, person: PERSON });
  assert.equal((await reg.call("term.attach", { term: p.term, surface: DECK }, "tailnet:alex", { peer: { stableId: "nLaptop" }, person: PERSON })).error?.code, "not_found");
  await ok(reg, "term.attach", { term: p.term, surface: DECK }, "tailnet:alex", { peer: { stableId: "nPhone" }, person: PERSON });
});

test("term: cwd must pass the files guard", async t => {
  const { reg, work } = await registry(t);
  for (const cwd of ["/", "/etc", path.dirname(work), path.join(work, "..", "x"), "relative/path", path.join(work, "missing")]) {
    const r = await reg.call("term.open", { cwd, surface: DECK }, "deck");
    assert.ok(r.error, `${cwd} should be refused`);
  }
  assert.equal(reg.modules.get("term")?.handle.terms.size, 0);
});

test("term: a ticket works once and expires", { skip: !LINUX && "the pty runs on the box (util-linux script)" }, async t => {
  const { reg, work } = await registry(t, { ticketMs: 300 });
  const port = await server(t, reg);
  const o = await ok(reg, "term.open", { cwd: path.join(work, "proj"), surface: DECK, cols: 80, rows: 24 });
  const a = await connect(port, o.path);
  assert.equal(a.status, 101);
  const again = await connect(port, o.path);
  assert.equal(again.status, 403);
  const late = await ok(reg, "term.attach", { term: o.term, surface: DECK });
  await wait(400);
  assert.equal((await connect(port, late.path)).status, 403);
  // Attach is for the screen that opened it.
  assert.equal((await reg.call("term.attach", { term: o.term, surface: "phone:zzz999" }, "deck")).error?.code, "not_found");
  a.sock.destroy();
});

for (const mode of ["dtach", "plain"]) test(`term: a real shell round trip, resize, and close ends the whole session (${mode})`, { skip: mode === "dtach" ? NO_DTACH : !LINUX && "the pty runs on the box (util-linux script)" }, async t => {
  const { reg, work, events } = await registry(t, {}, { dtach: mode === "dtach" ? undefined : false });
  const port = await server(t, reg);
  const o = await ok(reg, "term.open", { cwd: path.join(work, "proj"), surface: DECK, cols: 80, rows: 24 });
  assert.match(o.path, /^\/v1\/streams\/term\/pty\?ticket=/);
  assert.equal(o.durable, mode === "dtach");
  assert.equal(o.offset, 0);
  const c = await connect(port, o.path);
  assert.equal(c.status, 101);
  c.send({ t: "in", d: "echo h''i; pwd\n" });
  await c.until(/\bhi\r?\n/);
  await c.until(/proj/);
  c.send({ t: "size", cols: 100, rows: 30 });
  await wait(500);
  c.send({ t: "in", d: "stty size\n" });
  await c.until(/30 100/);
  c.send({ t: "in", d: "sleep 1000 & echo BG=$!\n" });
  const bg = Number((await c.until(/BG=(\d+)/))[1]);
  assert.ok(alive(bg));
  // A reattach replays what was printed.
  const re = await ok(reg, "term.attach", { term: o.term, surface: DECK });
  const c2 = await connect(port, re.path);
  await c2.until(/BG=\d+/);
  assert.equal((await ok(reg, "term.list", {})).terms[0].attached, 2);
  assert.deepEqual(await ok(reg, "term.close", { term: o.term }), { closed: true });
  for (let i = 0; i < 40 && alive(bg); i++) await wait(100);
  assert.ok(!alive(bg), "the background job outlived the terminal");
  assert.equal((await ok(reg, "term.list", {})).terms.length, 0);
  const types = events.since(0, {}).map(e => e.type).filter(x => x.startsWith("term."));
  assert.deepEqual(types, ["term.opened", "term.closed"]);
  // Nothing the terminal printed reaches the event log.
  assert.ok(!JSON.stringify(events.since(0, {})).includes("BG="));
});

test("term: a disconnect never ends it; it ends term.keep_hours after its last socket closes, unless reattached", { skip: !LINUX && "the pty runs on the box (util-linux script)" }, async t => {
  const { reg, work } = await registry(t, { keep_hours: keep(400) });
  const port = await server(t, reg);
  const o = await ok(reg, "term.open", { cwd: work, surface: DECK });
  const c = await connect(port, o.path);
  c.send({ t: "in", d: "echo ready\n" });
  await c.until(/ready/);
  c.sock.destroy();
  await wait(150);
  // Reattached inside the grace: it lives on.
  const re = await ok(reg, "term.attach", { term: o.term, surface: DECK });
  const c2 = await connect(port, re.path);
  await wait(700);
  assert.equal((await ok(reg, "term.list", {})).terms.length, 1);
  c2.sock.destroy();
  await wait(900);
  assert.equal((await ok(reg, "term.list", {})).terms.length, 0);
  assert.equal((await reg.call("term.attach", { term: o.term, surface: DECK }, "deck")).error?.code, "not_found");
});

test("term: at most max terminals, and without dtach stop ends them all", { skip: !LINUX && "the pty runs on the box (util-linux script)" }, async t => {
  const { reg, work } = await registry(t, { max: 2 }, { dtach: false });
  await ok(reg, "term.open", { cwd: work, surface: DECK });
  await ok(reg, "term.open", { cwd: work, surface: DECK });
  assert.equal((await reg.call("term.open", { cwd: work, surface: DECK }, "deck")).error?.code, "too_many");
  const handle = reg.modules.get("term")?.handle;
  const pids = [...handle.terms.values()].map(x => x.pty.pid);
  await handle.stop();
  for (let i = 0; i < 20 && pids.some(alive); i++) await wait(100);
  assert.ok(!pids.some(alive));
});

test("ring: offsets count every byte, and since(from) is exactly the bytes after it", () => {
  const r = new Ring(4096);
  r.push(Buffer.from("one\n"));
  r.push(Buffer.from("two\nthr"));
  r.push(Buffer.from("ee\n"));
  assert.equal(r.start, 0);
  assert.equal(r.end, 14);
  assert.equal(r.since(0).toString(), "one\ntwo\nthree\n");
  assert.equal(r.since(4).toString(), "two\nthree\n");
  assert.equal(r.since(11).toString(), "ee\n");
  assert.equal(r.since(14).length, 0);
  // A ring that starts later (after a vyred restart) keeps counting from there.
  const later = new Ring(4096, 1000);
  later.push(Buffer.from("x\n"));
  assert.equal(later.end, 1002);
  assert.equal(later.since(1001).toString(), "\n");
});

test("ring: trimmed only at line ends, and a line longer than the ring is the one cut mid-line", () => {
  const r = new Ring(1024);
  let all = "";
  for (let i = 0; i < 200; i++) { const line = `line ${String(i).padStart(4, "0")} ${"z".repeat(i % 17)}\n`; all += line; r.push(Buffer.from(line)); }
  assert.ok(r.bytes <= 1024, `${r.bytes} bytes held`);
  assert.ok(r.start > 0);
  assert.equal(r.end, Buffer.byteLength(all));
  assert.equal(all[r.start - 1], "\n", "the ring starts in the middle of a line");
  assert.match(r.since(0).toString(), /^line \d{4} z*\n/);
  assert.equal(r.since(0).toString(), all.slice(r.start));
  // No newline at all: it has to cut, and still counts every byte.
  const long = new Ring(1024);
  long.push(Buffer.from("a".repeat(3000)));
  assert.ok(long.bytes <= 1024);
  assert.equal(long.end, 3000);
  // tail(n) starts at a line when one begins in it.
  assert.match(r.tail(100).toString(), /^line \d{4}/);
});

test("term: without dtach it falls back to a plain pty and says so", { skip: !LINUX && "the pty runs on the box (util-linux script)" }, async t => {
  for (const dtach of [false, "missing"]) {
    const prev = process.env.VYRE_DTACH_BIN;
    if (dtach === "missing") process.env.VYRE_DTACH_BIN = path.join(SCRATCH, "no-such-dtach");
    t.after(() => { if (prev === undefined) delete process.env.VYRE_DTACH_BIN; else process.env.VYRE_DTACH_BIN = prev; });
    const { reg, work, handle } = await registry(t, {}, dtach === false ? { dtach: false } : {});
    if (dtach === "missing") { if (prev === undefined) delete process.env.VYRE_DTACH_BIN; else process.env.VYRE_DTACH_BIN = prev; }
    assert.equal(handle.durable, false);
    const o = await ok(reg, "term.open", { cwd: work, surface: DECK });
    assert.equal(o.durable, false);
    assert.equal((await ok(reg, "term.list", {})).terms[0].durable, false);
    assert.equal((await ok(reg, "term.attach", { term: o.term, surface: DECK })).durable, false);
  }
});

test("term: from=<offset> replays exactly the bytes after it, with at frames; no from is the old replay", { skip: !LINUX && "the pty runs on the box (util-linux script)" }, async t => {
  const { reg, work } = await registry(t);
  const port = await server(t, reg);
  const o = await ok(reg, "term.open", { cwd: work, surface: DECK });
  const c = await connect(port, o.path + "&from=0");
  assert.equal(c.status, 101);
  // Nothing printed yet, or only the prompt: the first word is where the box is.
  const first = await c.untilMsg(m => m.t === "at");
  assert.equal(typeof first.offset, "number");
  c.send({ t: "in", d: "echo AA''AA\n" });
  await c.until(/AAAA\r?\n/);
  // An at frame follows the output within a second, with the byte count so far.
  const at = await lastAt(c);
  assert.ok(at.offset > first.offset);
  assert.equal(at.offset, bytesBefore(c, at), "the at offset is not the count of bytes sent");
  c.sock.destroy();
  await wait(100);
  // Something printed while nobody watched.
  const mid = await ok(reg, "term.attach", { term: o.term, surface: DECK, from: at.offset });
  assert.equal(mid.offset, at.offset);
  assert.match(mid.path, new RegExp(`&from=${at.offset}$`));
  const c2 = await connect(port, mid.path);
  await c2.untilMsg(m => m.t === "at");
  c2.send({ t: "in", d: "echo BB''BB\n" });
  await c2.until(/BBBB\r?\n/);
  c2.sock.destroy();
  await wait(100);
  const re = await ok(reg, "term.attach", { term: o.term, surface: DECK, from: at.offset });
  const c3 = await connect(port, re.path);
  const back = await c3.untilMsg(m => m.t === "at");
  assert.ok(!c3.text.includes("AAAA"), "bytes before the offset came back");
  assert.match(c3.text, /BBBB/);
  assert.ok(!c3.msgs.some(m => m.t === "cut"));
  assert.equal(back.offset, at.offset + bytesBefore(c3, back));
  // The first thing on the socket is the replay; the at comes after it.
  assert.ok(c3.log.findIndex(x => x.b !== undefined) < c3.log.findIndex(x => x.t === "at"));
  // Without from: binary frames only, the whole recent screen, as before.
  const plain = await ok(reg, "term.attach", { term: o.term, surface: DECK });
  assert.ok(!plain.path.includes("from="));
  const c4 = await connect(port, plain.path);
  await c4.until(/BBBB/);
  await wait(1200);
  assert.match(c4.text, /AAAA[\s\S]*BBBB/);
  assert.equal(c4.msgs.length, 0, "a client that did not ask for offsets got text frames");
  c3.sock.destroy(); c4.sock.destroy();
});

test("term: an offset that has left the ring gets the whole ring, from a line start, after a cut marker", { skip: !LINUX && "the pty runs on the box (util-linux script)" }, async t => {
  const { reg, work } = await registry(t, { ring: 4096 });
  const port = await server(t, reg);
  const o = await ok(reg, "term.open", { cwd: work, surface: DECK });
  const c = await connect(port, o.path);
  c.send({ t: "in", d: "i=0; while [ $i -lt 400 ]; do i=$((i+1)); echo L$i-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa; done; echo DO''NE\n" });
  await c.until(/DONE\r?\n/, 15_000);
  c.sock.destroy();
  const re = await ok(reg, "term.attach", { term: o.term, surface: DECK, from: 0 });
  assert.ok(re.oldest > 0, "nothing left the ring");
  assert.ok(re.offset - re.oldest <= 4096);
  const c2 = await connect(port, re.path);
  const at = await c2.untilMsg(m => m.t === "at");
  assert.deepEqual(c2.log[0], { t: "cut", from: re.oldest, asked: 0 });
  assert.match(c2.text, /^L\d+-a+\r?\n/, "the replay starts mid-line");
  assert.match(c2.text, /L400-a+\r?\n[\s\S]*DONE/);
  assert.equal(at.offset, re.oldest + bytesBefore(c2, at));
  c2.sock.destroy();
});

test("term: with a real dtach the shell survives a vyred stop and start, and from= gets only new bytes", { skip: NO_DTACH, timeout: 60_000 }, async t => {
  const first = await registry(t);
  const port1 = await server(t, first.reg);
  const o = await ok(first.reg, "term.open", { cwd: path.join(first.work, "proj"), surface: DECK }, "tailnet:alex", { peer: { stableId: "nLaptop" } });
  assert.equal(o.durable, true);
  const c = await connect(port1, o.path + "&from=0");
  c.send({ t: "in", d: "sleep 1000 & echo BG=$!; echo OL''D-MARK\n" });
  const bg = Number((await c.until(/BG=(\d+)/))[1]);
  t.after(() => { try { process.kill(bg, "SIGKILL"); } catch {} });
  await c.until(/OLD-MARK\r?\n/);
  const at = await lastAt(c);
  assert.equal(at.offset, bytesBefore(c, at));
  const pid = first.handle.terms.get(o.term).pty.pid;
  t.after(() => { try { process.kill(pid, "SIGKILL"); } catch {} });

  // vyred stops: the client is told it is a restart (1012), the shell and its job live on.
  await first.stop();
  for (let i = 0; i < 20 && !c.closed; i++) await wait(50);
  assert.equal(c.closeCode, 1012);
  await wait(300);
  assert.ok(alive(bg), "the shell's job died with vyred");
  assert.ok(alive(pid), "the dtach master died with vyred");
  const table = fs.readFileSync(path.join(first.root, "run", "term", "terms.json"), "utf8");
  assert.ok(!table.includes("OLD-MARK"), "terminal output reached the disk");
  assert.equal(JSON.parse(table).terms[0].offset, at.offset);

  // vyred starts again on the same home: the terminal is there, for the same screen only.
  const second = await registry(t, {}, { root: first.root, work: first.work });
  const port2 = await server(t, second.reg);
  const listed = (await ok(second.reg, "term.list", {})).terms;
  assert.deepEqual(listed.map(x => [x.term, x.durable, x.offset]), [[o.term, true, at.offset]]);
  assert.equal((await second.reg.call("term.attach", { term: o.term, surface: DECK }, "tailnet:alex", { peer: { stableId: "nPhone" } })).error?.code, "not_found");
  const re = await ok(second.reg, "term.attach", { term: o.term, surface: DECK, from: at.offset }, "tailnet:alex", { peer: { stableId: "nLaptop" } });
  assert.equal(re.durable, true);
  const c2 = await connect(port2, re.path);
  assert.equal(c2.status, 101);
  const back = await c2.untilMsg(m => m.t === "at");
  assert.equal(back.offset, at.offset);
  assert.ok(!c2.msgs.some(m => m.t === "cut"));
  c2.send({ t: "in", d: "echo NE''W-MARK; pwd\n" });
  await c2.until(/NEW-MARK\r?\n/);
  await c2.until(/proj/);
  assert.ok(!c2.text.includes("OLD-MARK"), "bytes before the offset came back after the restart");
  // The same shell: its job is still its job.
  c2.send({ t: "in", d: "jobs -p\n" });
  await c2.until(new RegExp(`\\b${bg}\\b`));
  // And closing it now ends everything it started.
  assert.deepEqual(await ok(second.reg, "term.close", { term: o.term }), { closed: true });
  for (let i = 0; i < 40 && (alive(bg) || alive(pid)); i++) await wait(100);
  assert.ok(!alive(bg), "the background job outlived the terminal");
  assert.ok(!alive(pid), "the dtach master outlived the terminal");
  c2.sock.destroy();
});

test("term: a terminal the box lost while vyred was down (a deploy) answers terminal_closed and says so on the log", async t => {
  const root = tempHome(t);
  const dir = path.join(root, "run", "term");
  fs.mkdirSync(dir, { recursive: true });
  // What a vyred in the old container left: a table row whose socket and master went with it.
  const key = `tailnet:alex|nLaptop|${DECK}`;
  fs.writeFileSync(path.join(dir, "terms.json"), JSON.stringify({ terms: [{ id: "tlost", cwd: "/", surface: DECK, key, offset: 42, started: Date.now(),
    pid: 999_999, sock: path.join(dir, "tlost.sock"), left: Date.now(), cols: 80, rows: 24 }] }));
  const { reg, events, work, stop } = await registry(t, {}, { root });
  const closed = events.since(0, { type: "term.closed", limit: 10 });
  assert.deepEqual(closed.map(e => e.payload), [{ term: "tlost", reason: "server updated" }]);
  const r = await reg.call("term.attach", { term: "tlost", surface: DECK }, "tailnet:alex", { peer: { stableId: "nLaptop" }, person: PERSON });
  assert.equal(r.error?.code, "terminal_closed");
  assert.match(r.error.message, /server was updated/);
  // Another screen still learns nothing about it.
  assert.equal((await reg.call("term.attach", { term: "tlost", surface: DECK }, "tailnet:alex", { peer: { stableId: "nPhone" }, person: PERSON })).error?.code, "not_found");
  // And it is remembered across the next restart, without a second announcement.
  await stop();
  const again = await registry(t, {}, { root, work });
  assert.equal((await again.reg.call("term.attach", { term: "tlost", surface: DECK }, "tailnet:alex", { peer: { stableId: "nLaptop" }, person: PERSON })).error?.code, "terminal_closed");
  assert.equal(again.events.since(0, { type: "term.closed", limit: 10 }).length, 1);
});

test("term: one socket owns the size; take moves it, and the oldest left takes over at its own size", { skip: !LINUX && "the pty runs on the box (util-linux script)" }, async t => {
  const { reg, work, handle } = await registry(t);
  const port = await server(t, reg);
  const o = await ok(reg, "term.open", { cwd: work, surface: DECK, cols: 100, rows: 30 });
  const pty = () => handle.terms.get(o.term).pty;
  const sizeOf = (c, pred) => c.untilMsg(m => m.t === "size" && pred(m));
  const laptop = await connect(port, o.path + "&from=0");
  await sizeOf(laptop, m => m.owner === true && m.cols === 100);
  laptop.send({ t: "size", cols: 120, rows: 40 });
  await sizeOf(laptop, m => m.owner === true && m.cols === 120 && m.rows === 40);
  assert.deepEqual([pty().cols, pty().rows], [120, 40]);

  const re = await ok(reg, "term.attach", { term: o.term, surface: DECK, from: 0 });
  const phone = await connect(port, re.path);
  await sizeOf(phone, m => m.owner === false && m.cols === 120);
  // A size from a socket that does not own it is kept, not applied.
  phone.send({ t: "size", cols: 50, rows: 20 });
  await wait(200);
  assert.deepEqual([pty().cols, pty().rows], [120, 40]);

  // An old client (no from=) never gets text frames and does not change who owns the size.
  const old = await connect(port, (await ok(reg, "term.attach", { term: o.term, surface: DECK })).path);
  await wait(200);
  assert.deepEqual(old.msgs, []);

  // Take size: the phone owns it at the size it asked for; the laptop is told it does not.
  laptop.msgs.length = 0;
  phone.send({ t: "take" });
  await sizeOf(phone, m => m.owner === true && m.cols === 50 && m.rows === 20);
  await sizeOf(laptop, m => m.owner === false && m.cols === 50);
  assert.deepEqual([pty().cols, pty().rows], [50, 20]);

  // The phone leaves: the laptop, the oldest still here, owns it again at its own size.
  laptop.msgs.length = 0;
  phone.sock.destroy();
  await sizeOf(laptop, m => m.owner === true && m.cols === 120 && m.rows === 40);
  assert.deepEqual([pty().cols, pty().rows], [120, 40]);
  assert.deepEqual(old.msgs, [], "the old client still got no text frames");
  laptop.sock.destroy(); old.sock.destroy();
});
