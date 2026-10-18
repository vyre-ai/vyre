// @ts-check
import "../../../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { actOn, boxSelect, caps, copyName, editCalls, fileMenu } from "./file-menu-model.js";

const ids = (/** @type {any[][]} */ g) => g.map((x) => x.map((i) => i.id));

test("a Space file offers everything the backend does, in groups", () => {
  assert.deepEqual(ids(fileMenu([{ root: "space", dir: false }])), [["open", "look", "ask"], ["share", "download", "versions"], ["move", "rename", "duplicate"], ["delete"]]);
});

test("a linked file moves, renames and deletes but shares no link and keeps no versions list here", () => {
  assert.deepEqual(ids(fileMenu([{ root: "linked", dir: false, link: "l1" }])), [["open", "look", "ask"], ["download"], ["move", "rename"], ["delete"]]);
});

test("a box share is read-only: details, look and nothing that changes it", () => {
  assert.deepEqual(ids(fileMenu([{ root: "box", dir: false }])), [["open", "look"]]);
  assert.deepEqual(caps("computer"), { move: false, rename: false, remove: false, share: false, download: false, versions: false, duplicate: false, ask: false, look: false });
});

test("a folder opens, moves, renames and deletes; it is not asked about or shared", () => {
  assert.deepEqual(ids(fileMenu([{ root: "space", dir: true }])), [["open"], ["move", "rename"], ["delete"]]);
});

test("a selection offers Ask, Download, Move and Delete, never Rename, Open or Quick Look; a mixed source loses what one of them cannot do", () => {
  const sel = [{ root: "space", dir: false }, { root: "space", dir: false }, { root: "space", dir: false }];
  assert.deepEqual(ids(fileMenu(sel)), [["ask"], ["download"], ["move"], ["delete"]]);
  assert.equal(fileMenu(sel)[3][0].label, "Delete 3 items");
  assert.deepEqual(ids(fileMenu([{ root: "space", dir: false }, { root: "box", dir: false }])), [], "a box file in the set takes every change away and offers nothing common");
  assert.deepEqual(fileMenu([]), []);
});

test("a right-click acts on the whole selection when the row is in it, else on that row alone", () => {
  assert.deepEqual(actOn(new Set(["a", "b"]), "b"), { keys: ["a", "b"], reselect: false });
  assert.deepEqual(actOn(new Set(["a", "b"]), "c"), { keys: ["c"], reselect: true });
  assert.deepEqual(actOn(new Set(), "c"), { keys: ["c"], reselect: true });
});

test("a copy's name keeps the extension and counts up while taken", () => {
  assert.equal(copyName("brief.pdf", new Set(["brief.pdf"])), "brief copy.pdf");
  assert.equal(copyName("brief.pdf", new Set(["brief copy.pdf"])), "brief copy 2.pdf");
  assert.equal(copyName("notes", new Set()), "notes copy");
  assert.equal(copyName(".env", new Set()), ".env copy");
});

test("a box dragged on empty space picks the rows it touches, whichever corner it started from", () => {
  const rects = { a: { left: 0, top: 0, right: 100, bottom: 40 }, b: { left: 0, top: 40, right: 100, bottom: 80 }, c: { left: 0, top: 80, right: 100, bottom: 120 } };
  assert.deepEqual(boxSelect({ x1: 10, y1: 30, x2: 50, y2: 50 }, rects), ["a", "b"]);
  assert.deepEqual(boxSelect({ x1: 50, y1: 100, x2: 10, y2: 60 }, rects), ["b", "c"]);
  assert.deepEqual(boxSelect({ x1: 200, y1: 0, x2: 300, y2: 50 }, rects), []);
});

test("a move, a rename and a delete are the right tool for the source, with the call that undoes them", () => {
  const sp = { root: "space", path: "Clients/A/brief.pdf", name: "brief.pdf" };
  assert.deepEqual(editCalls("move", sp, "/Archive/"), { call: { tool: "files.drive.space.move", input: { from: "Clients/A/brief.pdf", to: "Archive/brief.pdf" } }, undo: { tool: "files.drive.space.move", input: { from: "Archive/brief.pdf", to: "Clients/A/brief.pdf" } } });
  assert.equal(editCalls("move", sp, "")?.call.input.to, "brief.pdf", "an empty folder is the top");
  assert.deepEqual(editCalls("rename", sp, "final.pdf"), { call: { tool: "files.drive.space.rename", input: { path: "Clients/A/brief.pdf", name: "final.pdf" } }, undo: { tool: "files.drive.space.rename", input: { path: "Clients/A/final.pdf", name: "brief.pdf" } } });
  assert.deepEqual(editCalls("delete", sp, ""), { call: { tool: "files.drive.space.delete", input: { path: "Clients/A/brief.pdf" } }, undo: null });
  const ln = { root: "linked", link: "l1", path: "a/x.txt", name: "x.txt" };
  assert.deepEqual(editCalls("move", ln, "b"), { call: { tool: "files.linked.rename", input: { id: "l1", path: "a/x.txt", to: "b/x.txt" } }, undo: { tool: "files.linked.rename", input: { id: "l1", path: "b/x.txt", to: "a/x.txt" } } });
  assert.deepEqual(editCalls("delete", ln, "")?.call, { tool: "files.linked.delete", input: { id: "l1", path: "a/x.txt" } });
  assert.equal(editCalls("move", { root: "box", path: "x", name: "x" }, "y"), null, "a box share is read-only");
  assert.equal(editCalls("delete", { root: "linked", path: "x", name: "x" }, ""), null, "a linked row with no link id does nothing");
});
