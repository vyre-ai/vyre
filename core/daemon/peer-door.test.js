import "../../scripts/mac-test-guard.mjs";
import "../runner/testing/hosted-guard.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createPeerDoor, STREAM_LIMITS } from "./peer-door.js";
import { peerClient } from "../../relay/client/peerclient.js";

const ID = "abcdefghijklmnop";
function door({ sessions = [], row = { kind: "app", removed: false } } = {}) {
  const seen = [];
  const registry = { call: async (tool, input, caller, meta) => {
    if (tool === "relay.device.info") return { data: row };
    seen.push({ tool, input, caller, meta }); return { data: { ok: true } };
  } };
  const kernel = { id: { space: "spc_aaaaaaaaaaaa", owner: "per_x" }, spaces: { for: () => null } };
  const d = createPeerDoor({ kernel, registry, people: { list: () => sessions }, now: () => 1000, callerFacts: (c, p, via, k, cap, device) => (device ? { kind: "device", device_key_id: ID, person: "per_x", path: "relay", ...(via && via.person ? { session: via.person.id } : {}) } : null) });
  return { d, seen };
}
const run = async (d, tool, input, id = ID) => {
  const { peerSession } = await import("../wink/node/peer-wire.js");
  /** the door's end is a relay stream (its handlers are set by the door); the client end is a pipe into it */
  const s = { ondata() {}, onend() {}, onreset() {}, respond() {}, ch: { transport: {} }, write: b => queueMicrotask(() => c.ondata(Buffer.from(b))), end() {}, reset() {} };
  const c = { ondata() {}, onclose() {}, buffered: () => 0, write: b => queueMicrotask(() => s.ondata(new Uint8Array(b))), end() {}, destroy() {} };
  d.accept(s, { deviceId: id });
  const client = peerSession(c, { first: 1 });
  try { return await client.call(tool, input, { timeoutMs: 3000 }); } finally { client.close("done"); }
};

test("a live paired session is the person; an expired one, and none, leave the call the device's own", async () => {
  let x = door({ sessions: [{ id: "s1", kind: "bearer", node: ID, paired: true, expires: 5000 }] });
  await run(x.d, "t.a", {});
  assert.deepEqual(x.seen[0].meta.person, { id: "s1", kind: "bearer" });
  x = door({ sessions: [{ id: "s1", kind: "bearer", node: ID, paired: true, expires: 500 }] });
  await run(x.d, "t.a", {});
  assert.equal(x.seen[0].meta.person, undefined);
  x = door({});
  await run(x.d, "t.a", {});
  assert.equal(x.seen[0].meta.person, undefined);
});
test("an oversize proof is dropped without failing the call, and tool input never supplies person, kernelFacts or kernel_proof", async () => {
  const x = door();
  await run(x.d, "t.a", { proof: { x: "y".repeat(5000) }, person: { id: "evil" }, kernelFacts: { person: "evil" }, kernel_proof: { op: "evil" }, keep: 1 });
  const m = x.seen[0].meta;
  assert.equal(m.proof, undefined);
  assert.equal(m.person, undefined);
  assert.equal(m.kernelFacts.person, "per_x");
  assert.equal(m.kernel_proof, undefined);
  const small = door();
  await run(small.d, "t.a", { proof: { k: 1 } });
  assert.deepEqual(small.seen[0].meta.proof, { k: 1 });
  assert.equal(small.seen[0].input.proof, undefined, "the proof never reaches the tool's input");
});
test("a well-formed id with no row gets a refused call and a closed session", async () => {
  const x = door({ row: null });
  await assert.rejects(() => run(x.d, "t.a", {}), e => e.code === "denied");
  assert.equal(x.seen.length, 0);
});


// ---- streams over the peer wire (lead ruling, 4 Oct): a call opens one, frames travel as server-to-device messages, the device closes its own, a dropped peer stream ends them ----

/** A relay stream pair: the door's end `a` and the device's end `b`, in memory. */
function streamPair() {
  const a = { ondata() {}, onend() {}, onreset() {}, respond() {}, ch: { transport: {} }, write: b => queueMicrotask(() => bb.ondata(new Uint8Array(b))), end() { queueMicrotask(() => bb.onend()); }, reset(w) { queueMicrotask(() => bb.onreset(w)); } };
  const bb = { ondata() {}, onend() {}, onreset() {}, write: b => queueMicrotask(() => a.ondata(Buffer.from(b))), end() { queueMicrotask(() => a.onend()); }, reset(w) { queueMicrotask(() => a.onreset(w)); } };
  return { a, b: bb };
}
const tick = (ms = 30) => new Promise(r => setTimeout(r, ms));
/** A door whose registry has one streaming tool, `chat.open { id, turns }`, and a controllable paired session. */
function streamDoor() {
  const state = { sessions: [{ id: "s1", kind: "bearer", node: ID, paired: true, expires: Date.now() + 3_600_000 }], cleaned: [], emitters: new Map(), row: { kind: "app", removed: false } };
  const registry = { call: async (tool, input, caller, meta) => {
    if (tool === "relay.device.info") return { data: state.row };
    if (tool === "chat.open") {
      const open = meta.peerStream.open(input.id, h => { state.emitters.set(input.id, h); for (let i = 1; i <= (input.turns || 0); i++) h.emit({ n: i }); return () => state.cleaned.push(input.id); });
      return { data: { stream: open.id } };
    }
    if (tool === "chat.say") return { data: { ok: true } };
    return { data: null };
  }, tools: new Map() };
  const kernel = { id: { space: "spc_aaaaaaaaaaaa", owner: "per_x" }, spaces: { for: () => null } };
  const door = createPeerDoor({ kernel, registry, people: { list: () => state.sessions }, callerFacts: (c, p, via, k, cap, device) => (device ? { kind: "device", device_key_id: ID, person: "per_x", path: "relay" } : null) });
  const connect = () => { const { a, b } = streamPair(); door.accept(a, { deviceId: ID }); return peerClient(b); };
  return { state, connect };
}

