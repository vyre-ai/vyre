// @ts-check
// Discovery reads only synthetic fixture files (this test never touches the real ~/.claude.json,
// ~/.claude, or the machine's own .mcp.json), per the lead's standing rule after a chat subagent
// read two real transcripts (2026-09-27): never read the user's real files, temp homes only.
//
// `root` is always a tempHome() folder, never the real ~/.vyre (tempHome() throws first if it
// ever were), so claudeJson/claudeHome always take the dev-home branch: <root>/claude.json and
// <root>/claude/plugins/. This is the case discover() is meant to prove itself against (e2e
// review, 2026-09-28): a fixture root reads only its own fixture files, never the real machine's.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { tempHome } from "../../test/helpers.js";
import { discover, parseServers, undiscovered } from "./discover.js";

/** A fixture root (the Vyre home) with a `project/` folder beside it, neither the real filesystem's. */
function fixture(t) {
  const root = tempHome(t);
  const project = path.join(root, "project");
  fs.mkdirSync(project, { recursive: true });
  return { root, project };
}

test("parseServers: stdio and http entries, bad JSON, an unknown type and a bad name are dropped, not thrown", () => {
  assert.deepEqual(parseServers("not json"), []);
  assert.deepEqual(parseServers("{}"), []);
  assert.deepEqual(parseServers(JSON.stringify({ mcpServers: {
    docs: { command: "node", args: ["server.js"], env: { TOKEN: "x" } },
    api: { type: "http", url: "https://example.com/mcp", headers: { Authorization: "x" } },
    old: { type: "sse", url: "https://example.com/sse" },
    bad: { type: "carrier-pigeon", url: "https://example.com" },
    empty: {},
    "not a name!": { command: "node" },
  } })), [
    { name: "docs", transport: "stdio", command: "node", args: ["server.js"], envNames: ["TOKEN"], hasSecrets: true },
    { name: "api", transport: "http", url: "https://example.com/mcp", headerNames: ["Authorization"], hasSecrets: true },
    { name: "old", transport: "sse", url: "https://example.com/sse" },
  ]);
});

test("parseServers: env and header values never appear, whatever they hold", () => {
  const rows = parseServers(JSON.stringify({ mcpServers: {
    a: { command: "node", env: { TOKEN: "sk-super-secret-value-123" } },
    b: { type: "http", url: "https://example.com", headers: { Authorization: "Bearer sk-super-secret-value-123" } },
  } }));
  assert.ok(!JSON.stringify(rows).includes("sk-super-secret-value-123"), "no value leaks, only the env/header NAMES");
  assert.deepEqual(rows[0].envNames, ["TOKEN"]);
  assert.deepEqual(rows[1].headerNames, ["Authorization"]);
});

test("parseServers: a planted key in args or the url never appears, whatever form it takes (reviewer's MEDIUM on 9ca2c50a)", () => {
  const rows = parseServers(JSON.stringify({ mcpServers: {
    tracker: { command: "npx", args: ["-y", "@northwind/tracker-mcp", "--api-key", "nw-secret-abc123", "--other", "kept"] },
    joined: { command: "npx", args: ["--token=nw-secret-abc123"] },
    trailing: { command: "npx", args: ["--auth-token"] },
    query: { type: "sse", url: "https://mcp.northwind.example/sse?key=nw-secret-abc123" },
    userinfo: { type: "http", url: "https://alex:nw-secret-abc123@mcp.northwind.example/mcp" },
    plain: { type: "http", url: "https://mcp.northwind.example/mcp" },
  } }));
  assert.ok(!JSON.stringify(rows).includes("nw-secret-abc123"), "no planted key leaks, from args or the url");

  const tracker = rows.find(r => r.name === "tracker");
  assert.deepEqual(tracker.args, ["-y", "@northwind/tracker-mcp", "--api-key", "[redacted]", "--other", "kept"]);
  assert.equal(tracker.hasSecrets, true);

  const joined = rows.find(r => r.name === "joined");
  assert.deepEqual(joined.args, ["--token=[redacted]"]);
  assert.equal(joined.hasSecrets, true);

  const trailing = rows.find(r => r.name === "trailing");
  assert.deepEqual(trailing.args, ["--auth-token"], "a secret flag with nothing after it is left alone, not thrown");
  assert.equal(trailing.hasSecrets, undefined);

  const query = rows.find(r => r.name === "query");
  assert.equal(query.url, "https://mcp.northwind.example/sse", "the query string is gone, not just its value");
  assert.equal(query.hasSecrets, true);

  const userinfo = rows.find(r => r.name === "userinfo");
  assert.equal(userinfo.url, "https://mcp.northwind.example/mcp", "userinfo is gone too");
  assert.equal(userinfo.hasSecrets, true);

  const plain = rows.find(r => r.name === "plain");
  assert.equal(plain.url, "https://mcp.northwind.example/mcp");
  assert.equal(plain.hasSecrets, undefined, "a url with neither never says hasSecrets");
});

test("parseServers: a ~/.claude.json-shaped file's projects[path].mcpServers is local scope, read separately from the top level", () => {
  const text = JSON.stringify({
    mcpServers: { "user-wide": { command: "node", args: ["a.js"] } },
    projects: { "/Users/alex/harlow": { mcpServers: { "just-here": { command: "node", args: ["b.js"] } } } },
  });
  assert.deepEqual(parseServers(text).map(s => s.name), ["user-wide"], "no project: the top-level table");
  assert.deepEqual(parseServers(text, "/Users/alex/harlow").map(s => s.name), ["just-here"], "with a project: only its own table, not merged with the top level");
  assert.deepEqual(parseServers(text, "/Users/alex/other").map(s => s.name), [], "a different project's table is not read");
});

