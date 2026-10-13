// @ts-check
// The Files screen's pure half: the roots of the tree, rows from each source's listing, sorting, breadcrumbs and what each source lets you do.
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";

const strip = Boolean(/** @type {any} */ (process.features).typescript);
const NOW = 1_800_000_000_000;

test("the roots are Space, Shared, Linked (with a child per linked folder), Box folders and On your computer", { skip: !strip }, async () => {
  const m = await import("./files-model.ts");
  const roots = m.rootsOf({ linked: [{ id: "l1", name: "Client-docs" }], shares: [{ name: "Documents" }] });
  assert.deepEqual(roots.map((r) => [r.id, r.label]), [["space", "Space"], ["shared", "Shared"], ["linked", "Linked"], ["box", "Box folders"], ["computer", "On your computer"]]);
  assert.deepEqual(roots[2].kids.map((k) => [k.id, k.label]), [["linked:l1", "Client-docs"]]);
  assert.deepEqual(roots[3].kids.map((k) => k.label), ["Documents"]);
  assert.equal(roots[0].kids, undefined, "the Space's folders load when it is opened");
  assert.deepEqual(m.rootsOf({ linked: [], shares: [] }).map((r) => r.id), ["space", "shared", "linked", "box", "computer"], "a root with nothing in it is still there");
});

test("a place is one string, and it comes apart again", { skip: !strip }, async () => {
  const m = await import("./files-model.ts");
  assert.equal(m.placeId({ root: "space", path: "Clients/A" }), "space:Clients/A");
  assert.equal(m.placeId({ root: "linked", link: "l1", path: "a/b" }), "linked:l1:a/b");
  assert.equal(m.placeId({ root: "box", share: "Documents", path: "x" }), "box:Documents:x");
  for (const p of [{ root: "space", path: "" }, { root: "space", path: "Clients/A" }, { root: "linked", link: "l1", path: "a/b" }, { root: "linked", link: "l1", path: "" }, { root: "box", share: "Documents", path: "x" }, { root: "shared", path: "" }]) {
    assert.deepEqual(m.parsePlace(m.placeId(/** @type {any} */ (p))), p);
  }
  assert.equal(m.parsePlace("nonsense"), null);
});

test("rows from the Space, a linked folder and a box share have the same shape", { skip: !strip }, async () => {
  const m = await import("./files-model.ts");
  const space = m.rowsFromSpace([{ name: "Clients", dir: true, path: "Clients", size: 0, ver: 0, at: 5 }, { name: "a.pdf", dir: false, path: "Clients/a.pdf", size: 2048, ver: 3, at: NOW }], "Clients");
  const linked = m.rowsFromLinked("l1", "Docs", [{ name: "plan.md", path: "Linked/Docs/a/plan.md", dir: false, size: 10, modified: NOW, rev: "7" }, { name: "a", path: "Linked/Docs/a", dir: true, size: 0, modified: null, rev: null }]);
  const box = m.rowsFromBox("Documents", "/sub", [{ name: "n.txt", dir: false, kind: "text", mime: "text/plain", size: 29, mtime: new Date(NOW).toISOString() }]);
  assert.deepEqual(space.map((r) => [r.name, r.dir, r.kind, r.place]), [["Clients", true, "folder", "space:Clients"], ["a.pdf", false, "pdf", "space:Clients/a.pdf"]]);
  assert.deepEqual(linked.map((r) => [r.name, r.dir, r.kind, r.place, r.rev]), [["plan.md", false, "text", "linked:l1:a/plan.md", "7"], ["a", true, "folder", "linked:l1:a", null]]);
  assert.deepEqual(box.map((r) => [r.name, r.kind, r.place, r.modified]), [["n.txt", "text", "box:Documents:/sub/n.txt", NOW]]);
  assert.equal(space[1].ver, 3);
});

test("a kind comes from the name, and a folder is always a folder", { skip: !strip }, async () => {
  const m = await import("./files-model.ts");
  const k = (/** @type {string} */ n, dir = false) => m.kindOf(n, dir);
  assert.deepEqual(["a.PDF", "b.docx", "c.xlsx", "d.png", "e.mp4", "f.mp3", "g.zip", "h.md", "i.unknown", "j"].map((n) => k(n)), ["pdf", "doc", "sheet", "image", "video", "audio", "archive", "text", "file", "file"]);
  assert.equal(k("whatever.pdf", true), "folder");
});

