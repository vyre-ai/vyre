import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createMockStore } from "../../src/store-core/mock-store.js";
import { cardFor, nowModel } from "./model.js";
import { loadWorld } from "./world.js";
import { askKind, dayText, fileNameOf, groupAsks, groupKeyOf, landing, laterChoices, nextMorning, openTarget, parseDay, quickDays, readSnoozed, stillSnoozed, vaultAddRoute, vaultItemOf } from "./ask-model.js";

const NOW = Date.parse("2026-10-01T13:00:00");
const world = async () => loadWorld(createMockStore({ now: () => NOW }), () => NOW);
const find = (w, title) => nowModel(w).needs.find((t) => t.title === title);

test("each kind of ask in the sample world gets its own control", async () => {
  const w = await world();
  const kind = (title) => { const t = find(w, title); return t ? askKind(cardFor(w, t), t) : null; };
  assert.equal(kind("Signing date"), "date");
  assert.equal(kind("Add a signature photo"), "file");
  assert.equal(kind("Approve a $720 refund for Priya Shah"), "yes_no");
  assert.equal(kind("Check the court docket"), "credential");
  assert.equal(kind("Send the Q3 report to Dana Reyes"), "send");
});

test("a stuck task that is not about a credential stays a plain stuck card", () => {
  const card = { reason: "stuck", actions: [{ id: "fix" }, { id: "reassign" }] };
  assert.equal(askKind(card, { stuck: { reason: "The bank did not answer.", suggested_fix: { text: "Try again after lunch." } }, output: {} }), "stuck");
  assert.equal(askKind(card, { stuck: { reason: "The sign-in expired.", suggested_fix: { text: "Chris can sign iris in again." } }, output: {} }), "credential");
});

test("the Vault item comes from the fix's own action, else a quoted name beside the word Vault, never a guess", () => {
  assert.equal(vaultItemOf({ stuck: { suggested_fix: { text: "x", action: { kind: "open_vault_item", resource: "vyre://s/vault/court-portal" } } } }), "court-portal");
  assert.equal(vaultItemOf({ stuck: { suggested_fix: { text: 'Update "stripe-key" in the Vault.' } } }), "stripe-key");
  assert.equal(vaultItemOf({ stuck: { suggested_fix: { text: 'Update "stripe-key" somewhere.' } } }), null);
  assert.equal(vaultItemOf({ stuck: { suggested_fix: { text: "Update the password in the Vault." } } }), null);
  assert.equal(vaultAddRoute({ stuck: { reason: "The password changed.", suggested_fix: { text: "x", action: { kind: "open_vault_item", resource: "court-portal" } } } }), "/u/vault?add=court-portal&kind=login");
  assert.equal(vaultAddRoute({ stuck: { reason: "The key was revoked.", suggested_fix: { text: "x" } } }), "/u/vault?add=1&kind=api-key");
});

test("a file lands where the ask says, else the project's folder, else the record's, and never climbs out", () => {
  assert.equal(landing({ output: { kind: "file", target: "Signed documents/2026" } }).folder, "Signed documents/2026");
  assert.equal(landing({ output: { kind: "file", target: "../../etc/x" } }).folder, "etc/x");
  assert.equal(landing({ project: "vyre://s/project/p9", output: { kind: "file", target: "Hero image" } }).folder, "Projects/p9/files");
  assert.equal(landing({ output: { kind: "file", target: "Hero image" } }, { recordTitle: "Jane Doe" }).folder, "Records/Jane Doe");
  assert.equal(landing({ output: { kind: "file" } }).folder, "Task files");
  assert.match(landing({ project: "vyre://s/project/p9", output: { target: "Hero image" } }).words, /project's files, as Hero image/);
  assert.equal(fileNameOf("C:\\scans\\deed: final?.pdf"), "deed final .pdf");
});

test("Open chat goes to the chat that made the ask, else its record, else its Flow, else nowhere", () => {
  assert.deepEqual(openTarget({ session: "c1", record: "vyre://s/matter/m1" }), { route: "/u/chats/c1", label: "Open chat" });
  assert.deepEqual(openTarget({ record: "vyre://s/matter/m1", flow: "f" }), { route: "/u/record/m1", label: "Open record" });
  assert.deepEqual(openTarget({ flow: "Large refunds" }), { route: "/u/flows/Large%20refunds", label: "Open Flow" });
  assert.equal(openTarget({ title: "Pack" }), null);
});

test("Later: an hour, this evening before six, tomorrow at eight, next Monday at eight; a snooze that ran out is gone", () => {
  const morning = new Date(2026, 9, 14, 9, 30).getTime(); // Wednesday
  const c = laterChoices(morning);
  assert.deepEqual(c.map((x) => x.id), ["hour", "evening", "morning", "monday"]);
  assert.equal(c[0].until, morning + 3_600_000);
  assert.equal(new Date(c[1].until).getHours(), 18);
  assert.equal(dayText(new Date(c[2].until)), "2026-10-15");
  assert.equal(dayText(new Date(c[3].until)), "2026-10-19");
  assert.deepEqual(laterChoices(new Date(2026, 9, 14, 19, 0).getTime()).map((x) => x.id), ["hour", "morning", "monday"]);
  assert.equal(dayText(new Date(nextMorning(new Date(2026, 9, 14, 7, 0).getTime()))), "2026-10-14");
  assert.deepEqual(stillSnoozed({ a: 100, b: 300 }, 200), { b: 300 });
  assert.deepEqual(readSnoozed('{"a":5,"b":"x"}'), { a: 5 });
  assert.deepEqual(readSnoozed("not json"), {});
  assert.deepEqual(readSnoozed("[1]"), {});
});

test("more than three asks from one project or Flow fold into one group, in place; three or fewer stay as they are", () => {
  const t = (id, project, flow) => ({ id, project, flow });
  const list = [t("1", "vyre://s/project/a"), t("2"), t("3", "vyre://s/project/a"), t("4", "vyre://s/project/a"), t("5", "vyre://s/project/a"), t("6", undefined, "F"), t("7", undefined, "F")];
  const out = groupAsks(list, groupKeyOf);
  assert.deepEqual(out.map((r) => (r.group ? `${r.key}x${r.items.length}` : r.item.id)), ["project:ax4", "2", "6", "7"]);
  assert.deepEqual(groupAsks(list.slice(0, 3), groupKeyOf).map((r) => r.group), [false, false, false]);
});

test("a date is parsed only when it is a real day", () => {
  assert.equal(parseDay("2026-10-28"), "2026-10-28");
  assert.equal(parseDay("2026-02-30"), null);
  assert.equal(parseDay("10/28/2026"), null);
  assert.deepEqual(quickDays(new Date(2026, 9, 31, 10).getTime()).map((q) => q.value), ["2026-10-31", "2026-11-01", "2026-11-07"]);
});
