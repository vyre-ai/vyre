// @ts-check
// A local core joins the box as a companion of the desktop app already paired on the same machine (core/link/companion.js).
// The handlers run directly over an in-memory table and a fake device registry: what is checked here is the box's own rules.

import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { companionSide, coreFingerprint, WINDOW_MS, tokenMessage, boxId, inputDigest } from "./companion.js";

const APP = "abcdefgabcdefgab", WEB = "bcdefgabcdefgabc", KEYID = "kh1";
const spki = () => crypto.generateKeyPairSync("ec", { namedCurve: "P-256" }).publicKey.export({ format: "der", type: "spki" }).toString("base64url");

function world() {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE link_peers (id TEXT PRIMARY KEY, name TEXT NOT NULL, login TEXT, node TEXT, stable_id TEXT, key_hash TEXT NOT NULL UNIQUE, paired_at INTEGER NOT NULL, last_seen INTEGER, kind TEXT NOT NULL DEFAULT 'mac', parent TEXT, core_pub TEXT)`);
  const clock = { t: 10_000_000 };
  const devices = new Map([[APP, { kind: "app", trusted: true, pairedAt: clock.t - 60_000, presenceKey: KEYID, removed: false }], [WEB, { kind: "web", trusted: true, pairedAt: clock.t - 60_000, presenceKey: "kh2", removed: false }]]);
  const tools = new Map(), events = [];
  const ctx = { tool: (n, d) => tools.set(n, d), events: { emit: (t, p) => events.push([t, p]), on: () => () => {} } };
  const boxPub = crypto.generateKeyPairSync("ed25519").publicKey.export({ format: "der", type: "spki" }).toString("base64url");
  const side = companionSide(ctx, { db, now: () => clock.t, box: () => ({ pub: boxPub, name: "alex" }), deviceInfo: async id => devices.get(id) || null });
  const call = (tool, input, caller = `device:${APP}`, meta = {}) => tools.get(tool).run(input, { caller, person: { id: "ps1" }, presence: { method: "device", keyId: KEYID }, ...meta });
  const ask = (extra = {}, caller, meta) => call("link.companion.pair", { core: spki(), name: "alex's PC core", nonce: crypto.randomBytes(12).toString("base64url"), ts: clock.t, ...extra }, caller, meta);
  return { db, clock, devices, tools, events, side, call, ask, boxPub };
}
const refusal = async (p, re) => assert.rejects(p, e => re.test(e.message));

test("companion: inside 15 minutes of the app's pairing the box approves at once, audits it, and answers no secret", async () => {
  const w = world();
  const r = await w.ask();
  assert.equal(r.approved, "window");
  assert.ok(r.id && !("key" in r), "an id and nothing the app could carry to the core");
  assert.match(r.fingerprint, /^[a-z2-7]{4} [a-z2-7]{4}$/);
  const row = w.db.prepare("SELECT kind, parent, key_hash FROM link_peers WHERE id = ?").get(r.id);
  assert.deepEqual([row.kind, row.parent], ["companion", APP]);
  assert.ok(w.events.some(e => e[0] === "companion.paired" && e[1].device === APP && e[1].companion === r.id && e[1].approved === "window" && e[1].fingerprint === r.fingerprint && e[1].nonce));
});

test("companion: only a desktop app's own device, with its own key and a person session, over a fresh nonce and time", async () => {
  const w = world();
  await refusal(w.ask({}, "cli"), /desktop app over its own relay channel/);
  await refusal(w.ask({}, `device:${WEB}`), /only a paired desktop app/);
  await refusal(w.ask({}, undefined, { presence: { method: "device", keyId: "kh-other" } }), /own key/);
  await refusal(w.ask({}, undefined, { person: undefined }), /no person session/);
  w.clock.t += 11 * 60_000; // the attempt limit is per 10 minutes, tested on its own below
  await refusal(w.ask({ core: "short" }), /public key this box accepts/);
  await refusal(w.ask({ ts: w.clock.t - 3 * 60_000 }), /two minutes/);
  const n = "n".repeat(20);
  assert.ok((await w.ask({ nonce: n })).id);
  w.clock.t += 11 * 60_000;
  await w.devices.set(APP, { ...w.devices.get(APP), pairedAt: w.clock.t - WINDOW_MS - 1 });
  await refusal(w.ask({ nonce: n }), /nonce/);
  assert.ok(w.events.filter(e => e[0] === "companion.refused").length >= 6, "each refusal is audited with its reason");
});

test("companion: past the window, or a second companion, waits for the person's tap; one request at a time, expiring in 5 minutes", async () => {
  const w = world();
  w.devices.set(APP, { ...w.devices.get(APP), pairedAt: w.clock.t - WINDOW_MS - 1 });
  const p = await w.ask();
  assert.equal(p.approved, false);
  assert.ok(p.pending);
  assert.ok(w.events.some(e => e[0] === "companion.requested" && e[1].request === p.pending && e[1].reason === "outside the pairing window"));
  await refusal(w.ask(), /already waiting/);
  assert.equal(w.db.prepare("SELECT COUNT(*) AS n FROM link_peers WHERE kind = 'companion'").get().n, 0, "nothing enrolled before the tap");
  const ok = await w.call("link.companion.approve", { request: p.pending });
  assert.ok(ok.id);
  assert.ok(w.events.some(e => e[0] === "companion.paired" && e[1].approved === "tap"));
  // a second companion in the window also needs the tap, and approving replaces the first
  w.devices.set(APP, { ...w.devices.get(APP), pairedAt: w.clock.t });
  const second = await w.ask();
  assert.ok(second.pending, "a second companion without a tap is refused");
  await assert.rejects(w.call("link.companion.approve", { request: "nope" }), /no companion request/);
  w.clock.t += 5 * 60_000 + 1;
  await assert.rejects(w.call("link.companion.approve", { request: second.pending }), /no companion request/, "a pending request expires in 5 minutes");
});

test("companion: valid only while its parent is live, checked on every use; removing the app removes it, and revoking it leaves the app", async () => {
  const w = world();
  const r = await w.ask();
  assert.ok(await w.side.valid(r.id));
  assert.equal((await w.call("link.companion.list", {})).companions[0].valid, true);
  w.devices.set(APP, { ...w.devices.get(APP), trusted: false });
  assert.equal((await w.side.valid(r.id)).trusted, false, "a parent that became untrusted makes an equally limited companion now");
  w.devices.set(APP, { ...w.devices.get(APP), removed: true });
  assert.equal(await w.side.valid(r.id), null, "a removed parent invalidates the companion at once, before any cleanup");
  assert.equal((await w.call("link.companion.list", {})).companions[0].valid, false);
  await w.side.reconcile();
  assert.equal(w.db.prepare("SELECT COUNT(*) AS n FROM link_peers WHERE kind = 'companion'").get().n, 0, "and the tidy-up removes the row");
  assert.ok(w.events.some(e => e[0] === "companion.removed" && /app device was removed/.test(e[1].why)));
  // revoking the companion alone
  const w2 = world();
  const r2 = await w2.ask();
  assert.equal((await w2.call("link.companion.remove", { id: r2.id })).removed, r2.id);
  assert.equal(w2.devices.get(APP).removed, false, "the app device stays");
});

test("companion: at most 5 attempts from a device in 10 minutes, and the core's key fingerprint is the same short form everywhere", async () => {
  const w = world();
  for (let i = 0; i < 5; i++) await w.ask({ core: "short" }).catch(() => {});
  await refusal(w.ask(), /too many companion attempts/);
  w.clock.t += 10 * 60_000 + 1;
  assert.ok((await w.ask()).id);
  assert.match(coreFingerprint(spki()), /^[a-z2-7]{4} [a-z2-7]{4}$/);
});

// ---- the call proof: the core's own key signs every call ----

/** A core with its own P-256 key, paired as a companion; sign() makes a call token the way the core does. */
async function pairedCore(w) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  const core = publicKey.export({ format: "der", type: "spki" }).toString("base64url");
  const r = await w.call("link.companion.pair", { core, name: "alex's PC core", nonce: crypto.randomBytes(12).toString("base64url"), ts: w.clock.t });
  const sign = (tool, input = {}, o = {}) => {
    const ts = o.ts ?? w.clock.t, nonce = o.nonce ?? crypto.randomBytes(12).toString("base64url"), id = o.id ?? r.id;
    const sig = crypto.sign("sha256", tokenMessage({ box: o.box ?? boxId(w.boxPub), companion: id, ts, nonce, tool, input }), { key: o.key ?? privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url");
    return `c1.${id}.${ts}.${nonce}.${sig}`;
  };
  return { id: r.id, boxPin: r.box, sign, privateKey };
}
const verify = (w, token, tool, input) => w.tools.get("link.companion.verify").run({ token, tool, input }, {});

test("companion call: pairing hands the core the box's key to pin, and a token signed by the core's own key verifies once", async () => {
  const w = world();
  const c = await pairedCore(w);
  assert.equal(c.boxPin.pub, w.boxPub);
  assert.equal(c.boxPin.id, boxId(w.boxPub));
  const hello = await w.tools.get("link.companion.hello").run({ token: c.sign("link.companion.hello", {}) }, {});
  assert.deepEqual([hello.paired, hello.companion, hello.device, hello.box.id], [true, c.id, APP, boxId(w.boxPub)]);
  const t = c.sign("sync.upload.start", { path: "a.jsonl", bytes: 3, hash: "h" });
  assert.equal((await verify(w, t, "sync.upload.start", { path: "a.jsonl", bytes: 3, hash: "h" })).id, c.id);
  await refusal(verify(w, t, "sync.upload.start", { path: "a.jsonl", bytes: 3, hash: "h" }), /nonce was already used/);
});

test("companion call: another key, another call, another input, another box, or another time is refused", async () => {
  const w = world();
  const c = await pairedCore(w);
  const input = { upload: "u1", offset: 0 };
  const other = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey;
  await refusal(verify(w, c.sign("sync.upload.cancel", input, { key: other }), "sync.upload.cancel", input), /signature/);
  await refusal(verify(w, c.sign("sync.upload.cancel", input), "sync.upload.finish", input), /signature/);
  await refusal(verify(w, c.sign("sync.upload.cancel", input), "sync.upload.cancel", { ...input, upload: "u2" }), /signature/);
  await refusal(verify(w, c.sign("sync.upload.cancel", input, { box: boxId("another box") }), "sync.upload.cancel", input), /signature/);
  await refusal(verify(w, c.sign("sync.upload.cancel", input, { ts: w.clock.t - 3 * 60_000 }), "sync.upload.cancel", input), /two minutes/);
  await refusal(verify(w, c.sign("sync.upload.cancel", input, { ts: w.clock.t + 3 * 60_000 }), "sync.upload.cancel", input), /two minutes/);
  await refusal(verify(w, "nope", "sync.upload.cancel", input), /not a companion token/);
  await refusal(verify(w, c.sign("sync.upload.cancel", input, { id: crypto.randomUUID() }), "sync.upload.cancel", input), /no such companion/);
  // none of those spent a nonce: the honest call still works
  assert.ok((await verify(w, c.sign("sync.upload.cancel", input), "sync.upload.cancel", input)).id);
});

test("companion call: a chunk's bytes are signed as bytes, so one changed byte or a string for a buffer is refused", async () => {
  const w = world();
  const c = await pairedCore(w);
  const data = Buffer.from("line one\nline two\n");
  const t = c.sign("sync.upload.chunk", { upload: "u1", offset: 0, data });
  await refusal(verify(w, t, "sync.upload.chunk", { upload: "u1", offset: 0, data: Buffer.from("line one\nline twO\n") }), /signature/);
  assert.ok((await verify(w, c.sign("sync.upload.chunk", { upload: "u1", offset: 0, data }), "sync.upload.chunk", { upload: "u1", offset: 0, data })).id);
  assert.equal(inputDigest({ data: Buffer.from("x") }), inputDigest({ data: "x" }), "a string counts as its UTF-8 bytes");
});

test("companion call: checked on every call: a removed or limited app device, a revoked companion, or a gone parent stops it at once", async () => {
  const w = world();
  const c = await pairedCore(w);
  const go = () => verify(w, c.sign("link.companion.hello", {}), "link.companion.hello", {});
  assert.ok((await go()).id);
  w.devices.set(APP, { ...w.devices.get(APP), trusted: false });
  await refusal(go(), /app device is limited/);
  w.devices.set(APP, { ...w.devices.get(APP), trusted: true });
  assert.ok((await go()).id, "trusted again, the same companion works again");
  w.devices.set(APP, { ...w.devices.get(APP), removed: true });
  await refusal(go(), /app device is gone/);
  w.devices.set(APP, { ...w.devices.get(APP), removed: false });
  await w.call("link.companion.remove", { id: c.id });
  await refusal(go(), /no such companion/);
});
