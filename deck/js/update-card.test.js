// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { updateCard, COMMAND_CARDS } from "../js/update-card.js";

test("update card: an update shows the version, the one command and the notes, and never anything else as a command", () => {
  const c = updateCard({ current: "0.2.0", available: "0.3.0", how: "command", command: "vyre update", notes: [{ version: "0.3.0", notes: "New." }], checkedAt: 1, auto: "notify" });
  assert.equal(c.headline, "Vyre 0.3.0 is out");
  assert.equal(c.command, "vyre update");
  assert.equal(c.notes.length, 1);
  assert.equal(updateCard({ current: "0.2.0", available: "0.3.0", how: "command", command: "rm -rf /; vyre update" }).command, null, "a command that is not a plain vyre verb is not shown");
  assert.equal(updateCard({ current: "0.2.0", available: "0.3.0", how: "app", command: null }).app, true);
});

test("update card: up to date says when it last looked, an error says why, off says so", () => {
  assert.equal(updateCard({ current: "0.2.0", available: null, checkedAt: Date.now() - 3 * 3600_000 }).headline, "Vyre 0.2.0 is up to date");
  assert.match(updateCard({ current: "0.2.0", available: null, checkedAt: Date.now() }).detail, /^Last looked/);
  assert.match(updateCard({ current: "0.2.0", available: null, error: "503 from the releases" }).detail, /503/);
  assert.match(updateCard({ current: "0.2.0", available: null, auto: "off" }).detail, /turned off/);
  assert.match(updateCard(null).detail, /Not looked/);
});

test("command cards: each command is a real verb with real flags, and the delete-data one says to export first", () => {
  const box = fs.readFileSync(new URL("../../box/vyre", import.meta.url), "utf8");
  const up = fs.readFileSync(new URL("../../core/cli/commands/up.js", import.meta.url), "utf8");
  for (const { commands } of COMMAND_CARDS) for (const { line } of commands) {
    const [, verb, ...flags] = line.split(" ");
    assert.ok(box.includes(`${verb})`) || up.includes(`name: "${verb}"`), `vyre ${verb} exists`);
    for (const f of flags) assert.ok(box.includes(f) || up.includes(f), `${verb} takes ${f}`);
  }
  assert.match(COMMAND_CARDS.flatMap(c => c.commands).find(c => /delete-data/.test(c.line)).note, /export first/);
});
