// Who may write a project, its team and a task: a member only where she owns or belongs, never giving herself a seat, never moving a task into a project she is not on, and the same on every route
// (records, the tasks service). Ordinary teamwork keeps working. A real kernel with an owner, an admin and four members.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createKernel } from "../index.js";
import { canonical, sha256 } from "../core/canonical.js";
import { isTrustedChain } from "./ownership.js";
import { PROJECT, TEAM_MEMBER, TASK } from "../../records/core-types.js";

const SPACE = "spc_aaaaaaaaaaaa", OWNER = "per_owner", ADMIN = "per_admin", BOB = "per_bob", DAN = "per_dan", EVE = "per_eve", FAY = "per_fay";
const proof = (action, input, resource) => ({ op: `grant.${action.split(".")[1]}`, fields: { resource, input_hash: sha256(canonical({ action, input })) }, n: Math.random() });
const used = new Set();
const presence = { check: async ({ chain, op, fields, proof: p }) => (chain && p && p.op === op && canonical(p.fields) === canonical(fields) && !used.has(p.n) && (used.add(p.n), true) ? null : "wrong_payload") };
const MEMO = { name: "memo", label: "Memo", fields: [{ name: "body", kind: "text", label: "Body" }] };

async function rig() {
  const k = await createKernel({ space: SPACE, owner: OWNER, owner_uid: 501, key: Buffer.alloc(32, 7), presence });
  const owner = k.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: OWNER, path: "direct", session: "s" });
  for (const [p, role] of [[ADMIN, "admin"], [BOB, "member"], [DAN, "member"], [EVE, "member"], [FAY, "member"]]) { const r = { person: p, role }; await k.gateway.grants.setRole(owner, r, { presence: proof("grants.role", r, `vyre://${SPACE}/member/${p}`) }); }
  const R = k.gateway.records, T = k.gateway.ask;
  await R.define(owner, { add_types: [PROJECT, TEAM_MEMBER, TASK, MEMO].map(t => ({ ...t, fields: t.fields.filter(f => f.name !== "client" && f.name !== "contact") })) });
  const person = id => ({ actor: { kind: "person", id, space: SPACE } });
  const p1 = await R.create(owner, "project", { name: "One", slug: "one", owner: person(BOB) });
  const p2 = await R.create(owner, "project", { name: "Two", slug: "two", owner: person(DAN) });
  const seat = await R.create(owner, "team-member", { name: "eve", actor: person(EVE), kind: "person", project: { urn: p1.urn } });
  const dev = (p, id) => k.chains.fromFacts({ kind: "device", device_key_id: id, person: p, path: "direct" });
  const chains = { owner, admin: dev(ADMIN, "d-a"), bob: dev(BOB, "d-b"), dan: dev(DAN, "d-d"), eve: dev(EVE, "d-e"), fay: dev(FAY, "d-f") };
  const ask = (by, doer, project) => T.request(by, { title: "t", doer: { kind: "person", id: doer, space: SPACE }, output: { kind: "note" }, ...(project ? { project } : {}) }).then(t => R.get(owner, "task", t.id));
  const t1 = await ask(chains.bob, EVE, p1.urn);       // bob (project owner) gives eve a task in project one
  const tFree = await ask(chains.fay, FAY);             // fay's own to-do, no project
  return { k, R, T, owner, chains, p1, p2, seat, t1, tFree, person, ask };
}
const refused = (p, re) => assert.rejects(p, e => e.code === "not_allowed" && (!re || re.test(e.message)));

test("a member cannot rewrite another's project, seat herself on it, or move a task into it; every refusal names who can", async () => {
  const { R, chains, p1, p2, person, t1 } = await rig();
  await refused(R.update(chains.fay, "project", p1.id, { name: "taken" }, p1.version), /team|owner/);
  await refused(R.create(chains.fay, "team-member", { name: "fay", actor: person(FAY), kind: "person", project: { urn: p2.urn } }), /owner/);
  await refused(R.update(chains.fay, "task", t1.id, { project: { urn: p2.urn } }, t1.version), /whoever it is for|project/);
});

