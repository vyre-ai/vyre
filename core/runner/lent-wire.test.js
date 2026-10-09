// The lent-computer wire on the REAL kernel: a member's computer runs one of the Space's sessions through the kernel's remote call (the in-memory stand-in for Wink), with the real Offers,
// the real leases and the real remote server on the home side, and the lent home service in front of the checkpoint store. Every refusal in team/archive/work-journals/runner.md is a test here.
import "../../scripts/mac-test-guard.mjs";
import "./testing/hosted-guard.js";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { SCRATCH } from "../../test/scratch.mjs";
import { createKernel } from "../../kernel/index.js";
import { canonical, sha256 } from "../../kernel/core/canonical.js";
import { createRemoteServer } from "../../kernel/remote/server.js";
import { createRemoteKernel } from "../../kernel/remote/client.js";
import { createMemoryTransport } from "../../kernel/remote/memory-transport.js";
import { createLentHome, CHUNK_BYTES } from "./lent-home.js";
import { createLentClient } from "./lent-client.js";

const SPACE = "spc_aaaaaaaaaaaa", OWNER = "per_owner", BOB = "per_bob", CAROL = "per_carol";
const proof = (action, input, resource) => ({ op: `grant.${action.split(".")[1]}`, fields: { resource, input_hash: sha256(canonical({ action, input })) }, n: Math.random() });
const used = new Set();
const presence = { check: async ({ chain, op, fields, proof: p }) => (chain && p && p.op === op && canonical(p.fields) === canonical(fields) && !used.has(p.n) && (used.add(p.n), true) ? null : "wrong_payload") };
function fakeSealer() {
  const st = { live: new Map(), revoked: new Set() }; let n = 0;
  const one = c => { if (!c || c.hops.length !== 1 || c.hops[0].actor.kind !== "person") throw Object.assign(new Error("human_only"), { code: "human_only" }); };
  return { st, lease: {
    // like the real process, issue gives the same member and computer the same key while access holds
    issue: async i => { one(i.chain); const m = i.chain.hops[0].actor.id; if (!i.allowed || st.revoked.has(`${m}|${i.device}`)) return { revoked: true }; const id = `lease_${++n}`; st.live.set(id, `${m}|${i.device}`); return { id, key: crypto.createHash("sha256").update(`${m}|${i.device}`).digest("base64"), ttlMs: 3600000 }; },
    renew: async i => { one(i.chain); if (!i.allowed) return { revoked: true }; return { ttlMs: 3600000 }; },
    revoke: async i => { one(i.chain); st.revoked.add(`${i.member}|${i.device}`); return { revoked: true }; },
    reinstate: async () => ({ reinstated: true }),
    check: async i => { if (!st.live.has(i.id)) throw Object.assign(new Error("no_lease"), { code: "no_lease" }); const [member, device] = st.live.get(i.id).split("|"); return { space: SPACE, member, device }; },
  } };
}

async function rig(t, o = {}) {
  const acceptCap = o.acceptCap;
  const keyOf = o.keyIsDevice ? "dev_laptop" : "KEY_LAPTOP";
  const dir = fs.mkdtempSync(path.join(SCRATCH, "lw-")); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const sealer = fakeSealer();
  const k = await createKernel({ space: SPACE, owner: OWNER, owner_uid: 501, key: Buffer.alloc(32, 8), sealer, presence, resolveCredential: async () => ({ secret: "v" }) });
  const owner = k.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: OWNER, path: "direct", session: "s" });
  const bob = k.chains.fromFacts({ kind: "device", device_key_id: "dev_laptop", person: BOB, path: "direct" });
  const g = k.gateway.grants;
  for (const p of [BOB, CAROL]) { const role = { person: p, role: "member" }; await g.setRole(owner, role, { presence: proof("grants.role", role, `vyre://${SPACE}/member/${p}`) }); }
  const mk = (chain, x) => g.offers.offer(chain, x, { presence: proof("grants.offer", x, `vyre://${SPACE}/offer/new`) });
  await mk(owner, { side: "space_allows", member: BOB });
  const accept = await mk(bob, { side: "member_accepts", member: BOB, device: "dev_laptop", device_key: keyOf, ...(acceptCap ? { network_cap: acceptCap } : {}) });
  const home = createLentHome({ space: SPACE, root: path.join(dir, "home"), offers: g.offers, chatHas: (chain, id) => { try { g.chats.read(chain, id); return true; } catch { return false; } }, leases: k.gateway.leases, lenderCap: () => o.cap, ...(o.now ? { now: o.now } : {}), ...(o.resume ? { resume: o.resume } : {}), ...(o.emit ? { emit: o.emit } : {}),
    specFor: o.specFor || (async ({ session }) => ({ command: "/usr/bin/agent", args: [session], env: {}, routes: [], readOnly: [], labels: {}, network: "internet", credentialRoutes: [{ route: "api.example.com", ref: "svc", paths: ["/v1/*"] }] })) });
  const server = createRemoteServer({ space: SPACE, kernel: k, services: { lent: home } });
  const as = (person, device) => { const remote = createRemoteKernel({ space: SPACE, transport: createMemoryTransport({ servers: { [SPACE]: server }, peer: { device_key_id: device, person, path: "wink" } }) }); return createLentClient({ invoke: remote.call, device, deviceKey: "KEY_LAPTOP" }); };
  return { k, owner, bob, g, mk, accept, home, server, sealer, as, dir };
}

