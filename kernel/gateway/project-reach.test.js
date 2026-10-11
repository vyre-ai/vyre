// An agent reaches a project's records, memory and chats only while it is the project's teammate on a task there (G22; the same rule as the project's files, kernel/gateway/project-members.js): the
// default assistant always (for a member), a teammate while it has a ready or working task in the project, anyone else never, not even by a grant of its own. A person is not affected. Real kernel.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createKernel } from "../index.js";
import { canonical, sha256 } from "../core/canonical.js";
import { PROJECT, TEAM_MEMBER, TASK } from "../../records/core-types.js";

const SPACE = "spc_aaaaaaaaaaaa", OWNER = "per_owner", BOB = "per_bob", DAN = "per_dan";
const proof = (action, input, resource) => ({ op: `grant.${action.split(".")[1]}`, fields: { resource, input_hash: sha256(canonical({ action, input })) }, n: Math.random() });
const used = new Set();
const presence = { check: async ({ chain, op, fields, proof: p }) => (chain && p && p.op === op && canonical(p.fields) === canonical(fields) && !used.has(p.n) && (used.add(p.n), true) ? null : "wrong_payload") };
const NOTE = { name: "note", label: "Note", fields: [{ name: "text", kind: "text", label: "Text" }] };

async function rig() {
  const k = await createKernel({ space: SPACE, owner: OWNER, owner_uid: 501, key: Buffer.alloc(32, 7), presence });
  const owner = k.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: OWNER, path: "direct", session: "s" });
  const g = k.gateway.grants;
  for (const p of [BOB, DAN]) { const r = { person: p, role: "member" }; await g.setRole(owner, r, { presence: proof("grants.role", r, `vyre://${SPACE}/member/${p}`) }); }
  for (const name of ["kit", "spy", "assistant"]) { const a = { kind: "agent", id: name, space: SPACE }; await g.addActor(owner, a, { presence: proof("grants.role", { actor: a }, `vyre://${SPACE}/member/${name}`) }); }
  await k.gateway.records.define(owner, { add_types: [PROJECT, TEAM_MEMBER, NOTE].map(t => ({ ...t, fields: t.fields.filter(f => f.name !== "client" && f.name !== "contact") })) });
  const person = id => ({ actor: { kind: "person", id, space: SPACE } });
  const agent = id => ({ actor: { kind: "agent", id, space: SPACE } });
  const project = await k.gateway.records.create(owner, "project", { name: "Rivera", slug: "rivera", owner: person(BOB) });
  await k.gateway.records.create(owner, "team-member", { name: "kit", actor: agent("kit"), kind: "assistant", project: { urn: project.urn } });
  const other = await k.gateway.records.create(owner, "project", { name: "Other", slug: "other", owner: person(DAN) });
  const note = await k.gateway.records.create(owner, "note", { text: "the plan" }, { attrs: { project: project.id } });
  k.kernelFor({ name: "work", needs: { kernel: { actions: ["records.read"] } } });   // the module the project oracle reads the team through
  const grant = async (who, actions, prefix) => { const i = { subject: { kind: "actor", actor: { kind: "agent", id: who, space: SPACE } }, actions, resource: { prefix }, conditions: {}, source: "test" }; return g.create(owner, i, { presence: proof("grants.create", i, `vyre://${SPACE}/grant/new`) }); };
  for (const who of ["kit", "spy"]) { await grant(who, ["project.reach"], project.urn); await grant(who, ["records.read"], `vyre://${SPACE}/note`); }
  await grant("assistant", ["project.reach"], `vyre://${SPACE}/project/*`); await grant("assistant", ["records.read"], `vyre://${SPACE}/note`);
  const as = (p, name, session) => k.chains.fromFacts({ kind: "agent_session", vouched: true, person: p, agent: name, session });
  const dev = (p, id) => k.chains.fromFacts({ kind: "device", device_key_id: id, person: p, path: "direct" });
  const reach = (chain, p = project) => k.gateway.authorize({ chain, action: "project.reach", resource: p.urn }).then(d => d.effect);
  const read = (chain) => k.gateway.records.get(chain, "note", note.id).then(r => (r ? "read" : "not_found"), e => e.code);
  return { k, owner, project, other, note, as, dev, reach, read };
}

test("a teammate reaches the project's reach and records only while it has a task there; the assistant for a member always; a non-teammate with a grant of its own never; a person is unchanged", async () => {
  const { k, owner, project, as, dev, reach, read } = await rig();
  const kit = as(BOB, "kit", "s1"), spy = as(BOB, "spy", "s2"), assistant = as(BOB, "assistant", "s3");
  assert.equal(await reach(dev(BOB, "d-b")), "allow", "the project's owner");
  assert.equal(await reach(assistant), "allow", "a member's default assistant");
  assert.equal(await read(assistant), "read");
  assert.equal(await reach(kit), "deny", "a teammate with no task here");
  assert.equal(await read(kit), "not_found");
  assert.equal(await reach(spy), "deny", "an agent that is not on the team, whatever grant it holds");
  assert.equal(await read(spy), "not_found");
  const svc = k.kernelFor({ name: "work", needs: { kernel: { actions: ["tasks.request", "tasks.read", "records.read"], prefixes: ["task/*", "project/*", "team-member/*"] } } });
  await svc.tasks.request(owner, { title: "Draft the letter", doer: { kind: "agent", id: "kit", space: SPACE }, checker: { kind: "person", id: BOB, space: SPACE }, output: { kind: "note" }, project: project.urn });
  assert.equal(await reach(kit), "allow", "with a task in this project");
  assert.equal(await read(kit), "read");
  const logged = k.log.read({ type: "project.reached" }).filter(e => e.data && e.data.agent === "kit");
  assert.ok(logged.some(e => e.data.action === "records.read" && e.data.project === project.id) && logged.some(e => e.data.action === "project.reach"), "each allowed read by the teammate is in the log, with the project and the action");
  assert.ok(!k.log.read({ type: "project.reached" }).some(e => e.data && e.data.agent === "spy"), "and nothing was logged for a refusal");
  assert.equal(await reach(spy), "deny", "the task is kit's, not spy's");
});
