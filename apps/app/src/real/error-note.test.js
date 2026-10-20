import "../../../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { errorNote } from "./error-note.js";

test("a known code shows the box's words, what to do and the code", () => {
  const n = errorNote({ code: "not_found", message: "no agent kit" });
  assert.deepEqual([n.code, n.reason], ["not_found", "no agent kit"]);
  assert.match(n.recourse, /Check the name/);
  assert.equal(n.title, "Not found");
});
test("no message: the catalogue's description stands in; an unknown code still shows the code; nothing at all shows the fallback", () => {
  assert.match(errorNote({ code: "timeout" }).reason, /waited for an answer/i);
  const u = errorNote({ code: "brand_new", message: "x broke" });
  assert.deepEqual([u.code, u.reason, u.recourse, u.title], ["brand_new", "x broke", "", ""]);
  assert.equal(errorNote(null, "Backups could not be read.").reason, "Backups could not be read.");
});

test("plainError: a readable sentence stays; a tool name, an address or a code gives way to the catalogue's words; nothing known is the fallback", async () => {
  const { plainError } = await import("./error-note.js");
  assert.equal(plainError({ code: "not_allowed", message: "Only an owner or an admin adds a link. Ask one of them." }), "Only an owner or an admin adds a link. Ask one of them.");
  assert.equal(plainError(Object.assign(new Error("that record changed meanwhile"), { code: "version_conflict" })), "That record changed meanwhile.");
  const raw = plainError({ code: "not_found", message: "no such space (spaces.list shows the ones you are in)" });
  assert.equal(raw, "No such space.", "a pointer in brackets for a model is taken off");
  const tech = plainError({ code: "not_found", message: "no records.serve call role.set for vyre://spc_abcdefghijkl/contact/x" });
  assert.match(tech, /^Not found\. Check the name/);
  assert.doesNotMatch(tech, /records\.|vyre:\/\//);
  assert.equal(plainError({ code: "brand_new", message: "bad_thing happened" }, "That did not save."), "That did not save.");
  assert.equal(plainError(undefined, "That did not save."), "That did not save.");
  assert.equal(plainError("plain words here"), "Plain words here.");
});