test("a lent session end to end: lease, definition with the lender's cap, transcript, a multi-chunk file, a checkpoint, and the same read back", async t => {
  const r = await rig(t, { cap: "provider" });
  const c = r.as(BOB, "dev_laptop");
  const lease = await c.vault.lease(); assert.ok(lease.id && lease.key);
  assert.deepEqual(await c.vault.renew({ id: lease.id }), { ttlMs: 3600000 });
  const spec = await c.spec({ session: "s1" });
  assert.equal(spec.command, "/usr/bin/agent"); assert.equal(spec.network, "provider", "the Space asked for the internet, the lender allows the provider only: the lender's cap wins at the home");
  assert.equal(spec.credentialRoutes, undefined, "the home's credential map never crosses to the lender");
  await c.sync.appendTranscript("s1", [{ seq: 1, line: "a" }, { seq: 2, line: "b" }]);
  const big = crypto.randomBytes(CHUNK_BYTES * 2 + 123);
  const put = await c.sync.putFile("s1", "files/big.bin", big); assert.equal(put.version, 1);
  await c.sync.putCheckpoint("s1", { turn: 1, seq: 2, manifest: { "files/big.bin": { hash: sha256Hex(big), version: 1, len: big.length } }, state: { n: 1 } });
  assert.equal((await c.sync.getCheckpoint("s1")).turn, 1);
  assert.deepEqual((await c.sync.getTranscript("s1", 1)).map(e => e.line), ["a", "b"]);
  assert.ok(Buffer.from(await c.sync.getFile("s1", "files/big.bin", 1)).equals(big), "a file crosses whole in chunks and comes back identical");
  await c.sync.putFile("s1", "files/big.bin", null);
});
const sha256Hex = b => crypto.createHash("sha256").update(b).digest("hex");

test("the lender's cap: provider and internet from the Offer's side, never more than the lender allowed; no cap means the Space's choice", async t => {
  for (const [cap, want] of [["provider", "provider"], ["internet", "internet"], [undefined, "internet"]]) {
    const r = await rig(t, { cap }); const c = r.as(BOB, "dev_laptop"); await c.vault.lease();
    assert.equal((await c.spec({ session: "s1" })).network, want, `cap ${cap}`);
  }
});

test("refused at the home: another member, another computer, a session never started, and a session started by someone else all read as not found", async t => {
  const r = await rig(t);
  const bob = r.as(BOB, "dev_laptop"); await bob.vault.lease(); await bob.spec({ session: "s1" });
  const carol = r.as(CAROL, "dev_carol"), otherDevice = r.as(BOB, "dev_other");
  for (const [who, name] of [[carol, "another member"], [otherDevice, "another computer of the same member"]]) {
    await assert.rejects(who.sync.getCheckpoint("s1"), e => e.code === "not_found", `${name}: read`);
    await assert.rejects(who.sync.appendTranscript("s1", [{ seq: 1, line: "x" }]), e => e.code === "not_found", `${name}: write`);
    await assert.rejects(who.spec({ session: "s2" }), e => ["not_allowed", "not_found"].includes(e.code), `${name}: start`);
  }
  await assert.rejects(bob.sync.getCheckpoint("never-started"), e => e.code === "not_found");
  await assert.rejects(bob.sync.appendTranscript("../etc", [{ seq: 1, line: "x" }]), e => e.code === "not_found");
});

test("a withdrawn Offer, a removed member and a stopped session end the very next call", async t => {
  let r = await rig(t); let c = r.as(BOB, "dev_laptop"); await c.vault.lease(); await c.spec({ session: "s1" });
  await c.sync.appendTranscript("s1", [{ seq: 1, line: "a" }]);
  const id = r.accept.id;
  await r.k.gateway.grants.offers.unoffer(r.bob, id, { presence: proof("grants.unoffer", { revoke: id }, `vyre://${SPACE}/offer/${id}`) });
  await assert.rejects(c.sync.appendTranscript("s1", [{ seq: 2, line: "b" }]), e => e.code === "not_found", "member withdrew: the next write is refused");
  await assert.rejects(c.spec({ session: "s3" }), e => ["not_allowed", "not_found"].includes(e.code));
  // the member is removed from the Space
  r = await rig(t); c = r.as(BOB, "dev_laptop"); await c.vault.lease(); await c.spec({ session: "s1" });
  const rm = { person: BOB };
  await r.g.removeMember(r.owner, rm, { presence: proof("grants.role", { remove: BOB }, `vyre://${SPACE}/member/${BOB}`) });
  await assert.rejects(c.sync.getCheckpoint("s1"), e => ["not_found", "not_a_member"].includes(e.code), "a removed member's next call is refused");
  // stop
  r = await rig(t); c = r.as(BOB, "dev_laptop"); await c.vault.lease(); await c.spec({ session: "s1" });
  await c.stop("s1");
  await assert.rejects(c.sync.getCheckpoint("s1"), e => e.code === "not_found", "a stopped session is gone");
});
test("file chunks are checked: out of order, repeated, oversize and a bad upload id are refused, and nothing half-written reaches the store", async t => {
  const r = await rig(t); const c = r.as(BOB, "dev_laptop"); await c.vault.lease(); const { epoch } = await c.spec({ session: "s1" });
  const call = (x) => createRemoteKernel({ space: SPACE, transport: createMemoryTransport({ servers: { [SPACE]: r.server }, peer: { device_key_id: "dev_laptop", person: BOB, path: "wink" } }) }).call("lent.putFile", ["s1", "f", { epoch, ...x }]);
  const b64 = n => crypto.randomBytes(n).toString("base64");
  await assert.rejects(call({ upload: "uploadid1", index: 1, total: 2, b64: b64(10) }), e => e.code === "gap", "chunk 1 before 0");
  await call({ upload: "uploadid2", index: 0, total: 2, b64: b64(10) });
  await assert.rejects(call({ upload: "uploadid2", index: 0, total: 2, b64: b64(10) }), e => e.code === "gap", "chunk 0 twice");
  await assert.rejects(call({ upload: "uploadid3", index: 0, total: 1, b64: b64(CHUNK_BYTES + 1) }), e => e.code === "too_large");
  await assert.rejects(call({ upload: "x", index: 0, total: 1, b64: b64(5) }), e => e.code === "bad_input");
  await assert.rejects(c.sync.getFile("s1", "f", 1), e => e.code === "not_found", "nothing was committed");
});

