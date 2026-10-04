// @ts-check
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { install, $ } from "../test/fake-dom.js";

const doc = /** @type {any} */ (install());
const { rowOf, onControl, primaryLink, siblingRows } = await import("./rows.js");

const el = (tag, attrs = {}, ...kids) => { const e = doc.createElement(tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v)); for (const k of kids) e.append(k); return e; };
const row = (href, extra = []) => el("div", { class: "work-row" }, el("span", { class: "initial" }, "x"), el("div", { class: "work-main" }, el("a", { href, class: "link quiet" }, "Title")), ...extra);

test("a row is found from anywhere inside it, and only a listed row", () => {
  const r = row("/threads/1");
  assert.equal(rowOf($(r, ".initial")), r);
  assert.equal(rowOf($(r, "a")), r);
  assert.equal(rowOf(el("div", { class: "other" })), null);
});

test("the main link is the first plain link, never a button-link; a row with none (a paired Mac's project) opens nothing", () => {
  const watch = el("a", { href: "/agents/kit", class: "btn btn-ghost" }, "Watch");
  const r = el("div", { class: "work-row" }, watch, el("a", { href: "/threads/9" }, "T"));
  assert.equal(primaryLink(r).getAttribute("href"), "/threads/9");
  assert.equal(primaryLink(el("div", { class: "pl-row" }, el("span", {}, "Mac"))), null);
});

test("a click on a control inside the row is the control's own: buttons, links, fields, and anything marked data-no-row", () => {
  const btn = el("button", {}, "Pin"), input = el("input", {}), marked = el("div", { "data-no-row": "1" }, el("span", { class: "in" }, "x"));
  const r = row("/threads/1", [btn, input, marked]);
  assert.equal(onControl(btn, r), true);
  assert.equal(onControl(input, r), true);
  assert.equal(onControl($(marked, ".in"), r), true);
  assert.equal(onControl($(r, ".initial"), r), false);
  assert.equal(onControl($(r, ".work-main"), r), false, "the plain area of the row opens it");
});

test("Up and Down go between the rows of a list that have a link", () => {
  const a = row("/t/1"), b = el("div", { class: "pl-row" }, el("span", {}, "no link")), c = row("/t/3");
  el("div", { class: "rows" }, a, b, c);
  assert.deepEqual(siblingRows(a), [a, c]);
});
