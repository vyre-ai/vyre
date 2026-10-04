// @ts-check
// What a teammate starts with, on the REAL kernel (test/kernel-rig.js): records read through the real gateway under the teammate's own chain, sealed fields as
// placeholders, labels from the kernel, and an unreadable or foreign link skipped and named.
import "../../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createRig } from "../../../test/kernel-rig.js";
import { teammateContext, parseUrn } from "./context.js";
import { memberLabels } from "../../../lib/labels.js";

const CLIENT = { name: "client", label: "Client", fields: [{ name: "name", kind: "text", label: "Name" }, { name: "note", kind: "text", label: "Note" }, { name: "ssn", kind: "sealed", label: "SSN", seal: { level: "ai", class: "us-ssn" } }] };
const PROJECT = { name: "project", label: "Project", fields: [{ name: "name", kind: "text", label: "Name" }, { name: "client", kind: "link", label: "Client" }, { name: "other", kind: "link", label: "Other" }, { name: "foreign", kind: "link", label: "Foreign" }, { name: "bank", kind: "sealed", label: "Bank", seal: { level: "ai", class: "bank-account" } }] };
const MATTER = { name: "matter", label: "Matter", fields: [{ name: "name", kind: "text", label: "Name" }] };

async function world() {
  const rig = await createRig({ agents: ["research"], defs: [CLIENT, PROJECT, MATTER] });
  const alex = rig.actor("person", "per_alex"), research = rig.actor("agent", "research");
  await rig.grantTo(research, ["records.read"]);
  const client = await rig.create("client", { name: "Jane Doe", note: "n", ssn: { sealed: "us-ssn", ref: "seal_9", present: true, valid_format: true, set_at: 1 } });
  const project = await rig.create("project", { name: "Estate plan for Jane Doe", client: { urn: client.urn }, bank: { sealed: "bank-account", ref: "seal_7", present: true, valid_format: true, set_at: 1, hint: "1234" } });
  return { rig, alex, research, client, project, chain: rig.assistant("per_alex", "research") };
}

test("a teammate starts with its role, the project and its linked records, with sealed fields as placeholders only", async () => {
  const { rig, client, project, chain } = await world();
  const ctx = await teammateContext(rig.kernel, chain, { project: project.urn, space: rig.space, role: { name: "Research", instructions: { text: "Read about the client.", labels: memberLabels(rig.space), reviewed: true } } });
  assert.match(ctx.text, /## Role: Research/);
  assert.match(ctx.text, /name: Estate plan for Jane Doe/);
  assert.match(ctx.text, /name: Jane Doe/);
  assert.match(ctx.text, /ssn: sealed, present/);
  assert.match(ctx.text, /bank: sealed, present/);
  assert.doesNotMatch(ctx.text, /seal_9|seal_7|1234|"ref"/);
  assert.deepEqual(ctx.urns, [project.urn, client.urn]);
});

test("the context is labelled by what it drew on: a record changed outside the gateway and unreviewed Kit text taint it", async () => {
  const { rig, client, project, chain } = await world();
  const clean = await teammateContext(rig.kernel, chain, { project: project.urn, space: rig.space });
  assert.equal(clean.labels.trust, "member");
  await rig.k.store.update("client", client.id, { note: "edited behind the kernel" }, client.version);
  const ctx = await teammateContext(rig.kernel, chain, { project: project.urn, space: rig.space, role: { name: "Research", instructions: "From a Kit." } });
  assert.equal(ctx.labels.trust, "external");
  assert.match(ctx.text, /from a Kit, not yet reviewed/);
});

test("a person-chain read still never puts a reference in the text", async () => {
  const { rig, project } = await world();
  const ctx = await teammateContext(rig.kernel, rig.ownerChain, { project: project.urn, space: rig.space });
  assert.doesNotMatch(ctx.text, /seal_9|seal_7/);
});

test("a linked record the teammate may not read, or in another Space, is skipped and named", async () => {
  const { rig, research, chain } = await world();
  // The teammate may read projects only (a deeper prefix than the world's blanket read): its first grant is replaced by a narrow one.
  const rig2 = await createRig({ agents: ["research"], defs: [CLIENT, PROJECT, MATTER] });
  await rig2.grantTo(research, ["records.read"], `vyre://${rig2.space}/project/*`);
  const secret = await rig2.create("matter", { name: "Privileged" });
  const project = await rig2.create("project", { name: "P", other: { urn: secret.urn }, foreign: { urn: "vyre://spc_other/client/abc" } });
  const ctx = await teammateContext(rig2.kernel, rig2.assistant("per_alex", "research"), { project: project.urn, space: rig2.space });
  assert.deepEqual(ctx.urns, [project.urn]);
  assert.equal(ctx.skipped.length, 2);
  assert.doesNotMatch(ctx.text, /Privileged/);
  void rig; void chain;
});

test("the project must be an address, and a missing project is not found", async () => {
  const { rig } = await world();
  await assert.rejects(teammateContext(rig.kernel, rig.ownerChain, { project: "nope", space: rig.space }), { code: "bad_input" });
  await assert.rejects(teammateContext(rig.kernel, rig.ownerChain, { project: `vyre://${rig.space}/project/00000000-0000-4000-8000-000000000000`, space: rig.space }), { code: "not_found" });
  assert.deepEqual(parseUrn("vyre://s/t/i"), { space: "s", type: "t", id: "i" });
});
