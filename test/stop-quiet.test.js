// @ts-check
// Nothing a module does outlives its stop(): start the full registry, let the modules do their startup work, stop
// vyred, then run two seconds more with the store closed. Any "database is not open" error, unhandled rejection or
// uncaught exception in that window fails the test and names the module that raised it (its path in the stack).
// Each start runs in a child process (stop-quiet-child.mjs), so an error after stop is ours to record.
// Found by the projects module's auto-seed, which kept retrying and writing after stop.

import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tempHome, writeModule } from "./helpers.js";

const CHILD = path.join(path.dirname(fileURLToPath(import.meta.url)), "stop-quiet-child.mjs");

/** @param {string} root @param {number} after @returns {Promise<{ running: number, late: { module: string, message: string }[] }>} */
function run(root, after) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [CHILD, root, String(after)], { // HOME and the XDG folders sit inside the temp home: the whole module set starts, and some read or write under ~
    // (the Claude home for imports, ~/Library registrations); on a person's Mac that must never be theirs.
    env: { ...process.env, VYRE_HOME: root, VYRE_NO_DIALOGS: "1", HOME: root, USERPROFILE: root, XDG_CONFIG_HOME: path.join(root, ".config"), XDG_DATA_HOME: path.join(root, ".local", "share"), XDG_STATE_HOME: path.join(root, ".local", "state"), XDG_CACHE_HOME: path.join(root, ".cache") }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    p.stdout.on("data", d => { out += d; });
    p.stderr.on("data", d => { err += d; });
    p.on("close", () => { const m = /RESULT (.*)\n/.exec(out); m ? resolve(JSON.parse(m[1])) : reject(new Error(`the child gave no result: ${err.slice(-600)}`)); });
  });
}

/** A home with the config every variant shares. @param {any} t @param {any} [extra] */
function home(t, extra = {}) {
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "stop-quiet", role: "box", transcripts: [], sessions: { install: false }, projectsDir: path.join(root, "projects"), vault: { keystore: "file" }, ...extra }));
  return root;
}

// Stopped straight after start, too: that is when a module's startup work is still in flight. And once with agents
// switched off, so what waits on another module (projects' access seed) is still waiting when vyred stops.
for (const [label, extra, after] of /** @type {[string, any, number][]} */ ([
  ["the full registry, after its startup work", {}, 3000],
  ["the full registry, stopped at once", {}, 0],
  ["the full registry, stopped mid-startup", {}, 700],
  ["a registry missing agents, stopped at once", { modules: { enable: [], disable: ["agents"] } }, 0],
])) {
  test(`stop: no module does work after vyred has stopped and its store is closed (${label})`, { timeout: 60_000 }, async t => {
    const r = await run(home(t, extra), after);
    assert.ok(r.running > (extra.modules ? 15 : 20), `${label} started (${r.running} modules)`);
    assert.deepEqual(r.late, [], "a module outlived its stop(): the names are the modules that raised the errors");
  });
}

// The control: a module whose timer writes to the store 500 ms after start and is never cleared by its stop() must be caught
// and named, or the tests above prove nothing.
test("stop: the check itself catches and names a module that writes after stop (control)", { timeout: 60_000 }, async t => {
  const root = home(t);
  writeModule(path.join(root, "modules"), "latewrite", { version: "0.1.0", apiVersion: 1, description: "writes after stop", roles: ["box", "local"], does: { tools: [{ name: "latewrite.ping", summary: "x" }] } },
    `export default { async start(ctx) { ctx.tool("latewrite.ping", { run: async () => "pong" }); setTimeout(() => { ctx.store.db.prepare("SELECT 1").get(); }, 500); return { async stop() {} }; } };`);
  const r = await run(root, 0);
  assert.deepEqual(r.late.map(l => l.module), ["latewrite"], "the late write is caught, and named");
});
