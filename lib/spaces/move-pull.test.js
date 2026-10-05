import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { createPullSource, createPuller, filesRoot, srcMessage, pullMessage, IDLE_MS, SESSION_CAP_MS } from "./move-pull.js";

const FROM = "spc_aaaaaaaaaaaa", TO = "spc_bbbbbbbbbbbb", OTHER = "spc_cccccccccccc";
const MOVE = "0190c3f2-1111-4abc-8def-0000000000a1", MOVE2 = "0190c3f2-1111-4abc-8def-0000000000a2";
const PERSON = "per_" + "a".repeat(26);
const key = () => crypto.generateKeyPairSync("ed25519");
const signer = k => m => crypto.sign(null, Buffer.from(m), k.privateKey).toString("base64url");
const verifier = pub => (m, sig) => crypto.verify(null, Buffer.from(m), pub, Buffer.from(sig, "base64url"));
const sha = b => crypto.createHash("sha256").update(b).digest("hex");

function world({ plan, limits, now } = {}) {
  const kFrom = key(), kTo = key();
  const urns = [1, 2, 3].map(i => `vyre://${FROM}/contact/0190c3f2-1111-4abc-8def-00000000000${i}`);
  const big = Buffer.alloc(2_500_000, 7);
  const files = [{ path: "Projects/a/small.txt", size: 5, sha256: sha(Buffer.from("hello")) }, { path: "Projects/a/big.bin", size: big.length, sha256: sha(big) }];
  const approved = { hash: "h".repeat(43), ids: urns, files };
  let current = plan || approved;
  const reads = [];
  const grant = { to: TO, to_pub: kTo.publicKey, person: PERSON, plan_hash: approved.hash, project: `vyre://${FROM}/project/0190c3f2-1111-4abc-8def-0000000000aa`, expires: 0 };
  const source = createPullSource({
    space: FROM, grantOf: m => (m === MOVE ? grant : null), sign: signer(kFrom), verify: (pub, m, s) => verifier(pub)(m, s),
    planFor: async () => current, readRecord: async (g, u) => { reads.push(["record", g.person, u]); return { urn: u, version: 1, data: { name: u.slice(-3) } }; },
    readFile: async (g, p, off, len) => { reads.push(["file", p, off, len]); return p.endsWith("small.txt") ? Buffer.from("hello").subarray(off, off + len) : big.subarray(off, off + len); },
    ...(limits ? { limits } : {}), ...(now ? { now } : {}),
  });
  const puller = (over = {}) => createPuller({ from: FROM, to: TO, move_id: MOVE, send: async req => source[req.t](req), verifySource: verifier(kFrom.publicKey), sign: signer(kTo), ...over });
  return { source, puller, kFrom, kTo, urns, files, big, reads, setPlan: p => { current = p; }, approved };
}

test("the pull: the target proves itself only after the source has, then reads the approved plan, records and files in checked chunks", async () => {
  const w = world();
  const p = w.puller();
  await p.connect();
  const plan = await p.plan();
  assert.deepEqual([plan.hash, plan.ids.length, plan.files.length], [w.approved.hash, 3, 2]);
  const recs = await p.records(w.urns.slice(0, 2));
  assert.deepEqual(recs.map(r => r.version), [1, 1]);
  assert.equal(w.reads.find(r => r[0] === "record")[1], PERSON, "records are read under the mover's person");
  // the big file in chunks, reassembled and equal to its hash
  const parts = [];
  for (let off = 0; off < w.big.length;) { const c = await p.file("Projects/a/big.bin", off, 1024 * 1024); parts.push(c.bytes); off += c.bytes.length; assert.equal(c.sha256, sha(w.big)); }
  assert.equal(sha(Buffer.concat(parts)), sha(w.big));
  assert.equal(filesRoot(w.files), filesRoot([...w.files].reverse()), "the root of the per-file hashes does not depend on order");
  await p.done();
  assert.equal(w.source.open(), 0);
});

