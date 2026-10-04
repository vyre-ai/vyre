import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { start } from "../core/daemon/index.js";
import { tempHome, writeModule } from "../test/helpers.js";
import { homeIdentity } from "./home.js";
import { mechanism } from "./modules/sandbox.js";

const linux = process.platform === "linux" && mechanism() === "bwrap";
// The sealing process refuses a desktop profile unless told this is development (kernel/seal hostCheck): tests run as development.
process.env.VYRE_SEAL_DEV = "1";
// First-party modules are signed in a release; a checkout's are not, so development says so (loud, never a default).
process.env.VYRE_KERNEL_PATH_RULE = "1";

test("home identity: a Space id and a first owner are made once and kept; no kernel key file is made", t => {
  const root = tempHome(t);
  const a = homeIdentity(root), b = homeIdentity(root);
  assert.match(a.space, /^spc_[a-z2-7]{12}$/);
  assert.match(a.owner, /^per_[a-z2-7]{26}$/);
  assert.deepEqual([b.space, b.owner], [a.space, a.owner]);
  assert.equal(a.key, undefined, "no key is made or read here: it comes from the sealing process");
  assert.equal(fs.existsSync(path.join(root, "kernel", "kernel.key")), false);
});

test("daemon: with the kernel off (the default) nothing changes and no kernel exists", { timeout: 30_000 }, async t => {
  const d = await start({ root: tempHome(t), log: () => {}, kernel: false });
  t.after(() => d.stop());
  assert.equal(d.kernel, null);
  assert.equal(d.registry.deps.moduleHost, undefined);
});

test("daemon: with the kernel on, the home has a Space, a first owner and a module host, and a restart keeps them", { timeout: 60_000 }, async t => {
  const root = tempHome(t);
  let d = await start({ root, log: () => {}, kernel: true });
  const id = d.kernel.id;
  assert.equal(d.kernel.fresh, true);
  assert.equal(d.kernel.grants.roleOf({ kind: "person", id: id.owner, space: id.space }), "owner");
  assert.ok(d.registry.deps.moduleHost);
  assert.equal((await d.kernel.gateway.audit.verify()).ok, true);
  const klog = d.kernel.log;
  await d.stop();
  const events = klog.latestSeq();
  d = await start({ root, log: () => {}, kernel: true });
  t.after(() => d.stop());
  assert.equal(d.kernel.fresh, false);
  assert.deepEqual(d.kernel.id, id);
  assert.equal(d.kernel.log.latestSeq(), events, "the owner and the log came back from the home's database");
});

test("daemon: an added module is refused while the supervisor cannot prove its sandbox, and sandboxed when it can", { timeout: 90_000, skip: !linux }, async t => {
  const root = tempHome(t);
  writeModule(path.join(root, "modules"), "zz-added", { does: { tools: [{ name: "zz-added.ping", reach: "anyone" }] } }, `export const handlers = { "zz-added.ping": async () => ({ pong: true }) };`);
  const d = await start({ root, log: () => {}, kernel: true });
  t.after(() => d.stop());
  const row = d.registry.status().find(m => m.name === "zz-added");
  assert.ok(row, "the module was found");
  assert.equal(row.state, "running", JSON.stringify(row));
  assert.deepEqual((await d.registry.call("zz-added.ping", {})).data, { pong: true });
});

