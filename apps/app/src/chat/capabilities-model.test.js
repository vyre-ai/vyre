// @ts-check
import "../../../../scripts/mac-test-guard.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { laterNoteFromLine, rewindPointsFromStore, secondOpinionTargets } from "./capabilities-model.js";

const slashSrc = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "../../ui/chat/slash.ts"), "utf8");

test("rewindPointsFromStore lists person messages newest first", () => {
  const store = {
    rows: () => [{ key: "u:a" }, { key: "u:b" }],
    item: (k) => (k === "u:a" ? { kind: "user", text: "first" } : k === "u:b" ? { kind: "user", text: "second" } : null),
  };
  assert.deepEqual(rewindPointsFromStore(store).map((p) => p.uuid), ["b", "a"]);
});

test("laterNoteFromLine parses /later", () => {
  assert.deepEqual(laterNoteFromLine('/later "at 5pm" check inbox'), { title: "check inbox", when: "at 5pm" });
});

test("NATIVE_SLASHES includes the documented composer command names", () => {
  for (const name of ["clear", "compact", "later", "find", "rewind", "export", "memory", "roll", "move"]) assert.ok(slashSrc.includes(`"${name}"`), name);
});

test("secondOpinionTargets skips the author", () => {
  const t = secondOpinionTargets([{ id: "assistant:juno", name: "juno", family: "assistant" }, { id: "assistant:kit", name: "kit", family: "assistant" }], "assistant:juno");
  assert.equal(t.length, 1);
  assert.equal(t[0].id, "assistant:kit");
});

test("secondOpinionTargets in a one-to-one chat: one per connected provider the chat does not have, by its default model; never the answer's own provider", () => {
  const rows = [
    { id: "claude", label: "Claude", accounts: [], models: [{ id: "opus", label: "Opus" }] },
    { id: "codex", label: "Codex", accounts: [{ id: "c1", label: "Work", signed_in: true }, { id: "c2", label: "Home", signed_in: true }], models: [] },
    { id: "grok", label: "Grok", accounts: [{ id: "g1", label: "Mine", signed_in: false }], models: [] },
    { id: "openrouter", label: "OpenRouter", accounts: [{ id: "o1", label: "Key", signed_in: true }], models: [] },
  ];
  const t = secondOpinionTargets([{ id: "model:claude/default#100001", name: "Claude", family: "model" }], "model:claude/default#100001", rows);
  assert.deepEqual(t.map((x) => [x.id, x.label]), [["codex", "Codex"], ["openrouter", "OpenRouter"]], "no 'No other model here': a signed-in provider joins; two Codex accounts are one target; signed out is not offered");
  assert.ok(t.every((x) => x.sub === "Joins this chat"));
  const withCodex = secondOpinionTargets([{ id: "assistant:juno", name: "Juno", family: "assistant" }, { id: "model:codex/default#2", name: "Codex", family: "model" }], "assistant:juno", rows);
  assert.deepEqual(withCodex.map((x) => x.id), ["model:codex/default#2", "claude", "openrouter"], "a provider already in the chat is offered as it is, not again");
  assert.deepEqual(secondOpinionTargets([], "assistant:juno").length, 0, "no accounts known: nothing to offer");
});
