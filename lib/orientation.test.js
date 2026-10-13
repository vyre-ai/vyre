// @ts-check
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { orientation } from "./orientation.js";

const project = { name: "Harlow Legal", dir: "/home/a/Vyre/projects/harlow-legal" };
const agent = { name: "intake", dir: "/home/a/Vyre/agents/agt_1" };

test("a plain session in a project: the project's instructions and context by path, the Files rule, the precedence", () => {
  const t = orientation({ project });
  assert.match(t, /project "Harlow Legal"/);
  assert.match(t, /harlow-legal\/AGENTS\.md \(CLAUDE\.md is the same\)/);
  assert.match(t, /harlow-legal\/context\//);
  assert.match(t, /\.link file holds a path in Vyre Files/);
  assert.match(t, /person's message first, then the project's instructions, then the Space's defaults/);
  assert.ok(!/agent "/.test(t), "no agent lines");
});

test("an agent with no project: its own instructions, context and notes", () => {
  const t = orientation({ agent });
  assert.match(t, /agent "intake"/);
  assert.match(t, /agt_1\/AGENTS\.md/);
  assert.match(t, /agt_1\/context\//);
  assert.ok(!/project "/.test(t), "no project lines");
  assert.match(t, /then your instructions, then the Space's defaults/);
});

test("an agent working in a project: both, the agent's for how it works and the project's for the work", () => {
  const t = orientation({ agent, project });
  assert.match(t, /agt_1\/AGENTS\.md/);
  assert.match(t, /harlow-legal\/AGENTS\.md/);
  assert.match(t, /your own instructions for how you work, then the project's instructions for the work itself/);
});

test("a plain chat with no project adds nothing; the block never carries a file's contents and stays short", () => {
  assert.equal(orientation({}), "");
  assert.ok(orientation({ agent, project }).length < 1100);
});

test("a folder with no instructions or no context does not name what is not there", () => {
  const t = orientation({ project: { ...project, instructions: false, context: false } });
  assert.ok(!/AGENTS\.md/.test(t) && !/context\//.test(t) && !/\.link/.test(t), t);
  assert.match(t, /project "Harlow Legal"/);
  const a = orientation({ agent: { ...agent, context: false } });
  assert.match(a, /agt_1\/AGENTS\.md/);
  assert.ok(!/context\//.test(a));
});
