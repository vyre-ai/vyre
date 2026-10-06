// @ts-check
// A module's Now card in the app: which slots are listed, what a card keeps, and that a module that fails never breaks Now.
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { nowSlots, nowCard, loadNowCards } from "./model.js";

const LISTED = { modules: [
  { name: "bakery", version: "0.1.0", state: "running", now: ["bakery.today"] },
  { name: "forms", version: "0.1.0", state: "running", now: [] },
  { name: "broken", version: "0.1.0", state: "failed", now: ["broken.card"] },
  { name: "odd", version: "0.1.0", state: "running", now: ["other.card", 7] },
] };

test("only a running module's own now: tools are slots", () => {
  assert.deepEqual(nowSlots({ data: LISTED }.data), [{ module: "bakery", tool: "bakery.today" }]);
  assert.deepEqual(nowSlots(null), []);
  assert.deepEqual(nowSlots({ modules: "x" }), []);
});

test("a card keeps a title, a detail and a meta line, trimmed, and nothing else", () => {
  const slot = { module: "bakery", tool: "bakery.today" };
  assert.deepEqual(nowCard(slot, { title: " Northwind Bakery ", detail: "3 of 40 items today", meta: "1 order", html: "<b>x</b>" }), { module: "bakery", tool: "bakery.today", title: "Northwind Bakery", detail: "3 of 40 items today", meta: "1 order" });
  assert.equal(nowCard(slot, {}), null);
  assert.equal(nowCard(slot, { title: "  " }), null);
  assert.equal(nowCard(slot, "text"), null);
  assert.equal(nowCard(slot, { title: "x".repeat(500) }).title.length, 80);
});

test("loadNowCards calls each slot once and leaves out a module that fails or answers nothing", async () => {
  const seen = /** @type {string[]} */ ([]);
  const call = async (/** @type {string} */ tool) => {
    seen.push(tool);
    if (tool === "system.modules") return { data: { modules: [{ name: "a", state: "running", now: ["a.card"] }, { name: "b", state: "running", now: ["b.card"] }, { name: "c", state: "running", now: ["c.card"] }] } };
    if (tool === "a.card") return { data: { title: "A", detail: "fine" } };
    if (tool === "b.card") throw new Error("boom");
    return { error: { code: "denied", message: "no" } };
  };
  const cards = await loadNowCards(call);
  assert.deepEqual(cards.map(c => c.module), ["a"]);
  assert.deepEqual(seen.sort(), ["a.card", "b.card", "c.card", "system.modules"]);
});
