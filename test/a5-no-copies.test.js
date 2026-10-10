// FOUNDATION A5, one owner per fact: a surface never keeps its own copy of a list another module owns. This finds literal lists (three or more names in one array) in the surfaces (apps/app, local, web) that are
// copies of an owner's registry: the tool names every module.json declares, the role ids of the kernel's contracts, and the AI providers of lib/skill-library.js. A surface reads the owner and follows its change event.
// Existing copies are in test/a5-baseline.json with the reason each stays; the count per file and owner may only go down, and a new copy fails until it reads the owner instead. (Issue #130.)
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ROLE_IDS } from "../kernel/contracts/index.js";
import { AIS } from "../lib/skill-library.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SURFACES = ["apps/app", "local", "web"];
const SKIP_DIR = new Set(["node_modules", "dist", ".git", ".expo"]);
const SKIP_FILE = /\.test\.|\.generated\.|mock|gallery|fixtures?\b|\/dist\/|\/test\//;

const walk = (/** @type {string} */ dir, /** @type {string[]} */ out = []) => {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIR.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else out.push(p);
  }
  return out;
};

/** The owners' lists, read from the owners. */
function owners() {
  const tools = new Set();
  for (const f of walk(path.join(ROOT, "core")).filter(f => f.endsWith("module.json"))) {
    const j = JSON.parse(fs.readFileSync(f, "utf8"));
    for (const t of (j.does && j.does.tools) || []) tools.add(typeof t === "string" ? t : t.name);
  }
  return /** @type {Record<string, Set<string>>} */ ({ tools, roles: new Set(ROLE_IDS), providers: new Set([...AIS, "openrouter", "openai-compatible"]) });
}

const LIST = /\[\s*((?:"[^"\n]*"|'[^'\n]*')\s*,\s*(?:(?:"[^"\n]*"|'[^'\n]*')\s*,?\s*){1,})\]/g;

/** Copies found: { "<file> <owner>": count }. @param {Record<string, Set<string>>} own */
export function copies(own) {
  /** @type {Record<string, number>} */ const found = {};
  for (const surface of SURFACES) for (const f of walk(path.join(ROOT, surface))) {
    const rel = path.relative(ROOT, f);
    if (!/\.(js|mjs|ts|tsx)$/.test(f) || SKIP_FILE.test("/" + rel)) continue;
    const s = fs.readFileSync(f, "utf8");
    for (const m of s.matchAll(LIST)) {
      const items = [...m[1].matchAll(/["']([^"'\n]*)["']/g)].map(x => x[1]);
      for (const [owner, set] of Object.entries(own)) if (items.filter(i => set.has(i)).length >= 3) found[`${rel} ${owner}`] = (found[`${rel} ${owner}`] || 0) + 1;
    }
  }
  return found;
}

test("A5: the registry lists are read from their owners, not copied into a surface (the baseline may only shrink)", () => {
  const own = owners();
  assert.ok(own.tools.size > 500 && own.roles.size >= 4 && own.providers.size >= 3, "the owners' lists were read");
  const base = JSON.parse(fs.readFileSync(path.join(ROOT, "test", "a5-baseline.json"), "utf8")).copies;
  const found = copies(own);
  const worse = Object.entries(found).filter(([k, n]) => n > (base[k] ? base[k].count : 0)).map(([k, n]) => `${k}: ${n} (allowed ${base[k] ? base[k].count : 0})`);
  assert.deepEqual(worse, [], "a literal copy of an owner's list: read it from the owner (tools: the module's own list; roles: kernel/contracts ROLE_IDS; providers: lib/skill-library AIS) or follow its change event");
  const stale = Object.keys(base).filter(k => !found[k] || found[k] < base[k].count).map(k => `${k}: found ${found[k] || 0}, baseline ${base[k].count}`);
  assert.deepEqual(stale, [], "a copy was removed: lower its number in test/a5-baseline.json");
});

test("A5: the guard sees a copy (a literal list of tool names, of roles, of providers) and ignores a list of other words", () => {
  const own = { tools: new Set(["a.one", "a.two", "a.three"]), roles: new Set(["owner", "admin", "member"]), providers: new Set(["claude", "codex", "grok"]) };
  {
    const hit = (/** @type {string} */ src) => { const found = {}; const items = [...src.matchAll(LIST)].flatMap(m => [...m[1].matchAll(/["']([^"'\n]*)["']/g)].map(x => x[1])); for (const [o, set] of Object.entries(own)) if (items.filter(i => set.has(i)).length >= 3) found[o] = 1; return Object.keys(found); };
    assert.deepEqual(hit(`const X = ["a.one", "a.two", "a.three", "b"];`), ["tools"]);
    assert.deepEqual(hit(`const R = ['owner', 'admin', 'member'];`), ["roles"]);
    assert.deepEqual(hit(`const P = ["claude", "codex", "grok"];`), ["providers"]);
    assert.deepEqual(hit(`const W = ["red", "green", "blue"];`), []);
    assert.deepEqual(hit(`const T = ["a.one", "a.two"];`), [], "two names are not a registry copy");
  }
});