test("project: owner and team write it; another member does not; the owner field is never changed by a member; only the owner removes it; she makes her own", async () => {
  const { R, chains, p1, p2 } = await rig();
  const v1 = (await R.update(chains.bob, "project", p1.id, { name: "by owner" }, p1.version));
  assert.equal(v1.data.name, "by owner");
  assert.equal((await R.update(chains.eve, "project", p1.id, { name: "by team" }, v1.version)).data.name, "by team", "a team member writes it");
  await refused(R.update(chains.fay, "project", p1.id, { name: "x" }, 1), /team/);
  await refused(R.update(chains.dan, "project", p1.id, { name: "x" }, 1), /team/);
  const cur = await R.get(chains.owner, "project", p1.id);
  await refused(R.update(chains.bob, "project", p1.id, { owner: { actor: { kind: "person", id: FAY, space: SPACE } } }, cur.version), /owner/);
  await refused(R.update(chains.eve, "project", p1.id, { owner: { actor: { kind: "person", id: EVE, space: SPACE } } }, cur.version), /owner/);
  await refused(R.remove(chains.eve, "project", p1.id, cur.version), /owner/);
  await refused(R.create(chains.fay, "project", { name: "new", slug: "new", owner: { actor: { kind: "person", id: BOB, space: SPACE } } }), /yours/);
  assert.ok(await R.create(chains.fay, "project", { name: "mine", slug: "mine" }), "she makes her own project");
  assert.ok(await R.update(chains.admin, "project", p2.id, { name: "admin" }, p2.version), "an admin passes");
  assert.ok(await R.update(chains.owner, "project", p2.id, { owner: { actor: { kind: "person", id: BOB, space: SPACE } } }, (await R.get(chains.owner, "project", p2.id)).version), "so does the owner, owner field included");
  assert.ok(await R.remove(chains.bob, "project", p1.id, cur.version), "the project's owner removes it");
});

test("team-member: only the project's owner (or an owner or admin) adds, changes or removes a seat; so a member cannot make herself the doer of a pool or project-role ask", async () => {
  const { R, chains, p1, p2, seat, person } = await rig();
  await refused(R.create(chains.fay, "team-member", { name: "fay", actor: person(FAY), kind: "person", role: "paralegal", project: { urn: p1.urn } }), /owner/);
  await refused(R.create(chains.eve, "team-member", { name: "eve2", actor: person(EVE), kind: "person", project: { urn: p1.urn } }), /owner/);
  await refused(R.update(chains.eve, "team-member", seat.id, { role: "partner" }, seat.version), /owner/);
  await refused(R.remove(chains.eve, "team-member", seat.id, seat.version), /owner/);
  await refused(R.update(chains.bob, "team-member", seat.id, { project: { urn: p2.urn } }, seat.version), /owner/);
  await refused(R.create(chains.fay, "team-member", { name: "loose", actor: person(FAY), kind: "person" }), /belongs to a project/);
  const added = await R.create(chains.bob, "team-member", { name: "fay", actor: person(FAY), kind: "person", project: { urn: p1.urn } });
  assert.ok(added, "the project's owner seats her");
  assert.equal((await R.update(chains.bob, "team-member", added.id, { name: "fay renamed" }, added.version)).data.name, "fay renamed");
  assert.ok(await R.remove(chains.bob, "team-member", added.id, (await R.get(chains.owner, "team-member", added.id)).version));
  assert.ok(await R.create(chains.admin, "team-member", { name: "x", actor: person(DAN), kind: "person", project: { urn: p1.urn } }), "an admin passes");
});

