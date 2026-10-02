// @ts-check
// PLAN.md section 5, minimum 11: no internal words on any surface. A person never reads "vyred", "switchboard",
// "no such tool" or "as Claude Code does"; the Deck says "the box", "sessions", or what they can do next. This scans
// every string literal in the Deck's own code. A literal that must carry one of them (a module id compared in code,
// never drawn) ends its line with `// internal-word: <why>`; nothing else is exempt.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SKIP = new Set(["node_modules", "vendor", "fixtures", "test", "testing"]);
const BANNED = /\b(vyred|switchboard|no such tool|as claude code does)\b/i;
const EXEMPT = /\/\/\s*internal-word:/;

function* files(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!SKIP.has(e.name)) yield* files(p); continue; }
    if (e.name.endsWith(".js") && !e.name.endsWith(".test.js")) yield p;
  }
}
/** The string literals on one line (double, single and template), without the comment after them. @param {string} line */
function literals(line) {
  const out = [];
  for (const m of line.matchAll(/"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|`((?:[^`\\]|\\.)*)`/g)) out.push(m[1] ?? m[2] ?? m[3] ?? "");
  return out;
}

test("no internal word (vyred, switchboard, no such tool, as Claude Code does) in any string the Deck draws", () => {
  const bad = [];
  for (const dir of ["deck"]) for (const f of files(path.join(ROOT, dir))) {
    const rel = path.relative(ROOT, f);
    fs.readFileSync(f, "utf8").split("\n").forEach((line, i) => {
      const t = line.trim();
      if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*") || EXEMPT.test(line)) return;
      if (literals(line).some(s => BANNED.test(s))) bad.push(`${rel}:${i + 1}: ${t.slice(0, 110)}`);
    });
  }
  assert.deepEqual(bad, [], `internal words on a surface (say "the box", "sessions", or what to do next), or mark a never-drawn id with // internal-word: <why>:\n${bad.join("\n")}`);
});

// ---- the box's own error texts --------------------------------------------------------------------------------------
// An error built in core/, modules/ or local/ reaches the Deck and the phone as the message a person reads (reviewer-2's
// note on the Deck guard). The words are not banned outright there yet, because many owners' files say "vyred"; this holds
// the line: a file may not gain one, and the count below only shrinks. Each owner brings its file's count to 0 by saying
// "the box" (or what to do next) and lowers the number here. core/cli (the terminal, where vyred is a command people type),
// core/daemon and tests are out of scope.
const ERR_CONTEXT = /(Error\(|refuse\(|fail\(|bad\(|throw |message:)/;
const ERR_SKIP = /(^|\/)(test|testing|node_modules|vendor|fixtures)(\/|$)|\.test\.js$|^core\/(cli|daemon)\//;
/** The lines per file that put an internal word inside a string literal on an error line. */
const BASELINE = {
  "core/computers/index.js": 3, "core/config/index.js": 1, "core/files/drop.js": 1, "core/gate/index.js": 1, "core/hooks/funnel.js": 2, "core/hooks/index.js": 1,
  "core/modules/index.js": 2, "core/names/backup.js": 1, "core/names/system.js": 1, "core/push/index.js": 1, "core/term/index.js": 1, "core/vault/tools/cli.js": 2, "core/vyre-core/install-main.js": 1, "core/watchers/run.js": 1,
};

test("the box's error texts: no file gains an internal word, and the counts only shrink", () => {
  /** @type {Record<string, number>} */ const found = {};
  for (const top of ["core", "modules", "local"]) for (const f of files(path.join(ROOT, top))) {
    const rel = path.relative(ROOT, f).split(path.sep).join("/");
    if (ERR_SKIP.test(rel)) continue;
    let n = 0;
    for (const line of fs.readFileSync(f, "utf8").split("\n")) {
      const t = line.trim();
      if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*") || EXEMPT.test(line) || !ERR_CONTEXT.test(line)) continue;
      if (literals(line).some(x => BANNED.test(x))) n++;
    }
    if (n) found[rel] = n;
  }
  const grew = Object.keys(found).filter(f => found[f] > (/** @type {any} */ (BASELINE)[f] || 0)).map(f => `${f}: ${found[f]} (allowed ${/** @type {any} */ (BASELINE)[f] || 0})`);
  const shrank = Object.keys(BASELINE).filter(f => (found[f] || 0) < /** @type {any} */ (BASELINE)[f]).map(f => `${f}: now ${found[f] || 0}, lower BASELINE (was ${/** @type {any} */ (BASELINE)[f]})`);
  assert.deepEqual(grew, [], `an error text gained "vyred", "switchboard" or another internal word: say "the box" or what to do next:\n${grew.join("\n")}`);
  assert.deepEqual(shrank, [], `good: an owner cleaned a file. Lower its number in BASELINE so it cannot come back:\n${shrank.join("\n")}`);
});
