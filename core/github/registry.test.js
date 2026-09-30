// @ts-check
// What the registry itself does with github's outward tools: merge, review and open declare
// reach "asked", so an agent's unasked call is refused before the tool runs (no request ever
// leaves), while the person's own call goes through to the tool. Boots a real vyred in a temp home.

import { test } from "node:test";
import assert from "node:assert/strict";
import { start } from "../daemon/index.js";
import { tempHome, present } from "../../test/helpers.js";

test("github.project.pr.open / .merge / .review: reach asked - an agent is refused not_asked, the person's own call reaches the tool", async t => {
  let daemon = null;
  const root = tempHome(t, { stop: () => daemon && daemon.stop() });
  daemon = await start({ root, presence: present, log: () => {} });
  const calls = [
    ["github.project.pr.open", { project: "app", title: "t", head: "vyre/x" }],
    ["github.project.pr.merge", { project: "app", pr: 7 }],
    ["github.project.pr.review", { project: "app", pr: 7, event: "APPROVE" }],
  ];
  for (const [tool, input] of calls) {
    const agent = await daemon.registry.call(tool, input, "mcp:agent:kit");
    assert.equal(agent.error && agent.error.code, "not_asked", `${tool} for an agent`);
    const person = await daemon.registry.call(tool, input, "cli");
    assert.notEqual(person.error && person.error.code, "not_asked", `${tool} for the person`);
    assert.equal(person.error && person.error.code, "not_found", "reached the tool, which has no such project");
  }
  // A read is open to the agent.
  const read = await daemon.registry.call("github.project.pr.get", { project: "app", pr: 7 }, "mcp:agent:kit");
  assert.notEqual(read.error && read.error.code, "not_asked");
});
