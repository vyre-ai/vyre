// @ts-check
// A terminal for a session (chat 0.3, task C): open for a session, the commands typed are recorded
// (never a password, never output), and a dropped connection resumes from its offset with no byte lost
// or repeated. A real pty, so these run on the box or testbox (util-linux script), not on a Mac.

import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Registry, discover } from "../modules/index.js";
import { open } from "../store/index.js";
import { Events } from "../../kernel/bus.js";
import * as config from "../config/index.js";
import { tempHome, deviceFor } from "../../test/helpers.js";
import { SCRATCH } from "../../test/scratch.mjs";
import { encodeClientFrame } from "../../lib/ws.js";
import { onCommand } from "./index.js";
import { fakeThreads } from "../stream/fake-threads.js";

const CORE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LINUX = process.platform === "linux";
const SKIP = !LINUX && "the pty runs on the box (util-linux script)";
const DECK = "deck:abc123";
// the person at the screen: a term call resolves the session's thread as them (the module relays the call's own person)
const facts = (/** @type {string} */ who) => ({ kernelFacts: { kind: "device", person: who, path: "direct" } });
const wait = ms => new Promise(r => setTimeout(r, ms));

async function registry(t) {
  const root = tempHome(t);
  const p = config.ensure(root);
  const work = fs.mkdtempSync(path.join(SCRATCH, "vyre-term-sess-"));
  fs.mkdirSync(path.join(work, "proj"));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const db = open(p.db);
  const events = new Events(db);
  const prev = process.env.VYRE_DTACH_BIN;
  process.env.VYRE_DTACH_BIN = "";
  const reg = new Registry({ db, events, config: { role: "box", files: { roots: [work] }, term: { shell: "/bin/sh" } }, paths: p, log: () => {}, presence: /** @type {any} */ ({ required: () => false, verify: async () => ({ ok: true }) }) });
  // The switchboard's threads.get is a stand-in: term resolves a session through it as the caller.
  const fake = fs.mkdtempSync(path.join(SCRATCH, "vyre-term-fake-"));
  t.after(() => fs.rmSync(fake, { recursive: true, force: true }));
  fakeThreads(fake);
  globalThis.__fakeThreadsKnown = new Map(["s_one", "s_pw", "s_resume", "victim_thread"].map(id => [id, { cwd: path.join(work, "proj") }]));
  try { await reg.start([...discover([CORE]).filter(f => f.manifest && f.manifest.name === "term"), ...discover([fake], { firstPartyRoots: [fake] })], { role: "box" }); }
  finally { if (prev === undefined) delete process.env.VYRE_DTACH_BIN; else process.env.VYRE_DTACH_BIN = prev; }
  t.after(async () => {
    const h = reg.modules.get("term")?.handle;
    for (const id of h ? [...h.terms.keys()] : []) await reg.call("term.close", { term: id }, "deck");
    await reg.stop();
    db.close();
  });
  assert.equal(reg.modules.get("term")?.state, "running");
  return { reg, work, events };
}

const ok = async (reg, tool, input) => {
  const r = await reg.call(tool, input, "deck", facts("per_owner"));
  if (r.error) throw new Error(`${tool}: ${r.error.code} ${r.error.message}`);
  return r.data;
};

async function server(t, reg) {
  const s = http.createServer((_q, r) => { r.writeHead(404); r.end(); });
  s.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url || "/", "http://vyred");
    const u = reg.upgrades.get("term/pty");
    u.handler(req, socket, head, { caller: "deck", url });
  });
  await new Promise(r => s.listen(0, "127.0.0.1", () => r(undefined)));
  t.after(() => { s.closeAllConnections(); s.close(); });
  return /** @type {any} */ (s.address()).port;
}

/** A WebSocket client that keeps every output byte (as a Buffer) and the text frames. */
function connect(port, p) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, "127.0.0.1");
    let buf = Buffer.alloc(0), upgraded = false;
    const c = { sock, bytes: Buffer.alloc(0), msgs: /** @type {any[]} */ ([]), status: 0,
      get text() { return c.bytes.toString("utf8"); },
      send: obj => sock.write(encodeClientFrame(Buffer.from(JSON.stringify(obj)), 1)),
      until: async (re, ms = 10000) => { const end = Date.now() + ms; while (Date.now() < end) { const m = re.exec(c.text); if (m) return m; await wait(25); } throw new Error(`timed out waiting for ${re} in ${JSON.stringify(c.text.slice(-300))}`); },
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
        if (op === 2) c.bytes = Buffer.concat([c.bytes, buf.subarray(off, off + len)]);
        if (op === 1) c.msgs.push(JSON.parse(buf.subarray(off, off + len).toString("utf8")));
        buf = buf.subarray(off + len);
      }
    });
    sock.on("error", e => { if (!upgraded) reject(e); });
  });
}

/** Type a line the way a person does: the first key, a beat for the box to look at the terminal, then the rest. */
async function type(c, line) { c.send({ t: "in", d: line[0] }); await wait(250); c.send({ t: "in", d: line.slice(1) }); }