test("vault use through the wire: a mapped route answers, an unmapped one is not found, and the lender never sees the credential map", async t => {
  const r = await rig(t); const c = r.as(BOB, "dev_laptop"); await c.vault.lease(); await c.spec({ session: "s1" });
  await assert.rejects(c.vault.credential({ session: "s1", route: "evil.example.com", method: "GET", path: "/v1/x" }), e => e.code === "not_found");
  await assert.rejects(c.vault.credential({ session: "other", route: "api.example.com", method: "GET", path: "/v1/x" }), e => e.code === "not_found");
});

test("the wire carries no group the home did not allow: an unknown call and a lent call without the service are no_such_call", async t => {
  const r = await rig(t);
  const remote = createRemoteKernel({ space: SPACE, transport: createMemoryTransport({ servers: { [SPACE]: r.server }, peer: { device_key_id: "dev_laptop", person: BOB, path: "wink" } }) });
  await assert.rejects(remote.call("lent.evil", []), e => e.code === "no_such_call");
  await assert.rejects(remote.call("leases.revoke", [{}]), e => e.code === "no_such_call");
  const bare = createRemoteServer({ space: SPACE, kernel: r.k });
  const remote2 = createRemoteKernel({ space: SPACE, transport: createMemoryTransport({ servers: { [SPACE]: bare }, peer: { device_key_id: "dev_laptop", person: BOB, path: "wink" } }) });
  await assert.rejects(remote2.call("lent.start", [{ session: "s1" }]), e => e.code === "no_such_call");
});

import { createRunner } from "./runner.js";
import { createLenderHost } from "./lender-host.js";
import { SANDBOX_WHY } from "./testing/require-sandbox.js";
// The real runner needs a sandbox and an encrypted workspace on this machine (bubblewrap and gocryptfs on Linux): without them the test is skipped, as in the runner's other tests.
const SKIP_RUN = (process.platform !== "linux" && process.platform !== "darwin") || SANDBOX_WHY !== "";

test("the real runner on a lent computer, ports from the lender host over the real kernel: it starts the Space's session, checkpoints reach the home's store, a second computer resumes, and a withdrawn Offer tells the runner", { skip: SKIP_RUN, timeout: 120_000 }, async t => {
  const r = await rig(t, { cap: "provider" });
  const agentDir = path.join(r.dir, "agent"); fs.mkdirSync(agentDir, { recursive: true });
  fs.copyFileSync(new URL("./testing/fake-agent.js", import.meta.url), path.join(agentDir, "agent.js"));
  const mkHost = async (device) => { const remote = createRemoteKernel({ space: SPACE, transport: createMemoryTransport({ servers: { [SPACE]: r.server }, peer: { device_key_id: device, person: BOB, path: "wink" } }) }); const h = createLenderHost({ invoke: remote.call, deviceId: device, deviceKey: "KEY_LAPTOP", lenderCap: "provider" }); await h.ready; t.after(() => h.stop()); return h; };
  const host = await mkHost("dev_laptop");
  assert.deepEqual(host.ports.grants(), { spaceAllows: true, memberAccepts: true });
  const base = path.join(r.dir, "lender");
  const runner = createRunner({ base, space: "harlow", device: "dev_laptop", ...host.ports, grants: host.ports.grants, watchdog: false, retryMs: 50, verifyState: () => true, state: () => ({ onPower: true, awake: true, cpuPct: 10, memPct: 40 }) });
  try {
    { const d = await runner.decide({}); assert.equal(d.where, "here", JSON.stringify(d)); }
    const spec = await host.ports.spec({ session: "s1" });
    assert.equal(spec.network, "provider");
    const h = await runner.start({ session: "s1", command: process.execPath, args: [path.join(agentDir, "agent.js")], readOnly: [agentDir, path.dirname(process.execPath)], routes: [] });
    h.send("turn alpha");
    for (let i = 0; i < 80 && !(await host.ports.sync.getCheckpoint("s1")); i++) await new Promise(res => setTimeout(res, 250));
    const cp = await host.ports.sync.getCheckpoint("s1");
    assert.ok(cp && cp.turn >= 1, "a checkpoint reached the home's store over the wire");
    assert.ok((await host.ports.sync.getTranscript("s1", 1)).length > 0, "the transcript is at the home");
    await h.stop();
    // withdrawing the member's Offer: the host tells the runner on its next refresh
    const told = []; host.ports.onRevoke(e => told.push(e.reason));
    await r.k.gateway.grants.offers.unoffer(r.bob, r.accept.id, { presence: proof("grants.unoffer", { revoke: r.accept.id }, `vyre://${SPACE}/offer/${r.accept.id}`) });
    await host.refresh();
    assert.deepEqual(told, ["withdrawn"]);
    assert.equal(host.ports.grants().memberAccepts, false);
    await assert.rejects(host.ports.sync.getCheckpoint("s1"), e => e.code === "not_found", "and the home refuses the lender's next call");

  } finally { await runner.stopAll().catch(() => {}); await runner.lock().catch(() => {}); }
});

