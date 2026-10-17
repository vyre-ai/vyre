// @ts-check
// The snapshot pull (lib/mcp-catalog-pull.js, scripts/mcp-catalog-snapshot.mjs): the registry is read to its last page or the pull fails, a plugin repo is read from a checkout, and a broken pull never overwrites a good snapshot.
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pullRegistry, readPluginRepo, annotateProbes } from "./mcp-catalog-pull.js";
import { buildSnapshot, decide, carryReviewed } from "../scripts/mcp-catalog-snapshot.mjs";
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

test("probes: each vendor-published registry entry is asked once, the answer settles its auth, a server that does not answer is refused, and the rest are left alone", async () => {
  const reg = (id, url, over = {}) => ({ id, url, verified: true, auth: "unknown", sources: [{ source: "registry", ref: id }], ...over });
  const entries = [reg("a", "https://mcp.a.com/mcp"), reg("b", "https://mcp.b.com/mcp"), reg("c", "https://mcp.c.com/mcp"), reg("d", "https://mcp.d.com/mcp", { auth: "header" }), reg("e", "https://mcp.e.com/mcp"), reg("inferred", "https://x.example.net/mcp", { verified: false }), reg("plug", "https://p.example.com/mcp", { sources: [{ source: "plugin", ref: "r" }] }), reg("done", "https://mcp.done.com/mcp", { probe: { result: "no-oauth" }, auth: "none" })];
  const asked = [];
  const answers = { "https://mcp.a.com/mcp": { result: "dcr-advertised", issuer: "https://mcp.a.com" }, "https://mcp.b.com/mcp": { result: "needs-client", issuer: "https://login.b.com" }, "https://mcp.d.com/mcp": { result: "no-oauth" }, "https://mcp.e.com/mcp": { result: "something-new" } };
  const out = await annotateProbes(entries, async (url) => { asked.push(url); if (url.includes("mcp.c.com")) throw new Error("connection refused"); return answers[url]; }, { concurrency: 3 });
  const by = Object.fromEntries(out.map(e => [e.id, e]));
  assert.deepEqual(asked.sort(), ["https://mcp.a.com/mcp", "https://mcp.b.com/mcp", "https://mcp.c.com/mcp", "https://mcp.d.com/mcp", "https://mcp.e.com/mcp"], "only verified registry entries without an answer");
  assert.deepEqual([by.a.auth, by.a.probe], ["oauth", { result: "dcr-advertised", issuer: "https://mcp.a.com" }]);
  assert.equal(by.b.auth, "oauth");
  assert.equal(by.c.probe.result, "refused");
  assert.equal(by.c.auth, "unknown");
  assert.equal(by.d.auth, "header", "a declared key stays a key");
  assert.equal(by.e.probe.result, "refused", "an answer the file does not know is not trusted");
  assert.equal(by.inferred.probe, undefined);
  assert.equal(by.plug.probe, undefined);
  assert.deepEqual(by.done, entries[7]);
  const slow = await annotateProbes([reg("s", "https://mcp.s.com/mcp")], () => new Promise(() => {}), { timeoutMs: 20 });
  assert.equal(slow[0].probe.result, "refused", "a server that never answers is refused, and the pull goes on");
});

test("a person's review survives a pull: a reviewed row wins at its address and stays when nothing lists it, and a probed row hands its answer on", () => {
  const row = (id, url, over = {}) => ({ id, name: id, vendor: "v", description: "", category: "other", url, transport: "http", auth: "unknown", headers: [], verified: true, basis: "registry", sources: [{ source: "registry", ref: id }], ...over });
  const prev = [
    row("linear", "https://mcp.linear.app/mcp", { auth: "oauth", basis: "vendor doc", verdict: "one-click", probe: { result: "dcr-advertised" }, sources: [{ source: "vendor-doc", ref: "d" }] }),
    row("withdrawn", "https://mcp.gone.example.com/mcp", { verdict: "blocked", probe: { result: "refused" } }),
    row("com.a/x", "https://mcp.a.com/mcp", { auth: "oauth", probe: { result: "dcr-advertised" } }),
  ];
  const next = [row("app.linear/mcp", "https://mcp.linear.app/mcp"), row("com.a/x", "https://mcp.a.com/mcp"), row("com.new/y", "https://mcp.new.com/mcp")];
  const out = carryReviewed(prev, next);
  const by = Object.fromEntries(out.map(e => [e.id, e]));
  assert.deepEqual(Object.keys(by).sort(), ["com.a/x", "com.new/y", "linear", "withdrawn"], "the reviewed row replaces the registry row at the same address and the withdrawn one stays");
  assert.equal(by.linear.verdict, "one-click");
  assert.equal(by.linear.basis, "vendor doc");
  assert.deepEqual(by.linear.sources.map(x => x.source).sort(), ["registry", "vendor-doc"], "both sources are kept");
  assert.deepEqual(by["com.a/x"].probe, { result: "dcr-advertised" }, "a probed row hands its answer on");
  assert.equal(by["com.a/x"].auth, "oauth");
  assert.equal(by["com.new/y"].probe, undefined);
  assert.deepEqual(carryReviewed([], next).map(e => e.id).sort(), ["app.linear/mcp", "com.a/x", "com.new/y"]);
});
