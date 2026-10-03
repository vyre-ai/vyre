// @ts-check
// Independent vectors for code.js. code-vectors.json was produced by the CFRG SageMath reference of draft-irtf-cfrg-cpace (see
// code-vectors.sage and team/0.3/PAKE-choice.md for the commits and how it was run), over OUR password, session id, channel identifiers and
// associated data, not the draft's fixed ones. cfrg-draft21-vectors.json is the draft-21 appendix vector for the same group, unchanged.
// The post-ISK values (tags, number, key, ack, seed) come from the script's own Python, a second reading of code.js, not a reference.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as C from "./code.js";
import { seedFromKey } from "./join.js";

const load = (/** @type {string} */ f) => JSON.parse(readFileSync(new URL(f, import.meta.url), "utf8"));
const V = load("./code-vectors.json");
const D21 = load("./cfrg-draft21-vectors.json");
const u = (/** @type {string} */ s) => new TextEncoder().encode(s);
const hex = (/** @type {string} */ h) => C.fromHex(h);
const H = C.toHex;

test("reference vectors: draft-21 appendix (ristretto255, SHA-512) matches code.js unchanged", () => {
  const g = D21.G_Coffee25519, x = (/** @type {string} */ k) => g[k].toLowerCase();
  const gen = C.calculateGenerator(hex(x("PRS")), hex(x("CI")), hex(x("sid")));
  assert.equal(H(gen.toBytes()), x("g"));
  const ya = C.scalarFromBytes(hex(x("ya"))), yb = C.scalarFromBytes(hex(x("yb")));
  const Ya = gen.multiply(ya).toBytes(), Yb = gen.multiply(yb).toBytes();
  assert.equal(H(Ya), x("Ya"));
  assert.equal(H(Yb), x("Yb"));
  const K = C.sharedPoint(ya, Yb);
  assert.equal(H(K), x("K"));
  assert.equal(H(C.sharedPoint(yb, Ya)), x("K"));
  assert.equal(H(C.isk(hex(x("sid")), K, C.transcriptIr(Ya, hex(x("ADa")), Yb, hex(x("ADb"))))), x("ISK_IR"));
});

test("reference vectors: the CFRG reference and code.js agree byte for byte on our own inputs", () => {
  assert.ok(V.cases.length >= 10);
  const seen = new Set();
  for (const c of V.cases) {
    const ci = hex(c.ci), sid = hex(c.sid);
    // Generator, public messages, shared point, transcript and ISK, from the reference.
    const g = C.calculateGenerator(u(c.pw), ci, sid);
    assert.equal(H(g.toBytes()), c.g, `generator ${c.pw}`);
    const ya = C.scalarFromBytes(hex(c.ya)), yb = C.scalarFromBytes(hex(c.yb));
    const Ya = g.multiply(ya).toBytes(), Yb = g.multiply(yb).toBytes();
    assert.equal(H(Ya), c.Ya, "Ya");
    assert.equal(H(Yb), c.Yb, "Yb");
    const K = C.sharedPoint(ya, Yb);
    assert.equal(H(K), c.K, "K");
    assert.equal(H(C.sharedPoint(yb, Ya)), c.K, "K both ways");
    const tr = C.transcriptIr(Ya, hex(c.adTypist), Yb, hex(c.adShowing));
    assert.equal(H(tr), c.transcript, "transcript");
    assert.equal(H(C.isk(sid, K, tr)), c.isk, "ISK");
    seen.add(c.pw + c.rv);
  }
  assert.equal(seen.size, V.cases.length, "ten different inputs");
});

test("reference vectors: whole sessions, with the reference's scalars and nonce, end with the same tags, number, key, ack code and ticket seed", () => {
  for (const c of V.cases) {
    const t = C.typistStart({ pw: c.pw, rv: c.rv, nonce: hex(c.nonce), scalar: C.scalarFromBytes(hex(c.ya)) });
    assert.equal(H(t.first), c.Ya);
    const s = C.showingStart({ pw: c.pw, rv: c.rv, route: c.route, s: t.s, first: t.first, scalar: C.scalarFromBytes(hex(c.yb)) });
    assert.equal(H(s.second), c.Yb);
    const tagT = t.second(s.second, c.route);
    assert.equal(H(tagT), c.tagT, "typist's confirmation");
    const r = s.confirm(tagT);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(H(r.tag), c.tagS, "showing device's confirmation");
    assert.equal(r.number, c.number);
    assert.equal(H(r.key), c.key);
    const f = t.finish(r.tag);
    assert.equal(f.ok && f.number, c.number);
    assert.equal(C.ackCode(r.key), c.ack, "typed-back code");
    assert.equal(H(seedFromKey(r.key)), c.seed, "ticket seed");
  }
});

test("reference vectors: a control, one changed input gives a different generator (the test can fail)", () => {
  const c = V.cases[0];
  assert.notEqual(H(C.calculateGenerator(u(c.pw.slice(0, 5) + (c.pw[5] === "0" ? "1" : "0")), hex(c.ci), hex(c.sid)).toBytes()), c.g);
  assert.notEqual(H(C.calculateGenerator(u(c.pw), hex(c.ci), hex(c.sid.slice(0, -2) + "00")).toBytes()), c.g);
});
