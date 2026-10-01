// @ts-check
// The setup page's half (relay/client/setup.js) against the box's (core/relay/wire.js and the Node
// relay): every derived value matches byte for byte, the hello is admitted only for the page's key
// and Noise key, and the mailbox reader checks each line's HMAC and sequence.
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { createSetupKey, setupCode, parseSetupCode, setupDerive, setupHello, setupWords, setupFingerprint, mailboxReader, openMailboxLine, plainText } from "./setup.js";
import { WORDS } from "./words.js";
import { WORDS as CORE_WORDS } from "../../core/relay/words.js";
import * as wire from "../../core/relay/wire.js";
import { createRelay } from "../node/server.js";
import { base64url } from "./bytes.js";
import { resolveTicket } from "./client.js";
import { nodeCrypto } from "./nodecrypto.js";

const ROUTE = "a".repeat(26);

test("setup client: the word list is the core one, 2048 distinct words", () => {
  assert.deepEqual([...WORDS], [...CORE_WORDS]);
  assert.equal(new Set(WORDS).size, 2048);
  assert.equal(crypto.createHash("sha256").update(WORDS.join("\n") + "\n").digest("hex"), "2f5eed53a4727b4bf8880d8f3f199efc90e58503646d9ff8eff3a2ed3b24dbda");
});

test("setup client: the page key is non-extractable, and the code carries its fingerprint", async () => {
  const key = await createSetupKey();
  assert.equal(key.privateKey.extractable, false);
  await assert.rejects(crypto.subtle.exportKey("pkcs8", key.privateKey));
  assert.equal(key.spki.length, 91);
  assert.ok(wire.isP256Spki(Buffer.from(key.spki)));
  const secret = crypto.randomBytes(16);
  const code = await setupCode(secret, key.spki);
  assert.equal(code.length, 43);
  assert.equal(code, wire.setupCode(secret, Buffer.from(key.spki)), "the box's function makes the same code");
  const parsed = parseSetupCode(code);
  assert.deepEqual(Buffer.from(parsed.secret), secret);
  assert.deepEqual(Buffer.from(parsed.fp), wire.setupFingerprint(Buffer.from(key.spki)));
  assert.deepEqual(Buffer.from(await setupFingerprint(key.spki)), wire.setupFingerprint(Buffer.from(key.spki)));
  const core = wire.parseSetupCode(code);
  assert.deepEqual(core.secret, secret);
  // a 43rd character with nonzero padding bits is not the canonical encoding of any 32 bytes
  const sloppy = code.slice(0, 42) + "B";
  for (const bad of ["", "a".repeat(42), "a".repeat(44), code.slice(0, 42) + "!", sloppy]) {
    assert.equal(parseSetupCode(bad), null, `client refuses ${bad.length} chars`);
    assert.equal(wire.parseSetupCode(bad), null, `box refuses ${bad.length} chars`);
  }
});

test("setup client: every value derived from secret16 matches the box's, byte for byte", async () => {
  const secret = crypto.randomBytes(16);
  const mine = await setupDerive(secret);
  for (const which of ["loc", "sec", "mac", "enc", "mbxw", "mbxenc", "mbxmac"]) {
    assert.deepEqual(Buffer.from(mine[which]), wire.setupDerive(/** @type {any} */ (which), secret), which);
  }
  const all = new Set(Object.values(mine).map(v => Buffer.from(v).toString("hex")));
  assert.equal(all.size, 7, "seven distinct values, one tag each");
  // loc/sec/mac/enc reuse the Wink tags, so they are ticketDerive of a longer ticket.
  assert.deepEqual(wire.setupDerive("loc", secret), wire.ticketDerive("loc", secret));
});

