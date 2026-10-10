// The pure half of the field renderers: formatting, emptiness, filter and sort for every kind, the sealed phrases, the stage menu.
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { MASK, PICKABLE_KINDS, KIND_LOGIC, addrText, allowedStages, filterOps, fmtDate, fmtMoney, isEmpty, isRevealable, isSealedValue, marks, maskText, matches, normalizeKind, parseDay, parseNum, relDate, sealedPhrase, sampleFor, sortKey, sortRows, toDate } from "./logic.js";

const NOW = new Date(2026, 9, 3, 12).getTime();

test("the fifteen kinds a person picks all have filter ops, a sort and a sample", () => {
  assert.equal(PICKABLE_KINDS.length, 15);
  for (const [k] of PICKABLE_KINDS) {
    assert.ok(KIND_LOGIC[k], `${k} has logic`);
    assert.ok(filterOps(k).length > 0, `${k} has filter ops`);
    assert.notEqual(sampleFor({ kind: k, options: ["A", "B"] }, { now: NOW, actors: [{ id: "alex" }], links: { "vyre://s/contact/1": { title: "Jane Doe" } } }), null, `${k} has a sample`);
  }
});

test("emptiness reads each shape", () => {
  for (const v of [null, undefined, "", [], { amount: null }, { urn: "" }, { actor: null }, { file: "", name: "" }, {}.x, { line1: "", city: "" }, { sealed: "free", present: false }]) assert.ok(isEmpty(v), JSON.stringify(v));
  for (const v of [0, "a", ["x"], { amount: 0, currency: "USD" }, { urn: "vyre://a/b/c" }, { line1: "1 Main" }, { sealed: "free", present: true }]) assert.ok(!isEmpty(v), JSON.stringify(v));
});

test("dates: Oct 28, the year when it is not this one, relative words, and typed input", () => {
  assert.equal(fmtDate("2026-10-28", NOW), "Oct 28");
  assert.equal(fmtDate("2027-01-02", NOW), "Jan 2, 2027");
  assert.equal(relDate("2026-10-04", NOW), "tomorrow");
  assert.equal(relDate("2026-10-02", NOW), "yesterday");
  assert.equal(relDate("2026-10-13", NOW), "in 10 days");
  assert.equal(toDate("nonsense"), null);
  assert.equal(parseDay("10/28/2026"), "2026-10-28");
  assert.equal(parseDay("2026-2-30"), null);
  assert.equal(parseDay(""), null);
});

test("money has no cents unless it has some; numbers parse with commas; addresses are one line", () => {
  assert.equal(fmtMoney({ amount: 4800, currency: "USD" }), "$4,800");
  assert.equal(fmtMoney({ amount: 12.5, currency: "USD" }), "$12.50");
  assert.equal(parseNum("1,250"), 1250);
  assert.equal(parseNum("x"), null);
  assert.equal(parseNum(""), null);
  assert.equal(addrText({ line1: "18 Larkin St", city: "San Francisco", region: "CA", postal: "94109" }), "18 Larkin St, San Francisco, CA 94109");
});

test("rich text: bold, italic and breaks only, never markup", () => {
  assert.deepEqual(marks("a **b** *c*\nd <b>x</b>"), [{ text: "a " }, { text: "b", bold: true }, { text: " " }, { text: "c", italic: true }, { text: "\n", br: true }, { text: "d <b>x</b>" }]);
});

test("filters: text contains, number range, stage is, sealed set or not, file has", () => {
  assert.ok(matches("text", "contains", "doe", "Jane Doe"));
  assert.ok(matches("text", "starts", "jan", "Jane Doe") && !matches("text", "starts", "doe", "Jane Doe"));
  assert.ok(matches("money", "between", [1000, 5000], { amount: 4800, currency: "USD" }) && !matches("money", "gte", 5000, { amount: 4800, currency: "USD" }));
  assert.ok(matches("stage", "isnot", "Closed", "Intake"));
  assert.ok(matches("sealed", "set", null, { sealed: "x", present: true }) && matches("sealed", "unset", null, null));
  assert.ok(matches("file", "has", null, { file: "f", name: "n", bytes: 1 }) && matches("file", "hasnot", null, null));
  assert.ok(matches("rating", "gte", 3, 4) && !matches("rating", "gte", 5, 4));
  assert.ok(matches("date", "before", "2026-11-01", "2026-10-28") && matches("date", "between", ["2026-10-01", "2026-10-31"], "2026-10-28"));
  assert.ok(matches("phone", "contains", "415", ["+1 415 555 0142"]));
});