test("term session: open for a session lists it, and the folder is the session's", { skip: SKIP }, async t => {
  const { reg, work } = await registry(t);
  const o = await ok(reg, "term.open", { cwd: path.join(work, "proj"), session: "s_one", surface: DECK });
  assert.equal(o.session, "s_one");
  const l = (await ok(reg, "term.list", {})).terms;
  assert.equal(l[0].session, "s_one");
  // No cwd and no session names no folder; a session nobody can find is not_found (the switchboard resolves real ones).
  assert.equal((await reg.call("term.open", { surface: DECK }, "deck", facts("per_owner"))).error?.code, "bad_input");
  assert.equal((await reg.call("term.open", { session: "s_none", surface: DECK }, "deck", facts("per_owner"))).error?.code, "not_found");
});

test("term session: a typed command is recorded as term.command and onCommand; output is not", { skip: SKIP }, async t => {
  const { reg, work, events } = await registry(t);
  const heard = [];
  const stop = onCommand(c => heard.push(c));
  t.after(stop);
  const port = await server(t, reg);
  const o = await ok(reg, "term.open", { cwd: path.join(work, "proj"), session: "s_one", surface: DECK });
  const c = await connect(port, o.path);
  await c.until(/\$ $|# $|> $|%/);
  c.send({ t: "in", d: "echo h''ello-OUT\r" });
  await c.until(/hello-OUT\r?\n/);
  c.send({ t: "in", d: "echo key=ghp_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8" + "\r" });
  await wait(600);
  // Up-arrow recall is not a line we can know; a skipped line is not recorded.
  c.send({ t: "in", d: "\x1b[A\r" });
  await wait(400);
  assert.equal(heard.length, 2, JSON.stringify(heard));
  assert.equal(heard[0].command, "echo h''ello-OUT");
  assert.equal(heard[0].session, "s_one");
  assert.equal(heard[0].term, o.term);
  assert.ok(!heard[1].command.includes("a1B2c3D4"), "a key is redacted before anyone sees it");
  const ev = events.since(0, {}).filter(e => e.type === "term.command");
  assert.equal(ev.length, 2);
  assert.equal(ev[0].thread, "s_one");
  assert.equal(ev[0].payload.command, "echo h''ello-OUT");
  // The word printed by the command (not typed) is in no log.
  assert.ok(!JSON.stringify(events.since(0, {})).includes("hello-OUT\\r"));
  assert.ok(!JSON.stringify(events.since(0, {})).includes("a1B2c3D4"));
});

test("term session: a terminal with no session records nothing", { skip: SKIP }, async t => {
  const { reg, work, events } = await registry(t);
  const heard = [];
  t.after(onCommand(c => heard.push(c)));
  const port = await server(t, reg);
  const o = await ok(reg, "term.open", { cwd: path.join(work, "proj"), surface: DECK });
  const c = await connect(port, o.path);
  c.send({ t: "in", d: "echo plain-run\r" });
  await c.until(/plain-run\r?\n/);
  await wait(300);
  assert.equal(heard.length, 0);
  assert.equal(events.since(0, {}).filter(e => e.type === "term.command").length, 0);
});

test("term session: what is typed at a password prompt is not recorded (by the prompt, and by the tty's echo flag)", { skip: SKIP }, async t => {
  const { reg, work } = await registry(t);
  const heard = [];
  t.after(onCommand(c => heard.push(c)));
  const port = await server(t, reg);
  const o = await ok(reg, "term.open", { cwd: path.join(work, "proj"), session: "s_pw", surface: DECK });
  const c = await connect(port, o.path);
  await c.until(/\$ $|# $|> $|%/);
  // 1. A prompt that says Password while the tty still echoes.
  c.send({ t: "in", d: "printf 'Password: '; read pw; echo got-$pw-A\r" });
  await c.until(/Password: $/);
  await type(c, "hunter2-first\r");
  await c.until(/got-hunter2-first-A/);
  // 2. A prompt that says nothing, with the tty's echo turned off.
  c.send({ t: "in", d: "printf 'code> '; stty -echo; read pw; stty echo; echo got-$pw-B\r" });
  await c.until(/code> /);
  await type(c, "hunter2-second\r");
  await c.until(/got-hunter2-second-B/);
  // 3. And an ordinary command afterwards is recorded again.
  await wait(300);
  c.send({ t: "in", d: "echo after-it\r" });
  await c.until(/after-it\r?\n/);
  await wait(500);
  const said = heard.map(h => h.command);
  assert.ok(!said.some(x => x.includes("hunter2")), JSON.stringify(said));
  assert.ok(said.includes("echo after-it"), JSON.stringify(said));
  // The two commands that raised the prompts are themselves ordinary lines.
  assert.ok(said.some(x => x.startsWith("printf 'Password: '")));
});

test("term session: kill the socket mid-output, reattach from the offset, get exactly the missing bytes", { skip: SKIP }, async t => {
  const { reg, work } = await registry(t);
  const port = await server(t, reg);
  const o = await ok(reg, "term.open", { cwd: path.join(work, "proj"), session: "s_resume", surface: DECK });
  const first = await connect(port, o.path.replace(/$/, "&from=0"));
  await first.until(/\$ $|# $|> $|%/);
  first.send({ t: "in", d: "seq 1 40000; echo DONE-MARK\r" });
  // Cut the connection while the output is still flowing.
  const t0 = Date.now();
  while (first.bytes.length < 20000 && Date.now() - t0 < 10000) await wait(5);
  assert.ok(first.bytes.length >= 20000, "output was flowing");
  const got = first.bytes.length;
  first.sock.destroy();
  await wait(200);
  // The box counts every byte; the client holds what it received. It reattaches from that.
  const re = await ok(reg, "term.attach", { term: o.term, surface: DECK, from: got });
  const second = await connect(port, re.path);
  await second.until(/DONE-MARK\r?\n/);
  await wait(300);
  // The truth: a fresh attach from 0 replays everything the ring holds.
  const all = await ok(reg, "term.attach", { term: o.term, surface: DECK, from: 0 });
  const full = await connect(port, all.path);
  await full.until(/DONE-MARK\r?\n/);
  await wait(300);
  assert.ok(full.bytes.length > 100000, `the whole run is more than a few chunks (${full.bytes.length})`);
  assert.equal(full.msgs.some(m => m.t === "cut"), false, "nothing fell out of the ring");
  const joined = Buffer.concat([first.bytes.subarray(0, got), second.bytes]);
  assert.equal(joined.length, full.bytes.length, "no byte lost and none repeated");
  assert.ok(joined.equals(full.bytes), "the bytes are the same bytes in the same order");
  const at = second.msgs.filter(m => m.t === "at").pop();
  assert.equal(at.offset, full.bytes.length);
});

test("C-2: term.open {cwd, session: victim} is refused for a caller who may not use that thread, and nothing is written to the victim's record", { skip: SKIP }, async t => {
  const { reg, work, events } = await registry(t);
  globalThis.__fakeThreadsKnown.set("victim_thread", { cwd: path.join(work, "proj"), deny: "bob" });
  const as = (login, caller) => (tool, input) => reg.call(tool, input, caller || deviceFor(login), { peer: { login, stableId: `n_${login}` }, person: { id: "s1", kind: "cookie" } });
  const r = await as("bob@example.com")("term.open", { cwd: path.join(work, "proj"), session: "victim_thread", surface: "deck:bobs" });
  assert.equal(r.error?.code, "denied");
  assert.equal((await as("bob@example.com")("term.open", { session: "ghost_thread", surface: "deck:bobs" })).error?.code, "not_found");
  assert.equal((await reg.call("term.list", {}, "deck")).data.terms.length, 0, "no terminal was made");
  assert.equal(events.since(0, {}).filter(e => e.type === "term.command").length, 0);
  assert.ok(!events.since(0, {}).some(e => e.thread === "victim_thread"));
  // the same session is fine for a caller the thread allows
  const o = await ok(reg, "term.open", { session: "victim_thread", surface: DECK });
  assert.equal(o.session, "victim_thread");
});

test("C-2: cwd with a session must be the session's own folder", { skip: SKIP }, async t => {
  const { reg, work } = await registry(t);
  fs.mkdirSync(path.join(work, "other"));
  const r = await reg.call("term.open", { cwd: path.join(work, "other"), session: "s_one", surface: DECK }, "deck", facts("per_owner"));
  assert.equal(r.error?.code, "denied");
  const same = await ok(reg, "term.open", { cwd: path.join(work, "proj"), session: "s_one", surface: DECK });
  assert.equal(same.cwd, fs.realpathSync(path.join(work, "proj")));
});

test("C-2: a typed command is recorded under the typist (author, via, surface), and term.attach for a session re-checks the caller", { skip: SKIP }, async t => {
  const { reg, work, events } = await registry(t);
  const port = await server(t, reg);
  const peer = { login: "carol@example.com", stableId: "n_carol" };
  const carolDevice = deviceFor("carol@example.com");
  const o = (await reg.call("term.open", { session: "s_one", surface: "deck:carols" }, carolDevice, { peer, person: { id: "s1", kind: "cookie" } }));
  assert.ok(!o.error, JSON.stringify(o.error));
  const c = await connect(port, o.data.path);
  await c.until(/\$ $|# $|> $|%/);
  c.send({ t: "in", d: "echo typed-by-carol\r" });
  await c.until(/typed-by-carol\r?\n/);
  await wait(300);
  const ev = events.since(0, {}).filter(e => e.type === "term.command");
  assert.equal(ev.length, 1);
  assert.equal(ev[0].thread, "s_one");
  assert.equal(ev[0].payload.author, "person:carol@example.com");
  assert.equal(ev[0].payload.via, carolDevice);
  assert.equal(ev[0].payload.surface, "deck:carols");
  // the session is no longer hers: attach is refused
  globalThis.__fakeThreadsKnown.set("s_one", { cwd: path.join(work, "proj"), deny: "carol" });
  const a = await reg.call("term.attach", { term: o.data.term, surface: "deck:carols" }, carolDevice, { peer, person: { id: "s1", kind: "cookie" } });
  assert.equal(a.error?.code, "not_found");
});
