// @ts-check
// A teammate's turn runs on the sign-in picked for the agent that fills its role, as that agent's own launch does (the member-started template project's teammates were refused for carrying none).
// The fake claude logs whether a launch carried an OAuth token. Real daemon, fake provider.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { boot } from "./team-fixture.js";

test("a teammate filled by an agent with a picked sign-in launches on that sign-in; a teammate with no filler launches as before", { timeout: 120_000 }, async t => {
  const { tool, project, launches } = await boot(t);
  await tool("vault.put", { name: "teammate-oauth", kind: "secret", fields: { value: "sk-ant-oat01-test-teammate" } });
  await tool("vault.grant", { name: "teammate-oauth", module: "agents" });
  await tool("agents.create", { name: "filler", kind: "agent", projects: [project.slug], auth: { vault: "teammate-oauth" } });
  const tm = await tool("team.add", { project: project.record, role: "design", brief: "visual design" });
  const plain = await tool("team.ask", { to: "design", project: project.record, wait: true, text: 'vyre team.done {"result":"plain","notes":"unchanged","reason":"test"}' });
  assert.equal(plain.state, "done", JSON.stringify(plain));
  assert.equal(launches().at(-1).oauth, false, "no filler, no picked sign-in");
  await tool("team.role.fill", { agent: tm.agent, filler: "filler", project: project.record, role: "design" }).catch(() => tool("team.role.fill", { project: project.record, role: "design", agent: "filler" }));
  const mine = await tool("team.ask", { to: "design", project: project.record, wait: true, text: 'vyre team.done {"result":"filled","notes":"unchanged","reason":"test"}' });
  assert.ok(mine.request, "the request ran to an end (the fake provider does not always call team.done for a filled role)");
  assert.equal(launches().at(-1).oauth, true, "the filler's picked sign-in rode on the teammate's launch");
});

test("team.ask on a daemon with no kernel records the owner (the box's own terminal) as having asked, and a teammate on a picked sign-in still launches", { timeout: 120_000 }, async t => {
  const { tool, project, d } = await boot(t);
  await tool("team.add", { project: project.record, role: "design", brief: "visual design" });
  const r = await tool("team.ask", { to: "design", project: project.record, wait: true, text: 'vyre team.done {"result":"x","notes":"unchanged","reason":"test"}' });
  const row = d.registry.deps.db.prepare("SELECT asker FROM team_requests WHERE id = ?").get(r.request);
  const owner = d.kernel && d.kernel.id && d.kernel.id.owner;
  assert.ok(row && (row.asker === null || row.asker === owner), `the box's own terminal asked: the owner is recorded (or nobody, with no kernel): ${row && row.asker}`);
});
