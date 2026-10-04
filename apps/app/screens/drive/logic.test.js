import "../../scripts/test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { addLink, canShare, filesIn, projectsIn, restore, revoke, versionsOf } from "./logic.js";

const F = (id, sp, proj, extra = {}) => ({ id, sp, proj, name: `${id}.pdf`, ver: 3, mod: "Today", by: "kit", size: "1 KB", ...extra });
const files = [F("d1", "harlow", "estate"), F("d2", "harlow", "harlow", { sealed: true }), F("d3", "mine", "site")];

test("files filter by space and project", () => {
  assert.equal(filesIn(files, "all", "all").length, 3);
  assert.deepEqual(filesIn(files, "harlow", "estate").map((f) => f.id), ["d1"]);
  assert.deepEqual(projectsIn(files, "mine"), ["site"]);
});

test("versions run newest first and say who and when", () => {
  const v = versionsOf(files[0], ["chris", "kit"]);
  assert.deepEqual(v.map((x) => x.n), [3, 2, 1]);
  assert.equal(v[0].current, true);
  assert.match(v[2].line, /^Created by/);
});

test("restoring an old version adds a new one", () => {
  assert.equal(restore(files, "d1", 1)[0].ver, 4);
  assert.equal(restore(files, "d1", 3)[0].ver, 3);
});

test("a sealed file cannot be shared; links can be revoked", () => {
  assert.equal(canShare(files[1]), false);
  assert.equal(addLink([], files[1]).length, 0);
  const l = addLink([], files[0]);
  assert.equal(l.length, 1);
  assert.deepEqual(revoke(l, l[0].id), []);
});
