import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { blankMail, sendInput, problemOf, addressesOf } from "./mail-composer-model.js";

test("mail composer: addresses are a comma list, trimmed, with empties dropped", () => {
  assert.deepEqual(addressesOf(" dana@northwind-bakery.example, ,juno@harlow.example "), ["dana@northwind-bakery.example", "juno@harlow.example"]);
  assert.deepEqual(addressesOf(""), []);
});

test("mail composer: a blank copy line is left out of what mail.send takes", () => {
  const f = { ...blankMail(), to: "dana@northwind-bakery.example", subject: "Invoice", body: "Attached." };
  assert.deepEqual(sendInput(f), { to: ["dana@northwind-bakery.example"], subject: "Invoice", body: "Attached." });
});

test("mail composer: cc, bcc and Files go in as mail.send takes them, the Files by path", () => {
  const f = { ...blankMail(), to: "dana@northwind-bakery.example", cc: "juno@harlow.example", bcc: "kit@harlow.example", subject: "Invoice", body: "Attached.",
    files: [{ path: "Invoices/Friday.pdf", name: "Friday.pdf" }] };
  assert.deepEqual(sendInput(f), { to: ["dana@northwind-bakery.example"], cc: ["juno@harlow.example"], bcc: ["kit@harlow.example"], subject: "Invoice", body: "Attached.",
    attachments: [{ path: "Invoices/Friday.pdf", name: "Friday.pdf" }] });
});

test("mail composer: says who it goes to, and that there are too many files", () => {
  assert.equal(problemOf(blankMail()), "Say who it goes to.");
  const many = Array.from({ length: 11 }, (_, i) => ({ path: `f${i}`, name: `f${i}` }));
  assert.equal(problemOf({ ...blankMail(), to: "a@b.example", files: many }), "An email takes at most 10 files.");
  assert.equal(problemOf({ ...blankMail(), to: "a@b.example" }), null);
});
