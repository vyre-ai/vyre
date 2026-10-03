// @ts-check
import test from "node:test";
import assert from "node:assert/strict";
import { createFakeKernel } from "../../test/fake-kernel.js";
import { teammateContext, parseUrn } from "./context.js";
import { externalLabels, memberLabels } from "../../lib/labels.js";

function world() {
  const f = createFakeKernel();
  const alex = f.person("alex"), research = f.agent("research");
  f.grant(alex, ["record.read", "record.write"]); f.grant(research, ["record.read"]);
  const client = f.seed("client", { name: "Jane Doe", ssn: { sealed: "us-ssn", ref: "seal_9", present: true, valid_format: true, set_at: 1 } }, externalLabels("spc_test"));
  const project = f.seed("project", { name: "Estate plan for Jane Doe", client: { urn: client.urn }, bank: { sealed: "bank-account", ref: "seal_7", present: true, valid_format: true, set_at: 1, hint: "1234" } });
  return { f, alex, research, client, project };
}

test("a teammate starts with its role, the project and its linked records, with sealed fields as placeholders only", async () => {
  const { f, alex, research, client, project } = world();
  f.sealValue("123-45-6789");
  const ctx = await teammateContext(f.kernel, f.chain([alex, research]), { project: project.urn, space: "spc_test", role: { name: "Research", instructions: { text: "Read about the client.", labels: memberLabels("spc_test"), reviewed: true } }, templates: [{ name: "Welcome", body: "Dear {{client.name}}" }] });
  assert.match(ctx.text, /## Role: Research/);
  assert.match(ctx.text, /name: Estate plan for Jane Doe/);
  assert.match(ctx.text, /name: Jane Doe/);
  assert.match(ctx.text, /ssn: sealed, present/);
  assert.match(ctx.text, /bank: sealed, present/);
  assert.doesNotMatch(ctx.text, /seal_9|seal_7|1234|"ref"/);
  assert.deepEqual(ctx.urns, [project.urn, client.urn]);
  // the context itself can go through the inference door
  f.script(() => ({ content: "ok" }));
  await f.kernel.model.call({ chain: f.chain([research]), purpose: "session", provider: "x", model: "y", messages: [{ role: "user", content: ctx.text }] });
});

test("the context is labelled by what it drew on: external linked content and unreviewed Kit text taint it", async () => {
  const { f, alex, research, project } = world();
  const ctx = await teammateContext(f.kernel, f.chain([alex, research]), { project: project.urn, space: "spc_test", role: { name: "Research", instructions: "From a Kit." } });
  assert.equal(ctx.labels.trust, "external");
  assert.match(ctx.text, /from a Kit, not yet reviewed/);
});

test("a person-chain read still never puts a reference in the text", async () => {
  const { f, alex, project } = world();
  const ctx = await teammateContext(f.kernel, f.chain([alex]), { project: project.urn, space: "spc_test" });
  assert.doesNotMatch(ctx.text, /seal_9|seal_7/);
});

test("a linked record the teammate may not read, or in another Space, is skipped and named", async () => {
  const f = createFakeKernel();
  const alex = f.person("alex"), research = f.agent("research");
  f.grant(alex, ["record.read"]); f.grant(research, ["record.read"], "vyre://spc_test/project");
  const secret = f.seed("matter", { name: "Privileged" });
  const project = f.seed("project", { name: "P", links: [{ urn: secret.urn }, { urn: "vyre://spc_other/client/abc" }] });
  const ctx = await teammateContext(f.kernel, f.chain([alex, research]), { project: project.urn, space: "spc_test" });
  assert.deepEqual(ctx.urns, [project.urn]);
  assert.equal(ctx.skipped.length, 2);
  assert.doesNotMatch(ctx.text, /Privileged/);
});

test("the project must be an address, and a missing project is not found", async () => {
  const { f, alex } = world();
  await assert.rejects(teammateContext(f.kernel, f.chain([alex]), { project: "nope", space: "spc_test" }), { code: "bad_input" });
  await assert.rejects(teammateContext(f.kernel, f.chain([alex]), { project: "vyre://spc_test/project/none", space: "spc_test" }), { code: "not_found" });
  assert.deepEqual(parseUrn("vyre://s/t/i"), { space: "s", type: "t", id: "i" });
});
