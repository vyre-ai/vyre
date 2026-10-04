// @ts-check
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { HAVE, nameOf, recoverCheck, recoverRefusal, successToast } from "./have-model.js";

test("each refusal has its own sentence and an unknown one says nothing was changed, never the server's text", () => {
  for (const [code, re] of [["bad_format", /26 letters and numbers/], ["not_found", /No one has that name/], ["not_a_person", /does not belong to a person/], ["wrong_code", /Nothing was changed/], ["unreachable", /Cannot reach the names directory/], ["rate_limited", /Too many tries/], ["newcomer", /24 hours/], ["rolled_back", /older version of this name.*will not trust it.*add this phone from another device/], ["exists", /already holds a different Vyre name, so it cannot take this one/], ["not_built", /not available in this build yet\. Nothing was changed/]])
    assert.match(recoverRefusal(code), re, code);
  assert.equal(recoverRefusal("surprise"), "Nothing was changed. Try again.");
});

test("the form is checked before the directory is asked: a name and a 26-character code, with or without dashes", () => {
  const good = "abcdefghijklmnopqrstuvwxyz".slice(0, 20) + "234567";
  assert.equal(recoverCheck({ name: "alex", code: good }), null);
  assert.equal(recoverCheck({ name: "alex.vyre.run", code: good.replace(/(.{4})/g, "$1-") }), null);
  assert.equal(recoverCheck({ name: " ", code: good })?.code, "not_found");
  assert.equal(recoverCheck({ name: "alex", code: "short" })?.code, "bad_format");
  assert.equal(nameOf(" Alex.vyre.run "), "alex");
});

test("the copy is ui-ux's final text", () => {
  assert.equal(HAVE.title, "Welcome back");
  assert.equal(HAVE.lostKeyTitle, "This iPhone no longer has your key");
  assert.equal(HAVE.go, "Bring my name here");
  assert.equal(successToast("alex"), "Welcome back, alex.");
  assert.equal(HAVE.spacesLine, "This iPhone should join your spaces on its own. It can take up to a minute.");
});
