// @ts-check
// The owner-only Flows tools, as the registry and the agent rules state them (team/0.6/FLOWS-PARITY.md, section 5 notes). A static contract,
// no daemon and no grants minted: each tool's registry reach, and its place in the agent rules (PERSON_ONLY, ASK_FIRST or the read-only list).
// The behaviour behind each (an assistant's chain refused, an owner's chain allowed) is the kernel's; its refusal is in kernel/flows/index.js.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { PERSON_ONLY, ASK_FIRST, OPEN } from "../modules/agent-reach.js";

const flowsModule = JSON.parse(fs.readFileSync(new URL("./module.json", import.meta.url), "utf8"));
const toolOf = name => flowsModule.does.tools.find(/** @type {any} */ t => t.name === name) || {};

/** Person's own, and an assistant refused them, as in the app. */
for (const name of ["flows.pause", "flows.resume", "flows.access.set", "flows.rollback", "flows.kit.remove", "flows.advance", "flows.budget.set", "flows.settle"]) {
  test(`${name}: the owner's own call over MCP, and an assistant is refused it`, () => {
    assert.equal(toolOf(name).reach, "person", `${name} must be a person's own call, so only the owner's own chain reaches it`);
    assert.ok(PERSON_ONLY.has(name), `${name} must be in agent-reach PERSON_ONLY, so an assistant is refused as in the app`);
    assert.ok(!OPEN.has(name) && !ASK_FIRST.has(name), `${name} is not open or held: it is refused`);
  });
}

test("flows.budget: reading is anyone's, setting it is the person-only flows.budget.set", () => {
  assert.equal(toolOf("flows.budget").reach, "anyone");
  assert.equal(toolOf("flows.budget").effect, "read");
  assert.equal(toolOf("flows.budget.set").effect, "write");
  assert.ok(!PERSON_ONLY.has("flows.budget"), "a read is not person-only");
});

test("flows.control: a read of the switch, anyone's; pause and resume are the person-only tools", () => {
  assert.equal(toolOf("flows.control").reach, "anyone");
  assert.equal(toolOf("flows.control").effect, "read");
});

test("flows.kit.propose: anyone may propose, and a proposal installs nothing: the approver's yes does", () => {
  assert.equal(toolOf("flows.kit.propose").reach, "anyone");
});

test("no tool is named flows.kit.install or flows.kit.update: the install runs only on an approved task (kit-apply), so adding one needs a ruling", () => {
  const names = flowsModule.does.tools.map(/** @type {any} */ t => t.name);
  assert.ok(!names.includes("flows.kit.install"), "flows.kit.install must not be a tool");
  assert.ok(!names.includes("flows.kit.update"), "flows.kit.update must not be a tool");
});
