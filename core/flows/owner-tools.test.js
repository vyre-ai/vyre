// @ts-check
// The owner-only Flows tools, as the registry and the agent rules state them (team/0.6/FLOWS-PARITY.md, section 5 notes): each tool is a
// person's own call (reach "person": the owner's key reaches it over MCP, as the app does), and an assistant is refused the ones the
// agent rules keep the person's own (PERSON_ONLY). A static contract: no daemon, no grants are minted. Settle, advance, control, budget
// and the Kit calls are not in this list: their reach or the agent rules differ from the app's, and a lead ruling decides them.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { PERSON_ONLY } from "../modules/agent-reach.js";

const flowsModule = JSON.parse(fs.readFileSync(new URL("./module.json", import.meta.url), "utf8"));
const reachOf = name => (flowsModule.does.tools.find(/** @type {any} */ t => t.name === name) || {}).reach;

/** The owner-only tools whose registry reach is the person's and whose agent refusal the rules state. */
const OWNER_ONLY = ["flows.pause", "flows.resume", "flows.access.set", "flows.rollback", "flows.kit.remove"];

for (const name of OWNER_ONLY) {
  test(`${name}: the owner's own call over MCP, and an assistant is refused it`, () => {
    assert.equal(reachOf(name), "person", `${name} must be a person's own call, so the owner's key reaches it and no other member does`);
    assert.ok(PERSON_ONLY.has(name), `${name} must be in agent-reach PERSON_ONLY, so an assistant is refused as in the app`);
  });
}
