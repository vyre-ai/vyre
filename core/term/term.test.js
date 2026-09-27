// @ts-check
// The term module inside a real Registry: who may open a terminal, the presence unlock, the files
// guard on cwd, one-use tickets, and on Linux a real shell over a real WebSocket (echo, resize,
// close ending the whole session, and the end after the last socket goes away).

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

const CORE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LINUX = process.platform === "linux";
const DECK = "deck:abc123";

/** A presence verifier that passes only a call carrying a proof, so unlock's gate is real. */
const presence = {
  required: (_tool, def) => Boolean(def && def.presence),
  verify: async ({ proof }) => proof ? { ok: true, method: "test" } : { ok: false, code: "presence_required", message: "needs a person", methods: ["passkey"] },
};

async function registry(t, term = {}) {
  const root = tempHome(t);
  const p = config.ensure(root);
  const work = fs.mkdtempSync(path.join(SCRATCH, "vyre-term-work-"));
  fs.mkdirSync(path.join(work, "proj"));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const db = open(p.db);
  const events = new Events(db);
  const reg = new Registry({ db, events, config: { role: "box", files: { roots: [work] }, term: { shell: "/bin/sh", ...term } }, paths: p, log: () => {}, presence: /** @type {any} */ (presence) });
  await reg.start(discover([CORE]).filter(f => f.manifest && f.manifest.name === "term"), { role: "box" });
  t.after(async () => { await reg.stop(); db.close(); });
  assert.equal(reg.modules.get("term")?.state, "running", reg.modules.get("term")?.error);
  return { reg, work, events };
}

const PROOF = { proof: { method: "test" } };
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
      sock, status: 0, closed: false,
      get text() { return text; },
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
        if (op === 2) text += buf.subarray(off, off + len).toString("utf8");
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
    const u = await reg.call("term.unlock", { surface: DECK }, caller, PROOF);
    assert.ok(u.error, `${caller} should not unlock`);
  }
  assert.ok(!reg.listTools("tailnet-guest:x").some(x => x.name.startsWith("term.")));
});

test("term: open needs an unlock from the same screen, and the unlock needs presence", async t => {
  const { reg, work } = await registry(t);
  const first = await reg.call("term.open", { cwd: work, surface: DECK }, "deck");
  assert.equal(first.error?.code, "unlock_required");
  const noProof = await reg.call("term.unlock", { surface: DECK }, "deck");
  assert.equal(noProof.error?.code, "presence_required");
  const u = await ok(reg, "term.unlock", { surface: DECK }, "deck", PROOF);
  assert.ok(u.until > Date.now() + 11 * 3_600_000);
  // Another screen, another caller or another tailnet node has no grant.
  assert.equal((await reg.call("term.open", { cwd: work, surface: "phone:zzz999" }, "deck")).error?.code, "unlock_required");
  assert.equal((await reg.call("term.open", { cwd: work, surface: DECK }, "cli")).error?.code, "unlock_required");
  await ok(reg, "term.unlock", { surface: DECK }, "tailnet:alex", { ...PROOF, peer: { stableId: "nPhone" } });
  assert.equal((await reg.call("term.open", { cwd: work, surface: DECK }, "tailnet:alex", { peer: { stableId: "nLaptop" } })).error?.code, "unlock_required");
});

test("term: cwd must pass the files guard", async t => {
  const { reg, work } = await registry(t);
  await ok(reg, "term.unlock", { surface: DECK }, "deck", PROOF);
  for (const cwd of ["/", "/etc", path.dirname(work), path.join(work, "..", "x"), "relative/path", path.join(work, "missing")]) {
    const r = await reg.call("term.open", { cwd, surface: DECK }, "deck");
    assert.ok(r.error, `${cwd} should be refused`);
  }
  assert.equal(reg.modules.get("term")?.handle.terms.size, 0);
});

test("term: a ticket works once and expires", { skip: !LINUX && "the pty runs on the box (util-linux script)" }, async t => {
  const { reg, work } = await registry(t, { ticketMs: 300 });
  const port = await server(t, reg);
  await ok(reg, "term.unlock", { surface: DECK }, "deck", PROOF);
  const o = await ok(reg, "term.open", { cwd: path.join(work, "proj"), surface: DECK, cols: 80, rows: 24 });
  const a = await connect(port, o.path);
  assert.equal(a.status, 101);
  const again = await connect(port, o.path);
  assert.equal(again.status, 403);
  const late = await ok(reg, "term.attach", { term: o.term, surface: DECK });
  await wait(400);
  assert.equal((await connect(port, late.path)).status, 403);
  // Attach is for the screen that opened it.
  assert.equal((await reg.call("term.attach", { term: o.term, surface: "phone:zzz999" }, "deck")).error?.code, "unlock_required");
  a.sock.destroy();
});

test("term: a real shell round trip, resize, and close ends the whole session", { skip: !LINUX && "the pty runs on the box (util-linux script)" }, async t => {
  const { reg, work, events } = await registry(t);
  const port = await server(t, reg);
  await ok(reg, "term.unlock", { surface: DECK }, "deck", PROOF);
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
});

test("term: the terminal ends a while after its last socket closes, unless reattached", { skip: !LINUX && "the pty runs on the box (util-linux script)" }, async t => {
  const { reg, work } = await registry(t, { endAfterMs: 400 });
  const port = await server(t, reg);
  await ok(reg, "term.unlock", { surface: DECK }, "deck", PROOF);
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

test("term: at most max terminals, and stop ends them all", { skip: !LINUX && "the pty runs on the box (util-linux script)" }, async t => {
  const { reg, work } = await registry(t, { max: 2 });
  await ok(reg, "term.unlock", { surface: DECK }, "deck", PROOF);
  await ok(reg, "term.open", { cwd: work, surface: DECK });
  await ok(reg, "term.open", { cwd: work, surface: DECK });
  assert.equal((await reg.call("term.open", { cwd: work, surface: DECK }, "deck")).error?.code, "too_many");
  const handle = reg.modules.get("term")?.handle;
  const pids = [...handle.terms.values()].map(x => x.pty.pid);
  await handle.stop();
  for (let i = 0; i < 20 && pids.some(alive); i++) await wait(100);
  assert.ok(!pids.some(alive));
});
