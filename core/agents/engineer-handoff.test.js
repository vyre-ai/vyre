// @ts-check
// The Engineer knows the handoff a Space page sends (From Playbooks, Objects, Flows or Agents, with a fenced engineer-context block), and a home that still has its earlier instructions is brought up to date.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { ENGINEER } from "./index.js";

test("the Engineer's instructions teach the handoff: read, two or three questions, a draft, and nothing applied before the yes", () => {
  const t = ENGINEER.instructions;
  for (const w of ["From Playbooks", "From Objects", "From Flows", "From Agents", "engineer-context", "source, ref, name, intent, words, shape", "work.template.define", "flows_define", "agents.update", "Apply nothing before the yes", "shape is empty"]) assert.ok(t.includes(w), `says ${w}`);
  assert.ok(t.startsWith("You are the Engineer. You set up the Space for the person you are talking to"), "the earlier instructions are kept");
});

test("a home holding the instructions this build shipped before is upgraded; the earlier ones are listed", () => {
  assert.equal(ENGINEER.previous.length, 5);
  assert.ok(ENGINEER.previous[4].startsWith(ENGINEER.previous[2]), "the text before tool names were written as calls is the earlier text plus the handoff");
  assert.ok(ENGINEER.previous[3].startsWith(ENGINEER.previous[2]) && ENGINEER.previous[3] !== ENGINEER.instructions, "the handoff before new agents is kept, so a home holding it is brought up to date");
  assert.match(ENGINEER.instructions, /agent\.new/, "and the Engineer is told how to propose a new agent");
  assert.ok(!ENGINEER.previous.includes(ENGINEER.instructions));
});