test("discover: user, local and project scope, each a separate source, from claudeJson/claudeHome, never os.homedir() for a fixture root", (t) => {
  const { root, project } = fixture(t);
  const jsonFile = path.join(root, "claude.json");
  fs.writeFileSync(jsonFile, JSON.stringify({
    mcpServers: { "gmail-alex": { command: "node", args: ["gmail.js"] } },
    projects: { [project]: { mcpServers: { "harlow-only": { command: "node", args: ["harlow.js"] } } } },
  }));
  fs.writeFileSync(path.join(project, ".mcp.json"), JSON.stringify({ mcpServers: { docs: { command: "node", args: ["docs.js"] } } }));

  const rows = discover({ root, cwd: project, plugins: [] });
  const bySource = Object.fromEntries(rows.map(r => [`${r.source}:${r.server.name}`, r]));
  assert.equal(Object.keys(bySource).length, 3);
  assert.ok(bySource["user:gmail-alex"]);
  assert.equal(bySource["user:gmail-alex"].path, jsonFile);
  assert.ok(bySource["local:harlow-only"]);
  assert.ok(bySource["project:docs"]);
  assert.equal(bySource["project:docs"].path, path.join(project, ".mcp.json"));
});

test("discover: an ancestor's .mcp.json is found too, nearest file wins its own name once", (t) => {
  const { root, project } = fixture(t);
  const child = path.join(project, "packages", "web");
  fs.mkdirSync(child, { recursive: true });
  fs.writeFileSync(path.join(project, ".mcp.json"), JSON.stringify({ mcpServers: { root: { command: "node", args: ["r.js"] } } }));
  fs.writeFileSync(path.join(child, ".mcp.json"), JSON.stringify({ mcpServers: { web: { command: "node", args: ["w.js"] } } }));

  const rows = discover({ root, cwd: child, plugins: [] });
  const names = rows.map(r => r.server.name).sort();
  assert.deepEqual(names, ["root", "web"]);
});

test("discover: with no root, only project scope is read (no reach for a home that was not given)", (t) => {
  const { project } = fixture(t);
  fs.writeFileSync(path.join(project, ".mcp.json"), JSON.stringify({ mcpServers: { docs: { command: "node", args: ["docs.js"] } } }));
  const rows = discover({ cwd: project, plugins: [] });
  assert.deepEqual(rows.map(r => r.source), ["project"]);
});

test("discover: a missing or unreadable file answers no rows for that source, not an error", (t) => {
  const { root, project } = fixture(t);
  // No claude.json, no .mcp.json anywhere under this fixture root.
  assert.deepEqual(discover({ root, cwd: project, plugins: [] }), []);
});

test("discover: a fixture root never reaches the real machine's ~/.claude.json or ~/.claude/plugins/", (t) => {
  const { root, project } = fixture(t);
  // Even with no fixture .claude.json written, discover() must not fall back to the real one:
  // proven by the previous test (empty result) and here by path, since a fixture root is never
  // realHome() (tempHome() would have thrown first if it were).
  const rows = discover({ root, cwd: project });
  assert.ok(rows.every(r => r.path.startsWith(root) || r.path.startsWith(project)), "every path stays under the fixture");
});

test("discover: a plugin under <root>/claude/plugins/ with its own .mcp.json is its own source, auto-scanned", (t) => {
  const { root, project } = fixture(t);
  const pluginDir = path.join(root, "claude", "plugins", "harlow-tools");
  fs.mkdirSync(pluginDir, { recursive: true });
  const mcpFile = path.join(pluginDir, ".mcp.json");
  fs.writeFileSync(mcpFile, JSON.stringify({ mcpServers: { "harlow-tools": { command: "node", args: ["p.js"] } } }));
  // A sibling plugin folder with no .mcp.json is skipped, not an error.
  fs.mkdirSync(path.join(root, "claude", "plugins", "no-mcp"), { recursive: true });

  const rows = discover({ root, cwd: project });
  const plugin = rows.find(r => r.source === "plugin");
  assert.deepEqual(plugin, { source: "plugin", path: mcpFile, plugin: "harlow-tools",
    server: { name: "harlow-tools", transport: "stdio", command: "node", args: ["p.js"] } });
});

test("discover: an explicit plugins list overrides the auto-scan", (t) => {
  const { root, project } = fixture(t);
  const outside = path.join(root, "elsewhere", ".mcp.json");
  fs.mkdirSync(path.dirname(outside), { recursive: true });
  fs.writeFileSync(outside, JSON.stringify({ mcpServers: { named: { command: "node", args: ["p.js"] } } }));

  const rows = discover({ root, cwd: project, plugins: [{ name: "named", mcpFile: outside }] });
  assert.deepEqual(rows.map(r => r.server.name), ["named"]);
});

test("undiscovered: only servers the hub does not already have a row for", () => {
  const rows = [
    { source: "project", path: "/a/.mcp.json", server: { name: "docs", transport: "stdio", command: "node" } },
    { source: "user", path: "/h/.claude.json", server: { name: "gmail-alex", transport: "stdio", command: "node" } },
  ];
  assert.deepEqual(undiscovered(rows, ["docs"]).map(r => r.server.name), ["gmail-alex"]);
  assert.deepEqual(undiscovered(rows, ["docs", "gmail-alex"]), []);
});
