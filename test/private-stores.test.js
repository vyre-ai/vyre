// @ts-check
// FOUNDATION A3: business data is a record type; a module's own database is for private operational state only (tokens, caches, per-computer rows, queues, indexes it can rebuild). Nothing
// used to check it. This lists every core module that opens SQLite itself (`node:sqlite` / `DatabaseSync` in non-test code) and requires each to be named below with the reason its data is
// operational. A new module that opens a database fails here until someone says, in a line, why what it keeps is not business data (or makes it a record type). A module that stops opening
// one must leave the table (it only shrinks). Tables made through the module's `ctx.db` are the same rule; this guard watches the direct opens.

import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SKIP = new Set(["node_modules", "vendor", "fixtures", "test", "testing", "legacy-fixture"]);

/** Core modules that open their own database, and why what they keep is private operational state. */
const OPERATIONAL = {
  computers: "which agent holds which computer and screen on this box",
  config: "settings values and their levels, per box",
  gate: "held items and the send log of this box",
  github: "the GitHub accounts this box is signed in to (tokens)",
  google: "the Google accounts this box is signed in to (tokens)",
  hooks: "webhook deliveries kept briefly for watchers",
  learn: "offline queue, metrics and skill state of the learning loop (derived, rebuildable)",
  mcp: "the MCP servers this box runs and their state",
  memory: "the assistant's own memory graph, decisions and sealed-scan marks (private to the assistant)",
  modules: "which module tool was called when (idempotency, use counts)",
  names: "backup bookkeeping",
  outside: "registration of outside agents: token hashes, what each was given, what waits for the person",
  planner: "legacy planner migration state (the planner's data is records)",
  presence: "the person session and presence marks of this box",
  projects: "what this computer knows of a project: folders and picked threads, per machine (the Project itself is a record)",
  recall: "the search index over the person's sessions (derived, rebuildable)",
  sessions: "provider accounts, routes, limits and model overrides of this box",
  store: "the kernel store's own migrations",
  stream: "imports bookkeeping of the event stream",
  switchboard: "threads, asks and leases of the sessions this box runs",
  vault: "the vault's items' wrapping, jobs, marks and reminders (sealed)",
  vitals: "per-minute and per-hour box health rollups",
  "vyre-core": "the box's first key",
  watchers: "watcher schedules, cursors, failures and filed items (their definitions are records)",
  "quiet.js": "quiet hours of this box",
};

function* walk(/** @type {string} */ dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!SKIP.has(e.name)) yield* walk(p); continue; }
    if (e.name.endsWith(".js") && !e.name.endsWith(".test.js")) yield p;
  }
}

/** The modules (folders of core, or a lone core/*.js file) whose non-test code opens SQLite itself. @param {string} root */
export function modulesOpeningSqlite(root = ROOT) {
  const out = new Set();
  const core = path.join(root, "core");
  for (const f of walk(core)) {
    if (!/node:sqlite|DatabaseSync/.test(fs.readFileSync(f, "utf8"))) continue;
    out.add(path.relative(core, f).split(path.sep)[0] || "");
  }
  return [...out].sort();
}

test("every core module that opens its own database is named, with why its data is operational and not business data", () => {
  const found = modulesOpeningSqlite();
  assert.ok(found.length > 15, "the scan finds the modules that open a database");
  const unnamed = found.filter(m => !(m in OPERATIONAL));
  assert.deepEqual(unnamed, [], `these core modules open a database and are not named in OPERATIONAL (business data is a record type; if this is private operational state, name it with its reason):\n${unnamed.join("\n")}`);
  const gone = Object.keys(OPERATIONAL).filter(m => !found.includes(m));
  assert.deepEqual(gone, [], `these no longer open a database: delete them from OPERATIONAL:\n${gone.join("\n")}`);
  for (const [m, why] of Object.entries(OPERATIONAL)) assert.ok(why.length > 15, `${m}: say why its data is operational`);
});

test("the scan sees a module that opens a database it was not told about", () => {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || "/tmp", "a3-"));
  try {
    fs.mkdirSync(path.join(dir, "core", "invoices"), { recursive: true });
    fs.writeFileSync(path.join(dir, "core", "invoices", "index.js"), 'import { DatabaseSync } from "node:sqlite";\nexport const db = new DatabaseSync("x.db");\n');
    fs.mkdirSync(path.join(dir, "core", "calm"), { recursive: true });
    fs.writeFileSync(path.join(dir, "core", "calm", "index.js"), "export const x = 1;\n");
    fs.writeFileSync(path.join(dir, "core", "calm", "index.test.js"), 'import { DatabaseSync } from "node:sqlite";\n');
    assert.deepEqual(modulesOpeningSqlite(dir), ["invoices"], "a business-looking module is found; a module without one, and a test file, are not");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
