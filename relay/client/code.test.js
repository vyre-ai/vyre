// @ts-check
// The typed Wink code: parsing, the draft's CPace test vectors (appendix B.3, ristretto255 + SHA-512),
// and the session between a typist and a showing device.

import test from "node:test";
import assert from "node:assert/strict";
import * as C from "./code.js";

const u = s => new TextEncoder().encode(s);
const hex = h => C.fromHex(h.replace(/\s+/g, ""));

test("code: format and parse, case, spaces and hyphens ignored, look-alikes folded", () => {
  assert.equal(C.formatCode("K7", "QM4P2X"), "WINK-K7QM-4P2X");
  for (const s of ["WINK-K7QM-4P2X", "wink-k7qm-4p2x", "k7qm4p2x", "K7QM 4P2X", " wink k7qm 4p2x ", "WINKK7QM4P2X", "K7-QM-4P-2X"]) {
    assert.deepEqual(C.parseCode(s), { code: "WINK-K7QM-4P2X", rv: "K7", pw: "QM4P2X" }, s);
  }
  // O is 0, I and L are 1.
  assert.equal(C.normaliseCode("wink-oi1l-0o0o"), "WINK-0111-0000");
  // No U, nothing short or long, nothing outside the alphabet.
  for (const bad of ["WINK-K7QM-4P2U", "WINK-K7QM-4P2", "WINK-K7QM-4P2XX", "", "WINK-K7QM-4P2!", "WINK-WINK-WINK-WINK", null, 7, "x".repeat(100)]) assert.equal(C.parseCode(/** @type {any} */ (bad)), null, String(bad));
  // The prefix is told apart by length: an 8-symbol code that starts with the symbols W, I, N, K stays a code.
  assert.equal(C.parseCode("WINKABCD")?.rv, "W1");
  assert.equal(C.parseCode("WINK-WINK-ABCD")?.rv, "W1");
});

test("code: the rendezvous is two symbols, 1024 values, and a fresh code has six random password symbols", () => {
  assert.equal(C.rendezvousIndex("00"), 0);
  assert.equal(C.rendezvousIndex("ZZ"), 1023);
  for (const i of [0, 1, 31, 32, 500, 1023]) assert.equal(C.rendezvousIndex(C.rendezvousFromIndex(i)), i);
  assert.equal(C.isRendezvous("K7"), true);
  assert.equal(C.isRendezvous("U7"), false);
  const seen = new Set();
  for (let i = 0; i < 50; i++) { const c = C.newCode("K7"); assert.match(c.code, /^WINK-K7[0-9A-HJKMNP-TV-Z]{2}-[0-9A-HJKMNP-TV-Z]{4}$/); assert.equal(C.parseCode(c.code)?.pw, c.pw); seen.add(c.pw); }
  assert.ok(seen.size > 45);
  assert.throws(() => C.newCode("UU"));
});

// draft-irtf-cfrg-cpace-20, appendix B.3
test("cpace vectors B.3.1: calculate_generator for ristretto255", () => {
  const ci = hex("0b415f696e69746961746f720b425f726573706f6e646572");
  const sid = hex("7e4b4791d6a8ef019b936c79fb7f2c57");
  const gs = C.generatorString(u("Password"), ci, sid);
  assert.equal(gs.length, 170);
  assert.equal(C.toHex(gs), "11435061636552697374726574746f3235350850617373776f7264" + "64" + "00".repeat(100) + "180b415f696e69746961746f720b425f726573706f6e646572107e4b4791d6a8ef019b936c79fb7f2c57");
  assert.equal(C.toHex(C.calculateGenerator(u("Password"), ci, sid).toBytes()), "222b6b195fe84b1652badb6f6a3ae3d24341e7306967f0b8115b40d5698c7e56");
});

test("cpace vectors B.3.2 to B.3.5: messages, K and ISK (initiator/responder)", () => {
  const ci = hex("0b415f696e69746961746f720b425f726573706f6e646572");
  const sid = hex("7e4b4791d6a8ef019b936c79fb7f2c57");
  const g = C.calculateGenerator(u("Password"), ci, sid);
  const ya = C.scalarFromBytes(hex("da3d23700a9e5699258aef94dc060dfda5ebb61f02a5ea77fad53f4ff0976d08"));
  const yb = C.scalarFromBytes(hex("d2316b454718c35362d83d69df6320f38578ed5984651435e2949762d900b80d"));
  const Ya = g.multiply(ya).toBytes(), Yb = g.multiply(yb).toBytes();
  assert.equal(C.toHex(Ya), "d6bac480f2c386c394efc7c47adb9925dcd2630b64f240c50f8d0eec482b9157");
  assert.equal(C.toHex(Yb), "3ea7e0b19560d7c0b0f5734f63b955286dfa8232b5ebe63324e2d9e7433f7258");
  const K = C.sharedPoint(ya, Yb);
  assert.equal(C.toHex(K), "80b69a8a76457ab6a4d7f887a4bf6b55a2f80ac19c333f917a05fc9887c8b40f");
  assert.equal(C.toHex(C.sharedPoint(yb, Ya)), C.toHex(K));
  const tr = C.transcriptIr(Ya, u("ADa"), Yb, u("ADb"));
  assert.equal(C.toHex(tr), "20d6bac480f2c386c394efc7c47adb9925dcd2630b64f240c50f8d0eec482b915703414461203ea7e0b19560d7c0b0f5734f63b955286dfa8232b5ebe63324e2d9e7433f725803414462");
  assert.equal(C.toHex(C.isk(sid, K, tr)), "b69effbf61b51d56401c0f65601abe428de8206feaaf0e32198896dcae7b35cd2b38950a39dfd5d4a79164614c2984f7daa460b588c1e80c3fa2068af7900447");
});

