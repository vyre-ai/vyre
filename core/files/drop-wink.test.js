// VyreDrop over Wink with the real sealing, the real server store and the real receiver, joined by an in-process "connection" (a computer calls the server's tools as the device it is, the server tells a connected
// receiver there is a drop): a file crosses between two computers through the server, sealed to the receiver; the server holds only ciphertext; an asleep receiver gets it when it wakes; a damaged chunk is refused.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { SCRATCH } from "../../test/scratch.mjs";
import { dropWink } from "./drop-wink.js";
import { createDropStore } from "./drop-store.js";
import { sender, receiver } from "./drop-seal.js";
import { newDeviceKey, pointOf, ecdhFrom, b64 } from "../../lib/keywrap.js";

/** Stand-ins for the identity list: each device (A, B) has an entry whose key-agreement key is its own P-256 key; the list serves the public points, the device's own ECDH is its alone. */
const KEYS = { A: newDeviceKey(), B: newDeviceKey(), X: newDeviceKey() };
const pointOfEid = eid => b64(pointOf(KEYS[eid].publicJwk));
const listDevices = () => ["A", "B"].map(e => ({ device: e, agree: pointOfEid(e) }));
const identityCalls = async (tool, input, me) => {
  if (tool === "spaces.identity.id") return { data: { id: "per_alex" } };
  if (tool === "spaces.identity.devices.read") return { data: { devices: listDevices() } };
  if (tool === "spaces.identity.status") return { data: { exists: true, pending: false, id: "per_alex", eid: me } };
  if (tool === "spaces.identity.ecdh") return { data: { secret: b64(await ecdhFrom(KEYS[me].privateJwk)(Buffer.from(input.epk, "base64url"))) } };
  return undefined;
};
const dir = p => fs.mkdtempSync(path.join(SCRATCH, p));
const guardFor = roots => ({ resolveSafe: p => { const real = fs.realpathSync(String(p)); if (path.basename(real).startsWith(".")) throw Object.assign(new Error("not available"), { code: "not_available" }); return { real }; }, roots: () => ({ live: roots.map(r => ({ given: r, real: fs.realpathSync(r) })) }) });

/** The server, and a way for each computer to reach it as the device it is. */
function world(t, { devices } = {}) {
  const tools = new Map(), events = [], offers = [];
  const root = dir("drop-srv-");
  const online = new Set(["A", "B"]);
  const peers = {};   // device id -> { offered(id) } the connected computers' own handlers
  const srvCtx = { paths: { root }, config: { files: {} }, log() {}, events: { emit: (n, p) => events.push([n, p]), on: () => () => {} }, tool: (n, d) => tools.set(n, d),
    call: async (tool, input) => {
      if (tool === "relay.devices.all") return { data: { devices: devices || [{ id: "A", name: "laptop", kind: "app", online: online.has("A") }, { id: "B", name: "desktop", kind: "app", online: online.has("B") }, { id: "W", name: "a browser", kind: "web", online: true }] } };
      { const r = await identityCalls(tool, input, "A"); if (r) return r; }
      if (tool === "wink.device.call") { if (!online.has(input.device)) throw Object.assign(new Error("not connected"), { code: "unreachable" }); offers.push(input); void peers[input.device]?.offered(input.input.id); return { ok: true }; }
      throw new Error("unexpected " + tool);
    } };
  const srvRoot = dir("drop-srvfiles-");
  const srv = dropWink(srvCtx, { role: "box", g: guardFor([srvRoot]), cfg: {} });
  t.after(() => srv.stop());
  const via = device => (tool, input, caller = `device:${device}`) => tools.get(tool).run(input, { caller });
  const computer = (id, o = {}) => {
    const t2 = new Map(), ev = [];
    const home = dir(`drop-${id}-`), files = dir(`drop-${id}-files-`);
    const ctx = { paths: { root: home }, config: { files: { roots: [files] } }, log() {}, events: { emit: (n, p) => ev.push([n, p]), on: (n, f) => { ctx.fire = ctx.fire || {}; (ctx.fire[n] ||= []).push(f); return () => {}; } }, tool: (n, d) => t2.set(n, d),
      call: async (tool, input) => { if (tool === "wink.home.id") return { data: { device: "srv" } }; { const r = await identityCalls(tool, input, id); if (r) return r; } throw new Error("unexpected " + tool); },
      sessionFor: () => ({ call: async (tool, input) => via(id)(tool, input) }) };
    fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ files: { roots: [files] } }));
    const inbox = path.join(files, "inbox");
    const cfg = { inbox, receive: o.receive === true };
    const h = dropWink(ctx, { role: "local", g: guardFor([files]), cfg });
    t.after(() => h.stop());
    peers[id] = { offered: async did => t2.get("files.drop.offered").run({ id: did }, { caller: "module:wink" }) };
    return { id, ctx, files, inbox, ev, tool: (n, i, caller = "cli") => t2.get(n).run(i, { caller }) };
  };
  return { srv, tools, events, offers, root, via, computer, online };
}
const until = async (f, ms = 4000) => { const t0 = Date.now(); for (;;) { const v = await f(); if (v) return v; if (Date.now() - t0 > ms) throw new Error("timed out"); await new Promise(r => setTimeout(r, 25)); } };
const allFiles = d => { const o = []; const w = x => { for (const n of fs.existsSync(x) ? fs.readdirSync(x) : []) { const p = path.join(x, n); fs.statSync(p).isDirectory() ? w(p) : o.push(p); } }; w(d); return o; };

