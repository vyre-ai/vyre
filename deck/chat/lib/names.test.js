// @ts-check
// The one labelling rule: the assistant's name (or an agent's own), "you", another surface's name, never claude.
import { test } from "node:test";
import assert from "node:assert/strict";
import { labelFor, isAssistant, readNames, OURS } from "./names.js";

test("replies: the agent's name, else the assistant's name from onboarding, else Vyre", () => {
  assert.equal(labelFor({ role: "assistant" }), "Vyre");
  assert.equal(labelFor({ role: "assistant" }, { assistant: "juno" }), "juno");
  assert.equal(labelFor({ role: "assistant", agent: "kit" }, { assistant: "juno" }), "kit");
  assert.equal(labelFor({ role: "assistant", agent: "claude" }, { assistant: "juno" }), "juno");
  assert.equal(labelFor({ role: "assistant" }, { assistant: "Claude" }), "Vyre");
  assert.equal(labelFor({}, { assistant: "juno" }), "juno", "role defaults to a reply");
});

test("people: you on this person's surfaces, another surface its name, never claude", () => {
  for (const s of [null, undefined, "", ...OURS]) assert.equal(labelFor({ role: "user", surface: s }), "you");
  assert.equal(labelFor({ role: "user", surface: "capsule" }), "capsule");
  assert.equal(labelFor({ role: "user", surface: "box:deck" }), "you", "a message the box forwarded to the Mac");
  assert.equal(labelFor({ role: "user", surface: "box:capsule" }), "you");
  assert.equal(labelFor({ role: "user", surface: "claude-code" }), "terminal");
});

test("isAssistant: the assistant wears the mark, an agent does not", () => {
  assert.equal(isAssistant({}, { assistant: "juno" }), true);
  assert.equal(isAssistant({ agent: "juno" }, { assistant: "juno" }), true);
  assert.equal(isAssistant({ agent: "kit" }, { assistant: "juno" }), false);
});

test("readNames: one system.info per page, a failure asked again", async () => {
  let n = 0;
  const fail = async () => { n++; return { error: { code: "offline" } }; };
  assert.deepEqual(await readNames(fail), { assistant: null, owner: null });
  const ok = async () => { n++; return { data: { assistant: { name: "juno" }, owner: { name: "alex" } } }; };
  assert.deepEqual(await readNames(ok), { assistant: "juno", owner: "alex" });
  await readNames(ok);
  assert.equal(n, 2);
});
