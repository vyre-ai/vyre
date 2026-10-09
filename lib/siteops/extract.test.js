// @ts-check
// extract: parse, extract, pick, cap, and the shape used to see drift.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseBody, getPath, pick, splitPick, extract, capOutput, inferShape, extractEmbedded, xssiOf } from "./extract.js";

test("parseBody strips XSSI prefixes and reads length-prefixed chunks", () => {
  assert.deepEqual(parseBody(`)]}'\n{"a":1}`), { a: 1 });
  assert.equal(xssiOf(`for (;;);{"a":1}`), "for (;;);");
  assert.deepEqual(parseBody(`)]}'\n\n5\n[1,2]\n3\n[3]`), [[1, 2], [3]]);
});

test("getPath steps into JSON strings, indexes, quoted keys and [*]", () => {
  const d = { a: { "x.y": [{ n: 1 }, { n: 2 }] }, s: JSON.stringify({ deep: [7, 8] }), groups: [{ items: [1, 2] }, { items: [3] }, { other: 1 }] };
  assert.equal(getPath(d, 'a["x.y"][1].n'), 2);
  assert.equal(getPath(d, "s.deep[1]"), 8);
  assert.deepEqual(getPath(d, "groups[*].items"), [1, 2, 3]);
  assert.equal(getPath(d, "nope.x"), undefined);
});

test("pick renames, filters by regex and drops empty items", () => {
  const rows = [{ name: "A", url: "https://x/in/ada" }, { junk: 1 }, { name: "B", url: "https://x/in/bo" }];
  assert.deepEqual(pick(rows, ["name", "slug=url~/in/([^/]+)"]), [{ name: "A", slug: "ada" }, { name: "B", slug: "bo" }]);
  assert.deepEqual(splitPick("a,b=c~(x,y),d"), ["a", "b=c~(x,y)", "d"]);
});

test("extract applies path then pick; embedded JSON is found by regex", () => {
  const body = JSON.stringify({ data: { rows: [{ id: 1, n: "a", z: 0 }] } });
  assert.deepEqual(extract({ format: "json", extract: "data.rows", pick: ["id", "n"] }, body), [{ id: 1, n: "a" }]);
  const page = `<script id="d" type="application/json">{"user":{"name":"Ada"}}</script>`;
  assert.deepEqual(extractEmbedded(page, 'id="d"[^>]*>\\s*([[{])'), { user: { name: "Ada" } });
});

test("capOutput never exceeds the cap and says what it cut", () => {
  const big = Array.from({ length: 500 }, (_, i) => ({ i, text: "x".repeat(100) }));
  const r = capOutput(big, 5000);
  assert.ok(JSON.stringify(r.data).length <= 5000);
  assert.match(String(r.truncated), /showing \d+ of 500 items/);
  assert.deepEqual(capOutput({ a: 1 }).data, { a: 1 });
});

test("inferShape records key paths and types, with id-keyed maps as *", () => {
  const s = inferShape({ results: [{ id: "a", meta: { score: 1 } }], airports: { SFO: { n: 1 }, JFK: { n: 2 } } });
  assert.equal(s["results[].meta.score"], "number");
  assert.equal(s["airports.*.n"], "number");
});