test("sealing: only the receiver's key opens a drop, a chunk cannot be moved, repeated or taken from another drop, and every drop has its own key", async () => {
  const id = "d".repeat(30), mine = ecdhFrom(KEYS.A.privateJwk), theirs = ecdhFrom(KEYS.X.privateJwk);
  const a = sender(id, pointOfEid("A"), "A"), b = sender(id, pointOfEid("A"), "A");
  assert.notEqual(a.eph, b.eph, "a fresh key for each drop");
  const c0 = a.seal(0, 3, Buffer.from("header")), c1 = a.seal(1, 3, Buffer.from("data"));
  const r = await receiver(id, a.eph, mine, "A");
  assert.equal(r.open(0, 3, c0).toString(), "header");
  assert.throws(() => r.open(1, 3, c0), { code: "bad_chunk" }, "a chunk in another place");
  assert.throws(() => r.open(0, 4, c0), { code: "bad_chunk" }, "a different total");
  assert.throws(() => r.open(1, 3, Object.assign(Buffer.from(c1), { 0: c1[0] ^ 1 })), { code: "bad_chunk" }, "a changed byte");
  await assert.rejects(receiver("e".repeat(30), a.eph, mine, "A"), { code: "bad_chunk" }, "another drop");
  await assert.rejects(receiver(id, a.eph, theirs, "A"), { code: "bad_chunk" }, "another device's key");
  await assert.rejects(receiver(id, a.eph, mine, "B"), { code: "bad_chunk" }, "sealed to another entry of the list");
});

test("a file crosses between two computers through the server: it arrives intact, the server held only ciphertext and keeps nothing after", async t => {
  const w = world(t);
  const A = w.computer("A"), B = w.computer("B", { receive: true });
  await until(() => w.tools.get("files.drop.targets").run({}, { caller: "device:A" }).then(r => r.devices.find(d => d.id === "B" && d.ready)));
  const big = Buffer.concat([Buffer.from("PLAIN-MARKER-DROP "), crypto.randomBytes(1_300_000)]);
  const src = path.join(A.files, "report.bin"); fs.writeFileSync(src, big);
  const r = await A.tool("files.send", { path: src, to: "desktop" });
  assert.deepEqual([r.sent, r.bytes, r.to, r.queued], ["report.bin", big.length, "desktop", false]);
  const landed = await until(() => fs.existsSync(path.join(B.inbox, "report.bin")) && path.join(B.inbox, "report.bin"));
  assert.ok(fs.readFileSync(landed).equals(big), "the same bytes");
  assert.ok(B.ev.some(([n, p]) => n === "files.received" && p.name === "report.bin" && p.bytes === big.length));
  assert.deepEqual(allFiles(path.join(w.root, "drop")).filter(f => /\/c\d+$|meta\.json$/.test(f)), [], "the server keeps nothing once it is taken");
  assert.deepEqual(fs.readdirSync(B.inbox), ["report.bin"], "no temporary file is left");
});

test("the server only ever holds ciphertext: its store has neither the file's name nor its bytes while the drop waits", async t => {
  const w = world(t);
  w.online.delete("B");                                  // the receiver is asleep
  const A = w.computer("A"), B = w.computer("B", { receive: true });
  await until(() => w.tools.get("files.drop.targets").run({}, { caller: "device:A" }).then(r => r.devices.find(d => d.id === "B" && d.ready)));
  const src = path.join(A.files, "secret-plan.txt"); fs.writeFileSync(src, "PLAIN-MARKER-WAITING ".repeat(5000));
  const r = await A.tool("files.send", { path: src, to: "B" });
  assert.equal(r.queued, true, "the receiver is not connected: the drop waits");
  const held = allFiles(path.join(w.root, "drop")).filter(f => /\/c\d+$/.test(f));
  assert.ok(held.length >= 2);
  for (const f of allFiles(path.join(w.root, "drop"))) { const b = fs.readFileSync(f); assert.ok(!b.includes(Buffer.from("PLAIN-MARKER-WAITING")) && !b.includes(Buffer.from("secret-plan")), `${path.basename(f)} holds no plaintext`); }
  assert.equal(fs.existsSync(path.join(B.inbox, "secret-plan.txt")), false);
  // the receiver wakes and connects: the daemon's connect hook offers it what waits, and it is taken
  w.online.add("B");
  await w.tools.get("files.drop.push").run({ device: "B" }, { caller: "module:vyred" });
  const landed = await until(() => fs.existsSync(path.join(B.inbox, "secret-plan.txt")) && path.join(B.inbox, "secret-plan.txt"));
  assert.equal(fs.readFileSync(landed, "utf8"), "PLAIN-MARKER-WAITING ".repeat(5000));
  assert.deepEqual(allFiles(path.join(w.root, "drop")).filter(f => /\/c\d+$/.test(f)), []);
});

