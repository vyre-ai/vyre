// @ts-check
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { fill, placeholders } from "./fill.js";
import { docx, textOf } from "./testing/docx.js";

const LETTER = () => docx(["Dear {client.name},", "Your fee is {matter.fee} for {matter.title}.", ["Signed: {cli", "ent.name}"]]);

test("a template is filled from nested values, including a placeholder Word split across runs", () => {
  const t = LETTER();
  const { buffer, used } = fill(t, { client: { name: "Dana Harlow" }, matter: { fee: 1500, title: "Estate plan" } });
  assert.deepEqual(textOf(buffer), ["Dear Dana Harlow,", "Your fee is 1500 for Estate plan.", "Signed: Dana Harlow"]);
  assert.deepEqual(used.sort(), ["client.name", "matter.fee", "matter.title"]);
});

test("a template with one missing field refuses, naming it, and makes nothing", () => {
  const e = (() => { try { fill(LETTER(), { client: { name: "Dana" }, matter: { title: "Estate plan" } }); } catch (x) { return /** @type {any} */ (x); } return null; })();
  assert.ok(e, "refused");
  assert.equal(e.code, "missing_values");
  assert.deepEqual(e.missing, ["matter.fee"]);
  assert.match(e.message, /this value is missing: matter\.fee/);
  assert.equal(e.buffer, undefined);
});

test("several missing values are all named, sorted; an empty string is missing; zero and false are values", () => {
  const e = (() => { try { fill(LETTER(), { client: { name: "" } }); } catch (x) { return /** @type {any} */ (x); } return null; })();
  assert.deepEqual(e.missing, ["client.name", "matter.fee", "matter.title"]);
  const ok = fill(docx(["{a} and {b}"]), { a: 0, b: false });
  assert.deepEqual(textOf(ok.buffer), ["0 and false"]);
});

test("a loop repeats for each item; a loop with no list is missing, not silently empty", () => {
  const t = docx(["{#fees}{label}: {amount}; {/fees}done"]);
  assert.deepEqual(textOf(fill(t, { fees: [{ label: "filing", amount: 100 }, { label: "retainer", amount: 2500 }] }).buffer), ["filing: 100; retainer: 2500; done"]);
  const e = (() => { try { fill(t, {}); } catch (x) { return /** @type {any} */ (x); } return null; })();
  assert.deepEqual(e.missing, ["fees"]);
  assert.deepEqual(placeholders(t).loops, ["fees"]);
  assert.deepEqual(placeholders(t).loopFields, { fees: ["label", "amount"] });
  assert.deepEqual(placeholders(t).names, []);
});

test("the same template and values give the same bytes, and the template is not changed", () => {
  const t = LETTER(), before = Buffer.from(t);
  const v = { client: { name: "Dana" }, matter: { fee: 1, title: "x" } };
  const a = fill(t, v).buffer, b = fill(t, v).buffer;
  assert.ok(a.equals(b), "deterministic");
  assert.ok(t.equals(before), "the template is untouched");
});

test("what is not a Word file, and a file that is too big, is refused in plain words", () => {
  assert.throws(() => fill(Buffer.from("hello"), {}), /not a Word \(\.docx\) file/);
  assert.throws(() => fill(Buffer.alloc(0), {}), /empty/);
  assert.throws(() => fill(Buffer.alloc(11 * 1024 * 1024, 1), {}), /most is/);
});

test("placeholders lists what a template asks for", () => {
  const p = placeholders(LETTER());
  assert.deepEqual(p.names.sort(), ["client.name", "matter.fee", "matter.title"]);
});
