// @ts-check
import "../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { seesNote, visibilityOf, aboutOf, NOTE_VISIBILITY } from "./note-share.js";

const ABOUT = "vyre://s/contact/0192f5a0-0000-7000-8000-000000000001";
const readable = async (/** @type {string} */ u) => u === ABOUT;

test("a note is private unless shared; a bad value reads as private", () => {
  assert.deepEqual(NOTE_VISIBILITY, ["private", "record", "space"]);
  assert.equal(visibilityOf(undefined), "private");
  assert.equal(visibilityOf("everyone"), "private");
  assert.equal(visibilityOf("space"), "space");
  assert.equal(aboutOf(ABOUT), ABOUT);
  assert.equal(aboutOf("not a urn"), null);
  assert.equal(aboutOf("vyre://s/note/0192f5a0-0000-7000-8000-000000000001"), null, "a note is about a record, not another note");
});

test("the writer reads their note; others read it only as shared", async () => {
  const note = (/** @type {any} */ more) => ({ kind: "note", by: "ana", ...more });
  assert.equal(await seesNote(note({}), "ana", readable), true, "the writer");
  assert.equal(await seesNote(note({}), "ben", readable), false, "private");
  assert.equal(await seesNote(note({ visibility: "space" }), "ben", readable), true, "shared with the Space");
  assert.equal(await seesNote(note({ visibility: "record", record: ABOUT }), "ben", readable), true, "shared with a record they can read");
  assert.equal(await seesNote(note({ visibility: "record", record: "vyre://s/contact/0192f5a0-0000-7000-8000-000000000002" }), "ben", readable), false, "a record they cannot read");
  assert.equal(await seesNote(note({ visibility: "record" }), "ben", readable), false, "no record named");
});

test("only notes are judged, and a call with no person reads all", async () => {
  assert.equal(await seesNote({ kind: "reminder", by: "ana" }, "ben", readable), true);
  assert.equal(await seesNote({ kind: "note", by: "ana" }, null, readable), true);
});
