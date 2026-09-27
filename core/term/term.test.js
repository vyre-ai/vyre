// @ts-check
// The term module inside a real Registry: who may open a terminal (no passkey for the owner), the files
// guard on cwd, one-use tickets, and on Linux a real shell over a real WebSocket (echo, resize,
// close ending the whole session, the end a keep after the last socket goes away, from=<offset>
// replays, size ownership, and a vyred restart finding its terminals again). Each test ends every
// holder it started.

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
import { query } from "./holder.js";

const CORE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LINUX = process.platform === "linux";
const DECK = "deck:abc123";

/** A presence verifier that passes only a call carrying a proof, so a presence gate here would bite. */
const presence = {
  required: (_tool, def) => Boolean(def && def.presence),
  verify: async ({ proof }) => proof ? { ok: true, method: "test" } : { ok: false, code: "presence_required", message: "needs a person", methods: ["passkey"] },
};

/**
 * A registry running only the term module. `again` starts a second one on the same home and
 * folder, as a restarted vyred would. Every holder left in the home's socket folder is ended after.
 */
async function registry(t, term = {}, again = /** @type {{ root: string, work: string }|null} */ (null)) {
  const root = again ? again.root : tempHome(t);
  const p = config.ensure(root);
  let work = again ? again.work : "";
  if (!again) {
    work = fs.mkdtempSync(path.join(SCRATCH, "vyre-term-work-"));
    fs.mkdirSync(path.join(work, "proj"));
    t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  }
  const db = open(p.db);
  const events = new Events(db);
  const reg = new Registry({ db, events, config: { role: "box", files: { roots: [work] }, term: { shell: "/bin/sh", login: false, ...term } }, paths: p, log: () => {}, presence: /** @type {any} */ (presence) });
  await reg.start(discover([CORE]).filter(f => f.manifest && f.manifest.name === "term"), { role: "box" });
  assert.equal(reg.modules.get("term")?.state, "running", reg.modules.get("term")?.error);
  const handle = reg.modules.get("term")?.handle;
  const dir = handle.dir;
  let stopped = false;
  const stop = async () => { if (stopped) return; stopped = true; await reg.stop(); db.close(); };
  t.after(async () => {
    if (!stopped) for (const id of [...handle.terms.keys()]) await reg.call("term.close", { term: id }, "deck");
    await stop();
    // Anything still answering in this home's socket folder was started here: end it and its pty.
    for (const name of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
      const info = await query(path.join(dir, name), 500);
      if (!info) continue;
      try { process.kill(info.pid, "SIGTERM"); } catch {}
      for (let i = 0; i < 40 && alive(info.pid); i++) await wait(50);
      for (const x of [info.pid]) { try { process.kill(x, "SIGKILL"); } catch {} }
      for (const g of [info.pty, info.leader]) if (g) { try { process.kill(-g, "SIGKILL"); } catch {} }
    }
  });
  return { reg, work, events, root, handle, stop };
}

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

/** A tiny WebSocket client: the status line, then binary frames as text, text frames as JSON in msgs, and the close. */
function connect(port, p) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, "127.0.0.1");
    let buf = Buffer.alloc(0), upgraded = false, text = "";
    const waiters = [];
    const c = {
      sock, status: 0, closed: false, bytes: 0, /** @type {any[]} */ msgs: [], /** @type {{ code: number, reason: string }|null} */ close: null,
      get text() { return text; },
      msg: (pred, ms = 8000) => new Promise((res, rej) => {
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
        if (op === 2) { text += buf.subarray(off, off + len).toString("utf8"); c.bytes += len; }
        else if (op === 1) { try { c.msgs.push(JSON.parse(buf.subarray(off, off + len).toString("utf8"))); } catch {} }
        else if (op === 8) c.close = { code: len >= 2 ? buf.readUInt16BE(off) : 0, reason: buf.subarray(off + 2, off + len).toString("utf8") };
        buf = buf.subarray(off + len);
      }
      for (let i = waiters.length - 1; i >= 0; i--) if (waiters[i]()) waiters.splice(i, 1);
    });
    sock.on("close", () => { c.closed = true; });
    sock.on("error", e => { if (!upgraded) reject(e); });
  });
}

