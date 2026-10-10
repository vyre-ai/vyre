// @ts-check
// A11: a source file over 2,000 lines does not grow; add a new focused file instead. test/file-size.json holds today's offenders and their sizes. A file over the limit that is not listed fails (a file
// crossed the line, or a new one was born over it); a listed file that grew fails; a listed file back under the limit must leave the list. The numbers only go down: growth in the list needs
// [ratchet +N: why] in a commit message (preflight R1), so splitting is the way out.
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RECORD = JSON.parse(fs.readFileSync(path.join(ROOT, "test", "file-size.json"), "utf8"));
const LIMIT = Number(RECORD.limit);

/** @returns {Record<string, number>} the source files over the limit, with their lines */
function overLimit() {
  /** @type {Record<string, number>} */ const out = {};
  const walk = (/** @type {string} */ dir) => {
    for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      if (["node_modules", ".git", "dist", "vendor", "dist-shots"].includes(e.name)) continue;
      const rel = dir ? `${dir}/${e.name}` : e.name;
      if (e.isDirectory()) { walk(rel); continue; }
      if (!/\.(m?js|cjs|ts|tsx)$/.test(e.name) || /\.test\./.test(e.name)) continue;
      const n = fs.readFileSync(path.join(ROOT, rel), "utf8").split("\n").length;
      if (n > LIMIT) out[rel] = n;
    }
  };
  walk("");
  return out;
}

test("no source file crossed 2,000 lines, and none of the listed ones grew", () => {
  const now = overLimit();
  const bad = [];
  for (const [f, n] of Object.entries(now)) {
    if (!(f in RECORD.files)) bad.push(`${f}: ${n} lines and not in test/file-size.json (split it: a new focused file, not more lines here)`);
    else if (n > RECORD.files[f]) bad.push(`${f}: grew from ${RECORD.files[f]} to ${n} lines`);
  }
  assert.deepEqual(bad, []);
});

test("a listed file that is under the limit, or gone, leaves the list; a listed size is never below the real one by luck", () => {
  const now = overLimit();
  const stale = Object.keys(RECORD.files).filter(f => !(f in now));
  assert.deepEqual(stale, [], `these are under ${LIMIT} lines now or gone: remove them from test/file-size.json`);
  const loose = Object.entries(RECORD.files).filter(([f, n]) => now[f] !== undefined && now[f] < Number(n));
  assert.deepEqual(loose.map(([f]) => f), [], "a file got smaller: lower its number in test/file-size.json so it cannot grow back");
});