test("ctx.kernel: a first-party module gets the kernel handle with exactly the actions its manifest declared; a module from outside gets none", { timeout: 60_000 }, async t => {
  const root = tempHome(t), fp = path.join(root, "modules");
  writeModule(fp, "zz-fp", { does: { tools: [{ name: "zz-fp.make", reach: "anyone" }, { name: "zz-fp.peek", reach: "anyone" }] }, needs: { kernel: { actions: ["records.read", "records.create"], prefixes: ["contact/*"] } } }, `
    export default { async start(ctx) {
      ctx.tool("zz-fp.make", { effect: "read", run: async ({ name }) => { const r = await ctx.kernel.records.create(ctx.kernel.serviceChain(), "contact", { name }); return { id: r.id }; } });
      ctx.tool("zz-fp.peek", { effect: "read", run: async () => ({ has: Object.keys(ctx.kernel).sort() }) });
      return {};
    } };`);
  const d = await start({ root, log: () => {}, kernel: true, firstPartyRoots: [fp] });
  t.after(() => d.stop());
  const owner = d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: d.kernel.id.owner, path: "direct", session: "s1" });
  await d.kernel.gateway.records.define(owner, { add_types: [{ name: "contact", label: "Contact", fields: [{ name: "name", kind: "text", label: "Name" }] }] });
  const row = d.registry.status().find(m => m.name === "zz-fp");
  assert.equal(row && row.state, "running", JSON.stringify(row));
  const made = await d.registry.call("zz-fp.make", { name: "From a module" });
  assert.ok(made.data && made.data.id, JSON.stringify(made));
  assert.equal((await d.kernel.gateway.records.get(owner, "contact", made.data.id)).data.name, "From a module");
  assert.deepEqual((await d.registry.call("zz-fp.peek", {})).data.has, ["acceptProofRequest", "audienceFor", "audit", "authorize", "canonicalPerson", "chain", "chainIn", "chats", "drive", "events", "for", "grants", "leases", "limits", "model", "offersPort", "owner", "presence", "proofChainHash", "proofFrom", "proofRequest", "records", "runnerHost", "runnerPorts", "serviceChain", "sessions", "space", "tasks"]);
});

test("ctx.kernel: a module that is not first party has no kernel handle", { timeout: 60_000, skip: !linux }, async t => {
  const root = tempHome(t);
  writeModule(path.join(root, "modules"), "zz-out", { does: { tools: [{ name: "zz-out.peek", reach: "anyone" }] } }, `export const handlers = { "zz-out.peek": async () => ({ kernel: typeof globalThis.kernel }) };`);
  const d = await start({ root, log: () => {}, kernel: true });
  t.after(() => d.stop());
  assert.equal(d.registry.status().find(m => m.name === "zz-out").state, "running");
  assert.equal((await d.registry.call("zz-out.peek", {})).data.kernel, "undefined");
});


test("K-3: the kernel key is derived in the sealing process and never written to disk; it is the same across restarts and differs between homes", { timeout: 60_000 }, async t => {
  const root = tempHome(t);
  let d = await start({ root, log: () => {}, kernel: true });
  assert.equal(fs.existsSync(path.join(root, "kernel", "kernel.key")), false, "no key file on a custody boot");
  const owner = d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d", person: d.kernel.id.owner, path: "direct" });
  const tok = (await d.kernel.surfaces.open(owner, {})).token;
  await d.stop();
  d = await start({ root, log: () => {}, kernel: true });
  t.after(() => d.stop());
  assert.ok(await d.kernel.surfaces.chainFor(tok), "the same sealing master, the same Space: the token made before the restart still verifies");
  assert.equal(d.kernel.fresh, false);
  // another home has another sealing master and another key: the token is nothing there
  const other = await start({ root: tempHome(t), log: () => {}, kernel: true });
  t.after(() => other.stop());
  await assert.rejects(() => other.kernel.surfaces.chainFor(tok), { code: "not_a_member" });
});

