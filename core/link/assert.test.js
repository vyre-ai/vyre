// @ts-check
// The box's signed answers to a Mac's asks (assert.js): the key it keeps, and every check the Mac
// makes before threads.answer runs as "link:box". Each failed check refuses on its own.

import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { tempHome } from "../../test/helpers.js";
import { gatedAsk } from "../modules/federate.js";
import { boxKey, canonical, decisionHash, signAnswer, checkAnswer, Nonces, KEY_FILE, TTL, MAX_NONCES, NONCES_FILE } from "./assert.js";

const T0 = Date.parse("2026-09-27T10:00:00Z");
const INPUT = { ask: "q7Xk2mA9pL0sN4vB", decision: "allow", surface: "deck" };

/** A key pair like the box's, the public half as the Mac pins it. */
function pair() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  return { privateKey, pinned: publicKey.export({ format: "der", type: "spki" }).toString("base64url") };
}
const sign = (k, o = {}) => signAnswer(k.privateKey, { mac: "nMAC", ask: INPUT.ask, thread: "t-1", input: INPUT, caller: "deck", device: "nPHONE", now: T0, ...o });
const check = (k, assertion, o = {}) => checkAnswer({ assertion, tool: "threads.answer", input: INPUT, pinned: k.pinned, self: "nMAC", nonces: new Nonces(), now: T0 + 1000, ...o });
/** An assertion with its payload changed and signed again by `k`. */
function forge(k, change) {
  const A = { ...JSON.parse(Buffer.from(sign(k).a, "base64url").toString()), ...change };
  const bytes = Buffer.from(canonical(A));
  return { a: bytes.toString("base64url"), sig: crypto.sign(null, bytes, k.privateKey).toString("base64url") };
}

test("assert: canonical JSON sorts keys at every depth, so the hash is the input's, not its key order", () => {
  assert.equal(canonical({ b: 1, a: { d: [2, { f: 1, e: 0 }], c: null } }), '{"a":{"c":null,"d":[2,{"e":0,"f":1}]},"b":1}');
  assert.equal(decisionHash({ decision: "allow", ask: "x" }), decisionHash({ ask: "x", decision: "allow" }));
  assert.notEqual(decisionHash({ ask: "x", decision: "allow" }), decisionHash({ ask: "x", decision: "deny" }));
  assert.match(decisionHash(INPUT), /^[A-Za-z0-9_-]{43}$/);
});

test("assert: the box's key is made once, on first need, at 0600 in its home, and read back after", t => {
  const home = tempHome(t);
  const file = path.join(home, KEY_FILE);
  assert.equal(fs.existsSync(file), false);
  const k1 = boxKey(home);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const k2 = boxKey(home);
  assert.equal(k2.publicKey, k1.publicKey, "the same key after a restart");
  assert.equal(crypto.createPublicKey({ key: Buffer.from(k1.publicKey, "base64url"), format: "der", type: "spki" }).asymmetricKeyType, "ed25519");
  assert.deepEqual(fs.readdirSync(home).filter(n => n.includes(".tmp")), [], "no temp file left behind");
});

test("assert: a signed answer carries what it binds, and the Mac accepts it once", () => {
  const k = pair();
  const s = sign(k);
  const A = JSON.parse(Buffer.from(s.a, "base64url").toString());
  assert.deepEqual(Object.keys(A).sort(), ["ask", "caller", "decision", "device", "exp", "iat", "mac", "nonce", "person", "presence", "thread", "tool", "v"]);
  assert.deepEqual([A.person, A.presence], [null, null], "a socket caller with no proof");
  assert.deepEqual([A.v, A.tool, A.mac, A.ask, A.thread, A.caller, A.device, A.iat, A.exp], [1, "threads.answer", "nMAC", INPUT.ask, "t-1", "deck", "nPHONE", T0, T0 + TTL]);
  assert.equal(A.decision, decisionHash(INPUT));
  assert.equal(Buffer.from(A.nonce, "base64url").length, 16);
  const nonces = new Nonces();
  const ok = check(k, s, { nonces });
  assert.equal(ok.ok, true, JSON.stringify(ok));
  const again = check(k, s, { nonces });
  assert.deepEqual(again, { ok: false, reason: "the assertion was used already" }, "a replayed nonce is refused");
});

