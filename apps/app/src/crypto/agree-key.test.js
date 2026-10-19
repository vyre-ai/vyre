import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createECDH } from "node:crypto";
import { readFileSync } from "node:fs";

// Where this device's chat (agreement) key is kept, and what the person is told when nothing keeps it (src/crypto/agree-key.ts). The ad-hoc-signed Mac app is the case: its Keychain and its page storage
// may each refuse, and before this a refused key came back as a quiet null or a new key every launch, so chats said "This device isn't ready for private chats yet." forever.

const b64u = (b) => Buffer.from(b).toString("base64url");

/** An IndexedDB stand-in, one store in memory. `mode`: "keeps" (stores anything), "no-cryptokey" (stores a CryptoKey but never gives it back, as the ad-hoc Mac window does), "refuses" (every write fails). */
const rows = new Map();
let mode = "keeps";
globalThis.indexedDB = {
  open() {
    const r = {};
    queueMicrotask(() => {
      r.result = { createObjectStore() {}, transaction: () => {
        const t = {};
        t.objectStore = () => ({
          get: (k) => { const q = {}; queueMicrotask(() => { const v = rows.get(k); q.result = mode === "no-cryptokey" && v && v.privateKey ? undefined : v; q.onsuccess?.(); }); return q; },
          put: (v, k) => { if (mode !== "refuses") rows.set(k, v); queueMicrotask(() => { if (mode === "refuses") { t.error = new Error("QuotaExceededError"); t.onerror?.(); } else t.oncomplete?.(); }); },
        });
        return t;
      } };
      r.onupgradeneeded?.();
      r.onsuccess?.();
    });
    return r;
  },
};

/** The Mac app's shell, with an agreement key in "its Keychain" (node's ECDH), or one whose Keychain refuses. */
function macShell({ refuse = null } = {}) {
  const mine = createECDH("prime256v1"); mine.generateKeys();
  const calls = [];
  globalThis.window = { __vyreShell: { kind: "mac", identity: {
    agreePublic: async () => { calls.push("public"); if (refuse) throw new Error(refuse); return b64u(mine.getPublicKey()); },
    agree: async (epk) => { calls.push("agree"); if (refuse) throw new Error(refuse); return b64u(mine.computeSecret(Buffer.from(epk, "base64url"))); },
  } } };
  return { mine, calls };
}

const K = await import("./agree-key.ts");
const A = await import("../identity/agree.ts");
const fresh = () => { K._forgetAgreeKey(); rows.clear(); mode = "keeps"; };
const peer = () => { const p = createECDH("prime256v1"); p.generateKeys(); return p; };

test("a Mac window keeps its chat key in the shell's store (the login Keychain an ad-hoc app can use) and opens chats with that same key", async (t) => {
  fresh(); t.after(() => delete globalThis.window);
  const { mine } = macShell();
  const r = await K.agreeKeyResult();
  assert.equal(r.store, "native");
  assert.deepEqual(Buffer.from(r.key.point, "base64url"), mine.getPublicKey());
  const p = peer();
  assert.deepEqual(Buffer.from(await r.key.ecdh(p.getPublicKey())), p.computeSecret(mine.getPublicKey()), "the published point is the one that opens chats");
  assert.equal(rows.size, 0, "nothing in the page's storage");
  assert.equal(await A.agreePublic(true), r.key.point, "agree.ts publishes the same point");
});

test("a Mac whose Keychain refuses falls back to the page's storage; a page that will not give a stored CryptoKey back keeps the key as JWK, and the same key comes back next launch", async (t) => {
  fresh(); t.after(() => delete globalThis.window);
  macShell({ refuse: "This Mac could not keep its chat key: the Keychain said OSStatus -34018" });
  mode = "no-cryptokey";
  const r = await K.agreeKeyResult();
  assert.equal(r.store, "jwk", "the CryptoKey did not come back, so the JWK row is used");
  const p = peer();
  const mine = Buffer.from(r.key.point, "base64url");
  assert.deepEqual(Buffer.from(await r.key.ecdh(p.getPublicKey())), p.computeSecret(mine));
  // the next launch: same row, same key, even now that the Keychain works (the point on the list is the fallback's)
  K._forgetAgreeKey();
  const { calls } = macShell();
  const again = await K.agreeKeyResult();
  assert.equal(again.key.point, r.key.point, "the key lasts across launches");
  assert.equal(again.store, "jwk");
  assert.deepEqual(calls, [], "a kept fallback key is not swapped for the Keychain's");
});

test("when every store refuses, the reason reaches the person: agreeKeyResult says which store and why, agree.ts rejects in those words, and nothing is cached", async (t) => {
  fresh(); t.after(() => delete globalThis.window);
  macShell({ refuse: "This Mac could not keep its chat key: the Keychain said OSStatus -25308." });
  mode = "refuses";
  const r = await K.agreeKeyResult();
  assert.equal(r.key, null);
  assert.match(r.reason, /OSStatus -25308/, "the Keychain's words");
  assert.match(r.reason, /storage/, "and the page storage's");
  const say = K.chatKeyProblem(r.reason);
  assert.match(say, /^Vyre couldn't save this device's chat key: /);
  assert.doesNotMatch(say, /isn't ready/);
  assert.equal(await A.agreePublic(true), null);
  await assert.rejects(A.agree(b64u(peer().getPublicKey())), (e) => e.code === "no_agree_key" && /^Vyre couldn't save this device's chat key: .*OSStatus -25308/.test(e.message));
  // a later ask tries again (the failure was not remembered): the Keychain works now
  macShell();
  assert.equal((await K.agreeKeyResult()).store, "native");
});

test("a browser keeps its non-extractable WebCrypto key in IndexedDB, as before", async (t) => {
  fresh(); delete globalThis.window; t.after(() => delete globalThis.window);
  const r = await K.agreeKeyResult();
  assert.equal(r.store, "webcrypto");
  assert.ok(rows.get("self")?.privateKey, "kept as a CryptoKeyPair under its old row");
  K._forgetAgreeKey();
  assert.equal((await K.agreeKeyResult()).key.point, r.key.point, "the same key next time");
});

test("starting a chat and the unlock repair both carry the store's reason instead of a vague line", () => {
  const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
  const start = read("../state/chat-start.ts");
  assert.match(start, /const got = await agreeKeyResult\(\);\s*if \(!got\.key\) return \{ say: chatKeyProblem\(got\.reason\) \};/);
  const host = read("../host/index.ts");
  assert.match(host, /throw Object\.assign\(new Error\(chatKeyProblem\(got\.reason\)\), \{ code: "no_agree_key" \}\)/);
  assert.match(read("../host/host-core.js"), /code === "no_agree_key" \? String/);
});
