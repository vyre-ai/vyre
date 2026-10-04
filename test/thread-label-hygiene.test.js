// @ts-check
// RC-1 (reviewer-2): a thread named in a model's label has no key behind it unless the daemon built the label. The daemon now builds it (lib/caller.js modelLabel) and drops a client's; a module still must
// not pick a thread out of a caller string to decide who a caller is: it reads meta.thread, the daemon's verified binding. This finds code that parses `mcp:thread:` or `harness:thread:` and fails on a new one.
// The one exception, by file: core/vault/connections.js, whose `as` and `caller` arguments are labels another module passes along a hop where meta.thread is gone; they are daemon-built labels.
import "../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ROOTS = ["core", "local", "modules", "lib", "relay", "records", "stores", "names"];
export const ALLOWED = Object.freeze({ "core/vault/connections.js": 1, "lib/caller.js": 1 });
const PARSES = /(?:mcp|harness)[^\n]{0,12}thread:\((?!\?)/;

/** @param {string} dir @param {string[]} out */
function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === "image") continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(js|mjs)$/.test(e.name) && !/\.test\.[mc]?js$/.test(e.name)) out.push(p);
  }
}

test("no module reads a thread out of a model's label, except the listed ones", () => {
  /** @type {string[]} */ const files = [];
  for (const r of ROOTS) if (fs.existsSync(path.join(REPO, r))) walk(path.join(REPO, r), files);
  /** @type {Record<string, number>} */ const hits = {};
  for (const f of files) {
    const rel = path.relative(REPO, f).split(path.sep).join("/");
    for (const line of fs.readFileSync(f, "utf8").split("\n")) {
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue;
      if (PARSES.test(line)) hits[rel] = (hits[rel] || 0) + 1;
    }
  }
  for (const [f, n] of Object.entries(hits)) assert.ok(n <= (/** @type {any} */ (ALLOWED)[f] || 0), `${f} parses a thread out of a model's label (${n} line${n === 1 ? "" : "s"}): read meta.thread, the daemon's verified binding`);
});
