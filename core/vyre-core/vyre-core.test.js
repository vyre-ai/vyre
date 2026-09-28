// @ts-check
// vyre-core phase 1 (ADR 0040): only the owner's uid gets an answer, and a write proves itself to
// core's own keys with a method core can check itself. Runs on Linux; the _vyre account and
// LOCAL_PEERCRED are a Mac check (docs/work/vyre-core-plan.md).

import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { startCore, openStore, CORE_METHODS } from "./server.js";
import { strictProblems } from "./strict.js";
import { canReadPeers } from "./peercred.js";
import { coreCall, coreTool, coreHello } from "../../lib/vyre-core-client.js";
import { inputHash } from "../presence/index.js";
import { SCRATCH } from "../../test/scratch.mjs";

const uid = typeof process.getuid === "function" ? process.getuid() : 0;

/** A core on a short socket path, with a data dir of its own. */
async function core(t, o = {}) {
  const dir = fs.mkdtempSync(path.join(SCRATCH, "vc-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const socket = path.join(dir, "c.sock");
  const c = await startCore({ socket, dataDir: path.join(dir, "data"), ownerUid: uid, version: "test", ...o });
  t.after(() => c.close());
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

test("vyre-core: the first key needs the installer's one-time code; touchid and tty are never taken", async t => {
  const c = await core(t, { peerCred: async () => ({ pid: process.pid, uid }) });
  const k = deviceKey();
  const input = { kind: "device", name: "alex-phone", public_key: k.pub, alg: -7 };
  const bare = await coreTool("presence.enroll", input, { socket: c.socket });
  assert.equal(bare.status, 401);
  assert.equal(bare.error.code, "presence_required");
  assert.deepEqual(bare.error.methods, [...CORE_METHODS]);
  for (const h of ["touchid", "tty id=x code=123456"]) {
    const r = await coreTool("presence.enroll", input, { socket: c.socket, presence: h });
    assert.equal(r.status, 401, h);
    assert.match(r.error.message, /doesn't take a (touchid|tty) proof/, h);
  }
  // The installer mints the code with core's own rights, straight into core's db.
  const store = openStore(path.join(c.dir, "data"));
  const { code } = store.presence.mintCode();
  store.db.close();
  const made = await coreTool("presence.enroll", input, { socket: c.socket, presence: `code code=${code}` });
  assert.ok(!made.error, JSON.stringify(made.error));
  assert.equal(made.data.kind, "device");
  const again = await coreTool("presence.enroll", { ...input, public_key: deviceKey().pub }, { socket: c.socket, presence: `code code=${code}` });
  assert.match(again.error.message, /wrong, used or expired/);
  // A code enrolls and does nothing else.
  assert.equal((await coreTool("presence.remove", { id: made.data.id }, { socket: c.socket, presence: `code code=${code}` })).status, 401);
  // Listing never shows a public key.
  const keys = (await coreTool("presence.keys", {}, { socket: c.socket })).data;
  assert.deepEqual(keys.map(r => r.id), [made.data.id]);
  assert.ok(keys.every(r => !("public_key" in r)));
});

test("vyre-core: a write is proved by an enrolled key over that exact input, once", async t => {
  const c = await core(t, { peerCred: async () => ({ pid: process.pid, uid }) });
  const phone = deviceKey();
  const id = c.presence.enroll({ kind: "device", name: "alex-phone", public_key: phone.pub, alg: -7 }).id;
  const other = c.presence.enroll({ kind: "device", name: "kit-phone", public_key: deviceKey().pub, alg: -7 }).id;

  // Signed for removing kit-phone, sent to remove alex-phone: refused.
  const wrong = await coreTool("presence.remove", { id }, { socket: c.socket, presence: phone.sign("presence.remove", { id: other })(id) });
  assert.equal(wrong.status, 401);
  assert.match(wrong.error.message, /does not check out/);
  // Signed by a key that isn't enrolled under this id: refused.
  const stranger = deviceKey();
  assert.equal((await coreTool("presence.remove", { id: other }, { socket: c.socket, presence: stranger.sign("presence.remove", { id: other })(id) })).status, 401);

  const header = phone.sign("presence.remove", { id: other })(id);
  const ok = await coreTool("presence.remove", { id: other }, { socket: c.socket, presence: header });
  assert.deepEqual(ok.data, { removed: true });
  assert.match((await coreTool("presence.remove", { id: other }, { socket: c.socket, presence: header })).error.message, /nonce was already used/);

  // A session from a live key, never from a code.
  const s = await coreTool("presence.session.open", {}, { socket: c.socket, presence: phone.sign("presence.session.open", {})(id) });
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
  assert.equal((await coreTool("vault.reveal", {}, { socket: c.socket })).error.code, "unknown_tool");
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
