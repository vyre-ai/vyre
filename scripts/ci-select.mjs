#!/usr/bin/env node
// Which test files a change can affect (fast pull request CI). The import graph of the repo's code, read from the files themselves, is walked backwards from each changed file to the test files
// that reach it, and only those run. Everything runs when the change is one that reaches every test: a lockfile, any package.json, a workflow, the test runner and its records, the kernel's core or the
// module loader, or a file that more than a third of the tests reach. A changed file that is not code and that nothing imports (a data file a test reads from disk) also runs everything, because the graph
// cannot see who reads it; plain docs and notes run nothing, except the generated docs, which run their one check. A changed code file that no test reaches is a failure (`uncovered`, exit 1: "no test covers <file>"), so untested code cannot ride through a fast run; the apps and the capsule, which their own workflows cover, are exempt.
// The full suite still runs on integrate/*, release/* and the train (.github/workflows/node.yml), so a miss here is caught there, never shipped.
//
//   node scripts/ci-select.mjs <base-ref>        prints {"all":bool,"files":[...],"docs":bool,"windows":bool,"why":[...]} for the diff from <base-ref> to the working tree
//   node scripts/ci-select.mjs --github-output   the same, written to $GITHUB_OUTPUT as all, docs, windows, files (space separated)
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { GLOBS } from "./test-counts.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CODE = /\.(?:m?js|cjs|tsx?|jsx)$/;
const TEST = /\.test\.(?:m?js|cjs)$/;
const EXTS = [".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".json"];
/** Every change here runs every test. */
const EVERYTHING = [/(^|\/)package(-lock)?\.json$/, /^\.github\/(workflows|actions)\//, /^kernel\/core\//, /^core\/modules\//, /^scripts\/(test-counts|mac-test-guard|ci-select)\./, /^test\/(helpers\.js|must-run\.json|test-counts\.json|tmp-guard\.mjs)$/, /^\.nvmrc$/, /(^|\/)tsconfig[^/]*\.json$/];
/** Changes that run no test of their own: notes, plans and the team's files. */
const INERT = [/^team\//, /^release\/notes\//, /\.md$/, /^LICENSE/, /^\.gitignore$/];
/** The generated docs and what they are generated from: their one check. */
const DOCS = [/^docs\//, /(^|\/)module\.json$/];
/** A change that can differ on Windows: the files test:windows and windows-socket-acl cover. */
const WINDOWS = [/^core\/(config|daemon)\//, /^scripts\/win-/, /^relay\/client\//, /^core\/cli\//, /^lib\//];
/** Code the node tests do not cover by design: the phone and desktop apps and the capsule have their own workflows. */
const OWN_WORKFLOW = [/^apps\/app\//, /^local\/capsule\//];
const FAN_IN = 1 / 3;

/** Every relative path a source file names: imports, dynamic imports, requires, `new URL("./x", import.meta.url)`, and quoted repo paths that a test spawns or reads. @param {string} src */
export function specifiers(src) {
  const out = new Set();
  for (const re of [/\b(?:import|export)\s[^'"`;]*?\bfrom\s*['"]([^'"]+)['"]/g, /\bimport\s*['"]([^'"]+)['"]/g, /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g, /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g, /new URL\(\s*['"](\.[^'"]+)['"]\s*,\s*import\.meta\.url/g, /['"`](\.{1,2}\/[\w@./-]+\.(?:m?js|cjs|tsx?|json|sh))['"`]/g]) for (const m of src.matchAll(re)) out.add(m[1]);
  /** repo-root paths a test names ("scripts/x.mjs", "core/y/module.json") */
  for (const m of src.matchAll(/['"`]((?:core|kernel|lib|scripts|web|apps|test|local|packages|records|stores|modules|relay|names|updates|site|harness)\/[\w@./-]+\.(?:m?js|cjs|tsx?|json|sh))['"`]/g)) out.add("/" + m[1]);
  return [...out];
}

/** The tracked file a specifier from `from` means, or null. @param {string} from @param {string} spec @param {Set<string>} tracked */
export function resolve(from, spec, tracked) {
  const base = spec.startsWith("/") ? spec.slice(1) : spec.startsWith(".") ? path.posix.normalize(path.posix.join(path.posix.dirname(from), spec)) : null;
  if (base === null) return null;
  for (const c of [base, ...EXTS.map(e => base + e), ...EXTS.map(e => `${base}/index${e}`)]) if (tracked.has(c)) return c;
  return null;
}

/** The workspace packages a bare import may name: name -> its directory. @param {Set<string>} tracked @param {(f: string) => string} read */
function workspaces(tracked, read) {
  /** @type {Record<string, string>} */ const out = {};
  for (const f of tracked) if (/^(packages|apps)\/[^/]+\/package\.json$|^packages\/[^/]+\/[^/]+\/package\.json$/.test(f)) { try { const n = JSON.parse(read(f)).name; if (typeof n === "string") out[n] = path.posix.dirname(f); } catch { /* not a package */ } }
  return out;
}

/** file -> the files that import it (and a workspace package's own files, under "pkg:<name>"). @param {Set<string>} tracked @param {(f: string) => string} read */
export function dependents(tracked, read) {
  /** @type {Map<string, Set<string>>} */ const rev = new Map();
  const add = (/** @type {string} */ to, /** @type {string} */ from) => { if (!rev.has(to)) rev.set(to, new Set()); /** @type {Set<string>} */ (rev.get(to)).add(from); };
  const ws = workspaces(tracked, read);
  const pkgOf = (/** @type {string} */ f) => Object.entries(ws).find(([, dir]) => f.startsWith(dir + "/"))?.[0];
  for (const f of tracked) {
    if (!CODE.test(f)) continue;
    const p = pkgOf(f); if (p) add(`pkg:${p}`, f);
    let src = ""; try { src = read(f); } catch { continue; }
    for (const s of specifiers(src)) {
      const r = resolve(f, s, tracked); if (r) { add(r, f); continue; }
      const name = Object.keys(ws).find(n => s === n || s.startsWith(n + "/")); if (name) add(`pkg:${name}`, f);
    }
  }
  // a file inside a workspace package reaches whoever imports the package
  for (const [name, dir] of Object.entries(ws)) for (const f of tracked) if (f.startsWith(dir + "/")) for (const u of rev.get(`pkg:${name}`) || []) if (!u.startsWith(dir + "/")) add(f, u);
  return rev;
}

/** The test files that reach `file`, through any chain of imports. @param {string} file @param {Map<string, Set<string>>} rev */
export function testsReaching(file, rev) {
  const seen = new Set([file]), q = [file];
  while (q.length) for (const d of rev.get(/** @type {string} */ (q.shift())) || []) if (!seen.has(d)) { seen.add(d); q.push(d); }
  return [...seen].filter(f => TEST.test(f));
}

/**
 * @param {{ changed: string[], tracked: Set<string>, read: (f: string) => string, tests?: string[] }} o `tests` are the files the suite runs (default: the tracked files test-counts would run)
 * @returns {{ all: boolean, files: string[], docs: boolean, windows: boolean, why: string[], uncovered: string[] }}
 */
export function select(o) {
  const { changed, tracked, read } = o;
  const tests = new Set(o.tests || [...tracked].filter(f => TEST.test(f)));
  const why = /** @type {string[]} */ ([]);
  const docs = changed.some(f => DOCS.some(r => r.test(f)));
  const windows = changed.some(f => WINDOWS.some(r => r.test(f)));
  const everything = (/** @type {string} */ reason) => ({ all: true, files: [], docs: true, windows: true, why: [...why, reason], uncovered: /** @type {string[]} */ ([]) });
  const uncovered = /** @type {string[]} */ ([]);
  const rev = dependents(tracked, read);
  const picked = new Set(docs ? ["test/docs-check.test.js"].filter(f => tests.has(f)) : []);
  for (const f of changed) {
    const hit = EVERYTHING.find(r => r.test(f)); if (hit) return everything(`${f} reaches every test`);
    if (tests.has(f)) picked.add(f);
    if (!tracked.has(f)) { if (CODE.test(f) && !TEST.test(f)) why.push(`${f} was deleted: its importers changed with it or the build is red`); continue; }
    if (INERT.some(r => r.test(f)) || DOCS.some(r => r.test(f))) continue;
    const reached = testsReaching(f, rev).filter(t => tests.has(t));
    if (reached.length > tests.size * FAN_IN) return everything(`${f} is reached by ${reached.length} of ${tests.size} tests`);
    for (const t of reached) picked.add(t);
    if (!reached.length) {
      if (CODE.test(f) && !TEST.test(f)) { if (!OWN_WORKFLOW.some(r => r.test(f))) uncovered.push(f); }
      else if (!TEST.test(f)) return everything(`${f} is data nothing imports: a test may read it from disk`);
    }
  }
  const files = [...picked].sort();
  return { all: false, files, docs: docs || files.includes("test/docs-check.test.js"), windows: windows || files.some(f => WINDOWS.some(r => r.test(f))), why, uncovered };
}

const git = (/** @type {string[]} */ args) => { const r = spawnSync("git", args, { cwd: REPO, encoding: "utf8", maxBuffer: 1 << 28 }); if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`); return r.stdout; };

/** The tracked files the suite would run, from test-counts' own globs. @param {Set<string>} tracked */
export const suite = tracked => { const globbed = new Set(GLOBS.flatMap(g => fs.globSync(g, { cwd: REPO })).map(f => f.split(path.sep).join("/"))); return [...tracked].filter(f => globbed.has(f) && TEST.test(f) && !f.split("/").includes("node_modules")); };

if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = process.argv[2] || "";
  const toOutput = arg === "--github-output";
  const base = toOutput ? process.argv[3] || "" : arg;
  const tracked = new Set(git(["ls-files"]).split("\n").filter(Boolean));
  /** A base that is missing or the zero sha selects everything: no way to know what changed. */
  const zero = !base || /^0+$/.test(base);
  let result;
  try {
    if (zero) throw new Error("no base to compare with");
    const changed = git(["diff", "--name-only", "--no-renames", `${base}...HEAD`]).split("\n").filter(Boolean);
    result = select({ changed, tracked, read: f => fs.readFileSync(path.join(REPO, f), "utf8"), tests: suite(tracked) });
  } catch (e) { result = { all: true, files: [], docs: true, windows: true, uncovered: [], why: [`could not tell what changed (${/** @type {Error} */ (e).message.split("\n")[0]}): running everything`] }; }
  if (toOutput && process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `all=${result.all}\ndocs=${result.docs}\nwindows=${result.windows}\nfiles=${result.files.join(" ")}\nany=${result.all || result.files.length > 0}\n`);
  console.log(JSON.stringify(result, null, 1));
  if (!result.all && result.uncovered.length) { for (const f of result.uncovered) console.error(`no test covers ${f}`); console.error("Add a test that reaches it (an import is enough to link them), then push again."); process.exit(1); }
}
