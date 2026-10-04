// @ts-check
// A handler in core/switchboard/index.js that uses `meta` must take it: a half-merge once left two handlers destructuring `{ caller }` while their bodies called wantsMacs(..., meta), and every
// threads.send answered "meta is not defined". This reads the file the way a reviewer would: each `async (i, <second argument>) => {` handler, its body by brace matching, and fails when the
// body names `meta` and the argument list does not bind it (and the body does not declare it). Every wantsMacs call must also pass meta as its last argument.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const SRC = fs.readFileSync(fileURLToPath(new URL("./index.js", import.meta.url)), "utf8");

/** The index just past the `}` that closes the `{` at `open`, skipping strings, template literals, regex-free enough comments. @param {string} s @param {number} open */
function close(s, open) {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    const c = s[i];
    if (c === "/" && s[i + 1] === "/") { i = s.indexOf("\n", i); if (i < 0) return s.length; continue; }
    if (c === "/" && s[i + 1] === "*") { i = s.indexOf("*/", i + 2) + 1; continue; }
    if (c === "'" || c === '"') { for (i++; i < s.length && s[i] !== c; i++) if (s[i] === "\\") i++; continue; }
    if (c === "`") { for (i++; i < s.length && s[i] !== "`"; i++) { if (s[i] === "\\") i++; else if (s[i] === "$" && s[i + 1] === "{") { i = close(s, i + 1) - 1; } } continue; }
    if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return i + 1;
  }
  return s.length;
}

/** @returns {{ line: number, args: string, body: string }[]} */
function handlers() {
  const out = [];
  const re = /async \(([^()]*(?:\([^()]*\)[^()]*)*)\) => \{/g;
  for (let m; (m = re.exec(SRC));) {
    const open = m.index + m[0].length - 1;
    const end = close(SRC, open);
    out.push({ line: SRC.slice(0, m.index).split("\n").length, args: m[1], body: SRC.slice(open, end) });
  }
  return out;
}

test("no handler in the Switchboard uses meta without taking it", () => {
  const bad = [];
  for (const h of handlers()) {
    if (!/\bmeta\b/.test(h.body)) continue;
    if (/\bmeta\b/.test(h.args)) continue;
    if (/\b(?:const|let|var)\s+(?:\{[^}]*\bmeta\b[^}]*\}|meta)\b/.test(h.body) || /\bmeta\s*=[^=>]/.test(h.body)) continue;
    bad.push(`line ${h.line}: async (${h.args.slice(0, 60)}) uses meta`);
  }
  assert.deepEqual(bad, [], "a handler uses `meta` but its arguments do not take it");
});

test("every wantsMacs call passes the call's meta", () => {
  const calls = [...SRC.matchAll(/wantsMacs\(([^;\n]*?)\)\)?(?:\s*&&|\s*\)|\s*\?|;|\s*\{)/g)].map(m => ({ line: SRC.slice(0, m.index).split("\n").length, args: m[1] }));
  assert.ok(calls.length >= 4, `found the call sites (${calls.length})`);
  assert.deepEqual(calls.filter(c => !/\bmeta\b/.test(c.args)).map(c => `line ${c.line}: wantsMacs(${c.args})`), []);
});
