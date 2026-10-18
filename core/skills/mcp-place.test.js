// @ts-check
// An approved plugin's MCP servers reach each AI in the form it reads: Claude and Grok a .mcp.json in the plugin folder, Codex a [mcp_servers] table in its own config.toml. Only a command and arguments or a url:
// never an environment or a header, and a Codex config line is rebuilt from checked fields, never copied.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { materialise } from "../../lib/skill-library.js";
import { codexHomeFor, mcpToml } from "../sessions/drivers/codex.js";

const plugin = (mcp) => ({ name: "demo", kind: "plugin", level: "space", body: JSON.stringify({ name: "demo", description: "A demo plugin for tests.", mcp }) });
const SERVERS = [{ name: "docs", transport: "stdio", command: "npx", args: ["-y", "docs-server", 'a"b'] }, { name: "web", transport: "http", url: "https://example.com/mcp" }, { name: "old", transport: "sse", url: "https://example.com/sse" }];
const tmp = () => fs.mkdtempSync(path.join(os.homedir(), "vyre-mcp-place-"));

test("Claude and Grok get .mcp.json with command+args or type+url; Codex gets a neutral list; the count is reported", () => {
  const d = tmp();
  try {
    const c = materialise(path.join(d, "claude"), "claude", [plugin(SERVERS)]);
    assert.equal(c.mcp, 3);
    const j = JSON.parse(fs.readFileSync(path.join(d, "claude", ".mcp.json"), "utf8"));
    assert.deepEqual(j.mcpServers.docs, { command: "npx", args: ["-y", "docs-server", 'a"b'] });
    assert.deepEqual(j.mcpServers.web, { type: "http", url: "https://example.com/mcp" });
    assert.ok(!JSON.stringify(j).includes("env") && !JSON.stringify(j).includes("headers"));
    const g = materialise(path.join(d, "grok"), "grok", [plugin(SERVERS)]);
    assert.equal(g.mcp, 3);
    assert.ok(fs.existsSync(path.join(d, "grok", ".mcp.json")));
    const x = materialise(path.join(d, "codex"), "codex", [plugin(SERVERS)]);
    assert.equal(x.mcp, 3);
    assert.ok(fs.existsSync(path.join(d, "codex", "mcp.json")) && !fs.existsSync(path.join(d, "codex", ".mcp.json")));
    assert.equal(materialise(path.join(d, "none"), "claude", [plugin([])]).mcp, 0);
    assert.ok(!fs.existsSync(path.join(d, "none", ".mcp.json")));
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test("Codex: stdio and http servers become [mcp_servers] tables with escaped strings; sse is not placed; a plugin with servers and no skills still gets its own home", () => {
  const d = tmp();
  try {
    const lib = path.join(d, "materialised", "codex", "abc");
    materialise(lib, "codex", [plugin(SERVERS)]);
    const toml = mcpToml(lib);
    assert.match(toml, /\[mcp_servers\.docs\]\ncommand = "npx"\nargs = \["-y", "docs-server", "a\\"b"\]/);
    assert.match(toml, /\[mcp_servers\.web\]\nurl = "https:\/\/example\.com\/mcp"/);
    assert.ok(!/old/.test(toml), "Codex has no sse transport here");
    const home = path.join(d, "home"); fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
    const dir = codexHomeFor(home, lib);
    assert.equal(dir, path.join(home, ".codex-lib", "abc"));
    const cfg = fs.readFileSync(path.join(dir, "config.toml"), "utf8");
    assert.match(cfg, /approval_policy = "on-request"/);
    assert.match(cfg, /\[mcp_servers\.docs\]/);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test("Codex: a hand-edited list cannot inject TOML: bad names, newlines, non-http urls and a non-array are dropped", () => {
  const d = tmp();
  try {
    fs.writeFileSync(path.join(d, "mcp.json"), JSON.stringify({ servers: [
      { name: "ok", transport: "stdio", command: "run", args: ["x\ny = 1", "fine"] },
      { name: "Bad Name]\n[evil", transport: "stdio", command: "run" },
      { name: "nl", transport: "stdio", command: "run\n[evil]" },
      { name: "file", transport: "http", url: "file:///etc/passwd" },
      { name: "quote", transport: "http", url: 'https://x.test/"\n[evil]' },
      { name: "env", transport: "stdio", command: "run", env: { TOKEN: "x" } },
    ] }));
    const toml = mcpToml(d);
    assert.ok(!/evil|passwd|y = 1|TOKEN/.test(toml), toml);
    assert.match(toml, /\[mcp_servers\.ok\]\ncommand = "run"\nargs = \["fine"\]/);
    assert.match(toml, /\[mcp_servers\.env\]\ncommand = "run"\nargs = \[\]/);
    fs.writeFileSync(path.join(d, "mcp.json"), JSON.stringify({ servers: "no" }));
    assert.equal(mcpToml(d), "");
    assert.equal(mcpToml(path.join(d, "missing")), "");
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});