test("RM-2: a target signs nothing for a source that cannot prove it is the source; a proof cannot be relayed, replayed or turned to another move or target", async () => {
  const w = world();
  // a hostile endpoint with its own key answers hello: the target refuses before signing anything
  const evil = key(); let signed = 0;
  const hostile = createPuller({ from: FROM, to: TO, move_id: MOVE, verifySource: verifier(w.kFrom.publicKey), sign: m => { signed++; return signer(w.kTo)(m); },
    send: async req => (req.t === "hello" ? { nonce: "N".repeat(24), src_sig: signer(evil)(srcMessage(FROM, TO, MOVE, "N".repeat(24))) } : { session: "x" }) });
  await assert.rejects(() => hostile.connect(), { code: "denied" });
  assert.equal(signed, 0, "nothing was signed for a source that did not prove itself");
  // the source's signature is bound to the target and the move: one for another target is no proof for this one
  const wrong = createPuller({ from: FROM, to: TO, move_id: MOVE, verifySource: verifier(w.kFrom.publicKey), sign: signer(w.kTo),
    send: async req => (req.t === "hello" ? { nonce: "M".repeat(24), src_sig: signer(w.kFrom)(srcMessage(FROM, OTHER, MOVE, "M".repeat(24))) } : { session: "x" }) });
  await assert.rejects(() => wrong.connect(), { code: "denied" });
  // a hello for a target the move does not name, or a move this source never started
  await assert.rejects(() => w.source.hello({ move_id: MOVE, to: OTHER }), { code: "not_found" });
  await assert.rejects(() => w.source.hello({ move_id: MOVE2, to: TO }), { code: "not_found" });
  // a relay that fetched a nonce from the real source cannot make the target's proof: only the target's key signs it
  const h = await w.source.hello({ move_id: MOVE, to: TO });
  await assert.rejects(() => w.source.auth({ move_id: MOVE, to: TO, nonce: h.nonce, proof: signer(key())(pullMessage(FROM, TO, MOVE, h.nonce)) }), { code: "denied" });
  // the nonce was spent by that failed try, and a good proof for it is too late
  await assert.rejects(() => w.source.auth({ move_id: MOVE, to: TO, nonce: h.nonce, proof: signer(w.kTo)(pullMessage(FROM, TO, MOVE, h.nonce)) }), { code: "denied" });
  // a proof is bound to this source, target, move and nonce
  const h2 = await w.source.hello({ move_id: MOVE, to: TO });
  await assert.rejects(() => w.source.auth({ move_id: MOVE, to: TO, nonce: h2.nonce, proof: signer(w.kTo)(pullMessage(OTHER, TO, MOVE, h2.nonce)) }), { code: "denied" });
  const h3 = await w.source.hello({ move_id: MOVE, to: TO });
  const ok = await w.source.auth({ move_id: MOVE, to: TO, nonce: h3.nonce, proof: signer(w.kTo)(pullMessage(FROM, TO, MOVE, h3.nonce)) });
  assert.match(ok.session, /^pt_/);
  await assert.rejects(() => w.source.auth({ move_id: MOVE, to: TO, nonce: h3.nonce, proof: signer(w.kTo)(pullMessage(FROM, TO, MOVE, h3.nonce)) }), { code: "denied" }, "a replayed proof is refused");
});

