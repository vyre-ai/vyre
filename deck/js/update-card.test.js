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

test("update card: a request waits, a run shows its step, and the result is in words; a Mac or a host with no unit shows no button", () => {
  const base = { current: "0.1.0", available: "0.2.0", how: "command", command: "vyre update", notes: [] };
  assert.equal(updateCard({ ...base, canApply: true }).canApply, true);
  assert.equal(updateCard({ ...base, canApply: false }).canApply, false);
  assert.equal(updateCard({ ...base, canApply: true, how: "app", command: null }).canApply, false, "a Mac updates itself");
  const wait = updateCard({ ...base, canApply: true, pending: true });
  assert.deepEqual([wait.busy, wait.progress], [true, "Waiting for this server to start it"]);
  const run = updateCard({ ...base, canApply: true, run: { state: "running", stage: "verifying", at: Date.now() } });
  assert.deepEqual([run.busy, run.progress], [true, "Checking its signature"]);
  assert.equal(updateCard({ ...base, run: { state: "running", stage: "not-a-stage" } }).progress, "Working");
  const ok = updateCard({ current: "0.2.0", available: null, run: { state: "ok", from: "0.1.0", to: "0.2.0", at: Date.now() } });
  assert.deepEqual([ok.busy, ok.result], [false, { ok: true, text: "Updated to 0.2.0." }]);
  const rb = updateCard({ ...base, run: { state: "rolled_back", from: "0.1.0", to: "0.2.0", at: Date.now() } });
  assert.match(rb.result.text, /0\.2\.0 did not start, so Vyre put 0\.1\.0 back and your data is as it was/);
  assert.equal(rb.result.ok, false);
  const failed = updateCard({ ...base, run: { state: "failed", message: "this release is not signed", at: Date.now() } });
  assert.match(failed.result.text, /did not happen: this release is not signed\. Nothing was changed/);
  assert.equal(updateCard({ ...base, run: { state: "ok", to: "0.2.0", at: Date.now() - 2 * 86400_000 } }).result, null, "a day old is not news");
});
