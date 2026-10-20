import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createECDH } from "node:crypto";
import { readFileSync } from "node:fs";

// The person's chat key is the master record's (src/crypto/agree-key.ts): held in memory while unlocked, never made or kept by a device. No IndexedDB, no Keychain, no Secure Enclave.
let touched = 0;
globalThis.indexedDB = { open() { touched++; throw new Error("no page storage may be used for the chat key"); } };
globalThis.window = { __vyreShell: { kind: "mac", identity: { agreePublic: async () => { touched++; return "x"; }, agree: async () => { touched++; return "x"; } } } };

const K = await import("./agree-key.ts");

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
  assert.equal(touched, 0, "neither the page's storage nor the shell's key was used");
});

test("starting a chat and the unlock repair both carry the reason instead of a vague line", () => {
  const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
  const start = read("../state/chat-start.ts");
  assert.match(start, /const got = await agreeKeyResult\(\);\s*if \(!got\.key\) return \{ say: chatKeyProblem\(got\.reason\) \};/);
  const host = read("../host/index.ts");
  assert.match(host, /throw Object\.assign\(new Error\(chatKeyProblem\(got\.reason\)\), \{ code: "no_agree_key" \}\)/);
  assert.match(read("../host/host-core.js"), /code === "no_agree_key" \? String/);
});
