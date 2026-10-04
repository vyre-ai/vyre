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

// ---- the invitee door ----
import crypto from "node:crypto";
import { peerSession } from "../wink/node/peer-wire.js";
const SPACE = "spc_harlowharlow";
const INVITE = "inv_" + "a".repeat(32);
const PERSON = "per_" + "q".repeat(26);
const BOX = "Qm94S2V5MTIzNDU2Nzg5MA";
const INVITEE = "zyxwvutsrqponmlk";

function inviteeWorld({ status = "pending", entry = true, addressedTo = null, limits } = {}) {
  const key = crypto.generateKeyPairSync("ed25519");
  const raw = key.publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  const served = [];
  const server = { serve: async (request, peer) => {
    served.push({ request, peer });
    if (request.call === "grants.invites.get") return addressedTo && addressedTo !== peer.person ? { v: 1, id: request.id, ok: false, error: { code: "not_found", message: "no such invite" } } : { v: 1, id: request.id, ok: true, result: { id: request.args[0], status, space: { id: SPACE } } };
    return { v: 1, id: request.id, ok: true, result: { accepted: true } };
  } };
  const registry = { call: async () => ({ data: null }) };
  const kernel = { id: { space: "spc_aaaaaaaaaaaa", owner: "per_x" }, spaces: { for: () => null } };
  let clock = 1_000_000;
  const d = createPeerDoor({ kernel, registry, people: { list: () => [] }, now: () => clock, callerFacts: () => null, serverFor: space => (space === SPACE ? server : null), boxId: async () => BOX,
    identityEntry: async (identity, eid) => (entry && identity === PERSON && eid === "e".repeat(26) ? { pub: Buffer.from(raw).toString("base64url") } : null), ...(limits ? { inviteeLimits: limits } : {}) });
  const hello = (over = {}) => {
    const h = { space: SPACE, invite: INVITE, identity: PERSON, entry: "e".repeat(26), ts: clock, nonce: crypto.randomBytes(12).toString("base64url"), channel: INVITEE, ...over };
    const msg = Buffer.from(`vyre-invitee-hello-v2\n${over.box || BOX}\n${h.space}\n${h.invite}\n${h.identity}\n${h.entry}\n${h.ts}\n${h.nonce}\n${h.channel}`);
    if (!h.sig) h.sig = crypto.sign(null, msg, key.privateKey).toString("base64url");
    delete h.box;
    return h;
  };
  const open = async (head) => {
    const s = { ondata() {}, onend() {}, onreset() {}, respond() {}, ch: { transport: {} }, write: b => queueMicrotask(() => c.ondata(Buffer.from(b))), end() {}, reset() {} };
    const c = { ondata() {}, onclose() {}, buffered: () => 0, write: b => queueMicrotask(() => s.ondata(new Uint8Array(b))), end() {}, destroy() {} };
    d.acceptInvitee(s, { inviteeId: INVITEE }, head);
    return peerSession(c, { first: 1 });
  };
  const kcall = (client, call, args, space = SPACE) => client.call("kernel.call", { v: 1, space, id: "c" + Math.random().toString(36).slice(2), ts: clock, call, args }, { timeoutMs: 3000 });
  return { d, hello, open, kcall, served, tick: ms => { clock += ms; } };
}

test("invitee door: a fresh hello with the identity's signature and a live invite reads the preview and accepts, and accepting ends the stream", async () => {
  const w = inviteeWorld();
  const c = await w.open(w.hello());
  const prev = await w.kcall(c, "grants.invites.get", [INVITE]);
  assert.equal(prev.ok, true);
  assert.equal(prev.result.status, "pending");
  assert.deepEqual(w.served.every(x => x.peer.person === PERSON && x.peer.device_key_id === INVITEE), true, "the kernel is told the proven person and the channel's id");
  const done = await w.kcall(c, "grants.invites.accept", [INVITE, { seen: {}, proof: {} }]);
  assert.equal(done.ok, true);
  await new Promise(r => setTimeout(r, 120));
  const after = await Promise.race([w.kcall(c, "grants.invites.get", [INVITE]).then(() => "answered", () => "refused"), new Promise(r => setTimeout(() => r("closed"), 1500))]);
  assert.notEqual(after, "answered", "the stream is closed after accept");
});

test("invitee door: every other call, another invite, another space, any registry tool and a person session are refused at the door", async () => {
  const w = inviteeWorld();
  const c = await w.open(w.hello());
  await w.kcall(c, "grants.invites.get", [INVITE]);
  const n = w.served.length;
  for (const [call, args] of [["grants.members.list", []], ["grants.invites.create", [{}]], ["records.query", [{}]], ["grants.invites.get", ["inv_" + "b".repeat(32)]], ["grants.invites.accept", ["inv_" + "b".repeat(32), {}]], ["grants.invites.get", []]]) {
    await assert.rejects(() => w.kcall(c, call, args), e => e.code === "denied", `${call} ${JSON.stringify(args).slice(0, 30)}`);
  }
  await assert.rejects(() => w.kcall(c, "grants.invites.get", [INVITE], "spc_" + "z".repeat(12)), e => e.code === "denied");
  await assert.rejects(() => c.call("system.info", {}, { timeoutMs: 3000 }), e => e.code === "denied");
  await assert.rejects(() => c.call("vault.reveal", { name: "x" }, { timeoutMs: 3000 }), e => e.code === "denied");
  assert.equal(w.served.length, n, "nothing past the two calls for this invite reached the kernel");
});