test("a sealed value never reaches a text filter or a sort key", () => {
  const v = { sealed: "us-ssn", ref: "r1", present: true, valid_format: true, set_at: 1 };
  assert.ok(!matches("text", "contains", "ssn", v) && !matches("text", "contains", "r1", v));
  assert.equal(sortKey("sealed", v), 1);
  assert.equal(sortKey("sealed", null), 0);
});

test("sort keys: stage order, money numeric, empties last", () => {
  const def = { options: ["Intake", "Drafting", "Closed"] };
  assert.deepEqual(sortRows(["Closed", "Intake", null, "Drafting"], (x) => x, "stage", { def }), ["Intake", "Drafting", "Closed", null]);
  assert.deepEqual(sortRows([{ amount: 900 }, { amount: 4800 }, null, { amount: 20 }], (x) => x, "money", {}, true), [{ amount: 4800 }, { amount: 900 }, { amount: 20 }, null]);
  const actors = [{ id: "a", name: "Zed" }, { id: "b", name: "Amy" }];
  assert.deepEqual(sortRows([{ actor: { id: "a" } }, { actor: { id: "b" } }], (x) => x, "actor", { actors }).map((x) => x.actor.id), ["b", "a"]);
});

test("sealed: the fixed mask, the hint only when the seal allows it, the assistant's phrase", () => {
  const held = { sealed: "us-ssn", ref: "r1", present: true, valid_format: true, set_at: 1, hint: "6789" };
  assert.equal(maskText({ seal: { level: "human", class: "x" } }, held), MASK);
  assert.equal(maskText({ seal: { level: "ai", class: "free", hint_allowed: true } }, held), `${MASK.slice(0, 4)} 6789`);
  assert.ok(isRevealable(held) && isSealedValue(held));
  assert.ok(isSealedValue({ sealed: "free", present: true }) && !isRevealable({ sealed: "free", present: true }));
  assert.equal(sealedPhrase("SSN"), "SSN on file, sealed");
});

test("the stage menu offers the stage and its neighbours unless a rule narrows it", () => {
  const def = { options: ["Intake", "Engagement", "Drafting", "Signing"] };
  assert.deepEqual(allowedStages(def, "Engagement"), ["Intake", "Engagement", "Drafting"]);
  assert.deepEqual(allowedStages(def, undefined), ["Intake"]);
  assert.deepEqual(allowedStages(def, "Intake", ["Intake", "Signing"]), ["Intake", "Signing"]);
});

test("the short kind names map to the kernel's", () => {
  assert.equal(normalizeKind("phone"), "phones");
  assert.equal(normalizeKind("email"), "emails");
  assert.equal(normalizeKind("richText"), "rich_text");
  assert.equal(normalizeKind("money"), "money");
});

import { actorName, linkHref, linkLabel } from "./logic.js";
test("a url field opens only http and https addresses", () => {
  assert.equal(linkHref("https://meet.example.com/x?y=1"), "https://meet.example.com/x?y=1");
  assert.equal(linkHref("  http://a.example "), "http://a.example/");
  assert.equal(linkHref("javascript:alert(1)"), null);
  assert.equal(linkHref("file:///etc/passwd"), null);
  assert.equal(linkHref("meet.example.com"), null);
  assert.equal(linkHref(null), null);
  assert.equal(linkLabel("https://meet.example.com/x/"), "meet.example.com/x");
});

test("an actor cell reads as You, a name, or a plain word, never as the kernel's id", () => {
  const env = { me: "per_me0000000000", actors: [{ id: "per_dana00000000", name: "Dana Smith" }] };
  assert.equal(actorName({ actor: { id: "per_me0000000000" } }, env), "You");
  assert.equal(actorName("per_dana00000000", env), "Dana Smith");
  assert.equal(actorName({ actor: { id: "per_zzzzzzzzzzzz", name: "Lee Park" } }, env), "Lee Park");
  assert.equal(actorName("per_zzzzzzzzzzzz", env), "Someone");
  assert.equal(actorName("Kit", env), "Kit", "a name typed by hand is the text itself");
  assert.equal(actorName("", env), "");
});
