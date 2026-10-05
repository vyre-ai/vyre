import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHomeMoves, HOME_LIMITS } from "./homemove.js";
import { createPeerDoor } from "../daemon/peer-door.js";
import { createHomeCaller } from "./homecall.js";
import { peerSession } from "./node/peer-wire.js";

let t0 = 1_000_000;
const clock = () => t0;

test("a move is open for its space only until it expires or is closed", () => {
  const m = createHomeMoves({ now: clock });
  assert.equal(m.isOpen("spc_a"), false);
  m.open({ space: "spc_a", move_id: "mv1", expires: t0 + 1000 });
  assert.equal(m.isOpen("spc_a"), true);
  assert.equal(m.isOpen("spc_b"), false);
  t0 += 2000;
  assert.equal(m.isOpen("spc_a"), false, "expired");
  t0 = 1_000_000;
  m.open({ space: "spc_a", move_id: "mv2", expires: t0 + 1000 });
  assert.deepEqual(m.close({ move_id: "mv2" }), { closed: true });
  assert.equal(m.isOpen("spc_a"), false);
  assert.deepEqual(m.close({ move_id: "nope" }), { closed: false });
});

test("open refuses a bad space, a past expiry and one over seven days", () => {
  const m = createHomeMoves({ now: clock });
  assert.throws(() => m.open({ space: "a b", move_id: "m", expires: t0 + 10 }), e => e.code === "bad_input");
  assert.throws(() => m.open({ space: "s", move_id: "m", expires: t0 - 1 }), e => e.code === "bad_input");
  assert.throws(() => m.open({ space: "s", move_id: "m", expires: t0 + HOME_LIMITS.maxOpenMs + 10 }), e => e.code === "bad_input");
});

test("begin: closed space denied, one at a time, and a per-minute cap per move", () => {
  const m = createHomeMoves({ now: clock });
  assert.throws(() => m.begin("spc_a"), e => e.code === "denied");
  m.open({ space: "spc_a", move_id: "mv", expires: t0 + 3_600_000 });
  const end = m.begin("spc_a");
  assert.throws(() => m.begin("spc_a"), e => e.code === "rate_limited");
  end();
  for (let i = 1; i < HOME_LIMITS.perMinute; i++) m.begin("spc_a")();
  assert.throws(() => m.begin("spc_a"), e => e.code === "rate_limited");
  t0 += 61_000;
  m.begin("spc_a")();
});

test("arrive caps the channels of strange homes per minute", () => {
  const m = createHomeMoves({ now: clock });
  for (let i = 0; i < HOME_LIMITS.channelsPerMinute; i++) m.arrive();
  assert.throws(() => m.arrive(), e => e.code === "rate_limited");
  t0 += 61_000;
  m.arrive();
});

// ---- the door ----
function homeDoor(moves, onCall) {
  const registry = { call: async (tool, input, caller, meta) => onCall ? onCall(tool, input, caller, meta) : { data: { ok: true } } };
  return createPeerDoor({ kernel: { id: { space: "spc_aaaaaaaaaaaa", owner: "per_x" }, spaces: { for: () => null } }, registry, people: { list: () => [] }, homeMoves: moves, callerFacts: () => null });
}
async function pull(d, head, tool, input) {
  const s = { ondata() {}, onend() {}, onreset() {}, respond() {}, ch: { transport: {} }, write: b => queueMicrotask(() => c.ondata(Buffer.from(b))), end() {}, reset() {} };
  const c = { ondata() {}, onclose() {}, buffered: () => 0, write: b => queueMicrotask(() => s.ondata(new Uint8Array(b))), end() {}, destroy() {} };
  d.acceptHome(s, { homeId: "hhhhhhhhhhhhhhhh" }, head);
  const client = peerSession(c, { first: 1 });
  try { return await client.call(tool, input, { timeoutMs: 3000 }); } finally { client.close("done"); }
}
const head = space => ({ peer: "wink", space: "home", pull: { space } });
/** One stream, several calls: returns { call, close }. */
function stream(d, hd) {
  const s = { ondata() {}, onend() {}, onreset() {}, respond() {}, ch: { transport: {} }, write: b => queueMicrotask(() => c.ondata(Buffer.from(b))), end() {}, reset() {} };
  const c = { ondata() {}, onclose() {}, buffered: () => 0, write: b => queueMicrotask(() => s.ondata(new Uint8Array(b))), end() {}, destroy() {} };
  d.acceptHome(s, { homeId: "hhhhhhhhhhhhhhhh" }, hd);
  const client = peerSession(c, { first: 1 });
  return { call: (input, tool = "spaces.moves.pull") => client.call(tool, input, { timeoutMs: 3000 }), close: () => client.close("done"), get closed() { return client.closed; } };
}
/** A stream whose hello and auth passed (the stand-in answers { nonce } then { session }). */
async function authed(d, space) {
  const st = stream(d, head(space));
  await st.call({ space, request: { t: "hello" } });
  await st.call({ space, request: { t: "auth", proof: "good" } });
  return st;
}
/** The stand-in pull tool: hello gives a nonce, auth with proof "good" gives a session, everything else answers its own. */
const standIn = extra => (tool, input) => {
  const r = input.request || {};
  if (r.t === "hello") return { data: { nonce: "n1" } };
  if (r.t === "auth") return r.proof === "good" ? { data: { session: "s1" } } : { error: { code: "denied", message: "that proof does not show the target space" } };
  return extra ? extra(tool, input) : { data: { ok: true } };
};

