// @ts-check
// Presets made from the catalog snapshot (from-catalog.js): only a vendor-published entry that signs in with OAuth becomes one, it is pinned to its own origin, it never takes over a curated vendor, and a
// config file cannot add one.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { presetFromEntry, snapshotCatalog, loadSnapshot } from "./from-catalog.js";
import { makeCatalog, SHIPPED_DATA, validate, hostsOf } from "./index.js";
import { presetIdFor } from "../mcp-catalog.js";
import { SCRATCH } from "../../test/scratch.mjs";

const entry = (over = {}) => ({ id: "com.northwind/notes", name: "Northwind Notes", vendor: "northwind.com", description: "Notes.", category: "other", url: "https://mcp.northwind.com/mcp", transport: "http", auth: "oauth", headers: [], verified: true, basis: "t", sources: [], probe: { result: "dcr-advertised" }, ...over });
const curated = makeCatalog(SHIPPED_DATA);

test("a verified entry whose server registers clients by itself becomes a valid preset pinned to its own origin; nothing else does", () => {
  const p = presetFromEntry(entry());
  assert.ok(p);
  validate(p);
  assert.equal(p.id, presetIdFor(entry()));
  assert.deepEqual(p.oauth, { client: "dcr", as: ["https://mcp.northwind.com"] });
  assert.deepEqual(hostsOf(p), ["mcp.northwind.com"], "a token minted for it goes to its host only");
  assert.equal(p.catalog.id, "com.northwind/notes");
  for (const over of [{ verified: false }, { probe: undefined }, { probe: { result: "needs-client" } }, { verdict: "blocked" }, { url: "http://mcp.northwind.com/mcp" }, { transport: "stdio" }]) assert.equal(presetFromEntry(entry(over)), null, JSON.stringify(over));
});

test("the snapshot catalog skips what a curated preset already serves and any id a curated vendor id extends", () => {
  const notion = curated.presets().find(p => p.id === "notion");
  const same = entry({ id: "com.notion/mcp", name: "Notion", url: notion.url });
  const fresh = entry();
  const snap = snapshotCatalog({ entries: [same, fresh, fresh], generated: "2026-10-19" }, curated);
  assert.deepEqual(snap.presets().map(p => p.id), [presetIdFor(fresh)], "the Notion entry is left to the curated preset, the repeated entry counts once");
  assert.equal(snap.checked(), "2026-10-19");
  assert.equal(snap.preset("notion"), null, "it holds no curated vendor");
  assert.equal(snap.boundFor(`${presetIdFor(fresh)}-auth`).hosts[0], "mcp.northwind.com");
  assert.equal(snapshotCatalog({ entries: [] }, curated).presets().length, 0);
});

test("loadSnapshot: the build's own file; a config path counts only inside a test run; a missing or broken file is an empty catalog", () => {
  const dir = fs.mkdtempSync(path.join(SCRATCH, "catalog-load-"));
  try {
    const f = path.join(dir, "s.json");
    fs.writeFileSync(f, JSON.stringify({ v: 1, generated: "2026-10-19", entries: [entry()] }));
    assert.equal(loadSnapshot({ mcp: { catalog: f } }).entries.length, 1, "named in a test run");
    assert.equal(loadSnapshot({ mcp: { catalog: f } }).generated, "2026-10-19");
    fs.writeFileSync(f, "not json");
    assert.deepEqual(loadSnapshot({ mcp: { catalog: f } }), { entries: [], generated: null });
    assert.deepEqual(loadSnapshot({ mcp: { catalog: path.join(dir, "none.json") } }), { entries: [], generated: null });
    const shipped = loadSnapshot(undefined);
    assert.ok(Array.isArray(shipped.entries), "the build's file reads");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
