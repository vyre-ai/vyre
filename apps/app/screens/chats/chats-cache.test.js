// @ts-check
// The Chat list's kept copy (chats-cache.js): one list per Space, drawn at once and replaced by the box's answer; a failed or slow first read shows a note, never a skeleton that stays.
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { AUX_BUDGET_MS, LIST_BUDGET_MS, MAX_AGE_MS, auxKey, chatsKey, packAux, packChats, pickChats, unpackAux, unpackChats } from "./chats-cache.js";
import { chatsView } from "./chats-model.js";
import { createLanding } from "../../ui/query-order.js";

const T = 1_790_000_000_000;
const row = (id, title) => ({ id, title, project: "", people: ["per_sam"], agents: [], models: [], providers: [], status: "idle", last: T, line: "", asks: 0, unread: 0, open: true });

test("each Space keeps its own Chat list", () => {
  assert.equal(chatsKey("spc_a"), "chats.list.spc_a");
  assert.equal(chatsKey(""), "chats.list.home");
  assert.notEqual(chatsKey("spc_a"), chatsKey("spc_b"));
});

test("a kept list comes back as it went in; another version, a broken copy or one over a week old does not", () => {
  const rows = [row("chat_a", "Lease reply"), row("chat_b", "Intake with Sam Rivera")];
  const packed = JSON.parse(JSON.stringify(packChats(rows, () => T)));
  assert.deepEqual(unpackChats(packed, () => T + 60_000), rows);
  assert.equal(unpackChats({ ...packed, v: 3 }, () => T), null);
  assert.equal(unpackChats(null), null);
  assert.equal(unpackChats({ v: 1, at: T, rows: "x" }, () => T), null);
  assert.equal(unpackChats(packed, () => T + MAX_AGE_MS + 1), null);
  assert.deepEqual(unpackChats({ v: 2, at: T, rows: [null, { id: "" }, row("chat_c", "Kept")] }, () => T).map((r) => r.id), ["chat_c"], "a row with no id is dropped");
});

test("what draws: the answer, else the kept list (stale), else a note when the read failed, else the placeholder", () => {
  const kept = [row("chat_k", "Kept")], fresh = [row("chat_f", "Fresh")];
  assert.deepEqual(pickChats({ fresh, kept, failed: false }), { rows: fresh, from: "chats", stale: false, note: false });
  assert.deepEqual(pickChats({ fresh: undefined, kept, failed: false }), { rows: kept, from: "chats", stale: true, note: false });
  assert.deepEqual(pickChats({ fresh: undefined, kept, failed: true }), { rows: kept, from: "chats", stale: true, note: true }, "a kept list with a quiet note when the box did not refresh it");
  assert.deepEqual(pickChats({ fresh: undefined, kept: null, failed: true }), { rows: [], from: "failed", stale: false, note: false });
  assert.deepEqual(pickChats({ fresh: undefined, kept: null, failed: false }), { rows: [], from: "none", stale: false, note: false });
  assert.deepEqual(pickChats({ fresh: "unsupported", kept, failed: false }).from, "unsupported");
  assert.ok(LIST_BUDGET_MS > 0 && LIST_BUDGET_MS <= 10_000, "the first read waits a few seconds at most");
});

test("the Chat page never sits on the skeleton: a failed read is a note with Try again, and a kept list is the list", () => {
  assert.deepEqual(chatsView({ from: "failed", gap: null, rows: [], live: true }), { body: "failed", banner: false });
  assert.deepEqual(chatsView({ from: "failed", gap: null, rows: [], live: false }), { body: "offline", banner: false });
  const kept = pickChats({ fresh: undefined, kept: [row("chat_k", "Kept")], failed: true });
  assert.equal(chatsView({ from: kept.from, gap: null, rows: kept.rows, live: true }).body, "list");
});

test("re-reads on every thread event: each answer lands unless a later one already has, so a busy box still shows a list", () => {
  const order = createLanding();
  const a = order.start(), b = order.start(), c = order.start();
  assert.equal(order.land(a), true, "the first answer lands though two reads started after it");
  assert.equal(order.land(c), true);
  assert.equal(order.land(b), false, "an older answer never replaces a newer one");
});

test("an empty kept list is no kept list: Chat never draws No chats yet from a copy", () => {
  assert.equal(unpackChats(packChats([], () => T), () => T), null);
  assert.equal(pickChats({ fresh: undefined, kept: unpackChats(packChats([], () => T), () => T), failed: false }).from, "none");
  assert.equal(pickChats({ fresh: [], kept: null, failed: false }).from, "chats", "only the box's own empty answer is an empty list");
});

test("the agents and teammates the list needs are kept per Space and come back whole", () => {
  assert.equal(auxKey("spc_a"), "chats.aux.spc_a");
  const a = { agents: [{ name: "kit" }], people: [{ id: "per_sam", name: "Sam" }], assistantName: "Qi", assistantAgent: "qi" };
  assert.deepEqual(unpackAux(JSON.parse(JSON.stringify(packAux(a, () => T))), () => T), a);
  assert.equal(unpackAux({ v: 2 }, () => T), null);
  assert.equal(unpackAux(packAux(a, () => T), () => T + MAX_AGE_MS + 1), null);
  assert.ok(AUX_BUDGET_MS > 0 && AUX_BUDGET_MS < LIST_BUDGET_MS);
});