test("sorting keeps folders first, whatever the column, and flips on a second press", { skip: !strip }, async () => {
  const m = await import("./files-model.ts");
  const rows = [
    { name: "b.txt", dir: false, size: 5, modified: 3 }, { name: "A", dir: true, size: 0, modified: 1 }, { name: "a.txt", dir: false, size: 50, modified: 2 }, { name: "Z", dir: true, size: 0, modified: 9 },
  ].map((r) => /** @type {any} */ (r));
  assert.deepEqual(m.sortRows(rows, "name", "asc").map((r) => r.name), ["A", "Z", "a.txt", "b.txt"]);
  assert.deepEqual(m.sortRows(rows, "name", "desc").map((r) => r.name), ["Z", "A", "b.txt", "a.txt"]);
  assert.deepEqual(m.sortRows(rows, "size", "desc").map((r) => r.name), ["A", "Z", "a.txt", "b.txt"]);
  assert.deepEqual(m.sortRows(rows, "modified", "desc").map((r) => r.name), ["Z", "A", "b.txt", "a.txt"]);
  assert.deepEqual(m.nextSort({ key: "name", dir: "asc" }, "name"), { key: "name", dir: "desc" });
  assert.deepEqual(m.nextSort({ key: "name", dir: "desc" }, "size"), { key: "size", dir: "asc" });
});

test("a filter matches words in a name, all of them, any case", { skip: !strip }, async () => {
  const m = await import("./files-model.ts");
  const rows = [{ name: "Retainer Agreement.pdf" }, { name: "notes.txt" }].map((r) => /** @type {any} */ (r));
  assert.deepEqual(m.filterRows(rows, " retainer PDF ").map((r) => r.name), ["Retainer Agreement.pdf"]);
  assert.equal(m.filterRows(rows, "").length, 2);
});

test("breadcrumbs name the root, then each step, and tapping one goes there", { skip: !strip }, async () => {
  const m = await import("./files-model.ts");
  const c = m.crumbsFor({ root: "linked", link: "l1", path: "a/b" }, { linked: { l1: "Docs" } });
  assert.deepEqual(c.map((x) => [x.name, x.place]), [["Linked", "linked"], ["Docs", "linked:l1"], ["a", "linked:l1:a"], ["b", "linked:l1:a/b"]]);
  assert.deepEqual(m.crumbsFor({ root: "space", path: "Clients/A" }, {}).map((x) => x.name), ["Space", "Clients", "A"]);
  assert.deepEqual(m.crumbsFor({ root: "box", share: "Documents", path: "/x" }, {}).map((x) => x.name), ["Box folders", "Documents", "x"]);
});

test("what a source lets you do is stated, so the bar offers only real things", { skip: !strip }, async () => {
  const m = await import("./files-model.ts");
  const can = (/** @type {string} */ root) => m.abilities(root);
  assert.deepEqual(can("space"), { upload: true, versions: true, move: false, remove: false, download: true, share: true, edit: false });
  assert.deepEqual(can("linked"), { upload: true, versions: true, move: true, remove: true, download: true, share: false, edit: true });
  assert.deepEqual(can("box"), { upload: false, versions: false, move: false, remove: false, download: true, share: false, edit: false });
  assert.deepEqual(can("shared"), { upload: false, versions: false, move: false, remove: true, download: false, share: false, edit: false });
  assert.equal(m.bulkActions("space", 2).map((a) => a.id).join(), "download,share");
  assert.equal(m.bulkActions("linked", 2).map((a) => a.id).join(), "move,download,delete");
  assert.equal(m.bulkActions("box", 0).length, 0);
});

test("selection: click selects one, ctrl or cmd toggles, shift takes a range, and the anchor stays", { skip: !strip }, async () => {
  const m = await import("./files-model.ts");
  const keys = ["a", "b", "c", "d", "e"];
  let s = m.selectOnly("b");
  assert.deepEqual([...s.set], ["b"]);
  s = m.selectToggle(s, "d");
  assert.deepEqual([...s.set].sort(), ["b", "d"]);
  s = m.selectToggle(s, "b");
  assert.deepEqual([...s.set], ["d"]);
  s = m.selectRange(m.selectOnly("b"), keys, "d");
  assert.deepEqual([...s.set], ["b", "c", "d"]);
  s = m.selectRange(s, keys, "a");
  assert.deepEqual([...s.set], ["a", "b"]);
  assert.deepEqual([...m.selectAll(keys).set], keys);
  assert.deepEqual([...m.prune(m.selectAll(keys), ["b", "c"]).set], ["b", "c"]);
});

test("the keyboard moves the focus row and opens, selects or goes up", { skip: !strip }, async () => {
  const m = await import("./files-model.ts");
  assert.equal(m.moveFocus(0, 5, "ArrowDown"), 1);
  assert.equal(m.moveFocus(4, 5, "ArrowDown"), 4);
  assert.equal(m.moveFocus(0, 5, "ArrowUp"), 0);
  assert.equal(m.moveFocus(2, 5, "Home"), 0);
  assert.equal(m.moveFocus(2, 5, "End"), 4);
  assert.equal(m.moveFocus(-1, 5, "ArrowDown"), 0);
  assert.equal(m.moveFocus(0, 0, "ArrowDown"), -1);
  assert.equal(m.parentPlace("space:Clients/A"), "space:Clients");
  assert.equal(m.parentPlace("space:Clients"), "space");
  assert.equal(m.parentPlace("linked:l1:a"), "linked:l1");
  assert.equal(m.parentPlace("linked:l1"), "linked");
  assert.equal(m.parentPlace("space"), null);
});