test("who can do what: a receiver that has not turned receiving on gets nothing; only the person's own computers use the server's tools; a browser or oneself is no target; a secret is refused", async t => {
  const w = world(t);
  const A = w.computer("A"), B = w.computer("B");        // B has receiving off
  const src = path.join(A.files, "a.txt"); fs.writeFileSync(src, "x");
  await assert.rejects(A.tool("files.send", { path: src, to: "desktop" }), { code: "not_ready" });
  for (const t2 of ["files.drop.targets", "files.drop.pending", "files.drop.register"]) await assert.rejects(w.tools.get(t2).run({ eid: "A" }, { caller: "cli" }), { code: "denied" }, `${t2} from a non-device`);
  await B.tool("files.receive", { on: true });
  await assert.rejects(A.tool("files.send", { path: src, to: "a browser" }), { code: "not_found" }, "a browser is no target");
  await assert.rejects(A.tool("files.send", { path: src, to: "laptop" }), { code: "not_found" }, "not oneself");
  fs.writeFileSync(path.join(A.files, ".env"), "KEY=1");
  await assert.rejects(A.tool("files.send", { path: path.join(A.files, ".env"), to: "desktop" }), { code: "not_available" });
  await assert.rejects(w.tools.get("files.drop.begin").run({ id: "a".repeat(30), to: "W", total: 1, size: 1, eph: "x".repeat(44) }, { caller: "device:A" }), { code: "not_found" });
  // another computer cannot read, take or cancel a drop that is not for it
  w.online.delete("B");
  await A.tool("files.send", { path: src, to: "desktop" });
  const waiting = (await w.tools.get("files.drop.pending").run({}, { caller: "device:B" })).drops[0];
  assert.ok(waiting, "the drop waits for B");
  await assert.rejects(w.tools.get("files.drop.get").run({ id: waiting.id, index: 0 }, { caller: "device:A" }), { code: "not_found" }, "A cannot read B's drop");
  await assert.rejects(w.tools.get("files.drop.ack").run({ id: waiting.id }, { caller: "device:A" }), { code: "not_found" }, "or throw it away as the receiver");
  await assert.rejects(w.tools.get("files.drop.cancel").run({ id: waiting.id }, { caller: "device:B" }), { code: "not_found" }, "only the sender takes it back");
  await w.tools.get("files.drop.cancel").run({ id: waiting.id }, { caller: "device:A" });
  assert.equal((await w.tools.get("files.drop.pending").run({}, { caller: "device:B" })).drops.length, 0);
  // no computer is ready and none is named: the sender is told so in words
  await B.tool("files.receive", { on: false });
  await assert.rejects(A.tool("files.send", { path: src }), { code: "ambiguous" });
});

test("a damaged drop is refused: the file does not appear, the drop stays for another try, and a wrong hash is caught", async t => {
  const w = world(t);
  w.online.delete("B");
  const A = w.computer("A"), B = w.computer("B", { receive: true });
  await until(() => w.tools.get("files.drop.targets").run({}, { caller: "device:A" }).then(r => r.devices.find(d => d.id === "B" && d.ready)));
  const src = path.join(A.files, "doc.txt"); fs.writeFileSync(src, "the document");
  await A.tool("files.send", { path: src, to: "B" });
  const chunk = allFiles(path.join(w.root, "drop")).find(f => /\/c1$/.test(f));
  const blob = fs.readFileSync(chunk); blob[2] ^= 0xff; fs.writeFileSync(chunk, blob);
  w.online.add("B");
  await w.tools.get("files.drop.push").run({ device: "B" }, { caller: "module:vyred" });
  await new Promise(r => setTimeout(r, 300));
  assert.equal(fs.existsSync(path.join(B.inbox, "doc.txt")), false, "nothing landed");
  assert.deepEqual(fs.existsSync(B.inbox) ? fs.readdirSync(B.inbox) : [], [], "no temporary file either");
  assert.ok(allFiles(path.join(w.root, "drop")).some(f => /\/c1$/.test(f)), "the drop is still on the server");
});

