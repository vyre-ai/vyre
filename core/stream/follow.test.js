// @ts-check
// stream.follow: a chat's stream over the peer wire (the door's meta.peerStream). The frames are the same per-viewer frames the WebSocket stream sends, resumable by cursor, and nobody
// but the chat's people opens one.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Registry, discover } from "../modules/index.js";
import { open } from "../store/index.js";
import { Events } from "../events/index.js";
import * as config from "../config/index.js";
import { tempHome } from "../../test/helpers.js";
import { SCRATCH } from "../../test/scratch.mjs";
import { fakeThreads } from "./fake-threads.js";
import { connect, wsDuplex } from "./client.js";

const CORE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CAROL = "carol@example.com", DAVE = "dave@example.com", BOB = "bob@example.com", ALEX = "alex@example.com";

async function world(t) {
  const p = config.ensure(tempHome(t));
  const db = open(p.db);
  const events = new Events(db);
  const reg = new Registry({ db, events, config: { role: "box" }, paths: p, log: () => {} });
  const fake = fs.mkdtempSync(path.join(SCRATCH, "vyre-stream-access-"));
  t.after(() => fs.rmSync(fake, { recursive: true, force: true }));
  fakeThreads(fake);
  await reg.start([...discover([CORE]).filter(f => f.manifest && f.manifest.name === "stream"), ...discover([fake], { firstPartyRoots: [fake] })], { role: "box" });
  assert.equal(reg.modules.get("stream")?.state, "running", reg.modules.get("stream")?.error);
  const w = { upgradeAs: "deck" };
  const s = http.createServer((_q, r) => { r.writeHead(404); r.end(); });
  s.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url || "/", "http://vyred");
    const u = reg.upgrades.get("stream/session");
    u.handler(req, socket, head, { caller: w.upgradeAs, url });
  });
  await new Promise(r => s.listen(0, "127.0.0.1", () => r(undefined)));
  const port = /** @type {any} */ (s.address()).port;
  t.after(async () => { s.closeAllConnections(); s.close(); await reg.stop(); db.close(); });
  const as = (login, caller = `tailnet:${login}`) => (tool, input) => reg.call(tool, input, caller, { peer: { login, stableId: `n_${login}` }, person: { id: `ps-${login}`, kind: "cookie" } }); // a person-reach tool over the tailnet needs the person's session (ADR 0032): the router sets it from the sign-in, so a test sets it
  const status = path => new Promise(resolve => {
    const r = http.request({ port, host: "127.0.0.1", path, headers: { connection: "Upgrade", upgrade: "websocket", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==", "sec-websocket-version": "13" } });
    r.on("response", res => resolve(res.statusCode));
    r.on("upgrade", (_res, sock) => { sock.destroy(); resolve(101); });
    r.on("error", () => resolve(0));
    r.end();
  });
  return { reg, w, as, status, port, stream: () => reg.modules.get("stream")?.handle };
}
const ok = r => { assert.ok(!r.error, r.error && `${r.error.code} ${r.error.message}`); return r.data; };
const codeOf = r => (r.error ? r.error.code : "ok");

/** A group of carol and dave, made by carol. */
async function group(w, session = "grp_cd") {
  ok(await w.as(CAROL)("stream.send", { session, text: "hello dave", people: [`person:${DAVE}`], to: [] }));
  return session;
}


/** A stand-in for the peer door's meta.peerStream (core/daemon/peer-door.js, wink-2): hands the producer an emit that records frames in order, and keeps its cleanup. */
function fakeDoor() {
  const d = { opened: /** @type {any[]} */ ([]), frames: /** @type {any[]} */ ([]), cleaned: 0, ended: /** @type {string[]} */ ([]), alive: true };
  /** @type {any} */ let cleanup = null;
  const meta = { open(id, producer) { d.opened.push(id); cleanup = producer({ emit: f => { if (!d.alive) return false; d.frames.push(f); return true; }, end: why => { d.ended.push(String(why)); d.alive = false; }, alive: () => d.alive }); } };
  return { meta, d, close() { if (cleanup) { cleanup(); d.cleaned++; cleanup = null; } } };
}

test("stream.follow: a person in the chat gets its frames over the peer door in order, live ones as they come, resumes by cursor, and the cleanup stops the feed", async t => {
  const w = await world(t);
  const sess = await group(w);
  const door = fakeDoor();
  const asCarol = (/** @type {string} */ tool, /** @type {any} */ input, /** @type {any} */ extra = {}) => w.reg.call(tool, input, `tailnet:${CAROL}`, { peer: { login: CAROL, stableId: `n_${CAROL}` }, person: { id: `ps-${CAROL}`, kind: "cookie" }, ...extra });
  const r = await asCarol("stream.follow", { session: sess, from: 0 }, { peerStream: door.meta });
  const data = ok(r);
  assert.ok(data.stream && /^[A-Za-z0-9_-]{8,64}$/.test(data.stream), "a stream id the door accepts");
  assert.equal(door.d.opened.length, 1);
  const types = () => door.d.frames.map(f => f.type);
  assert.ok(types().includes("session.user-message"), "the message already in the log is replayed");
  const cursors = door.d.frames.filter(f => f.cur > 0).map(f => f.cur);
  assert.deepEqual(cursors, cursors.map((_, i) => i + 1), "cursors are gapless from 1");
  const before = door.d.frames.length;
  ok(await w.as(DAVE)("stream.send", { session: sess, text: "hi carol" }));
  assert.ok(door.d.frames.length > before && door.d.frames.some(f => f.type === "session.user-message" && /hi carol/.test(JSON.stringify(f.data))), "a live frame arrives");
  // resume: a second follow from the last cursor sends only what is newer
  const last = Math.max(...door.d.frames.filter(f => f.cur > 0).map(f => f.cur));
  const door2 = fakeDoor();
  ok(await asCarol("stream.follow", { session: sess, from: last }, { peerStream: door2.meta }));
  assert.ok(door2.d.frames.filter(f => f.cur > 0).every(f => f.cur > last), "resume from the cursor repeats nothing");
  door.close();
  const n = door.d.frames.length;
  door.d.alive = true;
  ok(await w.as(DAVE)("stream.send", { session: sess, text: "after close" }));
  assert.equal(door.d.frames.length, n, "no frame after the cleanup ran");
  door2.close();
});

test("stream.follow: someone who is not in the chat gets nothing and the door is never opened; a call that is not on the peer door is refused", async t => {
  const w = await world(t);
  const sess = await group(w);
  const door = fakeDoor();
  const asBob = (/** @type {string} */ tool, /** @type {any} */ input, /** @type {any} */ extra = {}) => w.reg.call(tool, input, `tailnet:${BOB}`, { peer: { login: BOB, stableId: `n_${BOB}` }, person: { id: `ps-${BOB}`, kind: "cookie" }, ...extra });
  const r = await asBob("stream.follow", { session: sess, from: 0 }, { peerStream: door.meta });
  assert.equal(codeOf(r), "not_found");
  assert.equal(door.d.opened.length, 0, "no stream was opened for a stranger");
  const noDoor = await w.as(CAROL)("stream.follow", { session: sess, from: 0 });
  assert.equal(codeOf(noDoor), "bad_input", "stream.follow is for the peer door; the WebSocket path is stream.open");
});
