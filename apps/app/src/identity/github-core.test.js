import "../../../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { accountMessage, homeHintText, linkMessage, newVerifier, openRelease, parseHomeHint, ticketId } from "./github-core.js";
import { sealTo } from "../../../../escrow/worker/index.js";

test("the link and account messages are the bytes the relay checks", () => {
  assert.equal(Buffer.from(linkMessage({ ghid: 4242, identity: "per_x", tid: "T", ts: 5, host: "relay.vyre.run" })).toString(), "vyre-gh-link-v1\n4242\nper_x\nT\n5\nrelay.vyre.run");
  assert.equal(Buffer.from(accountMessage({ action: "unlink", identity: "per_x", nonce: "N", ts: 5, host: "relay.vyre.run" })).toString(), "vyre-gh-account-v1\nunlink\nper_x\nN\n5\nrelay.vyre.run");
});
test("the verifier's challenge is the hash of the verifier, as the relay checks", async () => {
  const { cv, cc } = await newVerifier();
  assert.equal(cc, crypto.createHash("sha256").update(cv).digest("base64url"));
  assert.equal(await ticketId(cv), cc);
  assert.match(cv, /^[A-Za-z0-9_-]{43}$/);
});
test("the home hint round-trips, and a hint that is not a pinned wss route is refused", () => {
  const t = homeHintText({ relay: "wss://relay.vyre.run", route: "r".repeat(26), box: "b".repeat(43), name: "Harlow" });
  assert.deepEqual(parseHomeHint(t), { relay: "wss://relay.vyre.run", route: "r".repeat(26), box: "b".repeat(43), name: "Harlow" });
  assert.equal(homeHintText({ relay: "ws://x", route: "r", box: "b".repeat(43) }), null);
  assert.equal(homeHintText(null), null);
  assert.equal(parseHomeHint('{"v":1,"relay":"https://x","route":"r","box":"' + "b".repeat(43) + '"}'), null);
  assert.equal(parseHomeHint("nope"), null);
});
test("what the escrow seals to a device's agreement point opens with that device's own ECDH, and not with another", async () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  const point = Buffer.from(publicKey.export({ format: "der", type: "spki" }).subarray(-65)).toString("base64url");
  const sealed = await sealTo(point, new TextEncoder().encode(JSON.stringify({ v: 1, sk: "VSK1-X", home: null })));
  const ecdh = (priv) => async (epk) => { const peer = crypto.createPublicKey({ key: Buffer.concat([Buffer.from("3059301306072a8648ce3d020106082a8648ce3d030107034200", "hex"), Buffer.from(epk, "base64url")]), format: "der", type: "spki" }); return new Uint8Array(crypto.diffieHellman({ privateKey: priv, publicKey: peer })); };
  assert.deepEqual(await openRelease(sealed, ecdh(privateKey)), { sk: "VSK1-X", home: null });
  const other = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey;
  await assert.rejects(openRelease(sealed, ecdh(other)), (e) => e.code === "bad_bundle");
});
