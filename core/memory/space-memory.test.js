// @ts-check
// The Space layer's memory tools over the kernel's memory.file / recall / retire: a pass-through, the chain is the caller's own, and the kernel's refusal reaches the caller. On a REAL kernel (test/kernel-rig.js), personal memory is refused to a group chat, readable only by its person and that
// person's own assistant (decided by the kernel's chain, not the 0.2 caller label), and sealed values never enter it. Corrections, pins, taught facts, agent writes and site rows
// survive a schema change. Only the projects.reach stand-in (a 0.2 module this one asks) and the model are stand-ins.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { open } from "../store/index.js";
import { SESSIONS, seedRecall } from "../../test/fixtures/corpus.js";
import { tempHome } from "../../test/helpers.js";
import { fakeReachCall } from "../../test/fixtures/fake-reach.js";
import { createRig } from "../../test/kernel-rig.js";
import { MIGRATIONS } from "./schema.js";
import { scrubIn, scanRows } from "./sealed.js";
import memory from "./index.js";


const surface = (label, uid = 501) => ({ kernelFacts: { kind: "socket", surface: label, uid, pid: 1, inside_model_process: false, capsule_verified: true } });
const AGENTS = [{ name: "kit", kind: "assistant", projects: "*" }];
async function world(t, spaceMem, extraConfig = {}, sources = null) {
  const rig = await createRig({ people: { per_bob: "member" }, agents: ["kit"] });
  const handle = rig.k.kernelFor({ name: "memory", needs: { kernel: { membership: true } } });
  const db = open(path.join(tempHome(t), "vyre.db"));
  t.after(() => db.close());
  seedRecall(db, SESSIONS);
  const tools = new Map();
  const calls = [], prompts = [];
  // The work module is not started here: its tools are answered by stand-ins so the test sees what memory asks of it and what it never asks.
  const space = { hits: [], answer: null };
  const ctx = {
    name: "memory", config: { me: { domains: ["riverastudio.com"] }, ...extraConfig }, paths: {}, store: { db, migrate: () => {} }, log: () => {},
    events: { on: () => () => {}, emit: () => {}, since: () => [], prune: () => 0 },
    call: async (tool, input) => { calls.push(tool); if (tool === "projects.backup.sources") return sources ? { data: { items: sources() } } : { error: { code: "no_such_tool" } }; return tool === "recall.search" ? { data: [] } : tool === "recall.thread" ? { data: { turns: [] } } : tool === "work.know.search" ? { data: { hits: space.hits } } : tool === "work.know.answer" ? (space.answer || { data: { result: { text: "", citations: [] } } }) : fakeReachCall(tool, input, { agents: AGENTS, projects: [] }); },
    tool: (name, def) => tools.set(name, def), kernel: Object.assign(Object.create(handle), { memory: spaceMem }), memoryRunner: null,
    iqRunner: async ({ prompt }) => { prompts.push(prompt); return { text: JSON.stringify({ answer: null, cite: [], confidence: 0, abstain: true, known: [] }), usd: 0 }; },
  };
  const h = await memory.start(ctx);
  t.after(() => h.stop());
  /** A tool's answer or its refusal, with the running call's session token bound the way the registry does it. */
  const call = async (name, input, caller, token, meta = {}) => {
    rig.k.bindCalls(() => (token ? { token } : null));
    try { return { data: await tools.get(name).run(input, { caller, ...(token ? { token } : {}), ...meta }) }; } catch (e) { return { error: /** @type {Error} */ (e).message, code: /** @type {any} */ (e).code || "failed" }; }
  };
  const session = async (person, o = {}) => (await rig.k.surfaces.open(rig.person(person), o)).token;
  return { rig, call, db, tools, session, calls, prompts, space };
}


