// Per-project seat levels (team/0.3.4/ROLES-proposal.html section 3): lead, contributor, viewer, stored as `level` on a person's team-member row (none = contributor). A viewer reads the project and writes nothing in it
// (records, tasks, files, its team), refused in words that name the next step; a contributor works as before; a lead manages the project's team like its owner; and a level only NARROWS the Space role: a Guest who is
// "lead" can do nothing a Guest cannot. A real kernel with a project owner, a contributor, a viewer, a lead, a Guest who is lead, and an outsider.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createKernel } from "../index.js";
import { sealedDrive } from "../storage/sealed-drive.js";
import { Keys } from "../../lib/keywrap.js";
import { derive } from "../../lib/databox.js";
import { canonical, sha256 } from "../core/canonical.js";
import { PROJECT, TEAM_MEMBER, TASK } from "../../records/core-types.js";

const SPACE = "spc_aaaaaaaaaaaa", ADA = "per_ada", OWNER = "per_owner", BOB = "per_bob", EVE = "per_eve", VIK = "per_vik", LEE = "per_lee", GUS = "per_gus", FAY = "per_fay", NEW = "per_new";
const proof = (action, input, resource) => ({ op: `grant.${action.split(".")[1]}`, fields: { resource, input_hash: sha256(canonical({ action, input })) }, n: Math.random() });
const used = new Set();
const presence = { check: async ({ chain, op, fields, proof: p }) => (chain && p && p.op === op && canonical(p.fields) === canonical(fields) && !used.has(p.n) && (used.add(p.n), true) ? null : "wrong_payload") };
const MEMO = { name: "memo", label: "Memo", fields: [{ name: "body", kind: "text", label: "Body" }] };
const enc = s => new TextEncoder().encode(s);
const dec = b => new TextDecoder().decode(b);

