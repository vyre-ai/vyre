// @ts-check
// agents + projects.access: option (a) (the lead's decision on the reviewer's drift MEDIUM).
// agents.create/update write the matching projects.access grants as part of the person's own
// already-gated action, and projects.create grants every projects: "*" agent at once, so
// agents.projects and projects.access never drift apart. Real daemon, real modules: this is an
// integration point across two modules, not one to fake.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { start } from "../daemon/index.js";
import { tempHome, present } from "../../test/helpers.js";

async function world(t, extra = {}) {
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ role: "box", transcripts: [], vault: { keystore: "file" },
    modules: { enable: [], disable: ["recall", "memory", "learn"] }, ...extra }));
  const d = await start({ root, log: () => {}, presence: present });
  t.after(() => d.stop());
  const c = (tool, input = {}, caller = "local") => d.registry.call(tool, input, caller);
  // Project homes for these tests, always under this test's own root, never a real path.
  const home = name => path.join(root, "homes", name);
  return { d, c, home };
}
const ok = (r, msg) => { assert.equal(r.error, undefined, msg || JSON.stringify(r)); return r.data; };

test("agents.create grants a new agent's own projects at once, no manual migrate needed", async t => {
  const { c, home } = await world(t);
  ok(await c("projects.create", { name: "Harlow Legal", home: home("harlow") }));
  const kit = ok(await c("agents.create", { name: "kit", projects: ["harlow-legal"] }));
  assert.deepEqual(kit.projects, ["harlow-legal"]);
  const check = ok(await c("projects.access.check", { project: "harlow-legal", agent: "kit" }, "module:x"));
  assert.equal(check.granted, true);
});

test("projects.create grants every projects: \"*\" agent (not the assistant) the moment it exists", async t => {
  const { c, home } = await world(t);
  ok(await c("agents.create", { name: "wilma", projects: "*" }));
  ok(await c("agents.create", { name: "juno", kind: "assistant" }));
  ok(await c("projects.create", { name: "Northwind", home: home("northwind") }));
  assert.equal(ok(await c("projects.access.check", { project: "northwind", agent: "wilma" }, "module:x")).granted, true);
  // The assistant's "*" is a different rule, never a projects.access row.
  assert.equal(ok(await c("projects.access.check", { project: "northwind", agent: "juno" }, "module:x")).granted, false);
});

test("agents.update: dropping a project revokes it; adding one back grants it, since nothing explicitly revoked it first", async t => {
  const { c, home } = await world(t);
  ok(await c("projects.create", { name: "Harlow Legal", home: home("harlow2") }));
  ok(await c("projects.create", { name: "Northwind", home: home("northwind2") }));
  ok(await c("agents.create", { name: "kit", projects: ["harlow-legal", "northwind"] }));
  ok(await c("agents.update", { name: "kit", projects: ["harlow-legal"] })); // northwind dropped
  assert.equal(ok(await c("projects.access.check", { project: "northwind", agent: "kit" }, "module:x")).granted, false);
  assert.equal(ok(await c("projects.access.check", { project: "harlow-legal", agent: "kit" }, "module:x")).granted, true);
  ok(await c("agents.update", { name: "kit", projects: ["harlow-legal", "northwind"] })); // added back
  assert.equal(ok(await c("projects.access.check", { project: "northwind", agent: "kit" }, "module:x")).granted, true);
});

test("a person's own explicit revoke is never silently re-granted by agents.update", async t => {
  const { c, home } = await world(t);
  ok(await c("projects.create", { name: "Northwind", home: home("northwind3") }));
  ok(await c("agents.create", { name: "kit", projects: ["northwind"] }));
  // The person revokes it directly, outside agents.update entirely.
  ok(await c("projects.access.revoke", { project: "northwind", agent: "kit" }, "local"));
  assert.equal(ok(await c("projects.access.check", { project: "northwind", agent: "kit" }, "module:x")).granted, false);
  // Dropping and re-adding the same project through agents.update must not paper over that.
  ok(await c("agents.update", { name: "kit", projects: [] }));
  const r = await c("agents.update", { name: "kit", projects: ["northwind"] });
  assert.ok(r.error, "re-adding an explicitly revoked project should refuse, not silently re-grant");
  assert.match(r.error.message, /explicitly revoked/);
  assert.equal(ok(await c("projects.access.check", { project: "northwind", agent: "kit" }, "module:x")).granted, false, "still revoked");
  // kit's own agents.projects list is unchanged too: the whole update failed, not half of it.
  assert.deepEqual((await c("agents.list")).data.find(a => a.name === "kit").projects, []);
});

test("agents.delete clears every projects.access row for that agent outright", async t => {
  const { c, home } = await world(t);
  ok(await c("projects.create", { name: "Harlow Legal", home: home("harlow4") }));
  ok(await c("agents.create", { name: "kit", projects: ["harlow-legal"] }));
  ok(await c("projects.access.revoke", { project: "harlow-legal", agent: "kit" }, "local")); // a row on record either way
  ok(await c("agents.delete", { agent: "kit" }));
  const rows = ok(await c("projects.access.list", { project: "harlow-legal" }, "local"));
  assert.ok(!rows.grants.some(g => g.agent === "kit"), JSON.stringify(rows));
  // Re-creating an agent named "kit" later starts clean: nothing left to weigh a re-grant against.
  ok(await c("agents.create", { name: "kit", projects: ["harlow-legal"] }));
  assert.equal(ok(await c("projects.access.check", { project: "harlow-legal", agent: "kit" }, "module:x")).granted, true);
});

test("a failed grant write fails the create: no half-made agent", async t => {
  const { c, home, d } = await world(t);
  // A project id that passes checkProjects's own shape rule but resolves to nothing: grant
  // throws "no project ...", so syncAccess's write fails before the INSERT ever runs.
  const r = await c("agents.create", { name: "kit", projects: ["no-such-project"] });
  assert.ok(r.error);
  assert.equal((await c("agents.list")).data.find(a => a.name === "kit"), undefined, "the agent was never created");
});

test("the assistant-only guard refuses an agent on every spelling of its claim, cli:agent:kit included", async t => {
  const { c } = await world(t);
  ok(await c("agents.create", { name: "kit" }));
  ok(await c("agents.create", { name: "juno", kind: "assistant" }));
  for (const who of ["mcp:agent:kit", "cli:agent:kit", "capsule:agent:kit", "deck agent:kit", "CLI:AGENT:kit"]) {
    const r = await c("agents.list", {}, who);
    assert.ok(r.error, `${who} listed agents: ${JSON.stringify(r)}`);
  }
  assert.ok(!(await c("agents.list", {}, "mcp:agent:juno")).error, "the assistant may");
  assert.ok(!(await c("agents.list", {}, "cli")).error, "the person may");
});
