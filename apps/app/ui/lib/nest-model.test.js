import "../../../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { crumbsOf, nestHint, nestKey, nestRows, nestStep } from "./nest-model.js";

const leaf = (key, label, pick) => ({ key, label, pick: { pick: label, urn: `u/${key}`, kind: "record", ...pick } });
const tree = [
  { key: "projects", label: "Projects", kids: [
    { key: "t-matter", label: "Matter", pick: { pick: "Matter (all)", urn: "template/matter", kind: "collection" }, kids: [leaf("p-okafor", "Okafor estate"), leaf("p-lee", "Lee trust")] },
    { key: "t-atp", label: "ATP", kids: [leaf("p-atp1", "ATP Rivera")] },
  ] },
  { key: "records", label: "Records", kids: [
    { key: "o-clients", label: "Clients", pick: { pick: "Clients (all)", urn: "type/Clients", kind: "collection" }, kids: [leaf("r-dana", "Dana Okafor"), leaf("r-sam", "Sam Lee")] },
    { key: "o-matters", label: "Matters", pick: { pick: "Matters (all)", urn: "type/Matters", kind: "collection" }, kids: [leaf("r-okafor", "Okafor estate")] },
  ] },
  { key: "tags", label: "Tags", kids: [leaf("tag-estate", "estate", { kind: "tag" })] },
];
const labels = (rows) => rows.map((r) => r.label);

test("top level shows the categories, each one a branch", () => {
  const rows = nestRows(tree, [], "");
  assert.deepEqual(labels(rows), ["Projects", "Records", "Tags"]);
  assert.ok(rows.every((r) => r.drill && !r.pick));
});

test("drill: Right on a category opens it, and the trail is absolute", () => {
  const rows = nestRows(tree, [], "");
  const path = nestStep([], "drill", rows[1]);
  assert.deepEqual(path, ["records"]);
  const inner = nestRows(tree, path, "");
  assert.deepEqual(labels(inner), ["Clients", "Matters"]);
  assert.deepEqual(inner[0].trail, ["records", "o-clients"]);
});

test("an object offers the whole (pick) and a way in (drill)", () => {
  const [clients] = nestRows(tree, ["records"], "");
  assert.equal(clients.drill, true);
  assert.deepEqual(clients.pick, { pick: "Clients (all)", urn: "type/Clients", kind: "collection" });
  assert.equal(nestKey({ key: "Enter" }, { query: "", count: 2, depth: 1, row: clients }), "pick");
  assert.equal(nestKey({ key: "ArrowRight" }, { query: "", count: 2, depth: 1, row: clients }), "drill");
  const inner = nestRows(tree, ["records", "o-clients"], "");
  assert.deepEqual(labels(inner), ["Dana Okafor", "Sam Lee"]);
  assert.equal(inner[0].drill, false);
});

test("a category has no whole: Enter drills in", () => {
  const [projects] = nestRows(tree, [], "");
  assert.equal(nestKey({ key: "Enter" }, { query: "", count: 3, depth: 0, row: projects }), "drill");
  assert.equal(nestKey({ key: "Tab" }, { query: "", count: 3, depth: 0, row: projects }), "drill");
});

test("Tab and Enter pick a leaf; Right on a leaf does nothing", () => {
  const [dana] = nestRows(tree, ["records", "o-clients"], "");
  assert.equal(nestKey({ key: "Tab" }, { query: "", count: 2, depth: 2, row: dana }), "pick");
  assert.equal(nestKey({ key: "Enter" }, { query: "", count: 2, depth: 2, row: dana }), "pick");
  assert.equal(nestKey({ key: "ArrowRight" }, { query: "", count: 2, depth: 2, row: dana }), null);
});