test("setup client: the hello is the box's to verify: right key and Noise key admitted, replays and wrong keys refused", async () => {
  const key = await createSetupKey();
  const secret = crypto.randomBytes(16);
  const code = wire.parseSetupCode(await setupCode(secret, key.spki));
  const noise = crypto.randomBytes(32);
  const hello = await setupHello({ ...key, route: ROUTE, noiseStatic: noise, secret });
  const ok = wire.setupHelloOk({ fp: code.fp, route: ROUTE, noiseStatic: noise, key: hello.setup.key, sig: hello.setup.sig });
  assert.ok(ok && ok.equals(Buffer.from(key.spki)));
  assert.equal(hello.pair, base64url((await setupDerive(secret)).sec));
  const other = crypto.randomBytes(32);
  assert.equal(wire.setupHelloOk({ fp: code.fp, route: ROUTE, noiseStatic: other, key: hello.setup.key, sig: hello.setup.sig }), null, "replayed from another Noise key");
  assert.equal(wire.setupHelloOk({ fp: code.fp, route: "b".repeat(26), noiseStatic: noise, key: hello.setup.key, sig: hello.setup.sig }), null, "another route");
  const stranger = await createSetupKey();
  const theirs = await setupHello({ ...stranger, route: ROUTE, noiseStatic: noise });
  assert.equal(wire.setupHelloOk({ fp: code.fp, route: ROUTE, noiseStatic: noise, key: theirs.setup.key, sig: theirs.setup.sig }), null, "a key that does not hash to fp");
  const forged = Buffer.from(hello.setup.sig, "base64url"); forged[3] ^= 1;
  assert.equal(wire.setupHelloOk({ fp: code.fp, route: ROUTE, noiseStatic: noise, key: hello.setup.key, sig: forged.toString("base64url") }), null, "a bad signature");
  assert.equal(wire.setupHelloOk({ fp: code.fp, route: ROUTE, noiseStatic: noise, key: hello.setup.key, sig: "" }), null, "no signature");
  assert.equal(wire.setupHelloOk({ fp: code.fp, route: ROUTE, noiseStatic: noise, key: "", sig: hello.setup.sig }), null, "no key");
});

test("setup client: the four check words match the box's, and differ per box key and secret", async () => {
  const box = crypto.randomBytes(32), secret = crypto.randomBytes(16);
  const mine = await setupWords(box, secret);
  assert.deepEqual(mine, wire.setupWords(box, secret));
  assert.equal(mine.length, 4);
  assert.ok(mine.every(w => WORDS.includes(w)));
  assert.notDeepEqual(mine, wire.setupWords(crypto.randomBytes(32), secret));
});

/** A relay, the writer's side of a mailbox (what the install script does), and the page's reader. */
async function mailbox(t) {
  const relay = createRelay();
  const base = await relay.listen();
  t.after(() => relay.close());
  const http = base.replace(/^ws/, "http");
  const key = await createSetupKey();
  const secret = crypto.randomBytes(16);
  const loc = wire.setupDerive("loc", secret).toString("base64url");
  const fp = wire.setupFingerprint(Buffer.from(key.spki)).toString("base64url");
  const wtok = wire.setupDerive("mbxw", secret).toString("base64url");
  const post = (line, extra = {}) => fetch(`${http}/v1/setup/mbx`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ loc, fp, wtok, ...(line === undefined ? {} : { line }), ...extra }) });
  const reader = await mailboxReader({ relay: base, secret, key });
  return { relay, base, http, key, secret, loc, fp, wtok, post, reader, line: (seq, text) => wire.mbxSeal(secret, seq, text) };
}

test("setup client: the mailbox reader takes lines in order, checks each HMAC and renders plain text", async t => {
  const m = await mailbox(t);
  assert.equal((await m.post(m.line(0, "Found your server"))).status, 200);
  assert.equal((await m.post(m.line(1, "Installing\u202e Tailscale\u0007"))).status, 200);
  assert.deepEqual(await m.reader.next(0), ["Found your server", "Installing Tailscale"], "bidi and control characters never reach the page");
  assert.equal(m.reader.seq, 2);
  assert.deepEqual(await m.reader.next(0), []);
  await m.post(m.line(2, "Done"));
  assert.deepEqual(await m.reader.next(0), ["Done"]);
});

test("setup client: a long poll waits for the next line and returns as soon as it lands", async t => {
  const m = await mailbox(t);
  await m.post();                                     // the script creates the mailbox
  const started = Date.now();
  const waiting = m.reader.next(5);
  setTimeout(() => m.post(m.line(0, "hello")), 300);
  assert.deepEqual(await waiting, ["hello"]);
  assert.ok(Date.now() - started < 3000, "answered on arrival, not at the end of the wait");
  // and a poll with nothing new ends at its wait, empty
  assert.deepEqual(await m.reader.next(1), []);
});