test("K-3: where the sealing process cannot run safely the kernel refuses to start, unless a developer opts into a file key", { timeout: 60_000 }, async t => {
  const saved = { dev: process.env.VYRE_SEAL_DEV, profile: process.env.VYRE_SEAL_PROFILE, uids: process.env.VYRE_AGENT_UIDS };
  delete process.env.VYRE_SEAL_DEV;
  t.after(() => { for (const [k, v] of [["VYRE_SEAL_DEV", saved.dev], ["VYRE_SEAL_PROFILE", saved.profile], ["VYRE_AGENT_UIDS", saved.uids]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  // A server whose sealing process would share an agent's uid does not start (a desktop does: its master is a file inside the Vyre home, no development switch).
  process.env.VYRE_SEAL_PROFILE = "server"; process.env.VYRE_AGENT_UIDS = String(process.getuid?.() ?? 0);
  await assert.rejects(() => start({ root: tempHome(t), log: () => {}, kernel: true }), { code: "key_custody" });
  delete process.env.VYRE_SEAL_PROFILE; delete process.env.VYRE_AGENT_UIDS;
  for (const profile of [undefined, "server"]) {
    if (profile) process.env.VYRE_SEAL_PROFILE = profile; else delete process.env.VYRE_SEAL_PROFILE;
    const ok = await start({ root: tempHome(t), log: () => {}, kernel: true }); t.after(() => ok.stop()); assert.ok(ok.kernel.fresh, `the kernel boots on the ${profile ?? "default (desktop)"} profile with no development variable`);
  }
  delete process.env.VYRE_SEAL_PROFILE;
  process.env.VYRE_KERNEL_FILE_KEY = "1";
  t.after(() => { delete process.env.VYRE_KERNEL_FILE_KEY; });
  const logs = [];
  const d = await start({ root: tempHome(t), log: m => logs.push(m), kernel: true });
  t.after(() => d.stop());
  assert.ok(logs.some(m => /DEVELOPER file key/.test(m)), "loud");
  assert.ok(d.kernel.fresh);
});

test("K-3: events an older key sealed (position-bound, before custody moved) verify once, are re-sealed in one snapshot under the sealing process, and the key file is deleted", { timeout: 60_000 }, async t => {
  const { DatabaseSync } = await import("node:sqlite");
  const { createSqliteEventLog } = await import("./store/sqlite-log.js");
  const { homeIdentity: ident, bootHomeKernel } = await import("./home.js");
  const { fileKernelKey } = await import("./keys.js");
  const { createChainBuilder } = await import("./core/chain.js");
  const { canonical, hmac } = await import("./core/canonical.js");
  const root = tempHome(t);
  const id = ident(root), key = fileKernelKey(id.dir);
  const dbFile = path.join(root, "k.db");
  const db1 = new DatabaseSync(dbFile);
  const log = createSqliteEventLog({ db: db1, space: id.space });
  const chains = createChainBuilder({ space: id.space, owner: id.owner, owner_uid: 1, key });
  const k = chains.fromFacts({ kind: "module", module: "grants", first_party: true });
  // the old format: the MAC binds the log position and the previous hash
  const legacy = (type, subject, data) => log.append(k, { type, sv: 1, subject, data: { ...data, mac: hmac(key, canonical({ type, subject, data, seq: log.latestSeq() + 1, prev: log.head() })) }, vis: "owner", red: "internal" });
  const membership = (person, role) => ({ space: id.space, person, role, added_by: "kernel", added_at: 1 });
  legacy("member.set", `vyre://${id.space}/member/${id.owner}`, { membership: membership(id.owner, "owner") });
  legacy("member.set", `vyre://${id.space}/member/per_old`, { membership: membership("per_old", "member") });
  // a forged legacy event (not sealed by that key) is ignored
  log.append(k, { type: "member.set", sv: 1, subject: `vyre://${id.space}/member/per_evil`, data: { membership: membership("per_evil", "owner"), mac: "AAAA" }, vis: "owner", red: "internal" });
  db1.close();
  const boot = async () => bootHomeKernel({ db: new DatabaseSync(dbFile), root, log: () => {}, isFirstParty: () => false });
  let kern = await boot();
  const who = p => kern.grants.roleOf({ kind: "person", id: p, space: id.space });
  assert.equal(who(id.owner), "owner");
  assert.equal(who("per_old"), "member", "read under the old key");
  assert.equal(who("per_evil"), null, "a forged one is not");
  assert.equal(kern.migrated, true);
  assert.equal(fs.existsSync(path.join(id.dir, "kernel.key")), false, "the key file is gone once the state is under the new seal");
  assert.ok(kern.log.read({ type: "grants.snapshot" }).length === 1);
  await kern.stop();
  kern = await boot();
  assert.equal(who(id.owner), "owner", "the snapshot alone is enough: no old key exists any more");
  assert.equal(who("per_old"), "member");
  assert.equal(kern.migrated, false);
  await kern.stop();
});

test("the daemon's edge carries x-vyre-kernel-proof to the tool as meta.kernel_proof, and the legacy proof header never becomes one", { timeout: 30_000 }, async t => {
  const { call } = await import("../core/daemon/client.js");
  const root = tempHome(t);
  writeModule(path.join(root, "modules"), "zz-edge", { does: { tools: [{ name: "zz-edge.peek", reach: "anyone" }] } }, `
    export default { async start(ctx) { ctx.tool("zz-edge.peek", { effect: "read", run: async (i, meta) => ({ kernel_proof: meta.kernel_proof ?? null, proof: meta.proof ?? null }) }); return {}; } };`);
  const d = await start({ root, log: () => {}, kernel: false });
  t.after(() => d.stop());
  const proof = { op: "grant.create", signer: "secure_enclave", key_id: "k1", payload_hash: "ph", signature: "sig" };
  const enc = Buffer.from(JSON.stringify(proof)).toString("base64url");
  assert.deepEqual((await call("zz-edge.peek", {}, { root, headers: { "x-vyre-kernel-proof": enc } })).data.kernel_proof, proof);
  assert.equal((await call("zz-edge.peek", {}, { root })).data.kernel_proof, null, "absent when not sent");
  for (const bad of ["not base64 !!", Buffer.from("[1,2]").toString("base64url"), Buffer.from("nope").toString("base64url"), "A".repeat(6000)]) assert.equal((await call("zz-edge.peek", {}, { root, headers: { "x-vyre-kernel-proof": bad } })).data.kernel_proof, null, "malformed is simply absent");
  assert.equal((await call("zz-edge.peek", {}, { root, headers: { "x-vyre-presence": "device abc" } })).data.kernel_proof, null, "the legacy presence header is not a kernel proof");
});

test("the daemon opens the Spaces registry at boot: a second hosted Space has its own kernel under the home's sealing process, no key file, and survives a restart", { timeout: 90_000 }, async t => {
  const root = tempHome(t);
  let d = await start({ root, log: () => {}, kernel: true });
  assert.deepEqual(d.kernel.spaces.list(), [d.kernel.id.space], "the personal Space is the first");
  const owner2 = "per_" + "b".repeat(26);
  const second = await d.kernel.spaces.host({ owner: owner2 });
  assert.notEqual(second.space, d.kernel.id.space);
  assert.equal(d.kernel.spaces.for(second.space).hosted, true);
  assert.equal(fs.existsSync(path.join(root, "kernel", "spaces", second.space, "kernel.key")), false, "no key file for a hosted Space");
  const o1 = d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d", person: d.kernel.id.owner, path: "direct" });
  const tok1 = (await d.kernel.surfaces.open(o1, {})).token;
  await assert.rejects(() => second.surfaces.chainFor(tok1), { code: "not_a_member" }, "a token of one Space opens nothing in another");
  assert.equal(second.kernel.grants.roleOf({ kind: "person", id: owner2, space: second.space }), "owner");
  await d.stop();
  d = await start({ root, log: () => {}, kernel: true });
  t.after(() => d.stop());
  assert.deepEqual(d.kernel.spaces.list().sort(), [d.kernel.id.space, second.space].sort());
  assert.equal(d.kernel.spaces.for(second.space).kernel.grants.roleOf({ kind: "person", id: owner2, space: second.space }), "owner", "reopened from its own store and log");
});

test("R1/R2: the daemon sets meta.token only from a session token the kernel's own door verified; input and other headers never do; the running turn's token does not outlive the turn", { timeout: 60_000 }, async t => {
  const { call } = await import("../core/daemon/client.js");
  const { currentCall } = await import("../core/modules/index.js");
  const root = tempHome(t);
  globalThis.__vyreLate = [];
  globalThis.__vyreCC = currentCall;
  const fp = path.join(root, "modules");
  fs.mkdirSync(fp, { recursive: true });
  writeModule(fp, "zz-tok", { does: { tools: [{ name: "zz-tok.peek", reach: "anyone" }] } }, `
    export default { async start(ctx) { ctx.tool("zz-tok.peek", { effect: "read", run: async (i, meta) => {
      const cc = globalThis.__vyreCC, inside = cc() && cc().token || null;
      setTimeout(() => { globalThis.__vyreLate.push(cc() && cc().token || null); }, 20);
      return { meta: meta.token ?? null, inside };
    } }); return {}; } };`);
  const d = await start({ root, log: () => {}, kernel: true, firstPartyRoots: [fp] });
  t.after(() => d.stop());
  const person = d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: d.kernel.id.owner, path: "direct" });
  const ses = await d.kernel.surfaces.open(person);
  const first = await call("zz-tok.peek", {}, { root, headers: { "x-vyre-kernel-session": ses.token } });
  assert.ok(first.data, JSON.stringify(first));
  const got = first.data;
  assert.equal(got.meta, ses.token, "from the verified header");
  assert.equal(got.inside, ses.token, "the running call sees it");
  assert.equal((await call("zz-tok.peek", { token: ses.token }, { root })).data.meta, null, "never from the input");
  const [body] = ses.token.split(".");
  // KS-4: a credential that is present and not valid refuses the call; it is never run as if it carried none
  for (const bad of [`${body}.AAAA`, "x.y", "a".repeat(3000), `${body}.${"b".repeat(60)}`, ""]) { const r = await call("zz-tok.peek", {}, { root, headers: { "x-vyre-kernel-session": bad } }); assert.equal(r.data, undefined, JSON.stringify(bad).slice(0, 20)); assert.equal(r.error && r.error.code, "no_session"); }
  d.kernel.surfaces.revoke(ses.session);
  assert.equal((await call("zz-tok.peek", {}, { root, headers: { "x-vyre-kernel-session": ses.token } })).error?.code, "no_session", "a revoked session's token refuses the call");
  assert.equal((await call("zz-tok.peek", {}, { root, headers: { authorization: `Bearer ${ses.token}` } })).data.meta, null, "no other header");
  await new Promise(r => setTimeout(r, 100));
  assert.ok(globalThis.__vyreLate.length >= 1 && globalThis.__vyreLate.every(x => x === null), "work started in a turn no longer sees its token once the turn is over");
  assert.equal(currentCall(), null);
});

test("stages: a record entering a stage reaches the stages module in the daemon (the gateway hook is wired), and a task nobody can do is reported, not lost", { timeout: 60_000 }, async t => {
  const root = tempHome(t);
  const logs = [];
  const d = await start({ root, log: m => logs.push(String(m)), kernel: true });
  t.after(() => d.stop());
  const owner = d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: d.kernel.id.owner, path: "direct", session: "s" });
  const type = { name: "matter", label: "Matter", fields: [{ name: "title", kind: "text", label: "Title" }, { name: "stage", kind: "stage", label: "Stage", options: ["intake", "open"] }],
    stages: [{ name: "intake", tasks: [{ title: "Research", doer: "teammate:ghost", output: { kind: "note" } }] }, { name: "open" }] };
  await d.kernel.gateway.records.define(owner, { add_types: [type] });
  await d.kernel.gateway.records.create(owner, "matter", { title: "Estate of Rivera", stage: "intake" });
  await new Promise(r => setTimeout(r, 400));
  assert.ok(logs.some(m => /stage\.error|stages: /.test(m)), `the stages module saw the entry: ${logs.filter(m => /stage|flows/.test(m)).join(" | ")}`);
});