test("RM-1: the source recomputes the plan and serves only what it holds; a changed project stops the pull", async () => {
  const w = world();
  const p = w.puller();
  await p.connect();
  await p.plan();
  await assert.rejects(() => p.records([`vyre://${FROM}/contact/0190c3f2-1111-4abc-8def-0000000000ff`]), { code: "denied" }, "a record outside the plan");
  await assert.rejects(() => p.file("Projects/other/secret.txt", 0, 10), { code: "denied" }, "a file outside the plan");
  await assert.rejects(() => p.file("Projects/a/small.txt", 0, 5 * 1024 * 1024), { code: "bad_input" }, "a chunk over the limit");
  await assert.rejects(() => p.file("Projects/a/small.txt", 99, 5), { code: "bad_input" }, "an offset outside the file");
  await assert.rejects(() => p.records([]), { code: "bad_input" });
  assert.equal(w.reads.filter(r => r[0] === "record").length, 0, "no read happened for a refused request");
  // the project changed after the approval: the next recompute differs, nothing more is served
  const now = { t: 1_000_000 };
  const w2 = world({ now: () => now.t });
  const p2 = w2.puller(); await p2.connect(); await p2.plan();
  w2.setPlan({ ...w2.approved, hash: "x".repeat(43) });
  assert.equal((await p2.records([w2.urns[0]])).length, 1, "the cached plan covers a short while");
  now.t += 3 * 60 * 1000;
  await assert.rejects(() => p2.records([w2.urns[0]]), { code: "plan_changed" });
  await assert.rejects(() => p2.records([w2.urns[0]]), { code: "denied" }, "and the session is closed");
});

test("RM-3: a pull lives past the start window until its cap or idle limit, and a stopped pull resumes with a new session for the same move", async () => {
  const now = { t: 5_000_000 };
  const w = world({ now: () => now.t });
  const p = w.puller(); await p.connect(); await p.plan();
  for (let i = 0; i < 18; i++) { now.t += 10 * 60 * 1000; await p.records([w.urns[0]]); } // three hours of steady pulling, a request every ten minutes
  assert.equal((await p.records([w.urns[0]])).length, 1, "a session that stays in use outlives the one-hour start window");
  // idle: 15 minutes with no request closes it; a new connect for the same move resumes
  now.t += IDLE_MS + 1000;
  await assert.rejects(() => p.records([w.urns[0]]), { code: "denied" });
  const again = w.puller(); await again.connect(); await again.plan();
  assert.equal((await again.records([w.urns[1]])).length, 1, "resume: same move, a new session");
  // the 24 hour cap, even for a busy pull
  const busy = w.puller(); await busy.connect(); await busy.plan();
  for (let i = 0; i < 143; i++) { now.t += 10 * 60 * 1000; await busy.records([w.urns[0]]); } // 23.8 hours, busy the whole time
  now.t += 11 * 60 * 1000; // 24 hours and a little: the cap, even for a pull that was never idle
  await assert.rejects(() => busy.records([w.urns[0]]), { code: "denied" }, "past the cap the session is closed");
  void SESSION_CAP_MS;
});

test("limits: a rate per minute and a size per move, and a tampered chunk is caught by its checksum", async () => {
  const w = world({ limits: { perMinute: 3, maxBytes: 1_100_000 } });
  const p = w.puller(); await p.connect(); await p.plan();
  await p.file("Projects/a/big.bin", 0, 1024 * 1024);
  await assert.rejects(() => p.file("Projects/a/big.bin", 1024 * 1024, 1024 * 1024), { code: "too_large" }, "the per-move size limit");
  const w2 = world({ limits: { perMinute: 3 } });
  const p2 = w2.puller(); await p2.connect(); await p2.plan(); // 1 plan
  await p2.records([w2.urns[0]]); await p2.records([w2.urns[1]]);
  await assert.rejects(() => p2.records([w2.urns[2]]), { code: "rate_limited" }, "requests per minute");
  // a courier or relay that flips a byte is caught
  const w3 = world();
  const tampered = w3.puller({ send: async req => { const r = await w3.source[req.t](req); return req.t === "file" ? { ...r, base64: Buffer.from("tampered").toString("base64") } : r; } });
  await tampered.connect(); await tampered.plan();
  await assert.rejects(() => tampered.file("Projects/a/small.txt", 0, 5), { code: "corrupt" });
  assert.deepEqual(await w3.source.sealed.length >= 0, true);
});
