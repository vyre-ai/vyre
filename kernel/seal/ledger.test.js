// @ts-check
// Invariant 6: the seal ledger catches a value in every form a bug could carry it (a canary corpus of transformed values), refuses nothing
// else, and holds no plaintext. Plus the class validators and the detectors, which are best effort and tested for what they must not flag.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Ledger, MAX_WINDOWS } from "./ledger.js";
import { CLASSES, detect, redact } from "./classes.js";
import { ledgerEntries, fold, compact } from "./normalise.js";
import { property, randomSsn, luhnCard } from "./testing.js";

const WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];
const PROSE = ["please", "review", "the", "attached", "file", "for", "Harlow", "Legal", "and", "reply", "by", "Friday", "thanks", "ref", "4821", "call", "555-0100"];
const prose = r => Array.from({ length: r.int(12) }, () => r.pick(PROSE)).join(" ");

/** The canary corpus: one value, many disguises. Each returns text a model-bound prompt might carry. */
function disguises(value, r) {
  const raw = Buffer.from(value), c = value.replace(/\D/g, "");
  const sep = r.pick([" ", "-", ".", "\n", " - "]);
  const spaced = c.split("").join(sep), grouped = [c.slice(0, 3), c.slice(3, 5), c.slice(5)].join(sep);
  const b64 = pad => Buffer.concat([Buffer.alloc(pad, 65), raw, Buffer.alloc(r.int(3), 66)]).toString("base64");
  const full = c.replace(/\d/g, d => String.fromCharCode(0xff10 + +d));
  return {
    plain: value, compact: c, spaced, grouped, full, words: c.split("").map(d => WORDS[+d]).join(r.pick([" ", "-", ", "])),
    b64: b64(0), b64pad1: b64(1), b64pad2: b64(2), b64url: b64(r.int(3)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""), b64wrapped: b64(1).replace(/(.{8})/g, "$1\n"),
    hex: raw.toString("hex"), hexc: Buffer.from(c).toString("hex"), url: encodeURIComponent(grouped), uni: [...c].map(ch => "\\u00" + ch.charCodeAt(0).toString(16)).join(""),
    partial: c.slice(0, Math.max(8, Math.ceil(c.length * 0.75))), partial2: c.slice(c.length - Math.max(8, Math.ceil(c.length * 0.75))), upper: value.toUpperCase(),
  };
}

test("canary corpus: every disguise of a ledgered SSN or card is caught, in any surrounding text", () => {
  property("ledger canary", 60, r => {
    const isCard = r.int(2) === 1, v = isCard ? luhnCard(r).replace(/(\d{4})(?=\d)/g, "$1 ") : randomSsn(r).replace(/(\d{3})(\d{2})(\d{4})/, "$1-$2-$3");
    const l = new Ledger(); l.add(ledgerEntries(v, isCard ? "card" : "us-ssn", l.key));
    for (const [name, text] of Object.entries(disguises(v, r))) {
      if (isCard && name === "full") continue;
      const hit = l.check(`${prose(r)} ${text} ${prose(r)}`);
      assert.ok(hit && hit.hit, `missed ${name}: ${JSON.stringify(text)}`);
    }
  });
});

test("the ledger does not flag unrelated text, another value, or another session's key", () => {
  property("ledger quiet", 80, r => {
    const a = randomSsn(r), b = randomSsn(r);
    if (a === b) return;
    const l = new Ledger(); l.add(ledgerEntries(a, "us-ssn", l.key));
    assert.equal(l.check(`${prose(r)} ${b} ${prose(r)} 4821 555-0100 2026-10-03`), null);
    const other = new Ledger(); // a different key: entries from l mean nothing to it
    other.add(ledgerEntries(a, "us-ssn", l.key));
    assert.equal(other.check(a), null);
  });
  assert.equal(new Ledger().check("anything at all 123-45-6789"), null, "an empty ledger refuses nothing");
});

