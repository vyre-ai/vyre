// @ts-check
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { refPrefix, refNumber, formatRef, nextRef, isClash, clashStep, MAX_MINT_TRIES, mintRef, idOnCreate, idOnUpdate, keptOnUpdate, withoutBlankIds, ID_GIVEN, ID_CHANGED } from "./ref.js";

test("an ID is a type prefix and a counter: PER-0001, and the next one follows the highest", () => {
  assert.deepEqual(["contact", "organization", "task", "note", "invoice", "x"].map(refPrefix), ["PER", "ORG", "TSK", "NOT", "INV", "X"]);
  assert.equal(formatRef("PER", 7), "PER-0007");
  assert.equal(nextRef("contact", []), "PER-0001", "the first");
  assert.equal(nextRef("contact", ["PER-0001", "PER-0009", "PER-0003"]), "PER-0010", "after the highest, in any order");
  assert.equal(nextRef("contact", ["PER-9999", "PER-10000"]), "PER-10001", "past four digits it still counts up");
  assert.equal(nextRef("contact", ["ORG-0044", "junk", null, undefined, 5]), "PER-0001", "another type's ID and junk do not count");
  assert.equal(refNumber("PER", "PER-0042"), 42);
  assert.equal(refNumber("PER", "per-0042"), 0);
});

test("a clash is told by its words, and the steps past it grow so a hidden high ID is passed in a few tries", () => {
  const clash = (/** @type {any} */ more = {}) => Object.assign(new Error("ref must be unique: another contact already has that value"), { code: "unique_violation", ...more });
  assert.equal(isClash(clash()), true);
  assert.equal(isClash(clash({ field: "ref" })), true);
  assert.equal(isClash(clash({ field: "email" })), false, "another field's clash is not the ID's");
  assert.equal(isClash(new Error("must be unique: already has it")), false, "words alone are not a clash");
  assert.equal(isClash(Object.assign(new Error("that link target exists"), { code: "invalid" })), false);
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(clashStep), [1, 1, 1, 10, 10, 10, 100, 100, 100, 1000]);
  let n = 1, tries = 0;
  const hidden = 250;   // a record the caller cannot see holds PER-0250
  while (n <= hidden && tries < MAX_MINT_TRIES) { tries++; n += clashStep(tries); }
  assert.ok(n > hidden && tries < MAX_MINT_TRIES, "a hidden ID 250 ahead is passed within the tries");
});

test("mintRef: a caller who cannot see the records holding the higher IDs still gets a free one, and the refusal's words go nowhere", async () => {
  const taken = new Set(Array.from({ length: 40 }, (_, k) => `PER-${String(k + 1).padStart(4, "0")}`));   // a member sees none of these
  const tried = /** @type {string[]} */ ([]);
  const out = await mintRef({ type: "contact", start: 1, create: async (ref) => { tried.push(ref); if (taken.has(ref)) throw Object.assign(new Error(`ref ${ref} must be unique: a record already has it`), { code: "unique_violation" }); return { ref }; } });
  assert.ok(!taken.has(out.made.ref), "a free one");
  assert.ok(tried.length <= MAX_MINT_TRIES, "within the tries");
  // a failure that is not a clash is passed up as it is, at once
  await assert.rejects(() => mintRef({ type: "contact", start: 1, create: async () => { throw Object.assign(new Error("not allowed"), { code: "denied" }); } }), (e) => e.code === "denied");
  // nothing ever free: a plain answer that names no record
  await assert.rejects(() => mintRef({ type: "contact", start: 1, create: async () => { throw Object.assign(new Error("must be unique: PER-9999 exists"), { code: "unique_violation" }); } }), (e) => e.code === "unavailable" && !/PER-|unique|exists/.test(e.message));
});

test("a record's identity is Vyre's: a create naming its ID, id or address is refused in words, an empty one counts as left out, and a change naming any of them is refused", () => {
  assert.equal(idOnCreate({ name: "Jo", ref: "PER-0007" }, true), ID_GIVEN, "the ID on a type with an ID field");
  assert.equal(idOnCreate({ name: "Jo", id: "0190a000-0000-4000-8000-000000000000" }, false), ID_GIVEN, "the store's id on any type");
  assert.equal(idOnCreate({ name: "Jo", urn: "vyre://s/contact/x" }, false), ID_GIVEN, "the address on any type");
  assert.equal(idOnCreate({ name: "Jo", ref: "PER-0007" }, false), null, "a type with no ID field: ref is not its ID (the store answers for an unknown field)");
  for (const blank of ["", "  ", null, undefined]) assert.equal(idOnCreate({ name: "Jo", ref: blank, id: blank }, true), null, `empty (${JSON.stringify(blank)}) is left out`);
  assert.deepEqual(withoutBlankIds({ name: "Jo", ref: "", id: null, urn: undefined }, true), { name: "Jo" }, "and is taken out before the store sees it");
  assert.deepEqual(withoutBlankIds({ name: "Jo", ref: "" }, false), { name: "Jo", ref: "" }, "a type with no ID field keeps what it was given");
  assert.equal(idOnCreate({ name: "Jo", identifier: "A-1", case_id: "77" }, true), null, "an ordinary field the owner named like an ID is theirs to fill");
  assert.equal(idOnUpdate({ ref: "PER-0099" }, true), ID_CHANGED);
  assert.equal(idOnUpdate({ ref: null }, true), ID_CHANGED, "clearing the ID is changing it");
  assert.equal(idOnUpdate({ id: "x" }, false), ID_CHANGED);
  assert.equal(idOnUpdate({ name: "Jo", case_id: "78" }, true), null, "other fields change as before");
  assert.ok(!/[—–]/.test(ID_GIVEN + ID_CHANGED), "plain words");
});

test("a field Vyre keeps (read-only, or a deal's weighted value even where its mark was lost) is refused on a change; ordinary fields are not", () => {
  const deal = [{ name: "ref", read_only: true }, { name: "amount", label: "Amount" }, { name: "weighted_value", label: "Weighted value" }, { name: "score", label: "Score", read_only: true }, { name: "case_id", label: "Case ID" }];
  assert.match(String(keptOnUpdate(deal, { weighted_value: 9 })), /^Weighted value is worked out by Vyre/);
  assert.match(String(keptOnUpdate(deal, { score: 1 })), /^Score is worked out by Vyre/);
  assert.equal(keptOnUpdate(deal, { amount: 5, case_id: "A-1" }), null, "the fields it comes from change as before");
  assert.equal(keptOnUpdate(deal, { ref: "X" }), null, "the ID has its own words (idOnUpdate)");
  assert.equal(keptOnUpdate(deal, null), null);
});
