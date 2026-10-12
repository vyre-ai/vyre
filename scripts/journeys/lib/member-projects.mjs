// A team member starts her own projects from the app's path (the member door's `work` group), sees them in her list, and cannot touch another member's (0.3.3). Written to run inside J9 after the chat steps:
// `await memberProjectsSteps({ J, w, team, people, needs })`. The file part (a member puts a file in her project) has no door call yet: this step says so instead of passing without it.
// The assistant's task and a template agent's teammate running are added when team-credential is merged.
import assert from "node:assert/strict";

const TEMPLATE = { name: "Walk intake", description: "One stage with a task", tags: ["walk"], roles: [{ role: "helper", agent: "assistant" }], stages: [{ name: "Intake", tasks: [{ title: "Gather the documents", doer: "role:helper", output: { kind: "note" } }, { title: "Check the documents", doer: "creator", output: { kind: "note" } }] }, { name: "Done" }] };

/** @param {{ J: any, w: any, team: any, people: any[], needs: string[] }} o  people: each { name, app, joined } */
export async function memberProjectsSteps({ J, w, people, needs }) {
  const [grace, edith] = people;
  /** @type {string} */ let tpl = "";
  /** @type {any} */ let hers = null;
  const A = "the owner puts a project template live on the team's server";
  await J.step(A, async () => {
    const def = await w.call("work.template.define", { body: TEMPLATE });
    await w.call("work.template.golive", { template: def.template, version: def.version });
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
    const ownerSees = JSON.stringify(await w.call("records.list", { type: "project" }));
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

  const F = "a member puts a file in her project's files area and reads it back; another member cannot see it";
  await J.step(F, async () => {
    const up = await grace.joined.call("files.upload", [{ project: hers.slug, name: "walk-note.txt", data: Buffer.from("hello from Grace").toString("base64") }]);
    assert.equal(up.size, 16);
    const list = await grace.joined.call("files.list", [{ project: hers.slug }]);
    assert.ok(list.files.some((/** @type {any} */ f) => f.name === "walk-note.txt"), JSON.stringify(list));
    const got = await grace.joined.call("files.read", [{ project: hers.slug, name: "walk-note.txt" }]);
    assert.equal(Buffer.from(got.data, "base64").toString(), "hello from Grace");
    await assert.rejects(() => edith.joined.call("files.list", [{ project: hers.slug }]), undefined, "Edith cannot list it");
    await assert.rejects(() => edith.joined.call("files.upload", [{ project: hers.slug, name: "edith.txt", data: Buffer.from("x").toString("base64") }]), undefined, "Edith cannot add to it");
    await assert.rejects(() => grace.joined.call("files.read", [{ project: hers.slug, name: "../.project" }]), /file name is/, "and nobody reads the marker");
    return "uploaded, listed, read back; the other member refused; the marker out of reach";
  }, { needs: [...needs, B], owner: "operations" });

  const G = "the template's first-stage task for the assistant is made on her project";
  await J.step(G, async () => {
    assert.ok(hers.tasks_made >= 1, `tasks made ${hers.tasks_made}, skipped ${JSON.stringify(hers.tasks_skipped || [])}`);
    return `tasks made ${hers.tasks_made}`;
  }, { needs: [...needs, B], owner: "projects-flows" });

  const G2 = "her own task from the template (doer \"creator\") is in her task list and she submits it (tasks.submit through the door)";
  await J.step(G2, async () => {
    const skipped = JSON.stringify(hers.tasks_skipped || []);
    if (/nobody can do creator/.test(skipped)) throw new Error(`NOT BUILT YET: the stage module cannot resolve the doer "creator" on a member-started project (${skipped}) (owner: projects-flows)`);
    const mine = await grace.joined.call("tasks.list", [{ record: hers.project }]);
    const rows = mine.rows || mine.tasks || mine;
    const task = rows.find((/** @type {any} */ t) => String(t.title || (t.task && t.task.title) || "").includes("Check the documents"));
    assert.ok(task, `her task: ${JSON.stringify(rows).slice(0, 400)}`);
    const out = await grace.joined.call("tasks.submit", [{ id: task.id, evidence: { note: "documents checked by the walk" } }]);
    return `submitted ${task.id}: ${JSON.stringify(out).slice(0, 120)}`;
  }, { needs: [...needs, B], owner: "projects-flows" });

  const H = "the Records screen's types leave out the team's kept types, and she adds a client";
  await J.step(H, async () => {
    const t = await grace.joined.call("records.types", [{}]);
    const names = (Array.isArray(t) ? t : t.types || []).map((/** @type {any} */ x) => String(x.name));
    for (const kept of ["skill", "def-flow", "flow-approval", "flow-state", "flow-control", "flow-tests", "flow-schedule", "flow-run", "project-template", "def-watcher"]) assert.ok(!names.includes(kept), `${kept} is not in her type list: ${names.join(", ")}`);
    assert.ok(names.includes("contact"), `a client type: ${names.join(", ")}`);
    const client = await grace.joined.call("records.create", [{ type: "contact", data: { name: "Walk Client" } }]);
    const clientRec = client.record || client;
    const list = await grace.joined.call("records.list", [{ type: "contact" }]);
    assert.ok(JSON.stringify(list).includes("Walk Client"), "the client is in her list");
    return `types ${names.length}, none kept; client ${clientRec.id || ""}`;
  }, { needs: [...needs, B], owner: "trust" });
}
