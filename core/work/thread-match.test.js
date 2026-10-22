// @ts-check
// A thread is a chat of one person and one agent. The assistant's pinned chat lists nobody, and a chat may store the agent under its id, its name or its model. Those still count, and the title is the person's own words.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { canonicalAgent, isAgentThread, keysFor, keysOf, rowFor, threadTitle } from "./thread-match.js";

const ME = "per_owner";
const roster = [
  { name: "juno", uid: "agt_juno", kind: "assistant", model: "opus", fallback_model: "sonnet" },
  { name: "kit", uid: "agt_kit", kind: "agent", model: "haiku" },
];

test("an agent is known by its name, its id and its model, and the assistant also by assistant", () => {
  const keys = keysFor(roster, "juno");
  for (const k of ["juno", "agt_juno", "opus", "sonnet", "assistant"]) assert.ok(keys.has(k), k);
  assert.equal(rowFor(roster, "opus").name, "juno");
  assert.equal(rowFor(roster, "agt_juno").name, "juno");
  assert.equal(rowFor(roster, "assistant").name, "juno");
  assert.equal(rowFor(roster, "haiku").name, "kit");
  assert.ok(!keysOf(roster[1]).has("assistant"), "another agent is not the assistant");
});

test("the pinned assistant chat counts, and so does a chat stored under the id or the model; a group and another agent do not", () => {
  const keys = keysFor(roster, "juno");
  const yes = (/** @type {any} */ o) => isAgentThread({ me: ME, keys, assistant: true, ...o });
  assert.equal(yes({ people: [ME], agents: [], pinned: "assistant" }), true, "the pinned chat lists nobody");
  assert.equal(yes({ people: [ME], agents: ["juno"], pinned: null }), true);
  assert.equal(yes({ people: [ME], agents: ["agt_juno"], pinned: null }), true, "stored under the agent id");
  assert.equal(yes({ people: [ME], agents: ["opus"], pinned: null }), true, "stored under the model");
  assert.equal(yes({ people: [ME], agents: ["assistant"], pinned: null }), true);
  assert.equal(yes({ people: [ME], agents: [], pinned: null }), false, "an empty chat that is not pinned is not a thread");
  assert.equal(yes({ people: [ME, "per_sam"], agents: ["juno"], pinned: null }), false, "a chat with another person is not a thread");
  assert.equal(yes({ people: [ME], agents: ["kit"], pinned: null }), false, "another agent's chat");
  assert.equal(yes({ people: [ME], agents: ["kit"], pinned: "assistant" }), false, "a chat that lists another agent stays that agent's");
  const kit = keysFor(roster, "kit");
  assert.equal(isAgentThread({ me: ME, keys: kit, assistant: false, people: [ME], agents: [], pinned: "assistant" }), false, "the pinned chat is not kit's");
  assert.equal(isAgentThread({ me: ME, keys: kit, assistant: false, people: [ME], agents: ["haiku"], pinned: null }), true, "kit stored under its model");
});

test("chats stored under an id or a model are the same agent, and the pinned chat is the assistant's", () => {
  assert.equal(canonicalAgent({ people: [ME], agents: ["opus"], pinned: null, roster }), "juno");
  assert.equal(canonicalAgent({ people: [ME], agents: ["agt_kit"], pinned: null, roster }), "kit");
  assert.equal(canonicalAgent({ people: [ME], agents: [], pinned: "assistant", roster }), "juno");
  assert.equal(canonicalAgent({ people: [ME, "per_sam"], agents: ["juno"], pinned: null, roster }), null);
  assert.equal(canonicalAgent({ people: [ME], agents: [], pinned: null, roster }), null);
});

test("a thread is named by the first thing the person typed, or New thread, never by the reply", () => {
  const long = "please draft the spring note for the bakery and keep it under one page of plain words";
  assert.equal(threadTitle("Assistant", "", "I'm Claude Code, running on Opus"), "New thread");
  assert.equal(threadTitle("New chat", "  hello there  ", "a reply"), "hello there");
  assert.equal(threadTitle("", long, long), long.slice(0, 60).trimEnd());
  assert.equal(threadTitle(long, "other", long), "other", "a title that is the reply is replaced by what the person typed");
  assert.equal(threadTitle("Spring note", "hello", "a reply"), "Spring note", "a title the person gave stays");
  assert.equal(threadTitle("first thread", "", ""), "first thread");
});