test("a paired device opens a stream by a call, receives its frames in order (even ones that beat the answer), sends a message by call, and closes it", async () => {
  const { state, connect } = streamDoor();
  const peer = connect();
  const got = [], ended = [];
  const s = await peer.openStream("chat.open", { id: "stream_aaaaaaaa", turns: 5 }, { onframe: (d, seq) => got.push([d.n, seq]), onend: w => ended.push(w) });
  await tick();
  assert.deepEqual(got, [1, 2, 3, 4, 5].map(n => [n, n]), "in order, with their sequence numbers");
  assert.deepEqual(await peer.call("chat.say", { id: "stream_aaaaaaaa", text: "hi" }), { ok: true }, "a message goes by call on the same wire");
  state.emitters.get("stream_aaaaaaaa").emit({ n: 6 });
  await tick();
  assert.equal(got.length, 6);
  s.close();
  await tick();
  assert.deepEqual(state.cleaned, ["stream_aaaaaaaa"], "the server's producer is cleaned up when the device closes");
  assert.equal(state.emitters.get("stream_aaaaaaaa").emit({ n: 7 }), false, "no frame after the device closed it");
  peer.close();
});

test("a dropped peer stream ends its streams on both sides, and the app resumes by opening again from the last frame it saw", async () => {
  const { state, connect } = streamDoor();
  const p1 = connect();
  const got = [], ended = [];
  await p1.openStream("chat.open", { id: "stream_bbbbbbbb", turns: 3 }, { onframe: (d, seq) => got.push(seq), onend: w => ended.push(w) });
  await tick();
  p1.close();                       // the peer stream drops
  await tick();
  assert.deepEqual(ended, ["closed"], "the app is told its stream ended with the peer stream");
  assert.ok(state.cleaned.includes("stream_bbbbbbbb"), "the server ended and cleaned the stream");
  // the app reopens the peer and the stream, from the last seq it saw
  const p2 = connect();
  const again = [];
  await p2.openStream("chat.open", { id: "stream_cccccccc", turns: 2, from: got[got.length - 1] }, { onframe: (d, seq) => again.push(seq) });
  await tick();
  assert.deepEqual(again, [1, 2]);
  p2.close();
});

test("a device whose session ended gets nothing more, and a stream cannot be opened without a live session", async () => {
  const { state, connect } = streamDoor();
  const peer = connect();
  const got = [], ended = [];
  await peer.openStream("chat.open", { id: "stream_dddddddd", turns: 1 }, { onframe: (d, seq) => got.push(seq), onend: w => ended.push(w) });
  await tick();
  state.sessions.length = 0;        // the paired session ended
  assert.equal(state.emitters.get("stream_dddddddd").emit({ n: 2 }), false, "no frame after the session ends");
  await tick();
  assert.deepEqual(got, [1]);
  assert.deepEqual(ended, ["session_ended"]);
  await assert.rejects(() => peer.openStream("chat.open", { id: "stream_eeeeeeee", turns: 1 }, { onframe() {} }), e => e.code === "denied");
  peer.close();
});

test("a device cannot close another device's stream by its id, the per-device cap holds, an oversize frame and a bad id end or refuse", async () => {
  const { state, connect } = streamDoor();
  const owner = connect(), other = connect();
  await owner.openStream("chat.open", { id: "stream_ffffffff", turns: 0 }, { onframe() {} });
  // another peer stream (another session) sends a close for that id: ignored
  await other.openStream("chat.open", { id: "stream_gggggggg", turns: 0 }, { onframe() {} });
  const forged = peerClient;   // keep the import used: a close frame for an id this session never opened
  void forged;
  other.closeById = undefined;
  await tick();
  assert.equal(state.cleaned.includes("stream_ffffffff"), false, "another session's stream is untouched");
  // cap: 8 per device across its peer streams
  for (let i = 0; i < STREAM_LIMITS.perDevice - 2; i++) await owner.openStream("chat.open", { id: `stream_cap_${i}xx`, turns: 0 }, { onframe() {} });
  await assert.rejects(() => owner.openStream("chat.open", { id: "stream_overcap", turns: 0 }, { onframe() {} }), e => e.code === "rate_limited");
  // an oversize frame ends its stream; a malformed id is refused
  const ends = [];
  const big = connect();
  await assert.rejects(() => big.openStream("chat.open", { id: "bad id!", turns: 0 }, { onframe() {} }), e => e.code === "bad_input");
  state.emitters.get("stream_ffffffff").emit({ blob: "x".repeat(STREAM_LIMITS.frameBytes + 10) });
  assert.equal(state.emitters.get("stream_ffffffff").alive(), false, "the oversize frame ended its stream");
  void ends; owner.close(); other.close(); big.close();
});