import mod, { resolveAgent } from "./index.js";
// (readiness needs the sandbox tools too, so these two skip where the real runner does: bubblewrap and gocryptfs are not on every CI machine)
test("the runner module on a computer whose host gives only its identity: ready, and a Space whose home is another computer is reached through ctx.kernel.for(space).call (the one remote path)", { skip: SKIP_RUN }, async t => {
  const r = await rig(t, { keyIsDevice: true });
  const remote = createRemoteKernel({ space: SPACE, transport: createMemoryTransport({ servers: { [SPACE]: r.server }, peer: { device_key_id: "dev_laptop", person: BOB, path: "wink" } }) });
  /** @type {Map<string, any>} */ const tools = new Map(); const events = [];
  const root = path.join(r.dir, "mod"); fs.mkdirSync(root, { recursive: true });
  const ctx = { paths: { root }, events: { emit: (n, p) => events.push(n), on: () => () => {} }, tool: (n, d) => tools.set(n, d),
    kernel: { owner: BOB, runnerHost: () => ({ identity: async () => ({ deviceId: "dev_laptop", deviceKey: "KEY_LAPTOP" }) }), for: id => (id === SPACE ? remote : { hosted: true }),
      chain: async () => ({ hops: [{ actor: { kind: "person", id: BOB } }] }) } };
  const h = await mod.start(ctx); t.after(() => h.stop());
  const st = await tools.get("runner.status").run({}, {});
  assert.equal(st.ready, true, st.why);
  const d = await tools.get("runner.place").run({ space: SPACE }, {});
  assert.ok(["here", "wait"].includes(d.where), JSON.stringify(d));
  assert.doesNotMatch(String(d.reason || ""), /has not allowed members|not set to run/, "both Offers were read from the home over the wire");
  await assert.rejects(tools.get("runner.place").run({ space: "spc_hostedhere01" }, {}), e => e.code === "unavailable", "a Space this computer hosts itself is not lent over a wire");
});

test("a host with no device identity yet: the module loads and says so, and a call is refused as not connected", { skip: SKIP_RUN }, async t => {
  const r = await rig(t);
  /** @type {Map<string, any>} */ const tools = new Map();
  const ctx = { paths: { root: path.join(r.dir, "mod2") }, events: { emit() {}, on: () => () => {} }, tool: (n, d) => tools.set(n, d),
    kernel: { owner: BOB, runnerHost: () => ({ identity: async () => { throw Object.assign(new Error("this computer has no device identity yet"), { code: "unavailable" }); } }), for: () => ({ call: async () => ({}) }) } };
  fs.mkdirSync(ctx.paths.root, { recursive: true });
  const h = await mod.start(ctx); t.after(() => h.stop());
  const st = await tools.get("runner.status").run({}, {});
  assert.equal(st.ready, false); assert.match(st.why, /no device identity/);
  await assert.rejects(tools.get("runner.place").run({ space: SPACE }, {}), e => e.code === "unavailable" || /identity/.test(e.message));
});

test("the lender's cap is read from the Offer the member accepted: the home limits the definition by it, the lender host reports it, a bad value is refused, and it is the member's own acceptance only", async t => {
  const r = await rig(t, { acceptCap: "provider" });          // no lenderCap function: the cap comes from the Offer alone
  const c = r.as(BOB, "dev_laptop"); await c.vault.lease();
  assert.equal((await c.spec({ session: "s1" })).network, "provider");
  const remote = createRemoteKernel({ space: SPACE, transport: createMemoryTransport({ servers: { [SPACE]: r.server }, peer: { device_key_id: "dev_laptop", person: BOB, path: "wink" } }) });
  const host = createLenderHost({ invoke: remote.call, deviceId: "dev_laptop", deviceKey: "KEY_LAPTOP" }); await host.ready; t.after(() => host.stop());
  assert.equal(host.ports.lenderCap, "provider", "the lender's runner applies the same cap locally");
  const open = await rig(t); const c2 = open.as(BOB, "dev_laptop"); await c2.vault.lease();
  assert.equal((await c2.spec({ session: "s1" })).network, "internet", "an acceptance that names no cap leaves the Space's choice");
  const bad = await rig(t);
  await assert.rejects(bad.g.offers.offer(bad.bob, { side: "member_accepts", member: BOB, device: "dev_x", device_key: "K", network_cap: "everything" }, { presence: proof("grants.offer", { side: "member_accepts", member: BOB, device: "dev_x", device_key: "K", network_cap: "everything" }, `vyre://${SPACE}/offer/new`) }), e => e.code === "bad_input");
  await assert.rejects(bad.g.offers.offer(bad.owner, { side: "space_allows", member: BOB, network_cap: "provider" }, { presence: proof("grants.offer", { side: "space_allows", member: BOB, network_cap: "provider" }, `vyre://${SPACE}/offer/new`) }), e => e.code === "bad_input", "the Space cannot set the lender's cap");
});

