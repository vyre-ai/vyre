// @ts-check
// A project's story and its place in the project list are its team's: a member who is not on a project does not read its timeline by naming it, nor see it (or the server's folders and computers) in the project list. The owner and admins read all. A real daemon.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { boot, recordOf } from "../team/team-fixture.js";

test("a member reads the timeline of, and sees in the project list, only the projects she is on", { timeout: 150_000 }, async t => {
  const { project, d, tool, root } = await boot(t);
  const OWNER = d.kernel.id.owner, SPACE = d.kernel.id.space, BEN = "per_" + "c".repeat(26);
  const R = d.kernel.gateway.records, ask = d.kernel.gateway.ask;
  const oc = d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-owner", person: OWNER, path: "direct", session: "s" });
  await d.kernel.gateway.grants.setRole(oc, { person: BEN, role: "member" }, { presence: { op: "x", fields: {}, n: 2 } });
  const tok = async (/** @type {any} */ c) => ({ token: (await d.kernel.surfaces.open(c, {})).token });
  const own = await tok(oc), ben = await tok(d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-ben", person: BEN, path: "direct", session: "sb" }));
  // Ben's project is made the way the project list knows it (projects.create), then handed to him as its owner
  const made = await tool("projects.create", { name: "Bens" });
  const bensId = await recordOf(root, made);
  const rec = await R.get(oc, "project", bensId);
  await R.update(oc, "project", bensId, { owner: { actor: { kind: "person", id: BEN, space: SPACE } } }, rec.version);
  const bens = { id: bensId };
  const BS = made.slug;
  const urn = (/** @type {string} */ id) => `vyre://${SPACE}/project/${id}`;
  for (const [tag, id] of [["OWNERS", project.record], ["BENS", bens.id]]) {
    await ask.request(oc, { title: `${tag} task`, doer: { kind: "person", id: OWNER, space: SPACE }, output: { kind: "note" }, source: "manual", project: urn(id) });
    await R.create(oc, "communication", { kind: "email", at: new Date().toISOString(), subject: `${tag} email`, record: { urn: urn(id) } });
  }
  const call = (/** @type {string} */ name, /** @type {any} */ input, /** @type {string} */ caller, /** @type {any} */ who) => d.registry.call(name, input, caller, who);
  const titles = (/** @type {any} */ r) => ((r.data && r.data.entries) || []).map((/** @type {any} */ e) => e.title).sort();
  for (const caller of ["mcp", "harness"]) {
    for (const input of [{ project: project.slug }, { record: urn(project.record) }]) {
      const r = await call("work.timeline", input, caller, ben);
      assert.equal(r.error && r.error.code, "not_found", `${caller}: the timeline of a project he is not on is "no such project": ${JSON.stringify(input).slice(0, 40)}`);
    }
    assert.deepEqual(titles(await call("work.timeline", { project: BS }, caller, ben)), ["BENS email", "BENS task"], `${caller}: and his own is his`);
    assert.deepEqual(titles(await call("work.timeline", { record: urn(bens.id) }, caller, ben)), ["BENS email", "BENS task"], `${caller}: by address too`);
    const list = await call("projects.list", {}, caller, ben);
    const slugs = ((list.data && list.data.projects) || []).map((/** @type {any} */ p) => p.slug);
    assert.deepEqual(slugs, [BS], `${caller}: the project list is the projects she is on`);
    for (const p of list.data.projects) for (const k of ["home", "workspaces", "machine"]) assert.ok(!(k in p), `${caller}: no ${k} in a member's project row`);
  }
  // a token whose chain cannot be read is no one: it never gets the owner's list
  const lost = await call("projects.list", {}, "mcp", { token: "not-a-token" });
  assert.deepEqual(((lost.data && lost.data.projects) || []).map((/** @type {any} */ p) => p.slug), [], "a chain that cannot be read gets no projects, not the full list");
  // the owner: every project, with its folders
  assert.deepEqual(titles(await call("work.timeline", { project: project.slug }, "cli", own)), ["OWNERS email", "OWNERS task"], "the owner reads any project's timeline");
  const all = await call("projects.list", {}, "cli", own);
  assert.deepEqual(all.data.projects.map((/** @type {any} */ p) => p.slug).filter((/** @type {string} */ x) => !x.startsWith("personal-")).sort(), [BS, project.slug].sort(), "the owner lists every project");
  assert.ok(all.data.projects.every((/** @type {any} */ p) => "home" in p), "with its folder");
});
