// @ts-check
// The snapshot pull (lib/mcp-catalog-pull.js, scripts/mcp-catalog-snapshot.mjs): the registry is read to its last page or the pull fails, a plugin repo is read from a checkout, and a broken pull never overwrites a good snapshot.
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pullRegistry, readPluginRepo } from "./mcp-catalog-pull.js";
import { buildSnapshot, decide } from "../scripts/mcp-catalog-snapshot.mjs";
import { SCRATCH } from "../test/scratch.mjs";

const server = (name, url) => ({ server: { name, version: "1.0.0", remotes: [{ type: "streamable-http", url }] }, _meta: { "io.modelcontextprotocol.registry/official": { status: "active", isLatest: true } } });

test("the registry is paged by cursor to the last page, and a repeated cursor or a bad page fails the pull", async () => {
  const seen = [], urls = [];
  const pages = { "": { servers: [server("com.a/x", "https://mcp.a.com/mcp")], metadata: { nextCursor: "c1" } }, c1: { servers: [server("com.b/x", "https://mcp.b.com/mcp")], metadata: { nextCursor: "c2" } }, c2: { servers: [], metadata: {} } };
  const got = await pullRegistry(async (url) => { urls.push(url); const c = new URL(url).searchParams.get("cursor") || ""; seen.push(c); return pages[c]; }, { base: "https://registry.example.test/v0/servers" });
  assert.equal(got.length, 3);
  assert.deepEqual(seen, ["", "c1", "c2"]);
  assert.equal(seen.length, 3);
  assert.ok(urls.every(u => new URL(u).searchParams.get("version") === "latest"), "only the latest version of each server is read");
  await assert.rejects(() => pullRegistry(async () => ({ servers: [], metadata: { nextCursor: "same" } })), /repeats/);
  await assert.rejects(() => pullRegistry(async () => ({ nope: 1 })), /not a server list/);
  await assert.rejects(() => pullRegistry(async () => { throw new Error("503 from registry.example.test"); }), /503/, "a failed page fails the whole pull, never a partial snapshot");
});

test("a plugin repo checkout: .mcp.json in either shape, plugin.json for the author, nested folders, nothing else", () => {
  const root = fs.mkdtempSync(path.join(SCRATCH, "catalog-plugins-"));
  try {
    const w = (rel, data) => { const p = path.join(root, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(data)); };
    w("plugins/legal/.mcp.json", { mcpServers: { docs: { type: "http", url: "https://mcp.docs.example.com/mcp" } } });
    w("plugins/legal/.claude-plugin/plugin.json", { name: "legal", author: { name: "Harlow Legal" }, description: "Legal tools" });
    w("external_plugins/ops/.mcp.json", { board: { type: "http", url: "https://mcp.board.example.com/mcp" } });
    w("plugins/inline/.claude-plugin/plugin.json", { author: "Northwind", mcpServers: { bake: { type: "http", url: "https://mcp.bake.example.com/mcp" } } });
    w("plugins/empty/.mcp.json", {});
    w(".git/plugins/hidden/.mcp.json", { x: { url: "https://mcp.hidden.example.com" } });
    const found = readPluginRepo(root);
    assert.deepEqual(found.map(p => p.plugin), ["inline", "legal", "ops"]);
    assert.equal(found.find(p => p.plugin === "legal").author, "Harlow Legal");
    assert.equal(found.find(p => p.plugin === "inline").author, "Northwind");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("the snapshot is built from both sources, and an unchanged pull or a broken one does not overwrite it", () => {
  const registryPages = [{ servers: [server("com.a/x", "https://mcp.a.com/mcp"), server("com.b/y", "https://mcp.b.com/mcp")], metadata: {} }];
  const plugins = [{ repo: "claude-plugins-official", sha: "abcdef1234567", found: [{ plugin: "ops", servers: { board: { type: "http", url: "https://mcp.board.example.com/mcp" } } }] }];
  const next = buildSnapshot({ registryPages, plugins, registry: "https://registry.example.test/v0/servers", today: "2026-10-19" });
  assert.equal(next.v, 1);
  assert.equal(next.entries.length, 3);
  assert.deepEqual(next.sources.registry, { url: "https://registry.example.test/v0/servers", seen: 2, kept: 2 });
  const withNoise = buildSnapshot({ registryPages: [{ servers: [server("com.a/x", "https://mcp.a.com/mcp"), server("io.github.someone/toy", "https://toy.example.net/mcp"), server("com.b/y", "https://elsewhere.example.org/mcp")], metadata: {} }], plugins: [], registry: "r", today: "2026-10-19" });
  assert.deepEqual(withNoise.entries.map(e => e.id), ["com.a/x"], "a community entry and one served from another domain are not kept");
  assert.equal(withNoise.sources.registry.seen, 3);
  assert.deepEqual(next.sources.plugins, [{ repo: "claude-plugins-official", sha: "abcdef1234567", servers: 1 }]);
  assert.deepEqual(decide(null, next, false), { write: true, why: "changed" });
  assert.deepEqual(decide({ ...next, generated: "2026-10-12" }, next, false), { write: false, why: "unchanged" }, "a new date alone is not a change");
  const big = { entries: Array.from({ length: 40 }, (_, i) => ({ ...next.entries[0], id: `e${i}` })) };
  assert.match(decide(big, next, false).why, /^refused/);
  assert.equal(decide(big, next, true).write, true, "--force names it on purpose");
});
