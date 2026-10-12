// @ts-check
// A project's memory is read by its team: a member who is not on the project does not read its facts by naming it, and cannot file one into it. The owner does, and so does the project's own owner. A real daemon, a member's session.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { boot } from "../team/team-fixture.js";

test("a member reads a project's memory only when she is on the project: naming it is not enough", { timeout: 120_000 }, async t => {
  const { project, d } = await boot(t);
  const OWNER = d.kernel.id.owner, SPACE = d.kernel.id.space, BEN = "per_" + "c".repeat(26), ANA = "per_" + "d".repeat(26);
  const R = d.kernel.gateway.records;
  const chainOf = (/** @type {string} */ person, /** @type {string} */ dev) => d.kernel.chains.fromFacts({ kind: "device", device_key_id: dev, person, path: "direct", session: "s" });
  const oc = chainOf(OWNER, "d-owner");
  for (const [i, p] of [BEN, ANA].entries()) await d.kernel.gateway.grants.setRole(oc, { person: p, role: "member" }, { presence: { op: "x", fields: {}, n: 2 + i } });
  const tok = async (/** @type {any} */ c) => ({ token: (await d.kernel.surfaces.open(c, {})).token });
  const own = await tok(oc), ben = await tok(chainOf(BEN, "d-ben")), ana = await tok(chainOf(ANA, "d-ana"));
  // Ana owns a project of her own; the fixture's project is the owner's
  const anas = await R.create(oc, "project", { name: "Anas", slug: "anas", owner: { actor: { kind: "person", id: ANA, space: SPACE } } });
  const file = (/** @type {string} */ text, /** @type {string} */ scope, /** @type {any} */ who = own) => d.registry.call("memory.space.file", { text, source: "session:abc", scope }, "cli", who);
  assert.ok((await file("OWNERS-PROJECT-FACT", `project:${project.slug}`)).data, "owner files into the owner's project");
  assert.ok((await file("ANAS-PROJECT-FACT", `project:anas`)).data, "owner files into Ana's project");
  const seen = async (/** @type {any} */ who, /** @type {string} */ proj, caller = "mcp") => ((await d.registry.call("memory.space.recall", { project: proj }, caller, who)).data || { facts: [] }).facts.map((/** @type {any} */ f) => f.text);
  assert.deepEqual(await seen(own, project.record, "cli"), ["OWNERS-PROJECT-FACT"], "the owner reads the owner's project");
  assert.deepEqual(await seen(own, anas.id, "cli"), ["ANAS-PROJECT-FACT"], "and any project");
  for (const caller of ["mcp", "harness"]) {
    assert.deepEqual(await seen(ana, anas.id, caller), ["ANAS-PROJECT-FACT"], `${caller}: the project's owner reads her own, by id`);
    assert.deepEqual(await seen(ana, "anas", caller), ["ANAS-PROJECT-FACT"], `${caller}: and by slug`);
    assert.deepEqual(await seen(ben, project.record, caller), [], `${caller}: a member not on the owner's project reads none of it, by id`);
    assert.deepEqual(await seen(ben, project.slug, caller), [], `${caller}: nor by slug`);
    assert.deepEqual(await seen(ben, anas.id, caller), [], `${caller}: nor Ana's`);
    assert.deepEqual(await seen(ben, "no-such-project-xyz", caller), [], `${caller}: an unknown project reads nothing`);
  }
  const into = await file("INTO-ANAS", "project:anas", ben);
  assert.ok(into.error, "a member cannot file a fact into a project she is not on");
});
