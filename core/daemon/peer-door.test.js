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
    const h = { space: SPACE, invite: INVITE, identity: PERSON, entry: "e".repeat(26), ts: clock, nonce: crypto.randomBytes(12).toString("base64url"), ...over };
    const msg = Buffer.from(`vyre-invitee-hello-v1\n${over.box || BOX}\n${h.space}\n${h.invite}\n${h.identity}\n${h.entry}\n${h.ts}\n${h.nonce}`);
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
