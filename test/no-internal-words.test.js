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
