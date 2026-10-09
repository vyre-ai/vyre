#!/usr/bin/env node
// preflight: the one check a teammate runs before queueing work (team/FOUNDATION.md, part 6).
// It turns the standing rulings into code, so nobody spends thinking on them and the lead never
// re-reviews them by hand.
//
//   node scripts/team/preflight.mjs                 static checks + guard tests + touched tests + app types
//   node scripts/team/preflight.mjs --static        static checks only (allowed on the Mac)
//   node scripts/team/preflight.mjs --base <ref>    compare against <ref> (default origin/work/lead-031-w)
//   node scripts/team/preflight.mjs --ci            the merge queue's mode: same checks, no fetch
//
// Exit 0 = clean. Every failure names the rule (FOUNDATION.md ids) and how to fix it.
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { GENERATED, GENERATORS } from "./regen.mjs";

const args = process.argv.slice(2);
const flag = (/** @type {string} */ n) => args.includes(n);
const opt = (/** @type {string} */ n, /** @type {string} */ d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const BASE = opt("--base", "origin/work/lead-031-w");
const STATIC = flag("--static");
const CI = flag("--ci");

const git = (/** @type {string[]} */ a) => execFileSync("git", a, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).trim();
/** @type {{rule: string, msg: string}[]} */ const fails = [];
const fail = (/** @type {string} */ rule, /** @type {string} */ msg) => fails.push({ rule, msg });

if (!STATIC && process.platform === "darwin") {
  console.error("preflight: tests never run on the Mac (rule P1). Use --static here, or run it on your test box.");
  process.exit(2);
}
if (!CI) { try { git(["fetch", "-q", "origin", BASE.replace(/^origin\//, "")]); } catch { /* offline: compare with what we have */ } }

const mergeBase = git(["merge-base", BASE, "HEAD"]);
const changed = git(["diff", "--name-only", `${mergeBase}...HEAD`]).split("\n").filter(Boolean);
const existing = changed.filter(f => fs.existsSync(f));
console.log(`preflight: ${changed.length} files changed since ${BASE} (${mergeBase.slice(0, 9)})`);

// ---- G1: generated files are never committed by hand (the merge queue regenerates them)
const gen = changed.filter(f => GENERATED.some(re => re.test(f)));
if (gen.length) fail("G1", `generated files are in your commits; drop them (git checkout ${BASE} -- <file>) and let the queue regenerate:\n    ${gen.join("\n    ")}`);

// ---- G2: no conflict markers
for (const f of existing) {
  if (/\.(png|jpg|gif|webp|woff2?|gz|zip|wasm|vyb|ico)$/.test(f)) continue;
  const t = fs.readFileSync(f, "utf8");
  if (/^(<<<<<<< |>>>>>>> )/m.test(t)) fail("G2", `conflict markers in ${f}`);
}

// ---- G3: credit the repository owner only, no AI attribution in commit messages
const bodies = git(["log", `${mergeBase}..HEAD`, "--format=%H %B%x00"]);
if (/Co-Authored-By:\s*Claude|Generated with \[Claude|Claude-Session:/i.test(bodies)) fail("G3", "a commit message carries Claude attribution; Vyre credits the repository owner only. Reword the commit (git commit --amend, or a new commit for older ones before queueing).");

// ---- added lines, per file, for the code rules
const diff = git(["diff", "-U0", `${mergeBase}...HEAD`, "--", ...existing.filter(f => /\.(m?js|ts|tsx|json|html|css|sh)$/.test(f))]).split("\n");
let file = "";
/** @type {{file: string, line: string}[]} */ const added = [];
for (const l of diff) {
  if (l.startsWith("+++ b/")) file = l.slice(6);
  else if (l.startsWith("+") && !l.startsWith("+++")) added.push({ file, line: l.slice(1) });
}
const isTest = (/** @type {string} */ f) => /(\.test\.|\/testing\/|^test\/|\/test\/|^scripts\/|\.real\.test\.)/.test(f);
const isDoc = (/** @type {string} */ f) => /\.md$|^docs\//.test(f);

for (const { file: f, line } of added) {
  // S1: a security or behaviour switch read raw from the environment (must go through devSwitch so a release build ignores it)
  if (!isTest(f) && !/kernel\/devbuild\.js$|appattest\.js$/.test(f) && /process\.env\.VYRE_[A-Z0-9_]*(OFF|DEV|SKIP|DISABLE|INSECURE|ALLOW|NO_[A-Z]+|UNSAFE|LEASES|SANDBOX)[A-Z0-9_]*\s*(!==|===|!=|==)\s*["'`][01]["'`]/.test(line))
    fail("S1", `${f}: a switch read raw from process.env; use devSwitch() from kernel/devbuild.js so a release build ignores it:\n    ${line.trim().slice(0, 160)}`);
  // S2: shipped code never loads from a third-party CDN (vendor it, pinned and hashed)
  if (!isTest(f) && !isDoc(f) && /https?:\/\/(unpkg\.com|cdn\.jsdelivr\.net|esm\.sh|cdnjs\.cloudflare\.com|cdn\.tailwindcss\.com|cdn\.skypack\.dev|ga\.jspm\.io|cdn\.sheetjs\.com)/.test(line))
    fail("S2", `${f}: shipped code points at a public CDN; vendor the file, pinned and hashed:\n    ${line.trim().slice(0, 160)}`);
  // T1: never hide a red: no new todo/skip in tests
  if (isTest(f) && /\.test\./.test(f) && /(\btest\.(todo|skip)\(|\bit\.(todo|skip)\(|\bdescribe\.skip\(|[{,]\s*(todo|skip)\s*:\s*(true|["'`]))/.test(line))
    fail("T1", `${f}: a new todo or skip hides a red; fix the cause, or ask the lead for a written ruling first:\n    ${line.trim().slice(0, 160)}`);
}

// ---- W1: edits in another team's paths (a warning, not a failure): the two ends of a seam talk first
/** @type {string[]} */ const warns = [];
try {
  const own = JSON.parse(fs.readFileSync("scripts/team/owners.json", "utf8"));
  const me = process.env.VYRE_TEAM || "";
  /** @param {string} f */
  const ownerOf = f => own.shared[f] || Object.entries(own.shared).find(([p]) => p.endsWith("/") && f.startsWith(p))?.[1] || own.paths.find((/** @type {[string,string]} */ [p]) => f.startsWith(p))?.[1] || "";
  /** @type {Map<string, string[]>} */ const by = new Map();
  for (const f of changed) { const o = ownerOf(f); if (o && o !== me && !/\.test\.|CHANGELOG|test-counts|^docs\/using\//.test(f)) by.set(o, [...(by.get(o) || []), f]); }
  for (const [o, fs2] of by) warns.push(`W1 touches ${o}'s paths (${fs2.slice(0, 4).join(", ")}${fs2.length > 4 ? ", ..." : ""}): if it changes a contract, the contract file in team/contracts/ says so and ${o} knows.`);
} catch { /* owners.json is advisory */ }

// ---- tests: guard set + touched tests + the touched source files' sibling tests
const GUARDS = [
  "test/boundaries.test.js", "test/declared-inputs.test.js", "test/dependency-guard.test.js", "test/description-lint.test.js",
  "test/http-single.test.js", "test/ids-single.test.js", "test/key-screens.test.js", "test/one-mechanism.test.js",
  "test/one-role-list.test.js", "test/one-person-surfaces.test.js", "test/outward-flags.test.js", "test/plain-session-writes.test.js",
  "test/project-arg.test.js", "test/reach-anyone.test.js", "test/reach-explicit.test.js", "test/reach-registry.test.js",
  "test/reach-module-calls.test.js", "test/reach-classes.test.js", "kernel/retrofit/agent-reach.test.js", "kernel/size.test.js",
  "test/scrub-single.test.js", "test/tools-budget.test.js", "test/module-sdk.test.js", "test/docs-build.test.js",
  "test/agent-docs.test.js", "test/docs-check.test.js", "test/credential-pins.test.js", "core/sessions/environment.test.js",
  "kernel/golden/allow.test.js",
].filter(f => fs.existsSync(f));

/** @type {Set<string>} */ const tests = new Set(GUARDS);
for (const f of existing) {
  if (/\.test\.(m?js)$/.test(f)) { tests.add(f); continue; }
  if (!/\.(m?js|ts|tsx)$/.test(f)) continue;
  const dir = path.dirname(f), stem = path.basename(f).replace(/\.(m?js|tsx?)$/, "");
  for (const cand of [`${dir}/${stem}.test.js`, `${dir}/${stem}.test.mjs`]) if (fs.existsSync(cand)) tests.add(cand);
  if (/^core\/[^/]+\/(index\.js|module\.json)$/.test(f) || /^core\/[^/]+\/module\.json$/.test(f)) {
    for (const t of fs.readdirSync(dir)) if (/\.test\.m?js$/.test(t)) tests.add(`${dir}/${t}`);
  }
}

let testsOk = true, tscOk = true;
if (!STATIC) {
  // Generated files are rebuilt in the working tree only, so the docs and golden guards see the branch's real state; they are restored afterwards.
  for (const g of GENERATORS) spawnSync(process.execPath, g, { stdio: "ignore" });
  const list = [...tests];
  console.log(`preflight: running ${list.length} test files (${GUARDS.length} guards + ${list.length - GUARDS.length} touched)`);
  const r = spawnSync(process.execPath, ["scripts/test-counts.mjs", "run", ...list], { stdio: "inherit", env: { ...process.env, VYRE_TEST_FILE_LIMIT_MS: process.env.VYRE_TEST_FILE_LIMIT_MS || "240000" } });
  testsOk = r.status === 0;
  if (!testsOk) fail("T2", "tests failed (above). A guard that fails names its rule; a touched test that fails is yours to fix. A red that is not yours: say so in your queue note with the file name, and do not queue until the lead rules.");

  // App types: only errors in files this branch touched count against it.
  if (existing.some(f => /^(apps\/app|lib)\//.test(f)) && fs.existsSync("apps/app/node_modules")) {
    const t = spawnSync("npx", ["tsc", "--noEmit", "-p", "apps/app"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    const errs = (t.stdout || "").split("\n").filter(l => /error TS/.test(l));
    const mine = errs.filter(l => existing.some(f => l.includes(f.replace(/^apps\/app\//, "")) || l.includes(f)));
    if (mine.length) { tscOk = false; fail("T3", `app type errors in files you touched:\n    ${mine.slice(0, 20).join("\n    ")}`); }
  }
  // put the generated files back as they are in git
  const dirty = git(["status", "--porcelain"]).split("\n").map(l => l.slice(3)).filter(f => f && GENERATED.some(re => re.test(f)));
  if (dirty.length) execFileSync("git", ["checkout", "--", ...dirty]);
}

console.log("");
for (const w of warns) console.log(`warn ${w}`);
if (!fails.length) { console.log(`preflight: CLEAN${STATIC ? " (static only)" : ""}. Queue it: scripts/team/queue.sh <item>`); process.exit(0); }
for (const f of fails) console.log(`FAIL ${f.rule}: ${f.msg}\n`);
console.log(`preflight: ${fails.length} problem(s). Rules: team/FOUNDATION.md.`);
process.exit(1);
