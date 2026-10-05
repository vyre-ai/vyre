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

test("the home door runs spaces.moves.pull as the daemon for an open move, and only that", async () => {
  const m = createHomeMoves({ now: clock });
  m.open({ space: "spc_a", move_id: "mv", expires: t0 + 3_600_000 });
  const seen = [];
  const d = homeDoor(m, (tool, input, caller, meta) => { seen.push({ tool, input, caller, meta }); return { data: { t: "ok", n: 1 } }; });
  assert.deepEqual(await pull(d, head("spc_a"), "spaces.moves.pull", { space: "spc_a", request: { t: "hello" } }), { t: "ok", n: 1 });
  assert.equal(seen[0].caller, "module:vyred");
  assert.equal(seen[0].meta.onBehalfOf, "home:hhhhhhhhhhhhhhhh");
  assert.deepEqual(seen[0].input, { space: "spc_a", request: { t: "hello" } });
  await assert.rejects(() => pull(d, head("spc_a"), "spaces.list", {}), e => e.code === "denied");
  await assert.rejects(() => pull(d, head("spc_a"), "spaces.moves.pull", { space: "spc_other", request: {} }), e => e.code === "bad_input");
  await assert.rejects(() => pull(d, head("spc_a"), "spaces.moves.pull", { space: "spc_a" }), e => e.code === "bad_input");
  assert.equal(seen.length, 1, "nothing else reached the registry");
});

test("a space with no open move is refused, and closing the move revokes the door", async () => {
  const m = createHomeMoves({ now: clock });
  const d = homeDoor(m);
  await assert.rejects(() => pull(d, head("spc_a"), "spaces.moves.pull", { space: "spc_a", request: {} }), e => e.code === "denied");
  m.open({ space: "spc_a", move_id: "mv", expires: t0 + 3_600_000 });
  await pull(d, head("spc_a"), "spaces.moves.pull", { space: "spc_a", request: {} });
  m.close({ move_id: "mv" });
  await assert.rejects(() => pull(d, head("spc_a"), "spaces.moves.pull", { space: "spc_a", request: {} }), e => e.code === "denied");
});

test("an answer over the cap is refused with too_large, and a tool error keeps its code", async () => {
  const m = createHomeMoves({ now: clock });
  m.open({ space: "spc_a", move_id: "mv", expires: t0 + 3_600_000 });
  const d = homeDoor(m, (tool, input) => (input.request.big ? { data: { chunk: "A".repeat(HOME_LIMITS.answerChars) } } : input.request.fail ? { error: { code: "plan_changed", message: "the plan moved" } } : { data: { chunk: "A".repeat(1_048_576) } }));
  await assert.rejects(() => pull(d, head("spc_a"), "spaces.moves.pull", { space: "spc_a", request: { big: true } }), e => e.code === "too_large");
  await assert.rejects(() => pull(d, head("spc_a"), "spaces.moves.pull", { space: "spc_a", request: { fail: true } }), e => e.code === "plan_changed");
  const ok = await pull(d, head("spc_a"), "spaces.moves.pull", { space: "spc_a", request: {} });
  assert.equal(ok.chunk.length, 1_048_576, "a full 1 MiB of base64 text still crosses");
});

test("a door with no moves port admits nothing", async () => {
  const d = homeDoor(null);
  assert.equal(d.homeOpen(), false);
  await assert.rejects(() => pull(d, head("spc_a"), "spaces.moves.pull", { space: "spc_a", request: {} }), e => e.code === "denied");
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