const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const wait = ms => new Promise(r => setTimeout(r, ms));

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
  const p = await ok(reg, "term.open", { cwd: work, surface: DECK }, "tailnet:alex", { peer: { stableId: "nPhone" } });
  assert.equal((await reg.call("term.attach", { term: p.term, surface: DECK }, "tailnet:alex", { peer: { stableId: "nLaptop" } })).error?.code, "not_found");
  await ok(reg, "term.attach", { term: p.term, surface: DECK }, "tailnet:alex", { peer: { stableId: "nPhone" } });
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

test("term: a real shell round trip, resize, and close ends the whole session", { skip: !LINUX && "the pty runs on the box (util-linux script)" }, async t => {
  const { reg, work, events, root } = await registry(t);
  const port = await server(t, reg);
  const o = await ok(reg, "term.open", { cwd: path.join(work, "proj"), surface: DECK, cols: 80, rows: 24 });
  assert.match(o.path, /^\/v1\/streams\/term\/pty\?ticket=/);
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
  // Nor any file in the home.
  const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(d, e.name)) : e.isFile() ? [path.join(d, e.name)] : []);
  for (const f of walk(root)) assert.ok(!fs.readFileSync(f).includes("BG="), `${f} holds terminal output`);
});

test("term: the terminal ends a while after its last socket closes, unless reattached", { skip: !LINUX && "the pty runs on the box (util-linux script)" }, async t => {
  const { reg, work } = await registry(t, { endAfterMs: 400 });
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

test("term: at most max terminals", { skip: !LINUX && "the pty runs on the box (util-linux script)" }, async t => {
  const { reg, work } = await registry(t, { max: 2 });
  await ok(reg, "term.open", { cwd: work, surface: DECK });
  await ok(reg, "term.open", { cwd: work, surface: DECK });
  assert.equal((await reg.call("term.open", { cwd: work, surface: DECK }, "deck")).error?.code, "too_many");
});

test("term: from=<offset> replays only what the screen missed, and says where it is", { skip: !LINUX && "the pty runs on the box (util-linux script)" }, async t => {
  const { reg, work } = await registry(t);
  const port = await server(t, reg);
  const o = await ok(reg, "term.open", { cwd: work, surface: DECK });
  assert.equal(o.durable, true);
  assert.equal(o.offset, 0);
  const a = await connect(port, o.path + "&from=0");
  const first = await a.msg(m => m.t === "at");
  assert.deepEqual({ cols: first.cols, rows: first.rows, owner: first.owner }, { cols: o.cols, rows: o.rows, owner: "none" });
  a.send({ t: "in", d: "echo on''e\n" });
  await a.until(/\bone\r?\n/);
  a.send({ t: "in", d: "sleep 0.4; echo tw''o\n" });
  await a.until(/sleep 0\.4/);
  await wait(100);
  const offset = a.bytes;
  a.sock.destroy();
  await wait(900);
  // term.attach carries from; the stream replays exactly the bytes after it.
  const re = await ok(reg, "term.attach", { term: o.term, surface: DECK, from: offset });
  assert.match(re.path, new RegExp(`&from=${offset}$`));
  const b = await connect(port, re.path);
  await b.until(/\btwo\r?\n/);
  const at = await b.msg(m => m.t === "at");
  assert.ok(!b.text.includes("one"), `replayed too much: ${JSON.stringify(b.text)}`);
  assert.ok(at.offset > offset, "at is past the offset asked for");
  assert.ok(!b.msgs.some(m => m.t === "cut"));
  // Output keeps the count: a later "at" matches every byte this socket received.
  b.send({ t: "in", d: "echo thr''ee\n" });
  await b.until(/\bthree\r?\n/);
  await wait(1300);
  const last = b.msgs.filter(m => m.t === "at").pop();
  assert.equal(last.offset, offset + b.bytes);
  // An offset older than the ring gets a cut marker and the whole ring.
  b.send({ t: "in", d: "head -c 1300000 /dev/zero | tr '\\0' x | fold -w 99; echo; echo do''ne\n" });
  await b.until(/\bdone\r?\n/, 20000);
  const c = await connect(port, (await ok(reg, "term.attach", { term: o.term, surface: DECK, from: 1 })).path);
  const cut = await c.msg(m => m.t === "cut");
  assert.equal(cut.asked, 1);
  assert.ok(cut.from > 1);
  await c.until(/\bdone\r?\n/, 10000);
  const cat = await c.msg(m => m.t === "at");
  assert.equal(cat.offset, cut.from + c.bytes);
  assert.ok(c.bytes <= 1024 * 1024);
  b.sock.destroy(); c.sock.destroy();
});

test("term: one screen owns the size; others watch at it until they send their own", { skip: !LINUX && "the pty runs on the box (util-linux script)" }, async t => {
  const { reg, work } = await registry(t);
  const port = await server(t, reg);
  const o = await ok(reg, "term.open", { cwd: work, surface: DECK, cols: 80, rows: 24 });
  const a = await connect(port, o.path + "&from=0");
  await a.msg(m => m.t === "at");
  a.send({ t: "size", cols: 100, rows: 30 });
  await a.msg(m => m.t === "size" && m.owner === "you" && m.cols === 100);
  // A second screen joins: it hears the owner's size and that someone else owns it.
  const b = await connect(port, (await ok(reg, "term.attach", { term: o.term, surface: DECK, from: 0 })).path);
  const bat = await b.msg(m => m.t === "at");
  assert.deepEqual({ cols: bat.cols, rows: bat.rows, owner: bat.owner }, { cols: 100, rows: 30, owner: "other" });
  // It takes the size.
  b.send({ t: "size", cols: 60, rows: 20 });
  await b.msg(m => m.t === "size" && m.owner === "you" && m.cols === 60);
  await a.msg(m => m.t === "size" && m.owner === "other" && m.cols === 60 && m.rows === 20);
  await wait(400);
  a.send({ t: "in", d: "stty size\n" });
  await a.until(/20 60/);
  assert.deepEqual((await ok(reg, "term.list", {})).terms.map(x => [x.cols, x.rows]), [[60, 20]]);
  // The owner goes: the one left hears nobody owns it.
  b.sock.destroy();
  await a.msg(m => m.t === "size" && m.owner === "none");
  a.sock.destroy();
});

test("term: a vyred restart keeps the shell, closes sockets with 1012, and the next vyred finds it", { skip: !LINUX && "the pty runs on the box (util-linux script)" }, async t => {
  const first = await registry(t);
  const port = await server(t, first.reg);
  const o = await ok(first.reg, "term.open", { cwd: path.join(first.work, "proj"), surface: DECK });
  const a = await connect(port, o.path + "&from=0");
  a.send({ t: "in", d: "sleep 1000 & echo BG=$!\n" });
  const bg = Number((await a.until(/BG=(\d+)/))[1]);
  await wait(200);
  const offset = a.bytes;
  await first.stop();
  for (let i = 0; i < 40 && !a.closed; i++) await wait(50);
  assert.equal(a.close?.code, 1012);
  assert.equal(a.close?.reason, "restarting");
  assert.ok(alive(bg), "the shell's job died with vyred");
  // The next vyred, on the same home.
  const second = await registry(t, {}, { root: first.root, work: first.work });
  const port2 = await server(t, second.reg);
  const list = (await ok(second.reg, "term.list", {})).terms;
  assert.equal(list.length, 1);
  assert.equal(list[0].term, o.term);
  assert.equal(list[0].cwd, fs.realpathSync(path.join(first.work, "proj")));
  // Only the screen that opened it may attach, as before.
  assert.equal((await second.reg.call("term.attach", { term: o.term, surface: "phone:zzz999" }, "deck")).error?.code, "not_found");
  const re = await ok(second.reg, "term.attach", { term: o.term, surface: DECK, from: offset });
  const b = await connect(port2, re.path);
  const at = await b.msg(m => m.t === "at");
  assert.equal(at.offset, offset + b.bytes);
  b.send({ t: "in", d: "echo ba''ck\n" });
  await b.until(/\bback\r?\n/);
  assert.deepEqual(await ok(second.reg, "term.close", { term: o.term }), { closed: true });
  for (let i = 0; i < 40 && alive(bg); i++) await wait(100);
  assert.ok(!alive(bg), "term.close after a restart left the job running");
  await wait(200);
  assert.equal(b.close?.code, 1000);
  assert.equal(b.close?.reason, "closed");
  assert.deepEqual(second.events.since(0, {}).map(e => e.type).filter(x => x.startsWith("term.")), ["term.opened", "term.closed"]);
});
