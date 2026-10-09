// @ts-check
// lib/scrub.js: the one place known secret values come out of text.
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { scrub, scrubAll, valueForms, CONCEALED, compact } from "./scrub.js";

const PEM = "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\nabcdEFGH==\n-----END PRIVATE KEY-----\n";

test("a value goes out in every form it is commonly seen in", () => {
  const v = "s3cr3t/Value+with space&=";
  const b = Buffer.from(v);
  const seen = ["x " + v + " y", b.toString("base64"), b.toString("base64").replace(/=+$/, ""), b.toString("base64url"), encodeURIComponent(v), encodeURIComponent(v).replace(/%20/g, "+"), JSON.stringify(v).slice(1, -1)];
  for (const form of seen) {
    const out = scrub(`before ${form} after`, [v]);
    assert.ok(!out.includes(form), `form not removed: ${form}`);
    assert.match(out, new RegExp(CONCEALED.replace(/[<>]/g, "\\$&")));
  }
});

test("the JSON-escaped form catches a PEM key that sits inside a JSON string", () => {
  const inJson = JSON.stringify({ key: PEM });
  assert.ok(!scrub(inJson, [PEM]).includes("MIIEvQIBADANBgkqhkiG9w0BAQEFAASC"));
  const walked = JSON.stringify(scrubAll({ nested: [{ key: PEM }], [PEM]: "as a key" }, [PEM]));
  assert.ok(!walked.includes("MIIEvQIBADANBgkqhkiG9w0BAQEFAASC") && !walked.includes("MIIEvQIBADANBgkqhkiG9w0BAQEFAASC".slice(4, 20)), walked);
});

test("a value shorter than the minimum is left alone, and a marker and a minimum can be chosen", () => {
  assert.equal(scrub("abc and abcd", ["abc"]), "abc and abcd");
  assert.equal(scrub("abc and abcd", ["abcd"]), `abc and ${CONCEALED}`);
  assert.equal(scrub("a key=ab", ["ab"], { marker: "[key]", min: 1 }), "a key=[key]");
  assert.equal(scrub("token tok-12345", ["tok-12345"], { marker: "[token]" }), "token [token]");
});

test("the longest form goes first, so a form that contains another is replaced whole", () => {
  const v = "abcd1234";
  const b = Buffer.from(v).toString("base64");
  assert.equal(scrub(`${b}/${v}`, [v]), `${CONCEALED}/${CONCEALED}`);
});

test("non-strings and missing input are harmless", () => {
  assert.equal(scrub(undefined, [null, 5, undefined]), "");
  assert.equal(scrub(null, undefined), "");
  assert.deepEqual(scrubAll({ n: 1, ok: true, nul: null }, ["secret-value"]), { n: 1, ok: true, nul: null });
});

test("scrubAll walks keys, values, arrays and an Error's message", () => {
  const out = scrubAll({ ["k-secret-value"]: ["v secret-value", { deep: "secret-value" }], err: new Error("boom secret-value") }, ["secret-value"]);
  const text = JSON.stringify(out);
  assert.ok(!text.includes("secret-value"), text);
  assert.ok(out.err instanceof Error && !out.err.message.includes("secret-value"));
});

test("wide forms: case, letters-and-digits only, hex", () => {
  const v = "Ab-12 Cd";
  const wide = valueForms(v, { wide: true });
  for (const f of [v.toLowerCase(), v.toUpperCase(), compact(v), Buffer.from(v).toString("hex")]) assert.ok(wide.includes(f), f);
  assert.ok(!valueForms(v).includes(v.toLowerCase()), "the narrow set is exact");
  assert.equal(compact("１２-ab C"), "12abc");
});