test("back: Left and Backspace on an empty query go up one; at the top Backspace closes", () => {
  const row = nestRows(tree, ["records"], "")[0];
  assert.equal(nestKey({ key: "ArrowLeft" }, { query: "", count: 2, depth: 1, row }), "back");
  assert.equal(nestKey({ key: "Backspace" }, { query: "", count: 2, depth: 1, row }), "back");
  assert.equal(nestKey({ key: "Backspace" }, { query: "", count: 3, depth: 0, row: nestRows(tree, [], "")[0] }), "close");
  // with text typed, Left and Backspace belong to the box
  assert.equal(nestKey({ key: "ArrowLeft" }, { query: "da", count: 1, depth: 1, row }), null);
  assert.equal(nestKey({ key: "Backspace" }, { query: "da", count: 1, depth: 1, row }), null);
  assert.deepEqual(nestStep(["records", "o-clients"], "back"), ["records"]);
  assert.deepEqual(nestStep([], "back"), []);
});

test("Esc closes, Up and Down move, only with rows", () => {
  const row = nestRows(tree, [], "")[0];
  assert.equal(nestKey({ key: "Escape" }, { query: "x", count: 0, depth: 2, row: undefined }), "close");
  assert.equal(nestKey({ key: "ArrowDown" }, { query: "", count: 3, depth: 0, row }), "next");
  assert.equal(nestKey({ key: "ArrowUp" }, { query: "", count: 3, depth: 0, row }), "prev");
  assert.equal(nestKey({ key: "ArrowDown" }, { query: "", count: 0, depth: 0, row: undefined }), null);
  assert.equal(nestKey({ key: "ArrowRight", metaKey: true }, { query: "", count: 1, depth: 0, row }), null);
});

test("typing at the top searches across every category, grouped, with the path", () => {
  const rows = nestRows(tree, [], "okafor");
  assert.deepEqual(rows.map((r) => [r.group, r.label]), [
    ["Projects", "Okafor estate"],
    ["Records", "Okafor estate"],
    ["Records", "Dana Okafor"],
  ]);
  assert.equal(rows[0].path, "Matter › Okafor estate");
  assert.equal(rows[1].path, "Matters › Okafor estate");
  assert.deepEqual(rows[1].trail, ["records", "o-matters", "r-okafor"]);
});

test("search keeps best matches first inside a group, and finds objects as drillable rows", () => {
  const rows = nestRows(tree, [], "ma");
  const r = rows.filter((x) => x.group === "Records").map((x) => x.label);
  assert.deepEqual(r, ["Matters"]);
  const obj = rows.find((x) => x.label === "Matters");
  assert.equal(obj.drill, true);
  assert.deepEqual(nestStep([], "drill", obj), ["records", "o-matters"]);
  assert.ok(rows.some((x) => x.label === "Matter" && x.group === "Projects"));
});

test("search with no match is empty", () => {
  assert.deepEqual(nestRows(tree, [], "zzz"), []);
});

test("inside a level the query filters that level only", () => {
  assert.deepEqual(labels(nestRows(tree, ["records", "o-clients"], "sam")), ["Sam Lee"]);
  assert.deepEqual(labels(nestRows(tree, ["records"], "okafor")), []);
});

test("a path that no longer exists falls back to the top", () => {
  assert.deepEqual(labels(nestRows(tree, ["records", "gone"], "")), ["Projects", "Records", "Tags"]);
});

test("a branch whose children are not loaded yet reads as empty, not as a leaf", () => {
  const t = [{ key: "files", label: "Files", kids: [] }];
  const rows = nestRows(t, [], "");
  assert.equal(rows[0].drill, true);
  assert.deepEqual(nestRows(t, ["files"], ""), []);
});

test("breadcrumb: the labels from the top to here", () => {
  assert.deepEqual(crumbsOf(tree, []), []);
  assert.deepEqual(crumbsOf(tree, ["records", "o-clients"]), ["Records", "Clients"]);
  assert.deepEqual(crumbsOf(tree, ["records", "gone"]), ["Records"]);
});

test("the footer names the keys that work here", () => {
  assert.match(nestHint(0, undefined), /type to search/i);
  assert.equal(nestHint(1, { drill: true, pick: { pick: "x" } }), "→ open · ← back · ⏎ pick");
  assert.equal(nestHint(1, { drill: false, pick: { pick: "x" } }), "← back · ⏎ pick");
  assert.equal(nestHint(1, { drill: true, pick: undefined }), "→ open · ← back");
  assert.equal(nestHint(0, { drill: true, pick: undefined }).startsWith("→ open"), true);
});