test("cpace: an identity or undecodable point is refused", () => {
  assert.throws(() => C.sharedPoint(5n, new Uint8Array(32)), /bad point/);
  assert.throws(() => C.sharedPoint(5n, new Uint8Array(32).fill(0xff)), /bad point/);
  assert.throws(() => C.sharedPoint(5n, new Uint8Array(5)), /bad point/);
});

/** Runs the four messages between two ends. */
function run(pwTyped, pwShown, route = "r".repeat(26)) {
  const t = C.typistStart({ pw: pwTyped, rv: "K7", route });
  const s = C.showingStart({ pw: pwShown, rv: "K7", route, s: t.s, first: t.first });
  const m3 = t.second(s.second);
  const c = s.confirm(m3);
  const f = c.ok ? t.finish(c.tag) : { ok: false };
  return { t, s, c, f };
}

test("pake: the right password gives the same number and key on both sides, and confirmations verify", () => {
  const r = run("QM4P2X", "QM4P2X");
  assert.equal(r.c.ok, true);
  assert.equal(r.f.ok, true);
  assert.match(/** @type {any} */ (r.f).number, /^\d{3}$/);
  assert.equal(/** @type {any} */ (r.c).number, /** @type {any} */ (r.f).number);
  assert.equal(C.toHex(/** @type {any} */ (r.c).key), C.toHex(/** @type {any} */ (r.f).key));
  assert.equal(/** @type {any} */ (r.f).key.length, 32);
  // Two runs never share a key.
  const r2 = run("QM4P2X", "QM4P2X");
  assert.notEqual(C.toHex(/** @type {any} */ (r2.f).key), C.toHex(/** @type {any} */ (r.f).key));
});

test("pake: a wrong password fails the typist's confirmation, and the showing device derives nothing to send", () => {
  const r = run("QM4P2X", "QM4P2Y");
  assert.deepEqual(r.c, { ok: false });
  assert.deepEqual(r.f, { ok: false });
  // The result carries no tag, key or number.
  assert.deepEqual(Object.keys(r.c), ["ok"]);
});

test("pake: a different route, rendezvous or session nonce is a different session (no replay across them)", () => {
  const route = "r".repeat(26);
  for (const other of [{ rv: "K8", route }, { rv: "K7", route: "q".repeat(26) }]) {
    const t = C.typistStart({ pw: "QM4P2X", rv: "K7", route });
    const s = C.showingStart({ pw: "QM4P2X", ...other, s: t.s, first: t.first });
    assert.equal(s.confirm(t.second(s.second)).ok, false);
  }
  const t2 = C.typistStart({ pw: "QM4P2X", rv: "K7", route });
  const s2 = C.showingStart({ pw: "QM4P2X", rv: "K7", route, s: C.b64url(new Uint8Array(16)), first: t2.first });
  assert.equal(s2.confirm(t2.second(s2.second)).ok, false);
});

test("pake: roles are bound, so a reflected message does not complete", () => {
  const route = "r".repeat(26);
  const t = C.typistStart({ pw: "QM4P2X", rv: "K7", route });
  // An attacker reflects the typist's own Ya as the showing device's Yb.
  const m3 = t.second(t.first);
  const s = C.showingStart({ pw: "QM4P2X", rv: "K7", route, s: t.s, first: t.first });
  assert.equal(s.confirm(m3).ok, false);
});

test("pake: a confirmation answers once; a replayed correct tag after a wrong one does not pass", () => {
  const t = C.typistStart({ pw: "QM4P2X", rv: "K7", route: "r".repeat(26) });
  const s = C.showingStart({ pw: "QM4P2X", rv: "K7", route: "r".repeat(26), s: t.s, first: t.first });
  const good = t.second(s.second);
  assert.equal(s.confirm(new Uint8Array(32)).ok, false);
  assert.equal(s.confirm(good).ok, false);
});

test("pake: bad inputs are refused", () => {
  assert.throws(() => C.typistStart({ pw: "QM4P2", rv: "K7", route: "x" }));
  assert.throws(() => C.typistStart({ pw: "QM4P2X", rv: "UU", route: "x" }));
  const t = C.typistStart({ pw: "QM4P2X", rv: "K7", route: "x" });
  assert.throws(() => C.showingStart({ pw: "QM4P2X", rv: "K7", route: "x", s: "short", first: t.first }));
  assert.throws(() => C.showingStart({ pw: "QM4P2X", rv: "K7", route: "x", s: t.s, first: new Uint8Array(32) }), /bad point/);
  assert.throws(() => t.second(new Uint8Array(32)), /bad point/);
});

test("number choices hold the right number once, are distinct, and have the asked size", () => {
  for (const count of [3, 5, 8]) {
    for (let i = 0; i < 20; i++) {
      const c = C.numberChoices("047", count);
      assert.equal(c.length, count);
      assert.equal(new Set(c).size, count);
      assert.equal(c.filter(x => x === "047").length, 1);
      for (const x of c) assert.match(x, /^\d{3}$/);
    }
  }
  assert.throws(() => C.numberChoices("047", 1));
});

test("the number is spread over 000 to 999", () => {
  const seen = new Set();
  for (let i = 0; i < 12; i++) seen.add(/** @type {any} */ (run("QM4P2X", "QM4P2X").f).number);
  assert.ok(seen.size >= 8);
});
