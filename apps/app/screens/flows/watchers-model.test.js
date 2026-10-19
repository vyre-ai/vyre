import "../../../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { watcherRow, presetInput, testLines, cardRows, PRESETS } from "./watchers-model.js";

test("a watcher row says its state in words, with next and last run and the buttons that fit", () => {
  const on = watcherRow({ name: "mail-ads", state: "on", title: "Notes for important mail", every: "every hour", next: "2026-10-19T05:00:00.000Z", lastRun: "2026-10-19T04:00:00.000Z", items: 3, failures: 0 }, (ms) => `t${ms % 1000}`);
  assert.equal(on.word, "On");
  assert.equal(on.title, "Notes for important mail");
  assert.match(on.sub, /every hour · next t0 · last t0 · 3 filed/);
  assert.deepEqual(on.actions, ["run", "pause", "delete"]);
  assert.deepEqual(watcherRow({ name: "a", state: "paused", pausedWhy: "you paused it" }).actions, ["resume", "delete"]);
  assert.equal(watcherRow({ name: "a", state: "paused", pausedWhy: "you paused it" }).problem, "you paused it");
  assert.deepEqual(watcherRow({ name: "a", state: "draft" }).actions, ["turn-on", "delete"]);
  assert.deepEqual(watcherRow({ name: "a", state: "invalid", problems: ["no code"] }).actions, ["delete"]);
  const bad = watcherRow({ name: "a", state: "on", failures: 3, lastError: "403 from Google" });
  assert.equal(bad.state, "failing");
  assert.equal(bad.tone, "err");
  assert.equal(bad.problem, "403 from Google");
});

test("every source in the presets lists the box's own seven kinds, and a preset asks only what it needs", () => {
  assert.deepEqual(PRESETS.map((p) => p.kind), ["mail", "calendar", "repo", "slack", "feed", "pr", "connector"]);
  assert.deepEqual(presetInput("repo", "ads", { repo: "acme/site", only: "pulls", match: "bug, urgent" }), { input: { kind: "repo", project: "ads", repo: "acme/site", only: "pulls", match: ["bug", "urgent"] } });
  assert.deepEqual(presetInput("repo", "ads", { repo: "" }), { missing: "Repository: fill this in." });
  assert.deepEqual(presetInput("feed", "", { url: "https://x.example/f.xml" }), { missing: "Choose the project it belongs to." });
  assert.deepEqual(presetInput("calendar", "ads", { credential: "google-cred", days: "x" }), { missing: "Days ahead: a whole number." });
  assert.equal(presetInput("calendar", "ads", { credential: "google-cred", days: "7" }).input.days, 7);
  assert.deepEqual(presetInput("nope", "ads", {}), { missing: "Choose where it watches." });
});

test("a dry run reads as lines: what it would file, or what to fix", () => {
  assert.deepEqual(testLines({ ok: true, count: 2, alreadyFiled: 1, items: [{ title: "Lease reply" }, { id: "x9" }] }).lines, ["It would file 2 items, 1 already filed.", "Lease reply", "x9"]);
  assert.equal(testLines({ ok: true, count: 0, items: [] }).lines[0], "It found nothing new. That can be right.");
  assert.deepEqual(testLines({ ok: false, problems: ["no code"] }), { ok: false, lines: ["no code"] });
  assert.equal(testLines({ ok: false, error: "403" }).ok, false);
});

test("the card shows when, checks, does, reads, acts and costs, and leaves out what is empty", () => {
  const rows = cardRows({ lines: { when: "Runs every hour", do: "Files notes" }, facts: { readsText: "Reads gmail", acts: "Never acts: it reads and files", cost: "No model cost" } });
  assert.deepEqual(rows.map((r) => r.label), ["When", "Does", "Reads", "Acts", "Costs"]);
  assert.deepEqual(cardRows(null), []);
});
