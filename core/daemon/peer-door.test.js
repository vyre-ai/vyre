import "../../scripts/mac-test-guard.mjs";
import "../runner/testing/hosted-guard.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createPeerDoor } from "./peer-door.js";

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
