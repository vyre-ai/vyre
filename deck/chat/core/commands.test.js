// @ts-check
// "/" commands for the composer: where the command is, ranking, and the text once one is picked.

import { test } from "node:test";
import assert from "node:assert/strict";
import { COMMANDS, findCommand, rankCommands, applyCommand, normalizeCommands, sourceLabel } from "./commands.js";

test("the command at the caret: only the first word, only after a slash", () => {
  assert.deepEqual(findCommand("/com", 4), { start: 0, end: 4, query: "com" });
  assert.deepEqual(findCommand("/compact keep todos", 3), { start: 0, end: 3, query: "co" });
  assert.deepEqual(findCommand("/", 1), { start: 0, end: 1, query: "" });
  assert.deepEqual(findCommand("/co", 99), { start: 0, end: 3, query: "co" }, "the caret is clamped");
  assert.equal(findCommand("/compact keep", 12), null, "past the first word");
  assert.equal(findCommand("ask kit /co", 11), null, "not at the start");
  assert.equal(findCommand("/co", 0), null);
  assert.equal(findCommand("//x", 3), null);
  assert.equal(findCommand("", 0), null);
});

test("ranking: best first, ties by name, aliases count, empty keeps the order", () => {
  assert.deepEqual(rankCommands(COMMANDS, "co").map(c => c.name), ["compact", "context", "cost"]);
  assert.deepEqual(rankCommands(COMMANDS, "reset").map(c => c.name), ["clear"]);
  assert.deepEqual(rankCommands(COMMANDS, " VYRE ").map(c => c.name), ["vyre"]);
  assert.deepEqual(rankCommands(COMMANDS, "zzz"), []);
  const all = rankCommands(COMMANDS, "");
  assert.deepEqual(all.map(c => c.name), COMMANDS.map(c => c.name));
  assert.notEqual(all, COMMANDS, "a copy");
});

test("the static list: frozen, unique names, never names the vendor", () => {
  assert.ok(Object.isFrozen(COMMANDS));
  assert.equal(new Set(COMMANDS.map(c => c.name)).size, COMMANDS.length);
  assert.ok(COMMANDS.every(c => !/claude/i.test(c.description)));
});

test("applying: the name, one space, the caret after it", () => {
  assert.deepEqual(applyCommand("/co", { start: 0, end: 3, query: "co" }, "compact"), { text: "/compact ", caret: 9 });
  assert.deepEqual(applyCommand("/co keep todos", { start: 0, end: 3, query: "co" }, "compact"), { text: "/compact keep todos", caret: 9 });
});

test("the session's own list: slashes dropped, sources kept, the composer's own commands added, junk gives the static list", () => {
  const got = normalizeCommands([
    { name: "/compact", description: "Summarise the conversation", source: "builtin" },
    { name: "intake-check", description: "Run the intake form checks", argumentHint: "[form]", source: "project" },
    { name: "pdf", description: "Read and fill PDF forms", source: "skill" },
    { name: "intake-check", description: "a second one", source: "user" },
    { name: "two words", description: "not a name" },
    null,
  ]);
  assert.deepEqual(got.map(c => [c.name, c.source]), [["compact", "session"], ["intake-check", "project"], ["pdf", "skill"], ["model", "session"], ["rewind", "session"], ["find", "session"]]);
  assert.equal(got[1].hint, "[form]");
  assert.equal(got.find(c => c.name === "model")?.local, "model");
  assert.deepEqual(normalizeCommands({}).map(c => c.name), COMMANDS.map(c => c.name), "an older box's {}");
  assert.deepEqual(normalizeCommands([]).map(c => c.name), COMMANDS.map(c => c.name));
  assert.equal(sourceLabel("session"), "");
  assert.equal(sourceLabel("user"), "yours");
  assert.equal(sourceLabel("plugin"), "plugin");
  assert.equal(sourceLabel("acme"), "acme");
});

test("threads.commands' answer object reads as its list; an empty one (not running) is the static list", () => {
  const got = normalizeCommands({ thread: "t1", commands: [{ name: "compact", description: "Clear history but keep a summary", argumentHint: "<instructions>" }, { name: "review-intake", description: "", argumentHint: "" }] });
  assert.deepEqual(got.slice(0, 2).map(c => [c.name, c.hint ?? null, c.source]), [["compact", "<instructions>", "session"], ["review-intake", null, "session"]]);
  assert.ok(got.some(c => c.name === "model" && c.local === "model"), "the composer's own are added");
  assert.deepEqual(normalizeCommands({ thread: "t1", commands: [], note: "not running" }).map(c => c.name), COMMANDS.map(c => c.name));
});