test("setup client: a line at the wrong position, replayed, or altered stops the reader", async t => {
  for (const [name, seqOf, code] of [["replayed", 0, "bad_line"], ["moved", 5, "bad_line"]]) {
    const m = await mailbox(t);
    await m.post(m.line(0, "one"));
    await m.post(m.line(seqOf, "two"));               // the relay (or anyone) replays or moves a line
    await assert.rejects(m.reader.next(0), { code }, name);
  }
  const m = await mailbox(t);
  const good = m.line(0, "one");
  const b = Buffer.from(good, "base64url"); b[20] ^= 1;
  await m.post(b.toString("base64url"));
  await assert.rejects(m.reader.next(0), { code: "bad_line" }, "an altered byte");
  // a relay that answers with the wrong index is caught too
  const lying = await mailboxReader({ relay: m.base, secret: m.secret, key: m.key, fetch: async () => new Response(JSON.stringify({ n: 1, lines: [{ i: 3, line: m.line(0, "x") }] })) });
  await assert.rejects(lying.next(0), { code: "out_of_order" });
  assert.equal(await openMailboxLine(await setupDerive(m.secret), 0, m.line(1, "x")), null, "the sequence number is inside the HMAC");
});

test("setup client: only the page's key reads: another key, a stale signature or the code alone gets 401", async t => {
  const m = await mailbox(t);
  await m.post(m.line(0, "secret progress"));
  const stranger = await createSetupKey();
  const theirs = await mailboxReader({ relay: m.base, secret: m.secret, key: stranger });
  await assert.rejects(theirs.next(0), { code: "unauthorized" }, "someone who holds the whole code but not the key");
  const stale = await mailboxReader({ relay: m.base, secret: m.secret, key: m.key, now: () => Date.now() - 10 * 60_000 });
  await assert.rejects(stale.next(0), { code: "unauthorized" }, "a signature older than the window");
  // a signature for another read position does not carry over
  const q = new URLSearchParams({ loc: m.loc, after: "1", wait: "0" });
  const ts = Date.now();
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, m.key.privateKey, wire.mbxReadMessage(m.loc, ts, 0)));
  const res = await fetch(`${m.http}/v1/setup/mbx?${q}`, { headers: { "x-vyre-setup-key": base64url(m.key.spki), "x-vyre-setup-ts": String(ts), "x-vyre-setup-sig": base64url(sig) } });
  assert.equal(res.status, 401);
  assert.deepEqual(await m.reader.next(0), ["secret progress"], "the real page still reads");
});

test("setup client: a second box writing to the same locator makes it contested, for resolve and the mailbox", async t => {
  const m = await mailbox(t);
  assert.equal((await m.post(m.line(0, "mine"))).status, 200);
  assert.equal((await m.post(m.line(1, "again"))).status, 200, "the same writer carries on");
  const other = await m.post(m.line(0, "theirs"), { wtok: wire.setupDerive("mbxw", crypto.randomBytes(16)).toString("base64url") });
  assert.equal(other.status, 409);
  assert.equal((await m.post(m.line(2, "mine again"))).status, 409, "the first writer is locked out too: contested");
  await assert.rejects(m.reader.next(0), { code: "contested" });
  const res = await fetch(`${m.http}/v1/pair`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ loc: m.loc }) });
  assert.equal(res.status, 409, "resolve answers contested as well");
});

test("setup client: resolveTicket reports a contested locator with its own code", async t => {
  const relay = createRelay();
  const base = await relay.listen();
  t.after(() => relay.close());
  const secret = crypto.randomBytes(16);
  const loc = wire.setupDerive("loc", secret).toString("base64url");
  const post = wtok => fetch(`${base.replace(/^ws/, "http")}/v1/setup/mbx`, { method: "POST", body: JSON.stringify({ loc, fp: "f".repeat(22), wtok }) });
  assert.equal((await post("w".repeat(43))).status, 200);
  assert.equal((await post("x".repeat(43))).status, 409);
  await assert.rejects(resolveTicket(secret, { relay: base, crypto: nodeCrypto() }), { code: "contested" });
});

test("setup client: plainText strips what could reorder or hide text", () => {
  assert.equal(plainText("a\u202eb\u200bc\u0000d\ne"), "abcd\ne");
  assert.equal(plainText("x".repeat(5000)).length, 1024);
});