test("memory.space.*: the tools pass the caller's own chain to the kernel's memory calls, return the facts as the kernel shaped them, and surface its refusal", async t => {
  const seen = [];
  const fact = { id: "f1", urn: "vyre://s/memory/f1", text: "Net 30 for Northwind", source: "session:s1", kind: "policy", topics: ["billing"], by: "person:per_alex", filed_at: 5, state: "active", labels: { trust: "member" } };
  const memory = {
    file: async (chain, f) => { seen.push(["file", chain.hops.map(h => `${h.actor.kind}:${h.actor.id}`), f]); if (f.text === "refuse") throw Object.assign(new Error("not allowed"), { code: "denied" }); return { ...fact, existing: false }; },
    recall: async (chain, o) => { seen.push(["recall", o]); return [fact]; },
    retire: async (chain, id) => { seen.push(["retire", id]); return { ...fact, state: "retired" }; },
  };
  const w = await world(t, memory);
  const tok = await w.session("per_alex");
  const f = await w.call("memory.space.file", { text: "Net 30 for Northwind", source: "session:s1", kind: "policy", topics: ["billing"] }, "deck", tok);
  assert.equal(f.error, undefined, JSON.stringify(f));
  assert.equal(f.data.id, "f1");
  assert.deepEqual(seen[0].slice(0, 2), ["file", ["person:per_alex"]], "the caller's own chain, not the module's");
  assert.deepEqual(seen[0][2], { text: "Net 30 for Northwind", source: "session:s1", kind: "policy", topics: ["billing"] });
  assert.equal(f.data.existing, false);
  const r = await w.call("memory.space.recall", { q: "net", limit: 5 }, "deck", tok);
  assert.deepEqual(r.data.facts.map(x => x.id), ["f1"]);
  assert.deepEqual(seen[1], ["recall", { q: "net", limit: 5 }]);
  assert.equal((await w.call("memory.space.retire", { id: "f1" }, "deck", tok)).data.state, "retired");
  const refused = await w.call("memory.space.file", { text: "refuse", source: "session:s1" }, "deck", tok);
  assert.equal(refused.code, "denied");
  // no Space memory on this kernel: said plainly
  const none = await world(t, undefined);
  assert.equal((await none.call("memory.space.recall", {}, "deck", await none.session("per_alex"))).code, "unavailable");
});