test("task through records: its doer, giver, or its project's owner or team change it; nobody else; never into a project she is not on", async () => {
  const { R, chains, p1, p2, t1, tFree, owner } = await rig();
  const ver = async id => (await R.get(owner, "task", id)).version;
  assert.ok(await R.update(chains.eve, "task", t1.id, { title: "by doer" }, await ver(t1.id)), "the doer");
  assert.ok(await R.update(chains.bob, "task", t1.id, { title: "by giver and owner" }, (await R.get(chains.owner, "task", t1.id)).version), "the one who gave it");
  await refused(R.update(chains.fay, "task", t1.id, { title: "x" }, await ver(t1.id)), /whoever it is for/);
  await refused(R.update(chains.dan, "task", tFree.id, { title: "x" }, await ver(tFree.id)), /whoever it is for/);
  assert.ok(await R.update(chains.fay, "task", tFree.id, { title: "own to-do" }, await ver(tFree.id)), "her own to-do with no project");
  await refused(R.update(chains.eve, "task", t1.id, { project: { urn: p2.urn } }, await ver(t1.id)), /only into a project you are on/);
  await refused(R.update(chains.fay, "task", tFree.id, { project: { urn: p1.urn } }, await ver(tFree.id)), /only into a project you are on/);
  assert.ok(await R.update(chains.admin, "task", t1.id, { project: { urn: p2.urn } }, (await R.get(chains.owner, "task", t1.id)).version), "an admin moves it");
});

test("task through the tasks service (edit, skip, reopen, request): the same rule; the doer moves and submits; a stranger cannot", async () => {
  const { T, R, chains, p1, p2, t1, tFree, ask, owner } = await rig();
  await refused(T.edit(chains.fay, t1.id, { title: "x" }), /whoever it is for/);
  await refused(T.skip(chains.fay, t1.id, "no"), /whoever it is for/);
  await refused(T.edit(chains.eve, t1.id, { project: p2.urn }), /only into a project you are on/);
  await refused(ask(chains.fay, FAY, p1.urn), /only into a project you are on/);
  assert.ok(await T.edit(chains.eve, t1.id, { title: "doer edits" }), "the doer edits through the service");
  assert.ok(await T.edit(chains.bob, t1.id, { note: "the project owner edits" }), "the project's owner edits");
  // the doer works it: start, then complete with a note; a stranger cannot do either
  await assert.rejects(() => T.start(chains.fay, t1.id), e => ["not_allowed", "denied", "forbidden", "not_found"].includes(e.code));
  await T.start(chains.eve, t1.id);
  await assert.rejects(() => T.complete(chains.fay, t1.id, { note: "stolen", sources: ["https://x"] }), e => ["not_allowed", "denied", "forbidden", "not_found"].includes(e.code));
  assert.ok(await T.complete(chains.eve, t1.id, { note: "done", sources: ["https://x"] }), "the doer submits");
  // asking another member without a project works; her own to-do works; a task's project team member edits it
  const asked = await ask(chains.fay, EVE);
  assert.ok(asked, "a member asks another member");
  assert.ok(await T.edit(chains.fay, tFree.id, { title: "mine" }), "her own to-do");
  const proj = await ask(chains.bob, EVE, p1.urn);
  assert.ok(await T.edit(chains.eve, proj.id, { title: "team member edits a task in the project" }));
  assert.ok(await T.edit(chains.owner, proj.id, { title: "the owner reassigns anything" }));
  void R; void owner;
});

test("ordinary work is untouched: a member makes a task for herself, a contact-like record and a memo", async () => {
  const { R, chains } = await rig();
  assert.ok(await R.create(chains.fay, "task", { title: "my to-do" }), "a task with no project");
  assert.ok(await R.create(chains.fay, "memo", { body: "a note" }), "a type the rule does not name");
});

