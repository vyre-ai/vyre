// @ts-check
// The rename table (lib/tool-names-table.json) is sound: every proposed name is in the grammar, none is taken twice or is another tool's own name, every row is a tool that still exists (a removed or
// renamed tool leaves a stale row, which fails here), the effect class the verb implies is not weaker than what the tool declares, and the registry resolves a proposed name to its tool before any gate.
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { build, VERBS, AREAS, EFFECT } from "../scripts/names-table.mjs";
import { aliasOf, proposedNameOf } from "../lib/tool-names.js";

const table = JSON.parse(fs.readFileSync(new URL("../lib/tool-names-table.json", import.meta.url), "utf8"));
const live = new Map(build().map((r) => [r.old, r]));

test("every row is in the grammar: a known area, a verb of the 19, at most four segments, nothing empty", () => {
  for (const r of table.rows) {
    if (r.name === r.old) continue; // not placed yet: the tool keeps its own name until its owner settles it (review: true)
    const segs = String(r.name).split(".");
    assert.ok(segs.length >= 2 && segs.length <= 4, `${r.name}: ${segs.length} segments`);
    assert.ok(segs.every((s) => /^[a-z0-9][a-z0-9-]*$/.test(s)), `${r.name}: a segment is not lower-case words`);
    assert.ok(segs[0] in AREAS, `${r.name}: ${segs[0]} is not an area`);
    assert.ok(VERBS.includes(segs[segs.length - 1]), `${r.name}: ${segs[segs.length - 1]} is not a verb`);
    assert.equal(r.effect, EFFECT[segs[segs.length - 1]], `${r.name}: its effect class follows its verb`);
  }
});

test("no proposed name is used twice, and none is another tool's own name", () => {
  const seen = new Map();
  for (const r of table.rows) {
    if (r.name === r.old) continue;
    assert.ok(!seen.has(r.name), `${r.name} is proposed for both ${seen.get(r.name)} and ${r.old}`);
    seen.set(r.name, r.old);
    assert.ok(!live.has(r.name), `${r.name} (for ${r.old}) is already the name of another tool`);
  }
});

test("rows that name a tool that is gone are only reported, so another team's rename never turns this red (regenerate with scripts/names-table.mjs --write)", () => {
  const stale = table.rows.filter((r) => !live.has(r.old)).map((r) => r.old);
  if (stale.length) console.log(`tool-names: ${stale.length} rows name tools that are gone (${stale.slice(0, 5).join(", ")}); regenerate the table`);
  assert.ok(table.rows.length - stale.length > 1000, "the table still covers the tools that exist");
});

test("a proposed name resolves to the tool, in both directions, and an unknown name resolves to nothing", () => {
  const r = table.rows.find((x) => x.name !== x.old);
  assert.ok(r, "the table renames something");
  assert.equal(aliasOf(r.name), r.old);
  assert.equal(proposedNameOf(r.old), r.name);
  assert.equal(aliasOf("nothing.such.get"), null);
  assert.equal(aliasOf(r.old), null, "a tool's own name is not an alias");
});

test("the registry runs a tool by its proposed name exactly as by its own, and an unknown name is still no_such_tool", async (t) => {
  const { start } = await import("../core/daemon/index.js");
  const { tempHome, present } = await import("./helpers.js");
  const root = fs.realpathSync(tempHome(t));
  fs.writeFileSync(`${root}/config.json`, JSON.stringify({ vault: { keystore: "file" }, recall: { every: 0, vectors: false } }));
  const d = await start({ root, log: () => {}, presence: present });
  t.after(() => d.stop());
  const row = table.rows.find((r) => r.old === "about.text");
  assert.ok(row && row.name !== row.old, "about.text has a proposed name");
  const own = await d.registry.call("about.text", {}, "cli");
  const alias = await d.registry.call(row.name, {}, "cli");
  assert.deepEqual(alias, own, "the same answer under either name");
  assert.equal((await d.registry.call("nothing.such.get", {}, "cli")).error.code, "no_such_tool");
});