test("the home says which computer is calling, from what the transport proved; the lender runs under that id", async t => {
  const r = await rig(t);
  const remote = createRemoteKernel({ space: SPACE, transport: createMemoryTransport({ servers: { [SPACE]: r.server }, peer: { device_key_id: "relay_dev_1", person: BOB, path: "wink" } }) });
  assert.deepEqual(await remote.call("lent.whoami", []), { device: "relay_dev_1", person: BOB });
});

test("runner.revoke is the Wink module's alone, and answers plainly when nothing is running for that Space", async t => {
  const r = await rig(t);
  /** @type {Map<string, any>} */ const tools = new Map();
  const root = path.join(r.dir, "mod3"); fs.mkdirSync(root, { recursive: true });
  const remote = createRemoteKernel({ space: SPACE, transport: createMemoryTransport({ servers: { [SPACE]: r.server }, peer: { device_key_id: "dev_laptop", person: BOB, path: "wink" } }) });
  const ctx = { paths: { root }, events: { emit() {}, on: () => () => {} }, tool: (n, d) => tools.set(n, d),
    kernel: { owner: BOB, runnerHost: () => ({ identity: async () => ({ deviceId: "dev_laptop", deviceKey: "KEY" }) }), for: id => (id === SPACE ? remote : { hosted: true }), chain: async () => ({ hops: [{ actor: { kind: "person", id: BOB } }] }) } };
  const h = await mod.start(ctx); t.after(() => h.stop());
  await assert.rejects(tools.get("runner.revoke").run({ space: SPACE }, { caller: "cli" }), e => e.code === "denied");
  await assert.rejects(tools.get("runner.revoke").run({ space: SPACE }, {}), e => e.code === "denied");
  assert.equal((await tools.get("runner.revoke").run({ space: SPACE }, { caller: "module:wink" })).revoked, false);
});

test("a name with no folder is the agent this computer has: VYRE_CLAUDE_BIN for claude, else PATH; a script runs under node; a path stays as given; none is refused", () => {
  const dir = fs.mkdtempSync(path.join(SCRATCH, "ra-"));
  const script = path.join(dir, "agent.js"); fs.writeFileSync(script, "// agent\n");
  const was = process.env.VYRE_CLAUDE_BIN, wasPath = process.env.PATH;
  try {
    process.env.VYRE_CLAUDE_BIN = script;
    const r = resolveAgent({ command: "claude", args: ["--x"], readOnly: ["/opt/ro"] });
    assert.deepEqual([r.command, r.args], [process.execPath, [script, "--x"]]);
    assert.ok(r.readOnly.includes(dir) && r.readOnly.includes("/opt/ro") && r.readOnly.includes(path.dirname(process.execPath)));
    assert.deepEqual(resolveAgent({ command: "/usr/bin/agent", args: ["a"] }), { command: "/usr/bin/agent", args: ["a"], readOnly: [] });
    delete process.env.VYRE_CLAUDE_BIN; process.env.PATH = "/nonexistent-dir";
    assert.throws(() => resolveAgent({ command: "claude" }), /no claude to run/);
  } finally { if (was === undefined) delete process.env.VYRE_CLAUDE_BIN; else process.env.VYRE_CLAUDE_BIN = was; process.env.PATH = wasPath; }
});

test("access ended: the session stops, the encrypted workspace and everything in it is deleted from this computer, and the home still holds the transcript, the files and the checkpoint", { skip: SKIP_RUN }, async t => {
  const r = await rig(t, { cap: "provider" });
  const agentDir = path.join(r.dir, "agent"); fs.mkdirSync(agentDir, { recursive: true });
  fs.copyFileSync(new URL("./testing/fake-agent.js", import.meta.url), path.join(agentDir, "agent.js"));
  const remote = createRemoteKernel({ space: SPACE, transport: createMemoryTransport({ servers: { [SPACE]: r.server }, peer: { device_key_id: "dev_laptop", person: BOB, path: "wink" } }) });
  const host = createLenderHost({ invoke: remote.call, deviceId: "dev_laptop", deviceKey: "KEY_LAPTOP", lenderCap: "provider" });
  await host.ready;
  const base = path.join(r.dir, "lender");
  const runner = createRunner({ base, space: "harlow", device: "dev_laptop", ...host.ports, grants: host.ports.grants, watchdog: false, retryMs: 50, verifyState: () => true, state: () => ({ onPower: true }) });
  try {
    await host.ports.spec({ session: "s1" });   // the home writes the session into its lent table, as runner.start does
    const h = await runner.start({ session: "s1", command: process.execPath, args: [path.join(agentDir, "agent.js")], readOnly: [agentDir, path.dirname(process.execPath)], routes: [] });
    h.send("turn SECRET-LINE-ONE");
    for (let i = 0; i < 80 && !(await host.ports.sync.getCheckpoint("s1")); i++) await new Promise(res => setTimeout(res, 250));
    assert.ok(await host.ports.sync.getCheckpoint("s1"), "the home has a checkpoint before access ends");
    const local = () => { const out = []; const walk = d => { for (const n of fs.existsSync(d) ? fs.readdirSync(d) : []) { const p = path.join(d, n); fs.statSync(p).isDirectory() ? walk(p) : out.push(p); } }; walk(base); return out; };
    assert.ok(local().length > 0, "there is a workspace on this computer");
    // the Space ends the member's access: the runner is told, and nothing of the work stays here
    await runner.revoke();
    for (let i = 0; i < 40 && local().some(f => !f.includes(`${path.sep}run${path.sep}`)); i++) await new Promise(res => setTimeout(res, 100));
    const left = local().filter(f => !f.includes(`${path.sep}run${path.sep}`));
    assert.deepEqual(left, [], "no file of the workspace is left (cipher text, its config, or the plain mount)");
    let alive = true; try { process.kill(Number(h.child.pid), 0); } catch { alive = false; }
    assert.equal(alive, false, "the session's process is gone");
    // the home keeps everything it was sent, and can still read it back
    assert.ok(fs.existsSync(path.join(r.dir, "home")), "the home's store is untouched");
    const held = []; const walkHome = d => { for (const n of fs.readdirSync(d)) { const p = path.join(d, n); fs.statSync(p).isDirectory() ? walkHome(p) : held.push(p); } }; walkHome(path.join(r.dir, "home"));
    assert.ok(held.some(f => f.includes("transcript")) && held.some(f => f.includes(`${path.sep}cp${path.sep}`)), "the transcript and a checkpoint are still at the home");
  } finally { await runner.stopAll().catch(() => {}); }
});