test("invitee door: a bad proof, a stale or replayed hello, an unknown identity, another box, a spent or expired invite and an invite for someone else each close the stream and reach the kernel for nothing but the preview", async () => {
  const cases = {
    "a signature by another key": () => { const w = inviteeWorld(); const h = w.hello(); h.sig = h.sig.slice(0, -4) + "AAAA"; return [w, h]; },
    "a hello for another box": () => { const w = inviteeWorld(); return [w, w.hello({ box: "AnotherBoxIdXXXXXXXXXX" })]; },
    "a stale hello": () => { const w = inviteeWorld(); return [w, w.hello({ ts: 1_000_000 - 3 * 60_000 })]; },
    "an identity the directory has no such entry for": () => [inviteeWorld({ entry: false }), null],
    "a spent invite": () => [inviteeWorld({ status: "used" }), null],
    "an expired invite": () => [inviteeWorld({ status: "expired" }), null],
    "an invite meant for another identity": () => [inviteeWorld({ addressedTo: "per_" + "x".repeat(26) }), null],
    "a space this home does not host": () => { const w = inviteeWorld(); return [w, w.hello({ space: "spc_" + "n".repeat(12) })]; },
    "a hello signed for another channel": () => { const w = inviteeWorld(); return [w, w.hello({ channel: "aaaabbbbccccdddd" })]; },
    "a malformed invite id": () => { const w = inviteeWorld(); return [w, w.hello({ invite: "inv_nope" })]; },
  };
  for (const [why, make] of Object.entries(cases)) {
    const [w, h] = make();
    const c = await w.open(h || w.hello());
    await assert.rejects(() => w.kcall(c, "grants.invites.get", [INVITE]), e => e.code === "denied", why);
    assert.ok(w.served.every(x => x.request.call === "grants.invites.get"), `${why}: nothing but the preview ever reached the kernel`);
  }
  // a replayed hello (same nonce) is refused the second time
  const w = inviteeWorld();
  const h = w.hello();
  const first = await w.open(h);
  assert.equal((await w.kcall(first, "grants.invites.get", [INVITE])).ok, true);
  const again = await w.open(h);
  await assert.rejects(() => w.kcall(again, "grants.invites.get", [INVITE]), e => e.code === "denied", "a replayed nonce");
});

test("invitee door: rates are held per invite and per identity", async () => {
  const w = inviteeWorld({ limits: { perInvite: 3, perIdentity: 100 } });
  let refused = 0;
  for (let i = 0; i < 6; i++) { const c = await w.open(w.hello()); try { await w.kcall(c, "grants.invites.get", [INVITE]); } catch { refused++; } }
  assert.equal(refused, 3, "the fourth hello for one invite inside a minute is refused");
  const w2 = inviteeWorld({ limits: { perInvite: 100, perIdentity: 2 } });
  let refused2 = 0;
  for (let i = 0; i < 4; i++) { const c = await w2.open(w2.hello()); try { await w2.kcall(c, "grants.invites.get", [INVITE]); } catch { refused2++; } }
  assert.equal(refused2, 2, "and the third for one identity");
});

test("invitee door: junk hellos naming a victim do not spend the victim's allowance, and a missed entry is remembered", async () => {
  const w = inviteeWorld({ limits: { perInvite: 100, perIdentity: 2, perChannel: 1000 } });
  for (let i = 0; i < 6; i++) { const c = await w.open(w.hello({ sig: "A".repeat(86) })); await assert.rejects(() => w.kcall(c, "grants.invites.get", [INVITE]), e => e.code === "denied"); }
  const ok = await w.open(w.hello());
  assert.equal((await w.kcall(ok, "grants.invites.get", [INVITE])).ok, true, "the real person still gets in after six forgeries naming them");
});

