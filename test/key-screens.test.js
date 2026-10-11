// R031-58, G27: the inventory of Vyre's own screens. Every route under apps/app/app/u is drawn from blocks (it reaches BlockScreen through its imports) or is named in test/screens-hand.json, one entry per
// route with the reason it is still hand-written. The list is a ratchet (scripts/team/ratchets.mjs): a new hand-written screen fails until it is named, and naming it is growth that needs a [ratchet +N: why]
// in a commit message; converting a screen to blocks makes its entry stale, and the test says to remove it, so the count of screens left to move only goes down and is always written down.
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "apps", "app");
const ROUTES = path.join(ROOT, "app");
/** Routes that are the shell or the harness, not a screen a person uses: layouts, the gallery, the demos and the picture routes. */
const NOT_SCREENS = /(^|\/)_layout\.tsx$|^(gallery|chat-demo|glass-relay-proof|keycheck|notices-proof|terminal-demo)\.tsx$|^shots-[a-z-]+\.tsx$/;
const HAND_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "screens-hand.json");

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


/** The words a generated entry starts with (UPDATE_SCREENS_HAND=1); an entry is then edited by hand. [pattern, reason]. */
const WHY = /** @type {[RegExp, string][]} */ ([
  [/^_layout\.tsx$/, "the shell, not a screen"],
  [/^install\//, "first-run flow with device pairing: a wizard of its own, not a data screen"],
  [/^chats\/(?!index\.tsx$)/, "the conversation (and the new-chat page): a live stream with a composer; the list (chats/index.tsx) is one list block; chat has its own renderer and the glance card (ChatCard) sits beside it"],
  [/^glass\/|^wink\/|^setup\//, "a live device or screen stream, a pairing flow"],
  [/^settings\/(?!index\.tsx$)/, "the settings pages behind the hub: forms and lists of their own; the hub itself (settings/index.tsx) is one list block"],
  [/^templates(\/\[id\])?\.tsx$/, "the project template studio (a tree of stages and tasks with its own editing): the projects team owns it; it moves with the template design in 0.3.2"],
  [/^record\/\[id\]\.tsx$/, "one record (RecordPage): fields, related records, files, timeline; moves with typed cells in 0.3.2 (the records list is on blocks already, through the `records` block)"],
  [/^(now|now\/doing|now\/needs|task\/\[id\]|project\/\[id\]|projects)\.tsx$|^now\/(doing|needs)\.tsx$/, "tasks and projects (ui/tasks): Now, Needs, Doing, Task, Project; they move with the project design"],
  [/^(flows|flows\/\[id\]|engineer)\.tsx$/, "the Flows canvas and the Engineer: a canvas and a live thread"],
  [/^(index|about|access|appearance|assistants|calendar|connections|drive|kits|kits\/\[id\]|memory|planner|search|sidebar|spaces|vault)\.tsx$/, "a hand-written page of Vyre's own; moves to a screen in a later wave of the key-screens work"],
]);

const whyOf = (/** @type {string} */ r) => (WHY.find(([p]) => p.test(r.replace(/^u\//, ""))) || [null, "a hand-written page of Vyre's own; it moves to blocks in a later wave of G27"])[1];
const routes = () => walk(ROUTES).filter(r => !NOT_SCREENS.test(r));
/** Routes that do not reach BlockScreen: the screens left to move. */
const handwritten = () => routes().filter(r => !reachesBlocks(path.join(ROUTES, r)));

test("key screens: every route is drawn from blocks or named in test/screens-hand.json with its reason, and a converted one leaves the list", () => {
  const hand = handwritten();
  const listed = JSON.parse(fs.readFileSync(HAND_FILE, "utf8")).routes;
  if (process.env.UPDATE_SCREENS_HAND === "1") {
    const was = listed || {};
    fs.writeFileSync(HAND_FILE, JSON.stringify({ _comment: "Routes under apps/app/app/u that are still hand-written (they do not reach BlockScreen), each with why. A ratchet: it may only shrink. Converting a screen removes its entry; a new hand-written screen must be named here with a [ratchet +N: why] in a commit message.", routes: Object.fromEntries(hand.map(r => [r, was[r] || whyOf(r)])) }, null, 1) + "\n");
    return;
  }
  assert.deepEqual(hand.filter(r => !(r in listed)), [], "a new hand-written screen needs a decision: draw it from blocks, or name it in test/screens-hand.json with the reason (and [ratchet +1: why] in a commit message)");
  assert.deepEqual(Object.keys(listed).filter(r => !hand.includes(r)), [], "these routes are drawn from blocks now (or gone): remove them from test/screens-hand.json, so the count of screens left to move is true");
  const all = routes();
  console.log(`key screens: ${all.length - hand.length} of ${all.length} routes drawn from blocks, ${hand.length} still hand-written`);
  assert.ok(all.length - hand.length >= 2);
});
