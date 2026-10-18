#!/usr/bin/env node
// codex-mcp-real-check: the [mcp_servers] tables Vyre writes for Codex (core/sessions/drivers/codex.js mcpToml, through codexHomeFor), read by a REAL Codex CLI.
//   node scripts/codex-mcp-real-check.mjs [codex-binary]
// Builds a skills folder with a neutral mcp.json (a stdio server whose arguments carry a quote and a space, and an http server; an sse server that must not be placed), makes the Codex home the way a session
// does, and asks `codex mcp list --json` and `codex mcp get <name> --json` in that home. No model call, no account, no network. Nothing touches a person's ~/.codex. Exit 0 only when Codex parsed the config
// Vyre wrote and lists exactly the servers and fields Vyre meant.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { codexHomeFor } from "../core/sessions/drivers/codex.js";

const bin = process.argv[2] || "codex";
const home = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-codex-mcp-home-"));
const lib = path.join(home, "lib", "abc");
fs.mkdirSync(path.join(lib, "skills"), { recursive: true });
const ARGS = ["-y", "docs-server", 'a"b c'];
fs.writeFileSync(path.join(lib, "mcp.json"), JSON.stringify({ servers: [
  { name: "docs", transport: "stdio", command: "npx", args: ARGS },
  { name: "web", transport: "http", url: "https://example.com/mcp" },
  { name: "old", transport: "sse", url: "https://example.com/sse" },
] }));
let failed = "";
try {
  const dir = codexHomeFor(home, lib);
  console.log("codex config.toml:\n" + fs.readFileSync(path.join(dir, "config.toml"), "utf8"));
  const env = { PATH: process.env.PATH, CODEX_HOME: dir, HOME: home };
  const run = (/** @type {string[]} */ args) => spawnSync(bin, args, { env, encoding: "utf8", timeout: 60_000 });
  const v = run(["--version"]);
  console.log("codex:", (v.stdout || v.stderr).trim());
  const l = run(["mcp", "list", "--json"]);
  console.log("mcp list --json exit", l.status, "\n" + (l.stdout || "") + (l.stderr || ""));
  if (l.status !== 0) throw new Error("codex mcp list failed on the config Vyre wrote");
  const parsed = JSON.parse(l.stdout);
  const rows = Array.isArray(parsed) ? parsed : Object.entries(parsed.servers || parsed.mcp_servers || parsed).map(([name, v]) => ({ name, ...(/** @type {any} */ (v)) }));
  const byName = Object.fromEntries(rows.map(r => [r.name, r]));
  const names = Object.keys(byName).sort();
  if (names.join(",") !== "docs,web") throw new Error(`codex lists ${JSON.stringify(names)}, wanted docs and web (sse is not placed)`);
  const flat = (/** @type {any} */ r) => JSON.stringify(r);
  const docs = byName.docs, web = byName.web;
  const cmd = docs.command ?? docs.transport?.command;
  const args = docs.args ?? docs.transport?.args;
  if (cmd !== "npx" || JSON.stringify(args) !== JSON.stringify(ARGS)) throw new Error(`docs came back as ${flat(docs)}, wanted npx and ${JSON.stringify(ARGS)}`);
  const url = web.url ?? web.transport?.url;
  if (url !== "https://example.com/mcp") throw new Error(`web came back as ${flat(web)}, wanted its url`);
  for (const n of ["docs", "web"]) {
    const g = run(["mcp", "get", n, "--json"]);
    console.log(`mcp get ${n} exit`, g.status, "\n" + (g.stdout || "") + (g.stderr || ""));
    if (g.status !== 0) throw new Error(`codex mcp get ${n} failed`);
  }
  console.log("ok: a real Codex reads the servers Vyre wrote, with the arguments and url intact, and no sse server");
} catch (e) {
  failed = String(/** @type {Error} */ (e).message || e);
}
fs.rmSync(home, { recursive: true, force: true });
if (failed) { console.error("FAIL:", failed); process.exit(1); }
