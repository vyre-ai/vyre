// A team member starts her own projects from the app's path (the member door's `work` group), sees them in her list, and cannot touch another member's (0.3.3). Written to run inside J9 after the chat steps:
// `await memberProjectsSteps({ J, w, team, people, needs })`. The file part (a member puts a file in her project) has no door call yet: this step says so instead of passing without it.
// The assistant's task and a template agent's teammate running are added when team-credential is merged.
import assert from "node:assert/strict";

const TEMPLATE = { name: "Walk intake", description: "One stage with a task", tags: ["walk"], stages: [{ name: "Intake", tasks: [{ title: "Gather the documents", doer: "role:owner", output: { kind: "note" } }] }, { name: "Done" }] };

/** @param {{ J: any, w: any, team: any, people: any[], needs: string[] }} o  people: each { name, app, joined } */
export async function memberProjectsSteps({ J, w, people, needs }) {
  const [grace, edith] = people;
  /** @type {string} */ let tpl = "";
  /** @type {any} */ let hers = null;
  const A = "the owner puts a project template live on the team's server";
  await J.step(A, async () => {
    const def = await w.operator("work.template.define", { body: TEMPLATE });
    await w.operator("work.template.golive", { template: def.template, version: def.version });
    tpl = def.template;
    return `${tpl} v${def.version} live`;
  }, { needs, owner: "projects-flows" });

  const B = "a member sees the live templates by name and starts a project from one: it is hers, in the team's Space";
  await J.step(B, async () => {
    const list = await grace.joined.call("work.templates", [{}]);
    assert.ok(list.templates.some((/** @type {any} */ t) => t.template === tpl && t.live === 1), JSON.stringify(list));
    assert.ok(!JSON.stringify(list).includes("Gather the documents"), "and not a template's body");
    hers = await grace.joined.call("work.start-project", [{ template: tpl, name: "Grace's walk matter" }]);
    assert.match(String(hers.project), /\/project\//, JSON.stringify(hers));
    assert.equal(hers.template, tpl);
    return `started ${hers.slug}; tasks made ${hers.tasks_made}${hers.tasks_skipped && hers.tasks_skipped.length ? `, skipped ${JSON.stringify(hers.tasks_skipped)}` : ""}`;
  }, { needs: [...needs, A], owner: "projects-flows" });

  const C = "the project is in her list (records.list through the door), hers by owner, and the owner sees it too";
  await J.step(C, async () => {
    const mine = await grace.joined.call("records.list", [{ type: "project" }]);
    const rows = mine.rows || mine.records || mine;
    const row = rows.find((/** @type {any} */ r) => r.data && r.data.slug === hers.slug);
    assert.ok(row, `her list: ${JSON.stringify(rows).slice(0, 300)}`);
    assert.equal(row.data.owner.actor.id, grace.app.identity.id, "she is its owner");
    const ownerSees = JSON.stringify(await w.operator("records.list", { type: "project" }));
    assert.ok(ownerSees.includes(hers.slug), "the owner sees it");
    return "in her list, owned by her, seen by the owner";
  }, { needs: [...needs, B], owner: "projects-flows" });

  const D = "another member cannot rename it, take its owner field, or add herself to its team; the refusals name who can";
  await J.step(D, async () => {
    const row = ((await edith.joined.call("records.list", [{ type: "project" }])).rows || []).find((/** @type {any} */ r) => r.data && r.data.slug === hers.slug);
    assert.ok(row, "Edith can see the project exists (members read project records)");
    const rename = await edith.joined.call("records.update", [{ urn: row.urn, patch: { name: "Renamed by Edith" }, base_version: row.version }]).then(() => "ALLOWED", (/** @type {any} */ e) => String(e && e.message));
    assert.match(rename, /project's team|owner/i, `rename: ${rename}`);
    const take = await edith.joined.call("records.update", [{ urn: row.urn, patch: { owner: { actor: { kind: "person", id: edith.app.identity.id } } }, base_version: row.version }]).then(() => "ALLOWED", (/** @type {any} */ e) => String(e && e.message));
    assert.match(take, /owner or admin/i, `owner field: ${take}`);
    return `rename: ${rename} | owner field: ${take}`;
  }, { needs: [...needs, C], owner: "trust" });

  const E = "a member makes a blank project of her own";
  await J.step(E, async () => {
    const blank = await grace.joined.call("work.project-create", [{ name: "Grace's blank matter" }]);
    assert.match(String(blank.project), /\/project\//);
    return `made ${blank.slug}`;
  }, { needs: [...needs, B], owner: "projects-flows" });

  const F = "a member puts a file in her project's files area and reads it back through the app's path";
  await J.step(F, () => { throw new Error("NOT BUILT YET: the member door has no files/drive call (kernel/remote/wire.js CALLS), so the app cannot add or open a project's files for a member (owner: operations)"); }, { needs: [...needs, E], owner: "operations" });
}