test("kernel attributes on create: a member names no other owner, and files nothing under a project she is not on (any type)", async () => {
  const { R, chains, p1, p2 } = await rig();
  await refused(R.create(chains.bob, "memo", { body: "into the other project" }, { attrs: { project: p2.id } }), /project you are on/);
  await refused(R.create(chains.fay, "memo", { body: "x" }, { attrs: { project: p1.id } }), /project you are on/);
  await refused(R.create(chains.fay, "memo", { body: "x" }, { attrs: { owner: BOB } }), /yours/);
  assert.ok(await R.create(chains.eve, "memo", { body: "on her own project" }, { attrs: { project: p1.id } }), "under a project she is on");
  assert.ok(await R.create(chains.fay, "memo", { body: "hers" }, { attrs: { owner: FAY } }), "owner herself");
  assert.ok(await R.create(chains.owner, "memo", { body: "owner may" }, { attrs: { project: p2.id, sensitivity: "privileged" } }), "the owner may");
});

test("a [member, work service] chain (the memory engine's) is not the work service: it is not trusted and writes no project owner, seat or task", async () => {
  const { k, R, chains, p1, p2, person } = await rig();
  const roleOf = a => (a.id === OWNER ? "owner" : a.id === ADMIN ? "admin" : "member");
  const viaWork = k.chains.forModule({ approver: chains.fay, module: "work" });
  const oneHop = k.chains.forModule({ approver: chains.owner, module: "work" });
  assert.equal(isTrustedChain(viaWork, roleOf), false, "[member, service:work] is not trusted");
  assert.equal(isTrustedChain(k.chains.fromFacts({ kind: "module", module: "work", first_party: true }), roleOf), true, "the work service's own one-hop chain is");
  assert.equal(isTrustedChain(oneHop, roleOf), true, "an owner acting through a service is the owner");
  for (const attempt of [
    R.create(viaWork, "project", { name: "x", slug: "x2", owner: { actor: { kind: "person", id: BOB, space: SPACE } } }),
    R.create(viaWork, "team-member", { name: "fay", actor: person(FAY), kind: "person", project: { urn: p1.urn } }),
    R.update(viaWork, "project", p2.id, { name: "taken" }, p2.version),
  ]) await assert.rejects(() => attempt, e => ["not_allowed", "not_found", "denied"].includes(e.code), "refused whichever check stops it first");
});

test("team seats: a project's owner adds a plain person; role, skills, instructions and assistant seats are for an owner or admin", async () => {
  const { R, chains, p1, person } = await rig();
  const seatOf = extra => ({ name: "fay", actor: person(FAY), kind: "person", project: { urn: p1.urn }, ...extra });
  await refused(R.create(chains.bob, "team-member", seatOf({ role: "attorney" })), /decides which work reaches the seat/);
  await refused(R.create(chains.bob, "team-member", seatOf({ skills: "probate" })), /decides which work/);
  await refused(R.create(chains.bob, "team-member", seatOf({ actor: { actor: { kind: "agent", id: "kit", space: SPACE } }, kind: "assistant" })), /person/);
  const plain = await R.create(chains.bob, "team-member", seatOf({}));
  assert.ok(plain, "a plain person is added");
  await refused(R.update(chains.bob, "team-member", plain.id, { role: "partner" }, plain.version), /decides which work/);
  assert.ok(await R.create(chains.admin, "team-member", seatOf({ name: "fay2", role: "attorney" })), "an admin may give a role");
});

