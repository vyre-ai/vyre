// A project's own files (`Projects/<id>/files/`, R031-04): stored sealed under a key the server derives for the project and never stores, opened only for the project's members, their assistants and a
// teammate while it works a task there. An owner or admin who is not a member, a member of the Space, an outside agent and another module get not_found, before the Drive is touched; every read is logged.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createKernel } from "../index.js";
import { sealedDrive } from "../storage/sealed-drive.js";
import { Keys } from "../../lib/keywrap.js";
import { derive } from "../../lib/databox.js";
import { canonical, sha256 } from "../core/canonical.js";
import { PROJECT, TEAM_MEMBER, TASK } from "../../records/core-types.js";

const SPACE = "spc_aaaaaaaaaaaa", OWNER = "per_owner", BOB = "per_bob", CAROL = "per_carol", ADA = "per_ada", DAN = "per_dan";
const proof = (action, input, resource) => ({ op: `grant.${action.split(".")[1]}`, fields: { resource, input_hash: sha256(canonical({ action, input })) }, n: Math.random() });
const used = new Set();
const presence = { check: async ({ chain, op, fields, proof: p }) => (chain && p && p.op === op && canonical(p.fields) === canonical(fields) && !used.has(p.n) && (used.add(p.n), true) ? null : "wrong_payload") };
const enc = s => new TextEncoder().encode(s);
const dec = b => new TextDecoder().decode(b);

function fakeDrive() {
  const files = new Map(), calls = [];
  return { calls, files,
    async put(p, bytes, { by } = {}) { const f = files.get(p) || []; f.push({ ver: f.length + 1, bytes, by }); files.set(p, f); calls.push(["put", p]); return { version: f.length }; },
    async get(p, { version } = {}) { calls.push(["get", p]); const f = files.get(p); if (!f) throw Object.assign(new Error("nf"), { code: "not_found" }); return f[(version ?? f.length) - 1].bytes; },
    stat(p) { const f = files.get(p); if (!f) throw Object.assign(new Error("nf"), { code: "not_found" }); return { version: f.length, size: f.at(-1).bytes.length, sha256: null }; },
    async *stream(p) { yield Buffer.from(files.get(p).at(-1).bytes); },
    async putStream() { throw new Error("unused"); },
    list(prefix) { return [...files.keys()].filter(k => k.startsWith(prefix)).map(path => ({ path })); },
    history(p) { return (files.get(p) || []).map(v => ({ ver: v.ver, by: v.by })); },
    async delete(p) { files.delete(p); return { deleted: true }; },
    async restore() { return { version: 1 }; }, async prune() { return { pruned: 0 }; }, async backup() { return { id: "b1" }; }, backups() { return []; }, async restoreBackup() { return {}; }, async pruneBackups() { return {}; },
  };
}

async function rig() {
  const raw = fakeDrive(), master = Buffer.alloc(32, 5);
  const drive = sealedDrive(raw, { projectFiles: true, keysFor: c => (c.startsWith("project-files:") ? new Keys(c, new Map([[1, derive(master, `project-files key ${c}`)]]), derive(master, `project-files names ${c}`), 1) : null), projectKeysFor: () => null });
  const k = await createKernel({ space: SPACE, owner: OWNER, owner_uid: 501, key: Buffer.alloc(32, 7), presence, drive });
  const owner = k.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: OWNER, path: "direct", session: "s" });
  const dev = (person, id) => k.chains.fromFacts({ kind: "device", device_key_id: id, person, path: "direct" });
  const g = k.gateway.grants;
  for (const [p, role] of [[BOB, "member"], [CAROL, "member"], [ADA, "admin"], [DAN, "member"]]) { const r = { person: p, role }; await g.setRole(owner, r, { presence: proof("grants.role", r, `vyre://${SPACE}/member/${p}`) }); }
  for (const name of ["kit", "spy", "assistant"]) { const a = { kind: "agent", id: name, space: SPACE }; await g.addActor(owner, a, { presence: proof("grants.role", { actor: a }, `vyre://${SPACE}/member/${name}`) }); }
  k.kernelFor({ name: "work", needs: { kernel: { actions: ["records.read"] } } });
  await k.gateway.records.define(owner, { add_types: [PROJECT, TEAM_MEMBER, TASK].filter(t => t.name !== "task").map(t => ({ ...t, fields: t.fields.filter(f => f.name !== "client" && f.name !== "contact") })) });
  const person = id => ({ actor: { kind: "person", id, space: SPACE } });
  const agent = id => ({ actor: { kind: "agent", id, space: SPACE } });
  const project = await k.gateway.records.create(owner, "project", { name: "Rivera", slug: "rivera", owner: person(BOB) });
  await k.gateway.records.create(owner, "team-member", { name: "Carol", actor: person(CAROL), kind: "person", project: { urn: project.urn } });
  await k.gateway.records.create(owner, "team-member", { name: "kit", actor: agent("kit"), kind: "assistant", project: { urn: project.urn } });
  const as = (person, name, session) => k.chains.fromFacts({ kind: "agent_session", vouched: true, person, agent: name, session });
  return { k, raw, D: k.gateway.drive, owner, bob: dev(BOB, "d-b"), carol: dev(CAROL, "d-c"), ada: dev(ADA, "d-a"), dan: dev(DAN, "d-d"), as, dir: `Projects/${project.id}/files`, project };
}

