import "../../scripts/test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import * as C from "../../../../kernel/identity/chain.js";
import { fromSeed } from "../identity/keys.js";
import { pairWords, nonceCommit, ticketTag } from "../../../../relay/client/pairwords.js";
import { pairServerDirect, pairToMessage, seedOf } from "./pair-direct.js";

const b64u = (b) => Buffer.from(b).toString("base64url");
const seed = new Uint8Array(16).map((_, i) => i + 1);
const ticket = b64u(seed);
const relay = "ws://relay.test:8787";
const box = b64u(new Uint8Array(32).fill(7));
const paired = { relay, route: "r1", box, device: "dev1", name: "a server" };
const finish = async () => ({ ok: true, paired });
const nowFn = () => 1000;

async function identity() {
  const key = await fromSeed(new Uint8Array(32).fill(3));
  return { id: "per_alexalexalexalexalexalex", name: "alex", eid: key.eid, key, sign: (m) => key.sign(m) };
}

/** A server that follows core/wink/pairing.js wink.server.adopt: commit, then its nonce, then the words once the app has revealed, then yes. */
function fakeServer({ lie = false, no = false } = {}) {
  const calls = [];
  const nb = "b".repeat(32);
  let commit = "";
  const fn = async (p, tool, input) => {
    calls.push({ tool, input });
    assert.equal(tool, "wink.server.adopt");
    const pr = input.pairing;
    if (pr.cancel) return { ok: true };
    if (!pr.reveal) { commit = pr.commit; return { pending: true, nb, until: 9e12 }; }
    assert.equal(await nonceCommit(pr.reveal), commit, "the revealed nonce matches the commit");
    const words = await pairWords(box, "dev1", { ticket: b64u(seed), nonceA: pr.reveal, nonceB: nb });
    const r = fn.asked ? { pending: false } : { pending: true, words: lie ? "wrong wrong wrong" : words, until: 9e12 };
    fn.asked = true;
    if (no) throw Object.assign(new Error("no"), { remote: "denied" });
    return r;
  };
  fn.calls = calls;
  return fn;
}

test("a device with only an identity pairs a fresh server: owner, proof, commit then reveal, the same three words, then not pending", async () => {
  const me = await identity(), server = fakeServer(), shown = [];
  const r = await pairServerDirect({ ticket, relay, deviceName: "Vyre on browser", identity: me, finish, call: server, onWords: (w) => shown.push(w), now: nowFn, sleep: async () => {}, random: (n) => new Uint8Array(n).fill(9) });
  assert.deepEqual(r.paired, paired);
  const first = server.calls[0].input;
  assert.deepEqual(first.owner, { kind: "identity", id: me.id, name: "alex" });
  assert.equal(first.identity, me.id);
  assert.equal(first.pairing.tag, await ticketTag(b64u(seed)));
  assert.equal(first.pairing.reveal, undefined, "the first call commits only");
  assert.equal(first.proof.eid, me.eid);
  assert.equal(await C.verifyWith(me.key.publicKey, pairToMessage(box, "dev1"), first.proof.sig), true, "the proof is a signature by a key of the identity over box and device");
  assert.equal(shown.length, 1);
  assert.match(shown[0], /\w+ \w+ \w+/);
  assert.equal(shown[0], await pairWords(box, "dev1", { ticket: b64u(seed), nonceA: "09".repeat(16), nonceB: "b".repeat(32) }), "the words are the server's, made from both nonces");
});

test("words that differ from the server's pair nothing and tell the server to let go", async () => {
  const me = await identity(), server = fakeServer({ lie: true });
  await assert.rejects(pairServerDirect({ ticket, relay, deviceName: "x", identity: me, finish, call: server, now: nowFn, sleep: async () => {} }), /do not match/);
  assert.ok(server.calls.some((c) => c.input.pairing.cancel), "a cancel was sent");
});

test("a server that says no (a remote refusal) ends the pairing with its own code and no cancel", async () => {
  const me = await identity(), server = fakeServer({ no: true });
  await assert.rejects(pairServerDirect({ ticket, relay, deviceName: "x", identity: me, finish, call: server, now: nowFn, sleep: async () => {} }), (e) => e.remote === "denied");
  assert.ok(!server.calls.some((c) => c.input.pairing.cancel));
});

test("a used or expired code says so; a bad code is refused before anything is sent", async () => {
  const me = await identity();
  await assert.rejects(pairServerDirect({ ticket, relay, deviceName: "x", identity: me, finish: async () => ({ ok: false, reason: "gone" }), call: async () => { throw new Error("no call"); } }), (e) => e.code === "ticket_gone");
  await assert.rejects(pairServerDirect({ ticket: "short", relay, deviceName: "x", identity: me, finish, call: async () => { throw new Error("no call"); } }), (e) => e.code === "bad_input");
  assert.throws(() => seedOf(ticket, "http://nope"), /no relay/);
});
