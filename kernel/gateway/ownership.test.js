// Who may write a project, its team and a task: a member only where she owns or belongs, never giving herself a seat, never moving a task into a project she is not on. A real kernel with an owner and four
// members; each case shows what a plain write does today (it succeeds) and that the ownership rule refuses it.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createKernel } from "../index.js";
import { canonical, sha256 } from "../core/canonical.js";
import { mayWrite } from "./ownership.js";
import { PROJECT, TEAM_MEMBER, TASK } from "../../records/core-types.js";

const SPACE = "spc_aaaaaaaaaaaa", OWNER = "per_owner", ADMIN = "per_admin", BOB = "per_bob", DAN = "per_dan", EVE = "per_eve", FAY = "per_fay";
const proof = (action, input, resource) => ({ op: `grant.${action.split(".")[1]}`, fields: { resource, input_hash: sha256(canonical({ action, input })) }, n: Math.random() });
const used = new Set();
const presence = { check: async ({ chain, op, fields, proof: p }) => (chain && p && p.op === op && canonical(p.fields) === canonical(fields) && !used.has(p.n) && (used.add(p.n), true) ? null : "wrong_payload") };
async function rig() {
  const k = await createKernel({ space: SPACE, owner: OWNER, owner_uid: 501, key: Buffer.alloc(32, 7), presence });
  const owner = k.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: OWNER, path: "direct", session: "s" });
  for (const [p, role] of [[ADMIN, "admin"], [BOB, "member"], [DAN, "member"], [EVE, "member"], [FAY, "member"]]) { const r = { person: p, role }; await k.gateway.grants.setRole(owner, r, { presence: proof("grants.role", r, `vyre://${SPACE}/member/${p}`) }); }
  const R = k.gateway.records;
  await R.define(owner, { add_types: [PROJECT, TEAM_MEMBER, TASK].map(t => ({ ...t, fields: t.fields.filter(f => f.name !== "client" && f.name !== "contact") })) });
  const person = id => ({ actor: { kind: "person", id, space: SPACE } });
  const p1 = await R.create(owner, "project", { name: "One", slug: "one", owner: person(BOB) });
  const p2 = await R.create(owner, "project", { name: "Two", slug: "two", owner: person(DAN) });
  const seat = await R.create(owner, "team-member", { name: "eve", actor: person(EVE), kind: "person", project: { urn: p1.urn } });
  const dev = (p, id) => k.chains.fromFacts({ kind: "device", device_key_id: id, person: p, path: "direct" });
  const svc = k.kernelFor({ name: "work", needs: { kernel: { actions: ["tasks.request", "tasks.read", "records.read"], prefixes: ["task/*", "project/*", "team-member/*"] } } });
  const mk = async (by, doer, project) => { const t = await svc.tasks.request(by, { title: "t", doer: { kind: "person", id: doer, space: SPACE }, output: { kind: "note" }, ...(project ? { project } : {}) }); return R.get(owner, "task", t.id); };
  const t1 = await mk(dev(BOB, "d-b"), EVE, p1.urn);
  const tFree = await mk(dev(FAY, "d-f"), FAY);
  const chains = { owner, admin: dev(ADMIN, "d-a"), bob: dev(BOB, "d-b"), dan: dev(DAN, "d-d"), eve: dev(EVE, "d-e"), fay: dev(FAY, "d-f") };
  const taskOf = async id => { const t = await svc.tasks.get(owner, id); return t ? { doer: t.doer, assigned_by: t.assigned_by, project: t.project || null } : null; };
  const rawProject = async ref => {
    const id = String(ref).split("/").pop();
    const pr = await R.get(owner, "project", id).catch(() => null);
    if (!pr) return null;
    const rows = (await R.query(owner, "team-member", { filter: { field: "project", op: "eq", value: { urn: pr.urn } }, page: { limit: 100 } })).rows;
    return { owner: pr.data.owner && pr.data.owner.actor ? pr.data.owner.actor.id : null, team: rows.filter(r => r.data.actor && r.data.actor.actor && r.data.actor.actor.kind === "person").map(r => r.data.actor.actor.id) };
  };
  const trustedOf = c => ["owner", "admin"].includes(c === chains.owner ? "owner" : c === chains.admin ? "admin" : "member");
  /** the guarded write: the rule first, then the real write on the member's own chain */
  const write = async (who, op, type, id, patch) => {
    const chain = chains[who];
    const row = op === "create" ? null : await R.get(owner, type, id);
    await mayWrite(chain, type, row, patch, { op, trusted: trustedOf(chain), project: rawProject, task: taskOf });
    if (op === "create") return R.create(chain, type, patch);
    if (op === "update") return R.update(chain, type, id, patch, row.version);
    return R.remove(chain, type, id, row.version);
  };
  return { k, R, owner, chains, p1, p2, seat, t1, tFree, person, write };
}
const refused = (p, re) => assert.rejects(p, e => e.code === "not_allowed" && (!re || re.test(e.message)));