test("project files are sealed at rest and open only for the project's members and their assistants; an owner, an admin, another member and an outside agent get not_found before the Drive is touched", async () => {
  const { D, raw, owner, bob, carol, ada, dan, as, dir } = await rig();
  await D.put(bob, `${dir}/plan.txt`, enc("the plan"));
  for (const [p, versions] of raw.files) if (p.startsWith(dir)) for (const v of versions) assert.ok(!Buffer.from(v.bytes).toString("utf8").includes("the plan"), `${p} is stored sealed`);
  assert.ok(![...raw.files.keys()].some(p => p.includes("plan.txt")), "and its name is not stored in the clear");
  assert.equal(dec(await D.get(bob, `${dir}/plan.txt`)), "the plan", "the owner of the project reads it");
  assert.equal(dec(await D.get(carol, `${dir}/plan.txt`)), "the plan", "a member with a team-member row");
  assert.equal(dec(await D.get(as(BOB, "assistant", "s1"), `${dir}/plan.txt`)), "the plan", "a member's default assistant");
  raw.calls.length = 0;
  for (const [who, name] of [[owner, "the Space owner"], [ada, "an admin"], [dan, "another member"], [as(DAN, "assistant", "s2"), "another member's assistant"], [as(BOB, "spy", "s3"), "an agent that is not a teammate"], [as(BOB, "kit", "s4"), "a teammate with no task"]]) {
    await assert.rejects(() => D.get(who, `${dir}/plan.txt`), { code: "not_found" }, `get by ${name}`);
    await assert.rejects(() => D.put(who, `${dir}/x.txt`, enc("x")), { code: "not_found" }, `put by ${name}`);
    await assert.rejects(() => D.history(who, `${dir}/plan.txt`), { code: "not_found" }, `history by ${name}`);
  }
  assert.deepEqual(raw.calls, [], "refused before the Drive was touched");
});

test("a teammate opens the project's files only while it works a task there, and every read by an agent is in the log with its chain", async () => {
  const { k, D, owner, bob, as, dir, project } = await rig();
  await D.put(bob, `${dir}/brief.txt`, enc("brief"));
  const kit = as(BOB, "kit", "s5");
  await assert.rejects(() => D.get(kit, `${dir}/brief.txt`), { code: "not_found" }, "before it has a task");
  const svc = k.kernelFor({ name: "work", needs: { kernel: { actions: ["tasks.request", "tasks.read", "records.read"], prefixes: ["task/*", "project/*", "team-member/*"] } } });
  const t = await svc.tasks.request(owner, { title: "Draft the letter", doer: { kind: "agent", id: "kit", space: SPACE }, checker: { kind: "person", id: BOB, space: SPACE }, output: { kind: "note" }, project: project.urn });
  assert.equal(dec(await D.get(kit, `${dir}/brief.txt`)), "brief", "with a ready task in this project");
  const reads = k.log.read({ type: "file.accessed" }).filter(e => e.data && e.data.what !== "stat");
  assert.ok(reads.some(e => JSON.stringify(e).includes("kit")), "the teammate's read is in the log, with its agent in the chain");
});