test("the home door runs spaces.moves.pull as the daemon for an open move, and only that", async () => {
  const m = createHomeMoves({ now: clock });
  m.open({ space: "spc_a", move_id: "mv", expires: t0 + 3_600_000 });
  const seen = [];
  const d = homeDoor(m, (tool, input, caller, meta) => { seen.push({ tool, input, caller, meta }); return standIn(() => ({ data: { t: "ok", n: 1 } }))(tool, input); });
  const st = await authed(d, "spc_a");
  assert.deepEqual(await st.call({ space: "spc_a", request: { t: "plan", session: "s1" } }), { t: "ok", n: 1 });
  assert.equal(seen.at(-1).caller, "module:vyred");
  assert.equal(seen.at(-1).meta.onBehalfOf, "home:hhhhhhhhhhhhhhhh");
  assert.deepEqual(seen.at(-1).input, { space: "spc_a", request: { t: "plan", session: "s1" } });
  await assert.rejects(() => st.call({}, "spaces.list"), e => e.code === "denied");
  await assert.rejects(() => st.call({ space: "spc_other", request: {} }), e => e.code === "bad_input");
  await assert.rejects(() => st.call({ space: "spc_a" }), e => e.code === "bad_input");
  assert.equal(seen.length, 3, "hello, auth and the plan reached the registry, nothing else");
  st.close();
});

test("a space with no open move is refused, and closing the move revokes the door", async () => {
  const m = createHomeMoves({ now: clock });
  const d = homeDoor(m, standIn());
  await assert.rejects(() => pull(d, head("spc_a"), "spaces.moves.pull", { space: "spc_a", request: { t: "hello" } }), e => e.code === "denied");
  m.open({ space: "spc_a", move_id: "mv", expires: t0 + 3_600_000 });
  const st = await authed(d, "spc_a");
  await st.call({ space: "spc_a", request: { t: "plan", session: "s1" } });
  m.close({ move_id: "mv" });
  await assert.rejects(() => st.call({ space: "spc_a", request: { t: "plan", session: "s1" } }), e => e.code === "denied");
  await assert.rejects(() => pull(d, head("spc_a"), "spaces.moves.pull", { space: "spc_a", request: { t: "hello" } }), e => e.code === "denied");
});

test("an answer over the cap is refused with too_large, and a tool error keeps its code", async () => {
  const m = createHomeMoves({ now: clock });
  m.open({ space: "spc_a", move_id: "mv", expires: t0 + 3_600_000 });
  const d = homeDoor(m, standIn((tool, input) => (input.request.big ? { data: { chunk: "A".repeat(HOME_LIMITS.answerChars) } } : input.request.fail ? { error: { code: "plan_changed", message: "the plan moved" } } : { data: { chunk: "A".repeat(1_048_576) } })));
  const st = await authed(d, "spc_a");
  await assert.rejects(() => st.call({ space: "spc_a", request: { t: "file", big: true } }), e => e.code === "too_large");
  await assert.rejects(() => st.call({ space: "spc_a", request: { t: "file", fail: true } }), e => e.code === "plan_changed");
  const ok = await st.call({ space: "spc_a", request: { t: "file" } });
  assert.equal(ok.chunk.length, 1_048_576, "a full 1 MiB of base64 text still crosses");
  st.close();
});

// ---- before auth: a stranger holding homeMove:true ----
test("pre-auth: only hello and auth cross, and every other request is refused and ends the stream", async () => {
  const m = createHomeMoves({ now: clock });
  m.open({ space: "spc_a", move_id: "mv", expires: t0 + 3_600_000 });
  const seen = [];
  const d = homeDoor(m, (tool, input) => { seen.push(input.request); return standIn()(tool, input); });
  for (const req of [{ t: "plan", session: "x" }, { t: "records", ids: [] }, { t: "file" }, { t: "sealed" }, { t: "done" }, {}]) {
    const st = stream(d, head("spc_a"));
    await assert.rejects(() => st.call({ space: "spc_a", request: req }), e => e.code === "denied", JSON.stringify(req));
    await new Promise(r => setTimeout(r, 300));
    assert.equal(st.closed, true, "the stream ended");
  }
  assert.deepEqual(seen, [], "nothing reached the pull tool");
});