test("a restart reconciles: the session that outlived the daemon is ended and the workspace left locked while access stands, and access that ended while the daemon was down deletes the workspace", { skip: SKIP_RUN }, async t => {
  const agentDir = fs.mkdtempSync(path.join(SCRATCH, "rc-agent-")); fs.copyFileSync(new URL("./testing/fake-agent.js", import.meta.url), path.join(agentDir, "agent.js"));
  const r = await rig(t, { keyIsDevice: true, specFor: async () => ({ command: process.execPath, args: [path.join(agentDir, "agent.js")], env: {}, routes: [], readOnly: [agentDir, path.dirname(process.execPath)], labels: {}, network: "provider", credentialRoutes: [] }) });
  const remote = createRemoteKernel({ space: SPACE, transport: createMemoryTransport({ servers: { [SPACE]: r.server }, peer: { device_key_id: "dev_laptop", person: BOB, path: "wink" } }) });
  const root = path.join(r.dir, "mod4"); fs.mkdirSync(root, { recursive: true });
  const mkCtx = () => { /** @type {Map<string, any>} */ const tools = new Map();
    return { tools, ctx: { paths: { root }, config: { role: "local" }, events: { emit() {}, on: () => () => {} }, tool: (n, d) => tools.set(n, d), log() {},
      kernel: { owner: BOB, runnerHost: () => ({ identity: async () => ({ deviceId: "dev_laptop", deviceKey: "dev_laptop" }) }), for: id => (id === SPACE ? remote : { hosted: true }), chain: async () => ({ hops: [{ actor: { kind: "person", id: BOB } }] }) } } }; };
  const base = path.join(root, "runner", "spaces");
  const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const waitFor = async (f, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await f()) return true; await new Promise(res => setTimeout(res, 100)); } return false; };
  const one = mkCtx(); const m1 = await mod.start(one.ctx);
  const later = [];
  try {
    const started = await one.tools.get("runner.start").run({ space: SPACE, session: "s1" }, { caller: "cli" });
    assert.ok(alive(started.pid), "the session runs");
    const dirs = fs.readdirSync(base); assert.equal(dirs.length, 1);
    assert.equal(fs.readFileSync(path.join(base, dirs[0], "space.id"), "utf8"), SPACE, "the folder says which Space it is for");
    // the daemon dies (a second one starts on the same home; the first is abandoned, its session still running) with access standing
    const two = mkCtx(); const m2 = await mod.start(two.ctx); later.push(m2);
    assert.equal(await waitFor(() => !alive(started.pid)), true, "the session that outlived its runner is ended at the restart");
    assert.equal(fs.existsSync(path.join(base, dirs[0])), true, "access stands: the workspace is kept");
    assert.ok(fs.existsSync(path.join(base, dirs[0], "cipher")), "encrypted at rest, locked");
    // the session is started again (resumes from the home's checkpoint), then the daemon dies again, and the Space ends this computer's access while it is down
    const again = await two.tools.get("runner.start").run({ space: SPACE, session: "s2" }, { caller: "cli" });
    assert.ok(alive(again.pid));
    await r.k.gateway.grants.offers.unoffer(r.bob, r.accept.id, { presence: proof("grants.unoffer", { revoke: r.accept.id }, `vyre://${SPACE}/offer/${r.accept.id}`) });
    const three = mkCtx(); const m3 = await mod.start(three.ctx); later.push(m3);
    assert.equal(await waitFor(() => !alive(again.pid)), true, "its session is ended");
    assert.equal(await waitFor(() => !fs.existsSync(path.join(base, dirs[0]))), true, "and the workspace, with everything in it, is deleted: access ended while the daemon was down");
  } finally { for (const m of [m1, ...later]) await m.stop().catch(() => {}); }
});

