// @ts-check
// vyre-core phase 1 (ADR 0040): only the owner's uid gets an answer, and a write proves itself to
// core's own keys with a method core can check itself. Runs on Linux; the _vyre account and
// LOCAL_PEERCRED are a Mac check (team/archive/work-journals/vyre-core-plan.md).

import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { startCore, openStore, CORE_METHODS, personOf, INSTALL_CODE, TYPED_CODE } from "./server.js";
import { strictProblems } from "./strict.js";
import { canReadPeers } from "./peercred.js";
import { coreCall, coreTool, coreHello, socketProblem } from "../../lib/vyre-core-client.js";
import { procTable } from "./procs.js";
import { inputHash } from "../presence/index.js";
import { SCRATCH } from "../../test/scratch.mjs";

const uid = typeof process.getuid === "function" ? process.getuid() : 0;

/** A core on a short socket path, with a data dir of its own. */
async function core(t, o = {}) {
  const dir = fs.mkdtempSync(path.join(SCRATCH, "vc-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const socket = path.join(dir, "c.sock");
  const c = await startCore({ socket, dataDir: path.join(dir, "data"), ownerUid: uid, version: "test", dev: true, ...o });
  t.after(() => c.close());
  c.presence.softwareOk = () => true; // these tests prove with a device key: a development-kind core takes it, a release-kind one never does (PW-1, 1ad4691e6; the release rule is in test/presence-strength.test.js)
  return { ...c, socket, dir };
}

/** A phone's P-256 device key, and a signer for one call. */
function deviceKey() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  const pub = publicKey.export({ format: "der", type: "spki" }).toString("base64url");
  const sign = (tool, input, key = privateKey) => {
    const ts = String(Date.now()), nonce = crypto.randomBytes(12).toString("base64url");
    const sig = crypto.sign("sha256", Buffer.from(`vyre-presence-v1\n${tool}\n${inputHash(input)}\n${ts}\n${nonce}`), { key, dsaEncoding: "der" }).toString("base64url");
    return (id) => `device key=${id} ts=${ts} nonce=${nonce} sig=${sig}`;
  };
  return { pub, sign };
}

test("vyre-core: the owner's uid is answered, by the kernel's word; any other uid is refused before any route", { skip: !canReadPeers && "no peer credentials on this platform" }, async t => {
  const c = await core(t);
  const hello = await coreHello(c.socket);
  assert.deepEqual(hello, { name: "vyre-core", protocol: 1, version: "test" });

  const other = await core(t, { peerCred: async () => ({ pid: process.pid, uid: uid + 1 }) });
  for (const [method, p] of [["GET", "/v1/hello"], ["GET", "/v1/peer"], ["POST", "/v1/tools/presence.keys"], ["POST", "/v1/tools/presence.enroll"]]) {
    const r = await coreCall({ socket: other.socket, method: /** @type {any} */ (method), path: p, body: {} });
    assert.equal(r.status, 403, p);
    assert.equal(r.error && r.error.code, "not_owner", p);
  }
  // A peer the kernel can't name is refused the same way.
  const unknown = await core(t, { peerCred: async () => null });
  assert.equal((await coreCall({ socket: unknown.socket, method: "GET", path: "/v1/hello" })).error.code, "not_owner");
});

test("vyre-core: /v1/peer is core's own verdict on its own connection", async t => {
  const seen = [];
  const c = await core(t, { peerCred: async () => ({ pid: 4242, uid }), personOf: pid => { seen.push(pid); return { person: false, why: "inside a Claude session" }; } });
  const r = await coreCall({ socket: c.socket, method: "GET", path: "/v1/peer" });
  assert.deepEqual(r.data, { pid: 4242, uid, person: false, why: "inside a Claude session" });
  assert.deepEqual(seen, [4242], "judged from the pid core read, never one the client sent");
});

/**
 * A Capsule public key this tree's enroll takes: P-256 once the p256 batch lands, Ed25519 before.
 * @param {any} presence a scratch Presence to ask
 */
function capsulePub(presence) {
  for (const kind of ["p256", "ed25519"]) {
    const k = kind === "p256" ? crypto.generateKeyPairSync("ec", { namedCurve: "P-256" }) : crypto.generateKeyPairSync("ed25519");
    const pub = k.publicKey.export({ format: "der", type: "spki" }).toString("base64url");
    try { const r = presence.enroll({ kind: "capsule", name: "probe", public_key: pub }); presence.remove(r.id); return () => {
      const n = kind === "p256" ? crypto.generateKeyPairSync("ec", { namedCurve: "P-256" }) : crypto.generateKeyPairSync("ed25519");
      return n.publicKey.export({ format: "der", type: "spki" }).toString("base64url");
    }; } catch {}
  }
  throw new Error("no Capsule key kind is accepted");
}

/** A fresh one-time code in core's own db, as the installer mints it. */
function mint(c, o = {}) {
  const store = openStore(path.join(c.dir, "data"));
  try { return store.presence.mintCode(o).code; } finally { store.db.close(); }
}

test("vyre-core: the first key needs the installer's one-time code; touchid and tty are never taken", async t => {
  const c = await core(t, { peerCred: async () => ({ pid: process.pid, uid }), codeFrom: async () => true });
  const newPub = capsulePub(c.presence);
  const input = { kind: "capsule", name: "Capsule", public_key: newPub() };
  const bare = await coreTool("presence.enroll", input, { socket: c.socket });
  assert.equal(bare.status, 401);
  assert.equal(bare.error.code, "presence_required");
  assert.deepEqual(bare.error.methods, [...CORE_METHODS]);
  for (const h of ["touchid", "tty id=x code=123456"]) {
    const r = await coreTool("presence.enroll", input, { socket: c.socket, coreUid: uid, presence: h });
    assert.equal(r.status, 401, h);
    assert.match(r.error.message, /doesn't take a (touchid|tty) proof/, h);
  }
  const code = mint(c, INSTALL_CODE);
  // The code enrolls the Capsule's key and nothing else.
  const phone = await coreTool("presence.enroll", { kind: "device", name: "alex-phone", public_key: deviceKey().pub, alg: -7 }, { socket: c.socket, coreUid: uid, presence: `code code=${code}` });
  assert.match(phone.error.message, /Capsule's key and nothing else/);
  // A failed enroll doesn't burn it: a key that isn't one, then the right one.
  const bad = await coreTool("presence.enroll", { kind: "capsule", name: "Capsule", public_key: "bm90IGEga2V5" }, { socket: c.socket, coreUid: uid, presence: `code code=${code}` });
  assert.ok(bad.error, JSON.stringify(bad));
  // presence.verify never spends or accepts a code.
  assert.match((await coreTool("presence.verify", { tool: "presence.enroll", input, proof: `code code=${code}` }, { socket: c.socket })).data.message, /only redeemed by presence.enroll/);
  const made = await coreTool("presence.enroll", input, { socket: c.socket, coreUid: uid, presence: `code code=${code}` });
  assert.ok(!made.error, JSON.stringify(made.error));
  assert.equal(made.data.kind, "capsule");
  // Once core has a key, no code enrolls anything, however fresh.
  const again = await coreTool("presence.enroll", { ...input, public_key: newPub() }, { socket: c.socket, coreUid: uid, presence: `code code=${mint(c, INSTALL_CODE)}` });
  assert.match(again.error.message, /already has a key/);
  // A code does nothing else.
  assert.equal((await coreTool("presence.remove", { id: made.data.id }, { socket: c.socket, coreUid: uid, presence: `code code=${code}` })).status, 401);
  const keys = (await coreTool("presence.keys", {}, { socket: c.socket })).data;
  assert.deepEqual(keys.map(r => r.id), [made.data.id]);
  assert.ok(keys.every(r => !("public_key" in r)));
});

test("vyre-core: only the Capsule core signed may redeem the code, and two racing redeems can't both win", async t => {
  const refused = await core(t, { peerCred: async () => ({ pid: process.pid, uid }), codeFrom: async () => false });
  const newPub = capsulePub(refused.presence);
  const r = await coreTool("presence.enroll", { kind: "capsule", name: "Capsule", public_key: newPub() }, { socket: refused.socket, coreUid: uid, presence: `code code=${mint(refused, INSTALL_CODE)}` });
  assert.match(r.error.message, /only the Capsule vyre-core signed/);

  const c = await core(t, { peerCred: async () => ({ pid: process.pid, uid }), codeFrom: async () => true });
  const code = mint(c, INSTALL_CODE);
  const race = await Promise.all([0, 1, 2].map(() => coreTool("presence.enroll", { kind: "capsule", name: "Capsule", public_key: newPub() }, { socket: c.socket, coreUid: uid, presence: `code code=${code}` })));
  assert.equal(race.filter(x => x.data).length, 1, JSON.stringify(race));
  assert.equal(c.presence.keys().length, 1);
});

test("vyre-core: a write is proved by an enrolled key over that exact input, once", async t => {
  const c = await core(t, { peerCred: async () => ({ pid: process.pid, uid }), capsuleFrom: async () => true });
  const phone = deviceKey();
  const id = c.presence.enroll({ kind: "device", name: "alex-phone", public_key: phone.pub, alg: -7 }).id;
  const other = c.presence.enroll({ kind: "device", name: "kit-phone", public_key: deviceKey().pub, alg: -7 }).id;

  // Signed for removing kit-phone, sent to remove alex-phone: refused.
  const wrong = await coreTool("presence.remove", { id }, { socket: c.socket, coreUid: uid, presence: phone.sign("presence.remove", { id: other })(id) });
  assert.equal(wrong.status, 401);
  assert.match(wrong.error.message, /does not check out/);
  // Signed by a key that isn't enrolled under this id: refused.
  const stranger = deviceKey();
  assert.equal((await coreTool("presence.remove", { id: other }, { socket: c.socket, coreUid: uid, presence: stranger.sign("presence.remove", { id: other })(id) })).status, 401);

  const header = phone.sign("presence.remove", { id: other })(id);
  const ok = await coreTool("presence.remove", { id: other }, { socket: c.socket, coreUid: uid, presence: header });
  assert.deepEqual(ok.data, { removed: true });
  assert.match((await coreTool("presence.remove", { id: other }, { socket: c.socket, coreUid: uid, presence: header })).error.message, /nonce was already used/);

  // A session from a live key, never from a code.
  const s = await coreTool("presence.session.open", {}, { socket: c.socket, coreUid: uid, presence: phone.sign("presence.session.open", {})(id) });
  assert.ok(s.data && s.data.session && s.data.secret, JSON.stringify(s));
});

test("vyre-core: presence.verify answers for another tool's call without trusting the asker", async t => {
  const c = await core(t, { peerCred: async () => ({ pid: process.pid, uid }) });
  const phone = deviceKey();
  const id = c.presence.enroll({ kind: "device", name: "alex-phone", public_key: phone.pub, alg: -7 }).id;
  const call = { tool: "gate.approve", input: { id: "a1" } };
  const good = await coreTool("presence.verify", { ...call, proof: phone.sign(call.tool, call.input)(id) }, { socket: c.socket });
  assert.deepEqual(good.data, { ok: true, method: "device", keyId: id });
  const other = await coreTool("presence.verify", { tool: "gate.approve", input: { id: "b2" }, proof: phone.sign(call.tool, call.input)(id) }, { socket: c.socket });
  assert.equal(other.data.ok, false);
  assert.equal((await coreTool("presence.verify", { ...call, proof: "touchid" }, { socket: c.socket })).data.ok, false);
  assert.equal((await coreTool("presence.verify", { ...call, proof: "" }, { socket: c.socket })).data.ok, false);
});

test("vyre-core: bad requests are refused plainly", async t => {
  const c = await core(t, { peerCred: async () => ({ pid: process.pid, uid }) });
  assert.equal((await coreTool("gate.approve", {}, { socket: c.socket })).error.code, "unknown_tool");
  assert.equal((await coreCall({ socket: c.socket, method: "GET", path: "/v1/tools/presence.keys" })).status, 404);
  const big = await coreTool("presence.keys", { pad: "x".repeat(300 * 1024) }, { socket: c.socket });
  assert.ok(big.status === 413 || (big.error && /core_unreachable|too_large/.test(big.error.code)), JSON.stringify(big));
  const gone = await coreHello(path.join(c.dir, "nope.sock"));
  assert.equal(gone, null);
  assert.equal((await coreCall({ socket: path.join(c.dir, "nope.sock"), method: "GET", path: "/v1/hello" })).error.code, "core_unavailable");
});

test("vyre-core: strict mode refuses a tree the owner's uid could write", () => {
  const OWNER = 501, VYRE = 280;
  /** @param {Record<string, { uid: number, mode: number }>} tree */
  const statOf = tree => p => { const s = tree[p]; if (!s) throw new Error("ENOENT"); return s; };
  const root = { uid: 0, mode: 0o755 };
  const good = {
    "/": root, "/Library": root, "/Library/Application Support": root, "/Library/Application Support/Vyre": root,
    "/Library/Application Support/Vyre/current": root,
    "/Library/Application Support/Vyre/data": { uid: VYRE, mode: 0o700 },
  };
  const at = { codeDir: "/Library/Application Support/Vyre/current", dataDir: "/Library/Application Support/Vyre/data", ownerUid: OWNER, uid: VYRE };
  assert.deepEqual(strictProblems({ ...at, stat: statOf(good) }), []);
  // Code in the owner's home, a group-writable folder on the way, data others can read, or core as the owner.
  const cases = [
    [{ ...good, "/Library/Application Support/Vyre/current": { uid: OWNER, mode: 0o755 } }, at, /owned by uid 501, not root/],
    [{ ...good, "/Library/Application Support/Vyre": { uid: 0, mode: 0o775 } }, at, /can be written by other users/],
    [{ ...good, "/Library/Application Support/Vyre/data": { uid: VYRE, mode: 0o750 } }, at, /0700/],
    [{ ...good, "/Library/Application Support/Vyre/data": { uid: OWNER, mode: 0o700 } }, at, /owned by uid 501/],
    [good, { ...at, uid: OWNER }, /the owner's own uid/],
    [good, { ...at, uid: 0 }, /must not run as root/],
  ];
  for (const [tree, o, want] of cases) assert.match(strictProblems({ .../** @type {any} */ (o), stat: statOf(/** @type {any} */ (tree)) }).join("\n"), /** @type {RegExp} */ (want));
  // A real temp dir, owned by whoever runs the test: refused.
  const dir = fs.mkdtempSync(path.join(SCRATCH, "vc-strict-"));
  try { assert.ok(strictProblems({ codeDir: dir, dataDir: path.join(dir, "d"), ownerUid: uid, uid }).length > 0); }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("vyre-core: a proof goes only to a socket vyre-core's uid owns, in a folder others can't write", async t => {
  const c = await core(t, { peerCred: async () => ({ pid: process.pid, uid }) });
  assert.equal(socketProblem(c.socket, uid), null);
  assert.match(String(socketProblem(c.socket, uid + 1)), /belongs to uid/);
  assert.match(String(socketProblem(path.join(c.dir, "nope.sock"), uid)), /isn't there/);
  // Without core's uid, no proof is sent at all.
  const r = await coreTool("presence.remove", { id: "x" }, { socket: c.socket, presence: "device key=x ts=1 nonce=abcdefgh sig=x" });
  assert.equal(r.error.code, "core_untrusted");
  assert.equal((await coreTool("presence.remove", { id: "x" }, { socket: c.socket, coreUid: uid + 1, presence: "device key=x ts=1 nonce=abcdefgh sig=x" })).error.code, "core_untrusted");
  // A squatted socket: a plain file, or a socket in a folder others can write.
  const fake = { isSocket: () => false, isDirectory: () => true, uid, mode: 0o755 };
  assert.match(String(socketProblem("/x/s", uid, p => (p === "/x/s" ? /** @type {any} */ (fake) : /** @type {any} */ ({ ...fake, mode: 0o40755 })))), /isn't a socket/);
  const sock = { isSocket: () => true, isDirectory: () => false, uid, mode: 0o140777 };
  const open = { isSocket: () => false, isDirectory: () => true, uid: 0, mode: 0o41777 };
  assert.match(String(socketProblem("/x/s", uid, p => /** @type {any} */ (p === "/x/s" ? sock : open))), /others can write/);
});

test("vyre-core: strict mode checks the socket's folder too", () => {
  const OWNER = 501, VYRE = 280;
  const root = { uid: 0, mode: 0o755 };
  const tree = { "/": root, "/Library": root, "/Library/Application Support": root, "/Library/Application Support/Vyre": root,
    "/Library/Application Support/Vyre/current": root, "/Library/Application Support/Vyre/data": { uid: VYRE, mode: 0o700 },
    "/var": root, "/var/run": root, "/var/run/vyre": { uid: VYRE, mode: 0o755 } };
  const at = { codeDir: "/Library/Application Support/Vyre/current", dataDir: "/Library/Application Support/Vyre/data", socketDir: "/var/run/vyre", ownerUid: OWNER, uid: VYRE };
  const statOf = t => p => { const s = t[p]; if (!s) throw new Error("ENOENT"); return s; };
  assert.deepEqual(strictProblems({ ...at, stat: statOf(tree) }), []);
  assert.match(strictProblems({ ...at, stat: statOf({ ...tree, "/var/run/vyre": { uid: OWNER, mode: 0o755 } }) }).join("\n"), /\/var\/run\/vyre is owned by uid 501/);
  assert.match(strictProblems({ ...at, stat: statOf({ ...tree, "/var/run/vyre": { uid: VYRE, mode: 0o777 } }) }).join("\n"), /can be written by other users/);
});

test("vyre-core: core reads its own process table, and its whole peer verdict never runs tmux or a PATH lookup", { skip: process.platform !== "linux" && "the /proc half; the Mac half is /bin/ps, a Mac check" }, () => {
  const look = procTable();
  const me = look(process.pid);
  assert.ok(me && me.ppid === process.ppid, JSON.stringify(me));
  assert.match(me.args, /node/);
  assert.equal(look(2 ** 30), null);
  // A PATH full of someone else's ps and tmux changes nothing: nothing here looks them up.
  const dir = fs.mkdtempSync(path.join(SCRATCH, "vc-path-"));
  try {
    for (const b of ["ps", "tmux"]) fs.writeFileSync(path.join(dir, b), `#!/bin/sh\ntouch ${dir}/ran-${b}\n`, { mode: 0o755 });
    const prev = process.env.PATH, prevTmux = process.env.VYRE_TMUX_BIN;
    process.env.PATH = `${dir}:${prev}`;
    process.env.VYRE_TMUX_BIN = path.join(dir, "tmux");
    try {
      procTable()(process.pid);
      const v = personOf(process.pid);
      assert.equal(typeof v.person, "boolean");
    } finally {
      process.env.PATH = prev;
      if (prevTmux === undefined) delete process.env.VYRE_TMUX_BIN; else process.env.VYRE_TMUX_BIN = prevTmux;
    }
    assert.deepEqual(fs.readdirSync(dir).filter(f => f.startsWith("ran-")), []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("vyre-core: the handoff code lasts 2 minutes, the typed one 10, and five wrong codes void every open one", async t => {
  const c = await core(t, { peerCred: async () => ({ pid: process.pid, uid }), codeFrom: async () => true });
  const store = openStore(path.join(c.dir, "data"));
  const hand = store.presence.mintCode(INSTALL_CODE), typed = store.presence.mintCode(TYPED_CODE);
  store.db.close();
  assert.equal(hand.code.length, 6);
  assert.equal(typed.code.length, 6);
  assert.ok(hand.expires - Date.now() <= 2 * 60_000 && hand.expires - Date.now() > 110_000);
  assert.ok(typed.expires - Date.now() <= 10 * 60_000 && typed.expires - Date.now() > 9 * 60_000);
  assert.throws(() => c.presence.mintCode({ length: 4 }), /6 to 16/);
  assert.throws(() => c.presence.mintCode({ ttl: 11 * 60_000 }), /at most 10 minutes/);
  const input = { kind: "capsule", name: "Capsule", public_key: capsulePub(c.presence)() };
  for (let i = 0; i < 5; i++) assert.equal((await coreTool("presence.enroll", input, { socket: c.socket, coreUid: uid, presence: "code code=ZZZZZZ" })).status, 401);
  for (const k of [hand.code, typed.code]) {
    const late = await coreTool("presence.enroll", input, { socket: c.socket, coreUid: uid, presence: `code code=${k}` });
    assert.match(late.error.message, /wrong, used or expired/, "a right code after five wrong ones is void");
  }
});

test("vyre-core: without dev set on purpose, the stand-in Capsule check says no, on Linux too", async t => {
  const c = await core(t, { peerCred: async () => ({ pid: process.pid, uid }), dev: false });
  const phone = deviceKey();
  const id = c.presence.enroll({ kind: "device", name: "alex-phone", public_key: phone.pub, alg: -7 }).id;
  const s = await coreTool("presence.session.open", {}, { socket: c.socket, coreUid: uid, presence: phone.sign("presence.session.open", {})(id) });
  assert.equal(s.error && s.error.code, "not_capsule");
  const r = await coreTool("vault.reveal", { name: "x" }, { socket: c.socket, coreUid: uid, presence: phone.sign("vault.reveal", { name: "x" })(id) });
  assert.equal(r.status, 403);
  // The installer's code is refused the same way, on a core with no key yet.
  const fresh = await core(t, { peerCred: async () => ({ pid: process.pid, uid }), dev: false });
  const store = openStore(path.join(fresh.dir, "data"));
  const code = store.presence.mintCode(INSTALL_CODE).code;
  store.db.close();
  const k = crypto.generateKeyPairSync("ed25519").publicKey.export({ format: "der", type: "spki" }).toString("base64url");
  const e = await coreTool("presence.enroll", { kind: "capsule", name: "Capsule", public_key: k }, { socket: fresh.socket, coreUid: uid, presence: `code code=${code}` });
  assert.match(String(e.error && e.error.message), /only the Capsule vyre-core signed/);
});
