// @ts-check
// The type roles (design-system.md section 2): caption 12, body 14, read 15, title 18, page 24, display 32 on a desktop; body 16, read 17, title 20,
// page 28 on a phone; the 11 px label; 20 for icons. A stylesheet may not use any other pixel size for text. The v2 files hold to it outright;
// the older stylesheets are on a shrink-only list (deck/test/type-roles.baseline.json): they may not gain an off-role size, and each screen's pass
// takes its entry down to nothing. Regenerate the list after a pass with `node deck/test/type-roles.test.js --write`.

import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DECK = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ROLES = new Set([11, 12, 14, 15, 16, 17, 18, 20, 24, 28, 32]);
const V2 = new Set(["css/tokens-v2.css", "css/kit.css"]);
const BASE = path.join(DECK, "test/type-roles.baseline.json");

/** Every .css under deck/, relative, except vendored ones. @param {string} dir @returns {string[]} */
function sheets(dir = DECK) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === "vendor" || e.name === "fonts" || e.name === "node_modules" ? [] : sheets(p);
    return e.name.endsWith(".css") ? [path.relative(DECK, p)] : [];
  });
}

/** The off-role pixel sizes a stylesheet's text uses (font-size and the size in the font shorthand). @param {string} css */
export function offRole(css) {
  const bare = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const out = /** @type {number[]} */ ([]);
  for (const m of bare.matchAll(/font-size:\s*(\d+(?:\.\d+)?)px/g)) if (!ROLES.has(Number(m[1]))) out.push(Number(m[1]));
  for (const m of bare.matchAll(/(?:^|[;{\s])font:\s*(?:(?:italic|normal|bold|[1-9]00)\s+)*(\d+(?:\.\d+)?)px/g)) if (!ROLES.has(Number(m[1]))) out.push(Number(m[1]));
  return out;
}

const counts = () => Object.fromEntries(sheets().map(f => [f, offRole(fs.readFileSync(path.join(DECK, f), "utf8")).length]).filter(([, n]) => n > 0));

if (process.argv.includes("--write")) { fs.writeFileSync(BASE, JSON.stringify(counts(), null, 2) + "\n"); console.log("wrote", BASE); process.exit(0); }

test("the v2 stylesheets use only the type roles", () => {
  for (const f of V2) assert.deepEqual(offRole(fs.readFileSync(path.join(DECK, f), "utf8")), [], f);
});

test("no older stylesheet gains an off-role text size, and the list only shrinks", () => {
  const base = /** @type {Record<string, number>} */ (JSON.parse(fs.readFileSync(BASE, "utf8")));
  const now = counts();
  const grew = Object.entries(now).filter(([f, n]) => n > (base[f] || 0)).map(([f, n]) => `${f}: ${n} (allowed ${base[f] || 0})`);
  assert.deepEqual(grew, [], "use a type role (css/kit.css .t-*) or a v2 token instead of a new size");
  const stale = Object.entries(base).filter(([f, n]) => (now[f] || 0) < n).map(([f]) => f);
  assert.deepEqual(stale, [], "a screen's pass removed some: lower or remove its entry (node deck/test/type-roles.test.js --write)");
});
