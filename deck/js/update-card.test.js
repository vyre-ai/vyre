// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import { updateCard } from "../js/update-card.js";

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