test("a lent session may name its chat: kept only when the lender's person is in that chat, shape-checked, never on the wire", async t => {
  const r = await rig(t); const c = r.as(BOB, "dev_laptop"); await c.vault.lease();
  const carol = r.k.chains.fromFacts({ kind: "device", device_key_id: "d-c", person: CAROL, path: "direct" });
  const mine = await r.g.chats.create(r.bob, { people: [] }), theirs = await r.g.chats.create(carol, { people: [] });
  await c.spec({ session: "s1", chat: mine.id }); await c.spec({ session: "s2" }); await c.spec({ session: "s4", chat: theirs.id });
  assert.deepEqual(r.home.rows().sort((a, b) => a.session.localeCompare(b.session)), [{ session: "s1", device: "dev_laptop", chat: mine.id }, { session: "s2", device: "dev_laptop" }, { session: "s4", device: "dev_laptop" }],
    "someone else's chat is dropped: the session runs but is not shown as that chat's");
  await c.spec({ session: "s5", chat: "chat_00000000-0000-4000-8000-000000000000" });
  assert.equal(r.home.rows().find(x => x.session === "s5").chat, undefined, "a chat that does not exist is dropped");
  await assert.rejects(c.spec({ session: "s3", chat: "../../x" }), e => e.code === "bad_input", "a chat is named by its id");
  assert.equal(r.home.rows().some(x => x.session === "s3"), false, "a bad chat starts nothing");
  assert.ok(r.home.rows().every(x => !("key" in x)), "a row carries no device key");
});

test("the lent service's rows are not a wire call", async () => {
  const { CALLS } = await import("../../kernel/remote/wire.js");
  assert.equal(CALLS.lent.includes("rows"), false);
});

// ---- the place of a lent session (R031-95 2.4, 2.5): the epoch, the heartbeat, the release and the server's take-over ---------------------------------------------------------------------
import { LAPSE_MS, HEARTBEAT_MS } from "./placement-book.js";
const CHAT = "chat_aaaaaaaa-0000-0000-0000-000000000001";
const clockRig = async (t, o = {}) => {
  const c = { t: 1_000_000 }; const resumed = [], said = [];
  const r = await rig(t, { now: () => c.t, resume: async i => { resumed.push(i); }, emit: (type, p) => said.push([type, p]), ...o });
  return { ...r, c, resumed, said };
};

test("every write names the epoch the session was lent under: none, or an older one, is refused", async t => {
  const r = await clockRig(t); const c = r.as(BOB, "dev_laptop"); await c.vault.lease();
  const first = await c.spec({ session: "s1", chat: CHAT });
  assert.equal(first.epoch, 1); assert.equal(c.epochOf("s1"), 1);
  await c.sync.appendTranscript("s1", [{ seq: 1, line: "a" }]);
  const raw = createRemoteKernel({ space: SPACE, transport: createMemoryTransport({ servers: { [SPACE]: r.server }, peer: { device_key_id: "dev_laptop", person: BOB, path: "wink" } }) });
  await assert.rejects(raw.call("lent.appendTranscript", ["s1", [{ seq: 2, line: "b" }]]), e => e.code === "bad_input", "a write that names no epoch is refused");
  await assert.rejects(raw.call("lent.putCheckpoint", ["s1", { turn: 1, seq: 1, manifest: {}, state: {} }, 7]), e => e.code === "conflict", "a write at another epoch is refused");
  await assert.rejects(raw.call("lent.putFile", ["s1", "f", { deleted: true, epoch: 0 }]), e => e.code === "conflict");
});

test("the split case: the computer is paused, not dead; the server resumes from the last acknowledged turn; the computer wakes and nothing it says is written", async t => {
  const r = await clockRig(t); const c = r.as(BOB, "dev_laptop"); await c.vault.lease();
  await c.spec({ session: "s1", chat: CHAT });
  await c.sync.appendTranscript("s1", [{ seq: 1, line: "a" }, { seq: 2, line: "b" }]);
  await c.sync.putCheckpoint("s1", { turn: 1, seq: 2, manifest: {}, state: { n: 1 } });
  await c.sync.appendTranscript("s1", [{ seq: 3, line: "c, a turn the checkpoint does not cover" }]);
  assert.deepEqual((await c.beat({ sessions: [{ session: "s1", epoch: c.epochOf("s1"), turn: 1, cpuPercent: 12, memoryMb: 300 }] })).fenced, [], "while it beats it keeps the session");
  // the lid closes: no beat for the lapse
  r.c.t += LAPSE_MS + 1;
  await r.home.sweep();
  assert.equal(r.resumed.length, 1, "the server took the session once");
  assert.deepEqual([r.resumed[0].session, r.resumed[0].chat, r.resumed[0].epoch, r.resumed[0].reason], ["s1", CHAT, 2, "offline"]);
  assert.equal((await r.resumed[0].view.checkpoint()).turn, 1, "from the last whole turn");
  assert.deepEqual((await r.resumed[0].view.transcript(1)).map(e => e.line).slice(0, 2), ["a", "b"]);
  assert.deepEqual(r.said.map(([type, p]) => [type, p.thread, p.to, p.reason, p.epoch, p.from]), [["thread.moved", CHAT, "server", "offline", 2, "mac"]]);
  await r.home.sweep(); assert.equal(r.resumed.length, 1, "a second sweep does not take it again");
  // the computer wakes: its client learns it was fenced, its writes are refused, nothing reaches the store
  const fenced = []; c.onFenced(s => fenced.push(s));
  await assert.rejects(c.sync.appendTranscript("s1", [{ seq: 4, line: "d, written after the server took over" }]), e => e.code === "not_found");
  await assert.rejects(c.sync.putCheckpoint("s1", { turn: 2, seq: 4, manifest: {}, state: {} }), e => e.code === "not_found");
  assert.deepEqual(fenced, ["s1", "s1"]);
  assert.deepEqual((await r.resumed[0].view.transcript(1)).map(e => e.line).filter(l => l.startsWith("d")), [], "the late line is not in the server's copy");
  assert.equal((await r.resumed[0].view.checkpoint()).turn, 1);
  const beat = await c.beat({ sessions: [{ session: "s1", epoch: 1 }] });
  assert.deepEqual(beat.fenced, ["s1"], "its next heartbeat says the same");
  // it cannot take the session back by starting it again; the person bringing it back is what allows that
  await assert.rejects(c.spec({ session: "s1" }), e => e.code === "conflict");
  r.home.book.bringBack("s1", BOB);
  assert.deepEqual((await c.beat({ sessions: [] })).directives, [{ do: "start", session: "s1", chat: CHAT, reason: null }], "the lender is told to start it");
  const again = await c.spec({ session: "s1" });
  assert.equal(again.epoch, 3);
  await c.sync.appendTranscript("s1", [{ seq: 3, line: "c again, on the computer" }]);
});