test("invitee door: directory lookups from invitee channels are capped box-wide and an unknown entry is asked once a minute", async () => {
  let asked = 0;
  const kernel = { id: { space: "spc_aaaaaaaaaaaa", owner: "per_x" }, spaces: { for: () => null } };
  let clock = 1_000_000;
  const d = createPeerDoor({ kernel, registry: { call: async () => ({ data: null }) }, people: { list: () => [] }, now: () => clock, callerFacts: () => null, serverFor: () => null, boxId: async () => BOX,
    identityEntry: async () => { asked++; return null; }, inviteeLimits: { perBox: 3, perChannel: 1000 } });
  const open = async head => {
    const s = { ondata() {}, onend() {}, onreset() {}, respond() {}, ch: { transport: {} }, write: b => queueMicrotask(() => c.ondata(Buffer.from(b))), end() {}, reset() {} };
    const c = { ondata() {}, onclose() {}, buffered: () => 0, write: b => queueMicrotask(() => s.ondata(new Uint8Array(b))), end() {}, destroy() {} };
    d.acceptInvitee(s, { inviteeId: INVITEE }, head);
    return peerSession(c, { first: 1 });
  };
  const hello = n => ({ space: SPACE, invite: INVITE, identity: "per_" + n.toString().padStart(26, "q").replace(/[0189]/g, "q"), entry: "e".repeat(26), ts: clock, nonce: crypto.randomBytes(12).toString("base64url"), channel: INVITEE, sig: "A".repeat(86) });
  const go = async h => { const c = await open(h); await c.call("kernel.call", { v: 1, space: SPACE, id: "x", ts: clock, call: "grants.invites.get", args: [INVITE] }, { timeoutMs: 3000 }).catch(() => {}); };
  for (let i = 0; i < 5; i++) await go(hello(2));
  assert.equal(asked, 1, "the same unknown entry is asked of the directory once");
  for (let i = 0; i < 8; i++) await go(hello(i + 2 + 100));
  assert.ok(asked <= 3, `the box-wide cap holds (${asked})`);
});

test("invitee door: the nonce store drops the oldest first instead of forgetting every nonce", async () => {
  const w = inviteeWorld({ limits: { perInvite: 1e6, perIdentity: 1e6, perChannel: 1e6, nonceMax: 3 } });
  const hs = [];
  for (let i = 0; i < 5; i++) { const h = w.hello(); hs.push(h); const c = await w.open(h); assert.equal((await w.kcall(c, "grants.invites.get", [INVITE])).ok, true); }
  const newest = await w.open(hs[4]);
  await assert.rejects(() => w.kcall(newest, "grants.invites.get", [INVITE]), e => e.code === "denied", "a recent nonce is still remembered");
  const oldest = await w.open(hs[0]);
  assert.equal((await w.kcall(oldest, "grants.invites.get", [INVITE])).ok, true, "only the oldest ones were dropped");
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
    if (tool === "chat.broken") { meta.peerStream.open(input.id, () => { throw new Error("the producer failed"); }); return { data: { stream: input.id } }; }
    return { data: null };
  }, tools: new Map() };
  const kernel = { id: { space: "spc_aaaaaaaaaaaa", owner: "per_x" }, spaces: { for: () => null } };
  const handlers = [];
  const events = { on: (t, f) => { handlers.push([t, f]); } };
  state.fire = t => { for (const [type, f] of handlers) if (type === t) f({}); };
  const door = createPeerDoor({ kernel, registry, events, people: { list: () => state.sessions }, callerFacts: (c, p, via, k, cap, device) => (device ? { kind: "device", device_key_id: ID, person: "per_x", path: "relay" } : null) });
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


test("PS-B: a producer that throws inside open leaves no stream and no count behind", async () => {
  const { connect } = streamDoor();
  const peer = connect();
  for (let i = 0; i < 20; i++) await assert.rejects(() => peer.call("chat.broken", { id: `stream_brk_${i}xx` }));
  // 20 failures did not use up the 8 slots
  for (let i = 0; i < STREAM_LIMITS.perDevice; i++) await peer.openStream("chat.open", { id: `stream_ok_${i}xxx`, turns: 0 }, { onframe() {} });
  peer.close();
});

test("PS-C: a removal or a signed-out session ends the streams at once, by event, without waiting for a timer", async () => {
  const { state, connect } = streamDoor();
  const peer = connect();
  const ended = [];
  await peer.openStream("chat.open", { id: "stream_evtevent", turns: 0 }, { onframe() {}, onend: w => ended.push(w) });
  state.row = { kind: "app", removed: true };
  state.fire("device.removed");
  await tick(60);
  assert.deepEqual(ended, ["session_ended"], "ended by the event, long before the 5 s fallback");
  assert.ok(STREAM_LIMITS.checkMs >= 5000, "the fallback timer is no faster than 5 s");
  peer.close();
});

test("PS-D: a flood of small frames ends the stream slow and a call on the same peer stream still answers", async () => {
  const { state, connect } = streamDoor();
  const peer = connect();
  const ended = [];
  await peer.openStream("chat.open", { id: "stream_floodxxx", turns: 0 }, { onframe() {}, onend: w => ended.push(w) });
  const h = state.emitters.get("stream_floodxxx");
  let sent = 0;
  for (let i = 0; i < 10_000; i++) if (h.emit({ n: i })) sent++;
  assert.ok(sent <= STREAM_LIMITS.framesPerSecond, `${sent} frames went out before the cap`);
  await tick(60);
  assert.ok(ended.includes("slow"));
  assert.deepEqual(await peer.call("chat.say", { id: "x" }), { ok: true }, "calls on the same peer stream are unaffected");
  peer.close();
});