function fakeDrive() {
  const files = new Map();
  return { files,
    async put(p, bytes, { by } = {}) { const f = files.get(p) || []; f.push({ ver: f.length + 1, bytes, by }); files.set(p, f); return { version: f.length }; },
    async get(p, { version } = {}) { const f = files.get(p); if (!f) throw Object.assign(new Error("nf"), { code: "not_found" }); return f[(version ?? f.length) - 1].bytes; },
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
  for (const [p, role] of [[BOB, "member"], [EVE, "member"], [VIK, "member"], [LEE, "member"], [ADA, "admin"], [GUS, "temp"], [FAY, "member"], [NEW, "member"]]) {
    // a Guest (role temp) is scoped to the types it works in and expires
    const r = role === "temp" ? { person: p, role, scope: ["project", "team-member", "memo", "task"].map(t => `vyre://${SPACE}/${t}/*`), expires: Date.now() + 3_600_000 } : { person: p, role };
    await k.gateway.grants.setRole(owner, r, { presence: proof("grants.role", r, `vyre://${SPACE}/member/${p}`) });
  }
  k.kernelFor({ name: "work", needs: { kernel: { actions: ["records.read"] } } });   // the work module reads a project's team for the files guard
  const R = k.gateway.records, T = k.gateway.ask, D = k.gateway.drive;
  await R.define(owner, { add_types: [PROJECT, TEAM_MEMBER, TASK, MEMO].map(t => ({ ...t, fields: t.fields.filter(f => f.name !== "client" && f.name !== "contact") })) });
  const person = id => ({ actor: { kind: "person", id, space: SPACE } });
  const p1 = await R.create(owner, "project", { name: "One", slug: "one", owner: person(BOB) });
  const seat = (p, extra = {}) => R.create(owner, "team-member", { name: p, actor: person(p), kind: "person", project: { urn: p1.urn }, ...extra });
  await seat(EVE);                           // no level: a contributor
  await seat(VIK, { level: "viewer" });
  await seat(LEE, { level: "lead" });
  await seat(GUS, { level: "lead" });        // a Guest, made lead
  await seat(BOB, { level: "contributor" }); // the project's own owner also has a row
  await seat(ADA, { level: "viewer" });      // an admin with a viewer seat: a seat never narrows the Space's staff
  const dev = (p, id) => k.chains.fromFacts({ kind: "device", device_key_id: id, person: p, path: "direct" });
  const chains = { owner, bob: dev(BOB, "d-b"), eve: dev(EVE, "d-e"), vik: dev(VIK, "d-v"), lee: dev(LEE, "d-l"), ada: dev(ADA, "d-a"), gus: dev(GUS, "d-g"), fay: dev(FAY, "d-f") };
  const ask = (by, doer, project) => T.request(by, { title: "t", doer: { kind: "person", id: doer, space: SPACE }, output: { kind: "note" }, ...(project ? { project } : {}) });
  return { k, R, T, D, raw, owner, chains, p1, person, seat, ask, dir: `Projects/${p1.id}/files` };
}
/** a refusal in words: not_allowed, saying the person is a viewer and who to ask */
const readOnly = p => assert.rejects(p, e => e.code === "not_allowed" && /read-only access to this project \(viewer\)/.test(e.message) && /Ask the project's owner or a lead/.test(e.message));
const refused = (p, re) => assert.rejects(p, e => e.code === "not_allowed" && (!re || re.test(e.message)));

test("a viewer reads the project and writes nothing in it: records, tasks, files and its team are refused in words", async () => {
  const { R, D, chains, p1, person, ask, dir } = await rig();
  const memo = await R.create(chains.eve, "memo", { body: "by a contributor" }, { attrs: { project: p1.id } });
  const task = await ask(chains.bob, EVE, p1.urn);
  await D.put(chains.bob, `${dir}/plan.txt`, enc("the plan"));
  // reads stay open: who can read the memo a contributor filed under the project (a diagnostic that names who cannot)
  const cannot = [];
  for (const [name, c] of Object.entries({ owner: chains.owner, bob: chains.bob, eve: chains.eve, vik: chains.vik })) { try { await R.get(c, "memo", memo.id); } catch (e) { cannot.push(`${name}: ${e.code} ${e.message}`); } }
  assert.deepEqual(cannot, [], "everyone on the project, and the owner, reads the memo");
  assert.equal((await R.get(chains.vik, "memo", memo.id)).data.body, "by a contributor", "a viewer reads a record in the project");
  assert.ok(await R.get(chains.vik, "task", task.id), "and a task");
  assert.equal(dec(await D.get(chains.vik, `${dir}/plan.txt`)), "the plan", "and a file");
  // writes are refused
  await readOnly(R.create(chains.vik, "memo", { body: "no" }, { attrs: { project: p1.id } }));
  await readOnly(R.update(chains.vik, "memo", memo.id, { body: "edited" }, memo.version));
  await readOnly(R.remove(chains.vik, "memo", memo.id, memo.version));
  await readOnly(ask(chains.vik, VIK, p1.urn));
  await readOnly(R.update(chains.vik, "task", task.id, { title: "renamed" }, (await R.get(chains.owner, "task", task.id)).version));
  await readOnly(D.put(chains.vik, `${dir}/new.txt`, enc("x")));
  await readOnly(D.put(chains.vik, `${dir}/plan.txt`, enc("overwrite")));
  await readOnly(R.update(chains.vik, "project", p1.id, { name: "mine" }, p1.version));
  await refused(R.create(chains.vik, "team-member", { name: "fay", actor: person(FAY), kind: "person", project: { urn: p1.urn } }), /owner or a lead/);
  assert.equal(dec(await D.get(chains.bob, `${dir}/plan.txt`)), "the plan", "nothing was overwritten");
});

test("a contributor, and a seat with no level, work as before: records, tasks and files; the team stays the owner's and a lead's", async () => {
  const { R, D, chains, p1, person, ask, dir } = await rig();
  const memo = await R.create(chains.eve, "memo", { body: "one" }, { attrs: { project: p1.id } });
  assert.ok(await R.update(chains.eve, "memo", memo.id, { body: "two" }, memo.version), "a contributor edits a record");
  assert.ok(await ask(chains.eve, EVE, p1.urn), "asks a task in the project");
  assert.ok(await D.put(chains.eve, `${dir}/a.txt`, enc("a")), "writes a file");
  assert.ok(await R.update(chains.eve, "project", p1.id, { name: "renamed by team" }, p1.version), "and a project's name, as a team member always could");
  await refused(R.create(chains.eve, "team-member", { name: "fay", actor: person(FAY), kind: "person", project: { urn: p1.urn } }), /owner or a lead/);
});

test("a lead manages the project's team like its owner: adds a seat, sets a level; nobody else on the team does", async () => {
  const { R, k, chains, p1, person, seat } = await rig();
  const added = await R.create(chains.lee, "team-member", { name: "fay", actor: person(FAY), kind: "person", level: "viewer", project: { urn: p1.urn } });
  assert.equal(added.data.level, "viewer", "a lead adds a person at a level");
  const up = await R.update(chains.lee, "team-member", added.id, { level: "contributor" }, added.version);
  assert.equal(up.data.level, "contributor", "and changes it");
  assert.equal((await R.update(chains.lee, "project", p1.id, { repo: "github.com/x/y" }, p1.version)).data.repo, "github.com/x/y", "a lead edits the project's settings, which a plain team member may not");
  await refused(R.update(chains.eve, "project", p1.id, { repo: "github.com/x/z" }, (await R.get(chains.owner, "project", p1.id)).version), /Ask the project's owner/);
  // the owner of a project does the same
  assert.ok(await R.create(chains.bob, "team-member", { name: "x", actor: person(NEW), kind: "person", project: { urn: p1.urn } }), "the owner seats a person");
  // a lead still seats only a PERSON, and routes no work (the kernel's rule for any non-staff writer)
  await refused(R.create(chains.lee, "team-member", { name: "bot", actor: { actor: { kind: "agent", id: "bot", space: SPACE } }, kind: "assistant", project: { urn: p1.urn } }), /seats a person/);
  void k; void seat;
});

test("a level never widens the Space role: a Guest who is a lead cannot manage the team, and a viewer is a viewer whatever the Space role", async () => {
  const { R, chains, p1, person } = await rig();
  await refused(R.create(chains.gus, "team-member", { name: "fay", actor: person(FAY), kind: "person", project: { urn: p1.urn } }), /owner or a lead/);
  const gusSeat = (await R.query(chains.owner, "team-member", { filter: { field: "name", op: "eq", value: GUS }, page: { limit: 1 } })).rows[0];
  await refused(R.update(chains.gus, "team-member", gusSeat.id, { level: "lead" }, gusSeat.version), /owner or a lead/);
  // a member who is not on the project is still outside it: a level is on a seat, and without a seat there is none
  await refused(R.create(chains.fay, "team-member", { name: "fay", actor: person(FAY), kind: "person", level: "lead", project: { urn: p1.urn } }), /owner or a lead/);
});

test("an admin or the Space owner with a viewer seat is not narrowed: records, tasks, files and team writes go through as a real admin write", async () => {
  const { R, D, chains, p1, person, ask, dir, seat } = await rig();
  await seat(OWNER, { level: "viewer" });
  for (const who of [chains.ada, chains.owner]) {
    const memo = await R.create(who, "memo", { body: "staff writes" }, { attrs: { project: p1.id } });
    assert.ok(await R.update(who, "memo", memo.id, { body: "again" }, memo.version), "a record");
    assert.ok(await ask(who, FAY, p1.urn), "a task in the project");
    assert.ok(await D.put(who, `${dir}/staff-${who === chains.ada ? "a" : "o"}.txt`, enc("x")), "a file");
  }
  assert.ok(await R.create(chains.ada, "team-member", { name: "n", actor: person(NEW), kind: "person", project: { urn: p1.urn } }), "the team");
});

test("a level outside lead, contributor and viewer is refused on write; a lead may seat another lead; a lead's change to the project owner's own row changes nothing for the owner", async () => {
  const { R, chains, p1, person } = await rig();
  await assert.rejects(R.create(chains.lee, "team-member", { name: "x", actor: person(NEW), kind: "person", level: "owner", project: { urn: p1.urn } }));
  await assert.rejects(R.create(chains.lee, "team-member", { name: "x", actor: person(NEW), kind: "person", level: "admin", project: { urn: p1.urn } }));
  const lead = await R.create(chains.lee, "team-member", { name: "x", actor: person(NEW), kind: "person", level: "lead", project: { urn: p1.urn } });
  assert.equal(lead.data.level, "lead", "a lead may seat another lead (the rule says so)");
  // the owner's own row demoted to viewer by a lead: the project's owner is never narrowed by a row
  const row = (await R.query(chains.owner, "team-member", { filter: { field: "name", op: "eq", value: BOB }, page: { limit: 1 } })).rows[0];
  await R.update(chains.lee, "team-member", row.id, { level: "viewer" }, row.version);
  const memo = await R.create(chains.bob, "memo", { body: "owner still writes" }, { attrs: { project: p1.id } });
  assert.ok(await R.update(chains.bob, "memo", memo.id, { body: "yes" }, memo.version), "the owner is not a viewer");
});