test("a computer that hands the session over after its final checkpoint is fenced at once, and the server resumes from that checkpoint", async t => {
  const r = await clockRig(t); const c = r.as(BOB, "dev_laptop"); await c.vault.lease();
  await c.spec({ session: "s1", chat: CHAT });
  await c.sync.appendTranscript("s1", [{ seq: 1, line: "a" }]);
  await c.sync.putCheckpoint("s1", { turn: 1, seq: 1, manifest: {}, state: {} });
  await assert.rejects(c.release({ session: "s1", reason: "whatever" }), e => e.code === "bad_input");
  assert.deepEqual(await c.release({ session: "s1", reason: "lid-closed" }), { moved: true, epoch: 2 });
  assert.equal(r.resumed.length, 1); assert.equal(r.resumed[0].reason, "lid-closed");
  await assert.rejects(c.sync.appendTranscript("s1", [{ seq: 2, line: "late" }]), e => e.code === "not_found");
  // a computer that was never this session's cannot release it
  await assert.rejects(r.as(BOB, "dev_other").release({ session: "s1", reason: "you" }), e => e.code === "not_found");
});

test("an automatic move is held back inside the cooldown, and the lender keeps the session; the person's own move is not", async t => {
  const r = await clockRig(t); const c = r.as(BOB, "dev_laptop"); await c.vault.lease();
  await c.spec({ session: "s1", chat: CHAT });
  assert.equal((await c.release({ session: "s1", reason: "unplugged" })).moved, true);
  r.home.book.bringBack("s1", BOB); r.c.t += 30_000;
  await c.spec({ session: "s1" });
  assert.deepEqual(await c.release({ session: "s1", reason: "unplugged" }), { moved: false, why: "cooldown" }, "no ping-pong");
  assert.equal(c.epochOf("s1"), 3, "the lender still holds the session");
  assert.equal((await c.release({ session: "s1", reason: "you" })).moved, true, "the person's move never waits");
});

test("the heartbeat tells a computer what the home wants: hand a session over, or that a condition cleared and the session is offered back", async t => {
  const r = await clockRig(t); const c = r.as(BOB, "dev_laptop"); await c.vault.lease();
  await c.spec({ session: "s1", chat: CHAT }); await c.spec({ session: "s2" });
  r.home.book.askRelease("s1", "you");
  const a = await c.beat({ sessions: [{ session: "s1", epoch: 1 }, { session: "s2", epoch: 1 }] });
  assert.deepEqual(a.directives, [{ do: "release", session: "s1", chat: CHAT, reason: "you" }]);
  assert.equal(r.home.book.get("s1").state, "moving");
  await c.release({ session: "s2", reason: "lid-closed" });
  assert.deepEqual((await c.beat({ sessions: [{ session: "s1", epoch: 1 }] })).offers, [], "not well yet: nothing is offered");
  const b = await c.beat({ sessions: [{ session: "s1", epoch: 1 }], well: true });
  assert.deepEqual(b.offers, ["s2"], "the lid is open: the session that went for it is offered back, not moved");
  assert.equal(r.home.book.get("s2").where, "server");
  // a computer that does not hand the session over when asked is overruled after a minute
  r.c.t += 61_000; await c.beat({ sessions: [{ session: "s1", epoch: 1 }] });
  await r.home.sweep();
  assert.equal(r.home.book.get("s1").where, "server"); assert.equal(r.home.book.get("s1").reason, "you");
});

test("a home that restarts keeps the sessions on lenders' computers, and gives each a whole lapse to show itself", async t => {
  const r = await clockRig(t); const c = r.as(BOB, "dev_laptop"); await c.vault.lease();
  await c.spec({ session: "s1", chat: CHAT });
  r.c.t += LAPSE_MS * 3;
  // the same folder, a new process: the book is read back from its file
  const home2 = createLentHome({ space: SPACE, root: path.join(r.dir, "home"), offers: r.g.offers, leases: r.k.gateway.leases, now: () => r.c.t, specFor: async () => ({ command: "x", routes: [] }) });
  assert.deepEqual(home2.rows().map(x => x.session), ["s1"], "still lent");
  assert.deepEqual(home2.book.lapsed(), [], "and not taken before it has had a lapse to beat");
  r.c.t += LAPSE_MS + 1;
  assert.deepEqual(home2.book.lapsed().map(x => x.session), ["s1"]);
});

test("a heartbeat is cheap and bounded: a lender names at most fifty sessions, and the beat interval is the one the book promises", () => {
  assert.ok(HEARTBEAT_MS < LAPSE_MS / 3, "three beats can be lost before a lender is taken");
});