test("project fields: a team member changes only the plain ones; the owner everything but the file, memory and credential fields and the owner; owner/admin all", async () => {
  const { R, chains, p1 } = await rig();
  const cur = async () => (await R.get(chains.owner, "project", p1.id)).version;
  assert.ok(await R.update(chains.eve, "project", p1.id, { due: "2030-01-01" }, await cur()), "team member: due");
  await refused(R.update(chains.eve, "project", p1.id, { repo: "git@evil:y" }, await cur()), /Ask the project's owner/);
  await refused(R.update(chains.eve, "project", p1.id, { drive_path: "/etc" }, await cur()), /files, memory or credentials/);
  await refused(R.update(chains.eve, "project", p1.id, { lead: "kit" }, await cur()), /Ask the project's owner/);
  assert.ok(await R.update(chains.bob, "project", p1.id, { lead: "kit", template: "t1" }, await cur()), "owner: lead and template fields");
  await refused(R.update(chains.bob, "project", p1.id, { memory_scope: "other" }, await cur()), /files, memory or credentials/);
  await refused(R.update(chains.bob, "project", p1.id, { slug: "renamed" }, await cur()), /owner or admin/);
  await refused(R.create(chains.fay, "project", { name: "n", slug: "n9", drive_path: "/etc" }), /owner or admin/);
  await refused(R.create(chains.fay, "project", { name: "n", slug: "n9", memory_scope: "project:one" }), /owner or admin/);
  assert.ok(await R.create(chains.fay, "project", { name: "n", slug: "n9", memory_scope: "project:n9" }), "a new project gets its own memory scope");
  assert.ok(await R.update(chains.admin, "project", p1.id, { drive_path: "Projects/one" }, await cur()), "an admin may");
});

// Every call of the tasks service is classified here. A call added later that is not in this table fails the test, so it cannot reach a member without someone deciding which rule guards it.
const TASK_CALLS = {
  // judged by the ownership rule (kernel/gateway/ownership.js): doer, giver, or the project's owner or team
  ownership: ["request", "edit", "skip", "reopen", "unblock"],
  // moved only by the actor the task names (the doer works it, the checker decides it; isDoer / checkersOf in kernel/tasks/tasks.js): a stranger is refused by that rule
  actor: ["start", "complete", "revise", "decide", "stuck", "observeDenial", "declineFix"],
  // reads, or kernel-internal bookkeeping with no person to speak of
  // the boot-time move of task words onto records: it takes no chain, runs as the tasks module's own chain and writes nothing a caller names
  internal: ["migrate"],
  read: ["get", "list", "needsYou", "card", "facts", "approvalFor", "kitApproval", "approvedAct", "useApproval", "approved", "scrubTexts"],
};

test("every call of the tasks service is classified: a new write that no rule covers fails here", async () => {
  const { T } = await rig();
  const known = new Set(Object.values(TASK_CALLS).flat());
  const unclassified = Object.keys(T).filter(n => typeof T[n] === "function" && !n.startsWith("_") && !known.has(n));
  assert.deepEqual(unclassified, [], "classify these in TASK_CALLS (ownership, actor or read)");
});

test("the actor-gated task calls refuse a stranger; unblock cannot hand a task to the stranger or take it for herself", async () => {
  const { T, chains, p1, p2, ask } = await rig();
  const t = await ask(chains.bob, EVE, p1.urn);
  const stranger = chains.fay;
  const refusedAny = (p) => assert.rejects(p, e => ["not_allowed", "denied", "forbidden", "not_found", "chain_not_person", "bad_state", "needs_presence", "presence_required"].includes(e.code), "refused");
  await refusedAny(T.start(stranger, t.id));
  await refusedAny(T.complete(stranger, t.id, { note: "x", sources: ["https://x"] }));
  await T.start(chains.eve, t.id);
  await refusedAny(T.stuck(stranger, t.id, { reason: "not mine" }));
  await refusedAny(T.revise(stranger, t.id, "no"));
  await refusedAny(T.decide(stranger, t.id, { outcome: "approved" }));
  // the doer says it is stuck; a stranger cannot unblock it, nor take it; its project's owner can hand it to someone on the project, not to a stranger
  await T.stuck(chains.eve, t.id, { reason: "waiting on a file" });
  await refusedAny(T.unblock(stranger, t.id, {}));
  await refusedAny(T.unblock(stranger, t.id, { reassign_to: { kind: "person", id: FAY, space: SPACE } }));
  await assert.rejects(() => T.unblock(chains.bob, t.id, { reassign_to: { kind: "person", id: FAY, space: SPACE } }), e => e.code === "not_allowed" && /someone on its project/.test(e.message), "the owner cannot hand it to someone off the project");
  void p2;
});