test("a derived session inherits the ledger under the same key, and the parent does not learn the child's values", () => {
  const p = new Ledger(), c = p.derive();
  p.add(ledgerEntries("123-45-6789", "us-ssn", p.key));
  assert.ok(c.check("x 123456789 y"));
  c.add(ledgerEntries("987-65-4320", "us-ssn", c.key));
  assert.ok(c.check("987654320")); assert.equal(p.check("987654320"), null);
});

test("a prompt too large to scan is reported as too big, so the door can fail closed", () => {
  const l = new Ledger(); l.add(ledgerEntries("123-45-6789", "us-ssn", l.key));
  assert.deepEqual(l.check("a".repeat(MAX_WINDOWS + 10)), { too_big: true });
});

test("the ledger holds keyed hashes only: entries carry no form of the value", () => {
  const e = ledgerEntries("123-45-6789", "us-ssn", Buffer.alloc(32, 1)), t = JSON.stringify(e);
  for (const x of ["123", "6789", "MTIz", "3132"]) assert.ok(!t.includes(x), x);
  assert.ok(e.every(x => /^[0-9a-f]{32}$/.test(x.h)));
});

test("fold: encodings and digit words, not prose", () => {
  assert.equal(compact("１２３ four%2D5 six"), "123456".slice(0, 3) + "4" + "5" + "6".repeat(0) + "6");
  assert.equal(fold("Nine-One-One"), "9-1-1");
});

test("class validators accept real shapes and refuse the near misses", () => {
  const ok = { "us-ssn": "078-05-1120", "us-itin": "912-70-1234", "us-ein": "12-3456789", card: "4111 1111 1111 1111", "routing-number": "021000021", iban: "GB82 WEST 1234 5698 7654 32", "bank-account": "000123456789", passport: "A12345678", "tax-id": "AB1234567890", medical: "x", free: "x" };
  const bad = { "us-ssn": "666-12-3456", "us-itin": "123-45-6789", "us-ein": "07-1234567", card: "4111 1111 1111 1112", "routing-number": "021000022", iban: "GB82 WEST 1234 5698 7654 33", "bank-account": "12", passport: "12", "tax-id": "12" };
  for (const [k, v] of Object.entries(ok)) assert.equal(CLASSES[k].validate(v), true, k);
  for (const [k, v] of Object.entries(bad)) assert.equal(CLASSES[k].validate(v), false, k);
  assert.equal(CLASSES["us-ssn"].validate("000-12-3456") || CLASSES["us-ssn"].validate("123-00-4567") || CLASSES["us-ssn"].validate("123-45-0000") || CLASSES["us-ssn"].validate("900-12-3456"), false);
});

test("detectors find the common shapes after folding and leave ordinary numbers alone", () => {
  const find = t => detect(t).map(f => f.class);
  assert.deepEqual(find("ssn 078-05-1120"), ["us-ssn"]);
  assert.deepEqual(find("ssn 078 05 1120 and 078051120"), ["us-ssn", "us-ssn"]);
  assert.deepEqual(find("zero seven eight oh five one one two zero"), ["us-ssn"]);
  assert.deepEqual(find("card 4111-1111-1111-1111"), ["card"]);
  assert.deepEqual(find("pay to routing 021000021 please"), ["routing-number"]);
  assert.deepEqual(find("EIN 12-3456789"), ["us-ein"]);
  assert.deepEqual(find("IBAN GB82 WEST 1234 5698 7654 32"), ["iban"]);
  assert.deepEqual(find("itin 912-70-1234"), ["us-itin"]);
  for (const quiet of ["ZIP 94110-1234", "call 415-555-0100 or 4155550100", "invoice 2026100312345", "born 1980-05-12", "card 4111 1111 1111 1112", "order 123456789012", "version 1.2.3.4.5.6.7.8.9"]) assert.deepEqual(find(quiet), [], quiet);
  assert.equal(redact("a 078-05-1120 b 078-05-1120 c 912-70-1234").text, "a [sealed: US SSN #1] b [sealed: US SSN #1] c [sealed: US ITIN #1]");
});
