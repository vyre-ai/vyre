// @ts-check
// Discovery reads only synthetic fixture files (this test never touches the real ~/.claude.json,
// ~/.claude, or the machine's own .mcp.json), per the lead's standing rule after a chat subagent
// read two real transcripts (2026-09-27): never read the user's real files, temp homes only.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { tempHome } from "../../test/helpers.js";
import { discover, parseServers, undiscovered } from "./discover.js";

/** A fixture root with `home/` and `project/` folders, neither the real filesystem's. */
function fixture(t) {
  const root = tempHome(t);
  const home = path.join(root, "home");
  const project = path.join(root, "project");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(project, { recursive: true });
  return { home, project };
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
    { name: "docs", transport: "stdio", command: "node", args: ["server.js"], env: { TOKEN: "x" } },
    { name: "api", transport: "http", url: "https://example.com/mcp", headers: { Authorization: "x" } },
    { name: "old", transport: "sse", url: "https://example.com/sse" },
  ]);
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

test("discover: user, local and project scope, each a separate source", (t) => {
  const { home, project } = fixture(t);
  fs.writeFileSync(path.join(home, ".claude.json"), JSON.stringify({
    mcpServers: { "gmail-alex": { command: "node", args: ["gmail.js"] } },
    projects: { [project]: { mcpServers: { "harlow-only": { command: "node", args: ["harlow.js"] } } } },
  }));
  fs.writeFileSync(path.join(project, ".mcp.json"), JSON.stringify({ mcpServers: { docs: { command: "node", args: ["docs.js"] } } }));

  const rows = discover({ userHome: home, cwd: project });
  const bySource = Object.fromEntries(rows.map(r => [`${r.source}:${r.server.name}`, r]));
  assert.equal(Object.keys(bySource).length, 3);
  assert.ok(bySource["user:gmail-alex"]);
  assert.ok(bySource["local:harlow-only"]);
  assert.ok(bySource["project:docs"]);
  assert.equal(bySource["project:docs"].path, path.join(project, ".mcp.json"));
});

test("discover: an ancestor's .mcp.json is found too, nearest file wins its own name once", (t) => {
  const { home, project } = fixture(t);
  const child = path.join(project, "packages", "web");
  fs.mkdirSync(child, { recursive: true });
  fs.writeFileSync(path.join(project, ".mcp.json"), JSON.stringify({ mcpServers: { root: { command: "node", args: ["r.js"] } } }));
  fs.writeFileSync(path.join(child, ".mcp.json"), JSON.stringify({ mcpServers: { web: { command: "node", args: ["w.js"] } } }));

  const rows = discover({ cwd: child });
  const names = rows.map(r => r.server.name).sort();
  assert.deepEqual(names, ["root", "web"]);
});

test("discover: with no userHome, only project scope is read (no reach for a home that was not given)", (t) => {
  const { project } = fixture(t);
  fs.writeFileSync(path.join(project, ".mcp.json"), JSON.stringify({ mcpServers: { docs: { command: "node", args: ["docs.js"] } } }));
  const rows = discover({ cwd: project });
  assert.deepEqual(rows.map(r => r.source), ["project"]);
});

test("discover: a missing or unreadable file answers no rows for that source, not an error", (t) => {
  const { home, project } = fixture(t);
  // No .claude.json, no .mcp.json anywhere under this fixture root.
  assert.deepEqual(discover({ userHome: home, cwd: project }), []);
});

test("discover: a plugin's own .mcp.json is its own source, labelled with the plugin's name", (t) => {
  const { home, project } = fixture(t);
  const pluginDir = path.join(home, "plugins", "harlow-tools");
  fs.mkdirSync(pluginDir, { recursive: true });
  const mcpFile = path.join(pluginDir, ".mcp.json");
  fs.writeFileSync(mcpFile, JSON.stringify({ mcpServers: { "harlow-tools": { command: "node", args: ["p.js"] } } }));

  const rows = discover({ cwd: project, plugins: [{ name: "harlow-tools", mcpFile }] });
  assert.deepEqual(rows, [{ source: "plugin", path: mcpFile, plugin: "harlow-tools",
    server: { name: "harlow-tools", transport: "stdio", command: "node", args: ["p.js"] } }]);
});

test("undiscovered: only servers the hub does not already have a row for", () => {
  const rows = [
    { source: "project", path: "/a/.mcp.json", server: { name: "docs", transport: "stdio", command: "node" } },
    { source: "user", path: "/h/.claude.json", server: { name: "gmail-alex", transport: "stdio", command: "node" } },
  ];
  assert.deepEqual(undiscovered(rows, ["docs"]).map(r => r.server.name), ["gmail-alex"]);
  assert.deepEqual(undiscovered(rows, ["docs", "gmail-alex"]), []);
});