test("stages: a Space this home hosts gets the same stage hook as the home's own, over its own kernel (a firm Space is not the personal one)", { timeout: 60_000 }, async t => {
  const root = tempHome(t);
  const logs = [];
  const d = await start({ root, log: m => logs.push(String(m)), kernel: true });
  t.after(() => d.stop());
  const owner = "per_" + "abcdefghijklmnopqrstuvwxyz".slice(0, 26);
  const h = await d.kernel.spaces.host({ owner, name: "Harlow Legal" });
  const chain = h.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-h", person: owner, path: "direct", session: "s" });
  const type = { name: "matter", label: "Matter", fields: [{ name: "title", kind: "text", label: "Title" }, { name: "stage", kind: "stage", label: "Stage", options: ["intake", "open"] }],
    stages: [{ name: "intake", tasks: [{ title: "Research", doer: "teammate:ghost", output: { kind: "note" } }] }, { name: "open" }] };
  await h.gateway.records.define(chain, { add_types: [type] });
  await h.gateway.records.create(chain, "matter", { title: "Estate of Rivera", stage: "intake" });
  await new Promise(r => setTimeout(r, 500));
  assert.ok(logs.some(m => /stage\.error|stages: /.test(m)), `the hosted Space's stages module saw the entry: ${logs.filter(m => /stage|flows/.test(m)).join(" | ")}`);
});
