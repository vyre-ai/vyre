// R031-58: the inventory of Vyre's own screens. Every route under apps/app/app/u is either drawn from blocks (it reaches BlockScreen through its imports) or named here as hand-written, with the reason
// and the wave it moves in. A new route that is in neither list fails, so a screen is never added without a decision, and the count of screens left to move can only go down.
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "apps", "app");
const ROUTES = path.join(ROOT, "app", "u");

/** Routes drawn from blocks. Each must reach BlockScreen through its imports. */
const BLOCKS = [/^module\/\[module\]\/\[view\]\.tsx$/, /^design\.tsx$/, /^records\/\[type\]\.tsx$/, /^tags\/\[tag\]\.tsx$/, /^settings\/index\.tsx$/, /^sites\.tsx$/, /^chats\/index\.tsx$/, /^(assistants|kits|spaces)\.tsx$/, /^settings\/(ai|assistants)\.tsx$/, /^sites\/\[id\]\.tsx$/];

/** Hand-written, with why. [pattern, reason]. Moving one means rebuilding it as a screen (data) and deleting the hand-written file. */
const HAND = /** @type {[RegExp, string][]} */ ([
  [/^_layout\.tsx$/, "the shell, not a screen"],
  [/^install\//, "first-run flow with device pairing: a wizard of its own, not a data screen"],
  [/^chats\/(?!index\.tsx$)/, "the conversation (and the new-chat page): a live stream with a composer; the list (chats/index.tsx) is one list block; chat has its own renderer and the glance card (ChatCard) sits beside it"],
  [/^glass\/|^wink\/|^setup\//, "a live device or screen stream, a pairing flow"],
  [/^settings\/(?!(index|ai|assistants)\.tsx$)/, "the settings pages behind the hub: forms and lists of their own; the hub itself (settings/index.tsx) is one list block, and so are the assistants and AI pages' lists"],
  [/^templates(\/\[id\])?\.tsx$/, "the project template studio (a tree of stages and tasks with its own editing): the projects team owns it; it moves with the template design in 0.3.2"],
  [/^record\/\[id\]\.tsx$/, "one record (RecordPage): fields, related records, files, timeline; moves with typed cells in 0.3.2 (the records list is on blocks already, through the `records` block)"],
  [/^(now|now\/doing|now\/needs|task\/\[id\]|project\/\[id\]|projects)\.tsx$|^now\/(doing|needs)\.tsx$/, "tasks and projects (ui/tasks): Now, Needs, Doing, Task, Project; they move with the project design"],
  [/^(flows|flows\/\[id\]|engineer)\.tsx$/, "the Flows canvas and the Engineer: a canvas and a live thread"],
  [/^(index|about|access|appearance|calendar|connections|drive|kits\/\[id\]|memory|planner|search|sidebar|vault)\.tsx$/, "a hand-written page of Vyre's own; moves to a screen in a later wave of the key-screens work"],
]);

const walk = (/** @type {string} */ dir, /** @type {string} */ rel = "") => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(dir, e.name), path.join(rel, e.name)) : e.name.endsWith(".tsx") ? [path.join(rel, e.name)] : []);

const require = createRequire(path.join(ROOT, "package.json"));
const ts = require("typescript");

/** The relative files a source file imports (from its import declarations, never from a comment or a string), and whether it actually draws BlockScreen: a JSX element or a call, in code. @param {string} file */
function facts(file) {
  const src = fs.readFileSync(file, "utf8");
  const tree = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  let draws = false;
  /** @type {{ spec: string, names: string[] }[]} */ const bound = [];
  /** @type {Set<string>} */ const used = new Set();
  const visit = (/** @type {any} */ n) => {
    if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier)) {
      const c = n.importClause, names = [];
      if (c && c.name) names.push(c.name.text);
      if (c && c.namedBindings) { if (ts.isNamespaceImport(c.namedBindings)) names.push(c.namedBindings.name.text); else for (const e of c.namedBindings.elements) names.push(e.name.text); }
      bound.push({ spec: n.moduleSpecifier.text, names });
      return; // what an import names is not a use of it
    }
    if (ts.isIdentifier(n)) used.add(n.text);
    if ((ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) && n.tagName.getText() === "BlockScreen") draws = true;
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "BlockScreen") draws = true;
    ts.forEachChild(n, visit);
  };
  visit(tree);
  // only the files whose imported names the code really uses: an import left behind after a screen stopped drawing a component does not make it drawn from blocks
  const imports = bound.filter(b => b.names.some(nm => used.has(nm))).map(b => b.spec);
  return { draws, imports };
}

/** Does this file draw BlockScreen itself, or through up to four levels of its relative imports? @param {string} file @param {number} depth @param {Set<string>} seen */
function reachesBlocks(file, depth = 4, seen = new Set()) {
  if (seen.has(file) || depth < 0 || !fs.existsSync(file)) return false;
  seen.add(file);
  const f = facts(file);
  if (f.draws) return true;
  for (const spec of f.imports) {
    if (!/^\.{1,2}\//.test(spec)) continue;
    const base = path.resolve(path.dirname(file), spec);
    const hit = [base + ".tsx", base + ".ts", path.join(base, "index.tsx"), path.join(base, "index.ts")].find(f2 => fs.existsSync(f2));
    if (hit && reachesBlocks(hit, depth - 1, seen)) return true;
  }
  return false;
}

test("key screens: every route is drawn from blocks or named as hand-written with its reason (a new one fails until it is named), and the ones that claim blocks reach BlockScreen", () => {
  const routes = walk(ROUTES);
  const undecided = routes.filter(r => !BLOCKS.some(p => p.test(r)) && !HAND.some(([p]) => p.test(r)));
  assert.deepEqual(undecided, [], "a new screen needs a decision: draw it from blocks, or name it in HAND with the reason");
  for (const r of routes.filter(r => BLOCKS.some(p => p.test(r)))) assert.ok(reachesBlocks(path.join(ROUTES, r)), `${r} says it is drawn from blocks but does not reach BlockScreen`);
  // the other direction: a route listed as hand-written that has since been moved onto blocks is a stale entry, so the count of screens left to move is true
  const moved = routes.filter(r => !BLOCKS.some(p => p.test(r)) && HAND.some(([p]) => p.test(r)) && reachesBlocks(path.join(ROUTES, r)));
  assert.deepEqual(moved, [], "these routes now draw BlockScreen: move them from HAND to BLOCKS");
  const blocks = routes.filter(r => BLOCKS.some(p => p.test(r))).length;
  console.log(`key screens: ${blocks} of ${routes.length} routes drawn from blocks (${routes.length - blocks - undecided.length} hand-written with a reason, ${undecided.length} undecided)`);
  assert.ok(blocks >= 2);
});

test("key screens: a hand-written entry that no route matches is dropped, so the list cannot go stale", () => {
  const routes = walk(ROUTES);
  for (const [p, why] of HAND) assert.ok(routes.some(r => p.test(r)), `no route matches ${p} (${why}); remove the entry`);
});
