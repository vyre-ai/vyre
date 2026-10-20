import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createECDH } from "node:crypto";
import { readFileSync } from "node:fs";

// The person's chat key is the master record's (src/crypto/agree-key.ts): held in memory while unlocked, never made or kept by a device. A key an older build kept on this device is READ (never made or
// written) so older chats still open, and is handed out only as `legacy`.
const rows = new Map();
const writes = [];
globalThis.indexedDB = {
  open() {
    const r = {};
    queueMicrotask(() => {
      r.result = { createObjectStore() {}, transaction: () => { const t = {}; t.objectStore = () => ({ get: (k) => { const q = {}; queueMicrotask(() => { q.result = rows.get(k); q.onsuccess?.(); }); return q; }, put: (v, k) => { writes.push(k); rows.set(k, v); queueMicrotask(() => t.oncomplete?.()); } }); return t; } };
      r.onupgradeneeded?.(); r.onsuccess?.();
    });
    return r;
  },
};
const shellCalls = [];
const oldMac = createECDH("prime256v1"); oldMac.generateKeys();
const b64u = (b) => Buffer.from(b).toString("base64url");
globalThis.window = { __vyreShell: { kind: "mac", identity: {
  agreePublic: async (create) => { shellCalls.push(["public", !!create]); return b64u(oldMac.getPublicKey()); },
  agree: async (epk) => { shellCalls.push(["agree"]); return b64u(oldMac.computeSecret(Buffer.from(epk, "base64url"))); },
} } };

const K = await import("./agree-key.ts");
const R = await import("./chat-ring.js");
const KW = await import("../../../../lib/keywrap.js");

test("locked there is no chat key and nothing is made or stored; unlocked it is the record's key and opens chats", async () => {
  K._forgetAgreeKey();
  const locked = await K.agreeKeyResult();
  assert.equal(locked.key, null);
  assert.match(K.chatKeyProblem(locked.reason), /unlock/);
  const made = await K.makeRecordAgreeKey();
  assert.equal(await K.useRecordAgreeKey(made.priv), made.point);
  const r = await K.agreeKeyResult();
  assert.equal(r.store, "record");
  assert.equal(r.key.point, made.point);
  const peer = createECDH("prime256v1"); peer.generateKeys();
  assert.deepEqual(Buffer.from(await r.key.ecdh(peer.getPublicKey())), peer.computeSecret(Buffer.from(made.point, "base64url")));
  await K.useRecordAgreeKey(null);
  assert.equal((await K.agreeKeyResult()).key, null);
  assert.deepEqual(writes, [], "nothing was written to the page's storage");
  assert.ok(shellCalls.every((c) => c[0] !== "public" || c[1] === false), "the shell's key is only ever read, never created");
});

test("an old per-device chat key still opens older chats: it rides as `legacy`, and a ring wrapped only to it opens, while new wraps never go to it", async () => {
  K._forgetAgreeKey();
  const made = await K.makeRecordAgreeKey();
  await K.useRecordAgreeKey(made.priv);
  const me = (await K.agreeKeyResult()).key;
  assert.equal(me.legacy.length, 1, "the old Mac key is held read only");
  const oldPoint = oldMac.getPublicKey();
  const oldJwk = { kty: "EC", crv: "P-256", x: b64u(oldPoint.subarray(1, 33)), y: b64u(oldPoint.subarray(33, 65)) };
  assert.equal(me.legacy[0].holder, await KW.fingerprint(oldJwk));
  // a chat made before v0.6.5: its ring has a wrap for the old key only
  const { doc } = await KW.createRing("chat_old", { [me.legacy[0].holder]: oldJwk });
  const keys = await R.openRingAs(doc, me);
  assert.ok(keys.epoch !== undefined);
  keys.lock();
  // a ring made now wraps to the record's key, and holdersFor never lists the legacy holder
  const none = await R.holdersFor(async () => ({ devices: [] }), [], me);
  assert.deepEqual(Object.keys(none.holders), [me.holder]);
  // a ring with no wrap for either still fails in the first error's words
  const other = createECDH("prime256v1"); other.generateKeys();
  const op = other.getPublicKey();
  const { doc: stranger } = await KW.createRing("chat_other", { x: { kty: "EC", crv: "P-256", x: b64u(op.subarray(1, 33)), y: b64u(op.subarray(33, 65)) } });
  await assert.rejects(() => R.openRingAs(stranger, me));
  await K.useRecordAgreeKey(null);
});

test("starting a chat and the unlock repair both carry the reason instead of a vague line", () => {
  const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
  const start = read("../state/chat-start.ts");
  assert.match(start, /const got = await agreeKeyResult\(\);\s*if \(!got\.key\) return \{ say: chatKeyProblem\(got\.reason\) \};/);
  const host = read("../host/index.ts");
  assert.match(host, /throw Object\.assign\(new Error\(chatKeyProblem\(got\.reason\)\), \{ code: "no_agree_key" \}\)/);
  assert.match(read("../host/host-core.js"), /code === "no_agree_key" \? String/);
});