test("pre-auth: one failed auth closes the stream, and at most three requests are taken", async () => {
  const m = createHomeMoves({ now: clock });
  m.open({ space: "spc_a", move_id: "mv", expires: t0 + 3_600_000 });
  const d = homeDoor(m, standIn());
  const st = stream(d, head("spc_a"));
  await st.call({ space: "spc_a", request: { t: "hello" } });
  await assert.rejects(() => st.call({ space: "spc_a", request: { t: "auth", proof: "forged" } }), e => e.code === "denied");
  await new Promise(r => setTimeout(r, 300));
  assert.equal(st.closed, true, "a failed auth ends the stream");
  const s3 = stream(d, head("spc_a"));
  for (let i = 0; i < HOME_LIMITS.preRequests; i++) await s3.call({ space: "spc_a", request: { t: "hello" } });
  await assert.rejects(() => s3.call({ space: "spc_a", request: { t: "hello" } }), e => e.code === "denied", "the fourth request before auth is refused");
  s3.close();
});

test("pre-auth: a stranger consumes none of the move's budget, and the real target still pulls at full rate", async () => {
  const m = createHomeMoves({ now: clock });
  m.open({ space: "spc_a", move_id: "mv", expires: t0 + 3_600_000 });
  const d = homeDoor(m, standIn());
  // strangers: many attempts, none of them proves anything
  for (let i = 0; i < 20; i++) {
    const st = stream(d, head("spc_a"));
    try { await st.call({ space: "spc_a", request: { t: "plan", session: "x" } }); } catch { /* refused */ }
    st.close();
  }
  const held = [];
  for (let i = 0; i < HOME_LIMITS.preStreams; i++) held.push(stream(d, head("spc_a")));   // streams sitting before auth
  const real = await authed(d, "spc_a");
  for (let i = 0; i < HOME_LIMITS.perMinute - 2; i++) await real.call({ space: "spc_a", request: { t: "plan", session: "s1" } });
  await real.call({ space: "spc_a", request: { t: "plan", session: "s1" } }).catch(() => assert.fail("the real target was refused inside its own budget"));
  for (const h of held) h.close();
  real.close();
});

test("pre-auth: streams that have not proven themselves are capped box-wide, and auth frees the slot", async () => {
  const m = createHomeMoves({ now: clock });
  const rel = [];
  for (let i = 0; i < HOME_LIMITS.preStreams; i++) rel.push(m.preEnter());
  assert.throws(() => m.preEnter(), e => e.code === "rate_limited");
  rel[0](); rel[0]();   // a double release frees one slot only
  const again = m.preEnter();
  assert.equal(m.preOpenCount(), HOME_LIMITS.preStreams);
  again(); rel[1](); rel[2]();
  assert.equal(m.preOpenCount(), 0);
});

test("pre-auth: a stream that never proves itself is closed after the pre-auth window", async () => {
  const m = createHomeMoves({ now: clock });
  m.open({ space: "spc_a", move_id: "mv", expires: t0 + 3_600_000 });
  const d = homeDoor(m, standIn());
  const st = stream(d, head("spc_a"));
  await new Promise(r => setTimeout(r, HOME_LIMITS.preMs + 500));
  assert.equal(st.closed, true);
});

test("a door with no moves port admits nothing", async () => {
  const d = homeDoor(null);
  assert.equal(d.homeOpen(), false);
  await assert.rejects(() => pull(d, head("spc_a"), "spaces.moves.pull", { space: "spc_a", request: { t: "hello" } }), e => e.code === "denied");
});

// ---- the caller ----
test("wink.home.call's caller refuses any other tool and a malformed pull before it dials", async () => {
  let dialed = 0;
  const c = createHomeCaller({ relayConnect: () => { dialed++; throw new Error("no dial"); } });
  const q = { relay: "wss://relay.example", route: "abcdefghijkl", box: "x" };
  await assert.rejects(() => c.call({ ...q, tool: "spaces.list", input: { space: "s", request: {} } }), e => e.code === "denied");
  await assert.rejects(() => c.call({ ...q, tool: "spaces.moves.pull", input: { space: "s" } }), e => e.code === "bad_input");
  await assert.rejects(() => c.call({ ...q, relay: "", tool: "spaces.moves.pull", input: { space: "s", request: {} } }), e => e.code === "bad_input");
  assert.equal(dialed, 0);
});