test("a plain write today lets any member rewrite another's project, give herself a team seat and move a task anywhere (the problem)", async () => {
  const { R, chains, p1, p2, person, t1 } = await rig();
  assert.ok(await R.update(chains.fay, "project", p1.id, { name: "taken" }, p1.version), "FAY edits BOB's project");
  assert.ok(await R.create(chains.fay, "team-member", { name: "fay", actor: person(FAY), kind: "person", project: { urn: p2.urn } }), "FAY seats herself on DAN's project");
  assert.ok(await R.update(chains.fay, "task", t1.id, { project: { urn: p2.urn } }, t1.version), "FAY moves a task of project one into project two");
});

test("project: the owner and the team write it; another member does not; the owner field is never changed by a member; only the owner removes it", async () => {
  const { chains, p1, p2, write } = await rig();
  assert.equal((await write("bob", "update", "project", p1.id, { name: "by owner" })).data.name, "by owner");
  const v = (await write("eve", "update", "project", p1.id, { name: "by team" })).data.name;
  assert.equal(v, "by team", "a team member writes it");
  await refused(write("fay", "update", "project", p1.id, { name: "x" }), /team/);
  await refused(write("dan", "update", "project", p1.id, { name: "x" }), /team/);
  await refused(write("bob", "update", "project", p1.id, { owner: { actor: { kind: "person", id: BOB } } , name: "same owner" }).then(() => write("bob", "update", "project", p1.id, { owner: { actor: { kind: "person", id: FAY } } })), /owner/);
  await refused(write("eve", "update", "project", p1.id, { owner: { actor: { kind: "person", id: EVE } } }), /owner/);
  await refused(write("eve", "remove", "project", p1.id, {}), /owner/);
  await refused(write("fay", "create", "project", null, { name: "new", slug: "new", owner: { actor: { kind: "person", id: BOB } } }), /yours/);
  assert.ok(await write("fay", "create", "project", null, { name: "mine", slug: "mine" }), "she makes her own project");
  assert.ok(await write("admin", "update", "project", p2.id, { name: "admin" }), "an admin passes");
  assert.ok(await write("owner", "update", "project", p2.id, { owner: { actor: { kind: "person", id: BOB } } }), "so does the owner, owner field included");
  assert.ok(await write("bob", "remove", "project", p1.id, {}), "the project's owner removes it");
});

test("team-member: only the project's owner (or an owner or admin) adds, changes or removes a seat; a seat cannot be moved to a project she does not own", async () => {
  const { chains, p1, p2, seat, person, write } = await rig();
  await refused(write("fay", "create", "team-member", null, { name: "fay", actor: person(FAY), kind: "person", project: { urn: p1.urn } }), /owner/);
  await refused(write("eve", "create", "team-member", null, { name: "eve2", actor: person(EVE), kind: "person", project: { urn: p1.urn } }), /owner/);
  await refused(write("eve", "update", "team-member", seat.id, { role: "partner" }), /owner/);
  await refused(write("eve", "remove", "team-member", seat.id, {}), /owner/);
  await refused(write("bob", "update", "team-member", seat.id, { project: { urn: p2.urn } }), /owner/);
  await refused(write("fay", "create", "team-member", null, { name: "loose", actor: person(FAY), kind: "person" }), /belongs to a project/);
  const added = await write("bob", "create", "team-member", null, { name: "fay", actor: person(FAY), kind: "person", project: { urn: p1.urn } });
  assert.ok(added, "the project's owner seats her");
  assert.equal((await write("bob", "update", "team-member", added.id, { role: "paralegal" })).data.role, "paralegal");
  assert.ok(await write("bob", "remove", "team-member", added.id, {}));
  assert.ok(await write("admin", "create", "team-member", null, { name: "x", actor: person(DAN), kind: "person", project: { urn: p1.urn } }), "an admin passes");
  void chains;
});

test("task: whoever it is for, whoever gave it, or its project's owner or team change it; nobody else; never into a project she is not on", async () => {
  const { p1, p2, t1, tFree, write } = await rig();
  assert.ok(await write("eve", "update", "task", t1.id, { title: "by doer" }), "the doer");
  assert.ok(await write("bob", "update", "task", t1.id, { title: "by giver and owner" }), "the one who gave it");
  await refused(write("fay", "update", "task", t1.id, { title: "x" }), /whoever it is for/);
  await refused(write("dan", "update", "task", t1.id, { title: "x" }), /whoever it is for/);
  await refused(write("dan", "update", "task", tFree.id, { title: "x" }), /whoever it is for/);
  assert.ok(await write("fay", "update", "task", tFree.id, { title: "own to-do" }), "her own to-do with no project");
  await refused(write("eve", "update", "task", t1.id, { project: { urn: p2.urn } }), /only into a project you are on/);
  await refused(write("fay", "update", "task", tFree.id, { project: { urn: p1.urn } }), /only into a project you are on/);
  await refused(write("fay", "create", "task", null, { title: "new", project: { urn: p1.urn } }), /only into a project you are on/);
  assert.ok(await write("dan", "create", "task", null, { title: "new in two", project: { urn: p2.urn } }), "a task into her own project");
  assert.ok(await write("admin", "update", "task", t1.id, { project: { urn: p2.urn } }), "an admin moves it");
});