test("the server's bounds: a file over the cap, a server holding as much as it will, an open drop that never finished, and an expired drop", () => {
  let T = 1_000_000;
  const st = createDropStore({ dir: dir("drop-cap-"), maxBytes: 100, homeBytes: 150, ttlMs: 1000, now: () => T });
  const k = newDropKey().pub;
  st.register("B", k, { eid: "B", sig: "s" });
  assert.throws(() => st.begin({ id: "a".repeat(30), from: "A", to: "B", total: 2, size: 101, eph: k }), { code: "too_large" });
  const id = "b".repeat(30); st.begin({ id, from: "A", to: "B", total: 2, size: 90, eph: k }); st.put(id, "A", 0, Buffer.alloc(40)); st.put(id, "A", 1, Buffer.alloc(40)); st.finish(id, "A");
  assert.throws(() => st.begin({ id: "c".repeat(30), from: "A", to: "B", total: 2, size: 90, eph: k }), { code: "no_room" }, "the server holds as much as it will");
  assert.throws(() => st.put(id, "A", 2, Buffer.alloc(1)), e => ["not_found", "gap", "bad_input"].includes(e.code), "a finished drop takes no more");
  assert.throws(() => st.get(id, "A", 0), { code: "not_found" }, "only the receiver takes it");
  assert.equal(st.pending("B").length, 1);
  T += 2000; assert.equal(st.pending("B").length, 0, "expired: no longer offered");
  assert.equal(st.sweep(), 1, "and deleted");
  const open = "d".repeat(30); st.begin({ id: open, from: "A", to: "B", total: 3, size: 10, eph: k });
  assert.throws(() => st.finish(open, "A"), { code: "incomplete" });
  T += 4_000_000; assert.equal(st.sweep(), 1, "an unfinished drop is dropped too");
});

test("files.deliver: the server's own file to one of the person's computers, sealed on the server, taken when the computer is there", async t => {
  const w = world(t);
  const B = w.computer("B", { receive: true });
  await until(() => w.tools.get("files.drop.targets").run({}, { caller: "device:A" }).then(r => r.devices.find(d => d.id === "B" && d.ready)));
  const srcDir = fs.realpathSync(path.dirname(path.join(w.root, "x"))); void srcDir;
  const f = path.join(dir("drop-srcsrv-"), "from-server.txt"); fs.writeFileSync(f, "delivered ".repeat(1000));
  // the server's guard is the one given to dropWink: its stand-in accepts any real path
  const r = await w.tools.get("files.deliver").run({ path: f, device: "desktop" }, { caller: "cli" });
  assert.deepEqual([r.sent, r.to], ["from-server.txt", "desktop"]);
  const landed = await until(() => fs.existsSync(path.join(B.inbox, "from-server.txt")) && path.join(B.inbox, "from-server.txt"));
  assert.equal(fs.readFileSync(landed, "utf8"), "delivered ".repeat(1000));
});

test("the receiving key comes from the identity list, never the server: an entry the list does not carry seals nothing, and a drop sealed to another of the person's computers does not open on the real receiver", async t => {
  const w = world(t);
  const A = w.computer("A"), B = w.computer("B", { receive: true });
  await until(() => w.tools.get("files.drop.targets").run({}, { caller: "device:A" }).then(r => r.devices.find(d => d.id === "B" && d.ready)));
  const src = path.join(A.files, "x.txt"); fs.writeFileSync(src, "x");
  const keys = path.join(w.root, "drop", "keys.json"); const m = JSON.parse(fs.readFileSync(keys, "utf8"));
  const real = m.B;
  // the server names an entry the identity list does not carry (its own, say): nothing is sealed
  m.B = { eid: "attacker" }; fs.writeFileSync(keys, JSON.stringify(m));
  await assert.rejects(A.tool("files.send", { path: src, to: "desktop" }), { code: "not_verified" }, "an entry not on the list");
  await assert.rejects(w.tools.get("files.deliver").run({ path: src, device: "desktop" }, { caller: "cli" }), { code: "not_verified" }, "the server's own deliver checks it too");
  // the server names another entry that IS on the list (A's): the file is sealed to A, so B, the intended receiver, cannot open it and nothing lands
  m.B = { eid: "A" }; fs.writeFileSync(keys, JSON.stringify(m));
  await A.tool("files.send", { path: src, to: "desktop" });
  await new Promise(r => setTimeout(r, 300));
  assert.equal(fs.existsSync(path.join(B.inbox, "x.txt")), false, "B could not open a drop sealed to A's key");
  m.B = real; fs.writeFileSync(keys, JSON.stringify(m));
  assert.equal((await A.tool("files.send", { path: src, to: "desktop" })).sent, "x.txt", "the real entry still works");
  await until(() => fs.existsSync(path.join(B.inbox, "x.txt")));
});