test("assert: each failed check refuses", () => {
  const k = pair();
  const other = pair();
  const cases = [
    ["bad signature", check(k, { ...sign(k), sig: sign(other).sig }), /not signed by the box/],
    ["payload changed after signing", check(k, { ...sign(k), a: Buffer.from(Buffer.from(sign(k).a, "base64url").toString().replace("nMAC", "nMAD")).toString("base64url") }), /not signed by the box/],
    ["signed by a key that is not pinned", check(k, sign(other)), /not signed by the box/],
    ["no key pinned", check(k, sign(k), { pinned: null }), /not pinned the box's key/],
    ["no own node known", check(k, sign(k), { self: null }), /own node/],
    ["no assertion", check(k, undefined), /no assertion/],
    ["another Mac", check(k, sign(k, { mac: "nOTHER" })), /another Mac/],
    ["another ask", check(k, sign(k), { input: { ...INPUT, ask: "zzzzzzzzzzzz" } }), /another ask/],
    ["altered decision", check(k, sign(k), { input: { ...INPUT, decision: "always" } }), /not the one the box signed/],
    ["an added message", check(k, sign(k), { input: { ...INPUT, message: "and push it" } }), /not the one the box signed/],
    ["expired", check(k, sign(k), { now: T0 + TTL }), /expired/],
    ["dated too far ahead", check(k, sign(k, { now: T0 + 2 * TTL + 1 })), /in the future/],
    ["a longer life than allowed", check(k, forge(k, { exp: T0 + 10 * TTL })), /times are not valid/],
    ["an unknown version", check(k, forge(k, { v: 2 })), /version/],
    ["an assertion made for threads.send", check(k, forge(k, { tool: "threads.send" })), /for threads.send, not threads.answer/],
    ["a good assertion offered for threads.send", check(k, sign(k), { tool: "threads.send" }), /threads.answer only, not threads.send/],
    ["no nonce", check(k, forge(k, { nonce: "" })), /no nonce/],
  ];
  for (const [name, r, why] of cases) {
    assert.equal(r.ok, false, name);
    assert.match(/** @type {any} */ (r).reason, /** @type {RegExp} */ (why), name);
  }
});

test("assert: a failed check spends no nonce, and the nonces seen are bounded and forgotten when they expire", () => {
  const k = pair();
  const nonces = new Nonces();
  const s = sign(k);
  assert.equal(check(k, s, { nonces, input: { ...INPUT, decision: "deny" } }).ok, false);
  assert.equal(check(k, s, { nonces }).ok, true, "the refused try did not use the nonce up");
  // Full: every new answer is refused, never an old nonce forgotten early.
  const full = new Nonces();
  for (let i = 0; i < MAX_NONCES; i++) assert.ok(full.take(`n${i}`.padEnd(22, "x"), T0 + TTL, T0));
  assert.equal(full.take("fresh-nonce-000000000", T0 + TTL, T0), false);
  assert.equal(full.take("fresh-nonce-000000000", T0 + 2 * TTL, T0 + TTL), true, "expired ones are swept");
  assert.equal(full.seen.size, 1);
});

test("assert: nonces persisted to a file survive a restart, so a captured assertion cannot replay across one (e2e review of 0f2a8752, LOW 2)", t => {
  const home = tempHome(t);
  const file = path.join(home, NONCES_FILE);
  const k = pair();
  const s = sign(k);
  const first = new Nonces(file, T0);
  assert.equal(check(k, s, { nonces: first, now: T0 + 1000 }).ok, true);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  // A fresh Nonces (as a restarted Mac would make) loads what the last one wrote. Its own clock
  // (here, the test's simulated one) decides what still counts as unexpired, same as take() does.
  const second = new Nonces(file, T0 + 2000);
  assert.equal(check(k, s, { nonces: second, now: T0 + 2000 }).ok, false, "the same assertion replays as used, not fresh, after a restart");
  // Expired nonces are not carried forward: loading prunes them.
  const third = new Nonces(file, T0 + TTL + 1);
  assert.equal(check(k, s, { nonces: third, now: T0 + TTL + 1 }).ok, false, "still expired: the assertion itself has expired too");
  const s2 = sign(k, { now: T0 + TTL + 1 });
  const fourth = new Nonces(file, T0 + TTL + 2);
  assert.equal(check(k, s2, { nonces: fourth, now: T0 + TTL + 2 }).ok, true, "a later assertion, once the old nonce has expired, is fresh");
  // A missing or unreadable file is no error: an empty set, as a first run has.
  assert.deepEqual([...new Nonces(path.join(home, "no-such-file.json")).seen], []);
  fs.writeFileSync(file, "not json", { mode: 0o600 });
  assert.deepEqual([...new Nonces(file).seen], []);
});

test("assert: an ask is gated when it approves a floor tool, by its exact name or its MCP name, or says presence is required", () => {
  for (const tool of ["vault.reveal", "mcp__vyre__vault_reveal", "mcp__plugin_vyre_vyre__vault_reveal", "mcp__vyre__vault_unlock-passphrase", "mcp__vyre__gate_approve", "mcp__vyre__link_pair_approve"]) {
    assert.equal(gatedAsk({ tool }), true, tool);
  }
  for (const tool of ["Bash", "Write", "mcp__vyre__threads_answer", "mcp__vyre__vault_list", "mcp__vyre__google_mail_send", "mcp__other__vault_reveal", "mcp__vyre__vault_reveal_all", "vault_reveal"]) {
    assert.equal(gatedAsk({ tool }), false, tool);
  }
  assert.equal(gatedAsk({ tool: "Bash", presence: { required: true } }), true);
  assert.equal(gatedAsk({ tool: "Bash", presence: { required: false } }), false);
  assert.equal(gatedAsk(null), false);
});

test("assert: for a gated ask the Mac needs the box's fresh proof in the assertion, never a presence session", () => {
  const k = pair();
  const r1 = check(k, sign(k), { gated: true });
  assert.equal(r1.ok, false);
  assert.match(/** @type {any} */ (r1).reason, /fresh proof of presence/);
  assert.equal(check(k, sign(k, { presence: "session" }), { gated: true }).ok, false);
  assert.equal(check(k, sign(k, { presence: "passkey", person: "ps-1" }), { gated: true }).ok, true);
  assert.equal(check(k, sign(k), { gated: false }).ok, true, "an ungated ask needs no proof");
});