test("memory.backup: no team means none; with one, run backs up, status reads ok, and nothing is readable on the server", async t => {
  const fs = await import("node:fs"), os = await import("node:os"), { newDeviceKey } = await import("../../lib/keywrap.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-bkt-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const dev = newDeviceKey();
  fs.writeFileSync(path.join(dir, "device.json"), JSON.stringify(dev));
  const none = await world(t, undefined);
  const ns = await none.call("memory.backup.status", {}, "deck", await none.session("per_alex"), surface("deck"));
  assert.deepEqual(ns.data, { to: null, last: null, state: "none" }, JSON.stringify(ns));
  assert.equal((await none.call("memory.backup.run", {}, "deck", await none.session("per_alex"), surface("deck"))).code, "not_found");
  const items = [{ kind: "file", name: "northwind/node_modules/x/index.js", size: 5, mtime: 1, text: "skip" }, { kind: "file", name: "northwind/debug.log", size: 5, mtime: 1, text: "skip" }, { kind: "file", name: "northwind/.git/HEAD", size: 5, mtime: 1, text: "keep!" }, { kind: "rows", name: "rows/chats.jsonl", size: 40, mtime: Date.now() - 1000, text: '{"chat":"Harlow billing question"}' }];
  const w = await world(t, undefined, { memory: { identity: { id: "alex", home: path.join(dir, "server"), name: "Acme Team", server: "Acme Team", deviceKey: path.join(dir, "device.json") } } }, () => items);
  const tok = await w.session("per_alex");
  // not enrolled yet: nothing to back up to, and the status says so
  assert.equal((await w.call("memory.backup.status", {}, "deck", tok, surface("deck"))).data.state, "none");
  assert.equal((await w.call("memory.identity.enroll", { devices: [{ label: "laptop", publicJwk: dev.publicJwk }], recovery_code: "abcd-efgh-ijkl-mnop-qrst-uvwx-23" }, "deck", tok, surface("deck"))).error, undefined);
  const run = await w.call("memory.backup.run", {}, "deck", tok, surface("deck"));
  assert.equal(run.error, undefined, JSON.stringify(run));
  assert.equal(run.data.items, 2, "dependency folders and logs are never sent; .git is kept");
  assert.equal(run.data.uploaded, 2);
  const st = (await w.call("memory.backup.status", {}, "deck", tok, surface("deck"))).data;
  assert.equal(st.to, "Acme Team");
  assert.ok(fs.existsSync(path.join(dir, "server", "backup", "alex", "ring.json")), "beside the identity home, in the same storage");
  assert.equal(st.state, "ok");
  assert.ok(st.last > 0);
  const walk = d => fs.readdirSync(d).flatMap(n => { const p = path.join(d, n); return fs.statSync(p).isDirectory() ? walk(p) : [fs.readFileSync(p, "latin1")]; });
  assert.ok(!walk(path.join(dir, "server")).join("").includes("Harlow"), "ciphertext only on the server");
  assert.equal((await w.call("memory.backup.status", {}, "mcp:agent:kit")).code, "denied", "an agent does not read the backup status");
  // restore onto a new device, from the recovery code alone, into a folder of the person's choosing
  const out = path.join(dir, "restored");
  const rest = await w.call("memory.backup.restore", { to: out, recovery_code: "abcd-efgh-ijkl-mnop-qrst-uvwx-23" }, "deck", tok, surface("deck"));
  assert.equal(rest.error, undefined, JSON.stringify(rest));
  assert.equal(rest.data.restored, 2);
  assert.equal(fs.readFileSync(path.join(out, "northwind/.git/HEAD"), "utf8"), "keep!");
  assert.match(fs.readFileSync(path.join(out, "rows/chats.jsonl"), "utf8"), /Harlow billing question/);
});

test("memory.personal: the status counts the sealed records while locked, and the owner's cap is read back", async t => {
  const fs = await import("node:fs"), os = await import("node:os"), { newKey } = await import("../../lib/keywrap.js"), { createSealedStore } = await import("../../kernel/store/sealed.js"), { FileBackend } = await import("./identity/home.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-pst-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const none = await world(t, undefined);
  assert.deepEqual((await none.call("memory.personal.status", {}, "deck", await none.session("per_alex"), surface("deck"))).data.host, null);
  const w = await world(t, undefined, { memory: { identity: { id: "alex", home: path.join(dir, "server"), name: "Acme Team", server: "Acme Team" } } });
  const tok = await w.session("per_alex");
  const s = createSealedStore({ backend: new FileBackend(path.join(dir, "server")), identity: "alex", imk: newKey(), create: true });
  await s.store.define({ add_types: [{ name: "note", label: "Note", fields: [{ name: "text", kind: "text", label: "Text" }] }] });
  await s.store.create("note", "0190c3f2-1111-4abc-8def-000000000001", { text: "dentist" });
  s.lock();
  const st = (await w.call("memory.personal.status", {}, "deck", tok, surface("deck"))).data;
  assert.equal(st.host, "Acme Team");
  assert.ok(st.used_bytes > 0, "counted from the storage, no key needed");
  assert.equal(st.cap_bytes, 1024 ** 3);
  assert.equal((await w.call("memory.personal.set-cap", { bytes: 5000 }, "deck", tok, surface("deck"))).data.cap_bytes, 5000);
  assert.equal((await w.call("memory.personal.status", {}, "deck", tok, surface("deck"))).data.cap_bytes, 5000);
  assert.equal((await w.call("memory.personal.status", {}, "mcp:agent:kit")).code, "denied");
});
