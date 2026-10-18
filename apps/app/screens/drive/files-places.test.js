// @ts-check
import "../../../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { detailLines, placeGroups, quickLook, recentOf } from "./files-places.js";

test("the left column: three places, the projects the person can see, then Sites with New site always last", () => {
  const g = placeGroups({ projects: [{ name: "Spring launch", path: "Projects/p1/files" }], agents: [{ name: "ads", path: "agents/agt_a" }, { name: "x", path: "" }], sites: [{ id: "s1", name: "juniper.studio", live: true }, { id: "s2", name: "Spring landing" }] });
  assert.deepEqual(g.map((x) => x.heading), [null, "Projects", "Agents", "Sites"]);
  assert.deepEqual([g[1].places[0], g[2].places.map((p) => p.label)], [{ id: "project:Projects/p1/files", label: "Spring launch", kind: "project", path: "Projects/p1/files" }, ["ads"]], "an agent with no folder is not a place");
  assert.deepEqual(g[0].places.map((p) => p.label), ["All files", "Recent", "Your shared links"]);
  assert.deepEqual(g[3].places.map((p) => [p.label, p.live ?? false, p.draft ?? false]), [["juniper.studio", true, false], ["Spring landing", false, true], ["New site", false, false]]);
  const none = placeGroups();
  assert.deepEqual(none.map((x) => x.heading), [null, "Sites"], "no Projects heading over nothing");
  assert.deepEqual(none[1].places.map((p) => p.kind), ["newsite"]);
});

test("Recent is files only, newest first, and capped", () => {
  const rows = [{ dir: true, modified: 99 }, { dir: false, modified: 5 }, { dir: false, modified: 9 }, { dir: false, modified: 0 }];
  assert.deepEqual(recentOf(rows).map((r) => r.modified), [9, 5]);
  assert.equal(recentOf(Array.from({ length: 50 }, (_, i) => ({ dir: false, modified: i + 1 })), 30).length, 30);
});

test("a file's details are only what is known", () => {
  const when = (/** @type {number} */ at) => (at ? "1 hour ago" : "");
  assert.deepEqual(detailLines({ dir: false, by: "Dana", modified: 1, ver: 3 }, { where: "Spring launch", when, usedIn: ["Website", "Launch email"], whoCanSee: "Spring launch team" }),
    [{ k: "From", v: "Dana, 1 hour ago" }, { k: "In", v: "Spring launch" }, { k: "Versions", v: "3" }, { k: "Used in", v: "Website, Launch email" }, { k: "Who can see", v: "Spring launch team" }]);
  assert.deepEqual(detailLines({ dir: false, modified: 0 }), [], "nothing known, nothing drawn");
  assert.deepEqual(detailLines({ dir: false, by: "Sam", modified: 0, ver: 1 }), [{ k: "From", v: "Sam" }], "one version is not worth a line");
});

test("Quick Look: Space opens the selected file and closes it, folders never open, arrows step and stop at the ends, Esc closes", () => {
  const shown = [{ key: "a", dir: true }, { key: "b", dir: false }, { key: "c", dir: false }];
  let s = { open: /** @type {string | null} */ (null) };
  s = quickLook(s, { type: "space" }, shown, "a"); assert.equal(s.open, null, "a folder");
  s = quickLook(s, { type: "space" }, shown, null); assert.equal(s.open, null, "nothing selected");
  s = quickLook(s, { type: "space" }, shown, "b"); assert.equal(s.open, "b");
  s = quickLook(s, { type: "step", by: 1 }, shown, "b"); assert.equal(s.open, "c");
  s = quickLook(s, { type: "step", by: 1 }, shown, "b"); assert.equal(s.open, "c", "the end");
  s = quickLook(s, { type: "step", by: -5 }, shown, "b"); assert.equal(s.open, "b", "the start of the files, the folder is skipped");
  s = quickLook(s, { type: "space" }, shown, "b"); assert.equal(s.open, null, "Space again closes");
  s = quickLook(s, { type: "open", key: "c" }, shown, null); assert.equal(s.open, "c", "a double click");
  assert.equal(quickLook(s, { type: "close" }, shown, "c").open, null);
  assert.equal(quickLook({ open: "gone" }, { type: "step", by: 1 }, shown, null).open, null, "the open file left the list");
});
