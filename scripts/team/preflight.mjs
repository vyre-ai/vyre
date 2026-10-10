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
import { RATCHETS, growth, ruled } from "./ratchets.mjs";
import { cdnHit, s2Exempt } from "./cdn-hosts.mjs";

const args = process.argv.slice(2);
const flag = (/** @type {string} */ n) => args.includes(n);
const opt = (/** @type {string} */ n, /** @type {string} */ d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const BASE = opt("--base", "origin/work/lead-031-w");
const STATIC = flag("--static");
const CI = flag("--ci");

const git = (/** @type {string[]} */ a) => execFileSync("git", a, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).trim();
/** @type {{rule: string, msg: string}[]} */ const fails = [];
/** @type {string[]} */ const warns = [];
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
// docs/agents/ pages are hand-written prose around generated blocks (<!-- agent:NAME:start -->): prose may be committed, as long as the
// generator leaves the page unchanged, i.e. the generated blocks are current.
const agentPages = changed.filter(f => /^docs\/agents\//.test(f) && fs.existsSync(f));
const agentStale = agentPages.length ? (() => {
  const before = new Map(agentPages.map(f => [f, fs.readFileSync(f, "utf8")]));
  spawnSync(process.execPath, ["scripts/gen-agent-docs.mjs"], { stdio: "ignore" });
  const stale = agentPages.filter(f => fs.readFileSync(f, "utf8") !== before.get(f));
  for (const [f, text] of before) fs.writeFileSync(f, text);
  return stale;
})() : [];
const gen = changed.filter(f => GENERATED.some(re => re.test(f)) && !(agentPages.includes(f) && !agentStale.includes(f)));
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

// The trusted base as kernel/size.test.js measures it (its BASE_DIRS and BASE_FILES), read from that test so the two never drift.
const KBASE = (() => { try { const t = fs.readFileSync("kernel/size.test.js", "utf8"); const arr = (/** @type {string} */ n) => [...((new RegExp(`${n}\\s*=\\s*\\[([\\s\\S]*?)\\]`).exec(t) || [])[1] || "").matchAll(/"([^"]+)"/g)].map(m => m[1]); return { dirs: arr("BASE_DIRS"), files: arr("BASE_FILES") }; } catch { return { dirs: [], files: [] }; } })();
/** @param {string} f */
const inBase = f => { if (!f.startsWith("kernel/")) return false; const r = f.slice(7); return KBASE.dirs.length ? (KBASE.dirs.some(d => r.startsWith(d + "/")) || KBASE.files.includes(r)) : true; };

// ---- K1: kernel lines need a ruling. Net lines added under kernel/ (outside tests) must be named in a commit message as [kernel +N: <reason>]; the lead rules on them first (FOUNDATION A8).
{
  const stat = git(["diff", "--numstat", `${mergeBase}...HEAD`, "--", "kernel/"]).split("\n").filter(Boolean)
    .map(l => l.split("\t")).filter(([, , f]) => f && /\.m?js$/.test(f) && !/\.test\.|\/testing\//.test(f) && inBase(f));
  const net = stat.reduce((n, [a, d]) => n + (Number(a) || 0) - (Number(d) || 0), 0);
  if (net > 0 && !/\[kernel \+\d+:/i.test(bodies)) fail("K1", `this branch adds about ${net} net kernel lines with no ruling: ask the lead first, then name it in a commit message as [kernel +${net}: why]. Report the kernel/size.test.js number in your landing.`);
  else if (net > 0) warns.push(`kernel: about +${net} net lines (ruled in a commit message); report the size number in your landing`);
}

// ---- D1: a test, a guard or the test machinery is never deleted by accident (a merge once dropped test/headless-chrome.js and the Chrome install steps). Deleting one needs [delete: why] in a commit message.
{
  const gone = git(["diff", "--name-only", "--diff-filter=D", `${mergeBase}...HEAD`]).split("\n").filter(Boolean)
    .filter(f => /\.test\.m?js$|^test\/|\/testing\/|^scripts\/(team\/|install-test-|test-)|^\.github\/workflows\//.test(f));
  if (gone.length && !/\[delete:/i.test(bodies)) fail("D1", `this branch deletes test machinery: ${gone.join(", ")}. If that is meant, say why in a commit message as [delete: why]; if not, restore them.`);
}

// ---- R1: a ratchet or allowlist that may only shrink must not grow without a reviewer-visible tag. Each list is compared with its merge-base copy (scripts/team/ratchets.mjs); growth, including a list
// regenerated by an environment switch, needs `[ratchet +N: why]` in a commit message of the branch.
{
  /** @type {string[]} */ const grown = [];
  for (const r of RATCHETS) {
    if (!changed.includes(r.file) || !fs.existsSync(r.file)) continue;
    let before = null; try { before = git(["show", `${mergeBase}:${r.file}`]); } catch { /* new file */ }
    grown.push(...growth(r, before, fs.readFileSync(r.file, "utf8")));
  }
  if (grown.length && !ruled(bodies)) fail("R1", `a list that may only shrink has grown, with no reason in a commit message. Shrink it, or name why in a commit message as [ratchet +${grown.length}: why]:\n    ${grown.join("\n    ")}`);
  else if (grown.length) warns.push(`ratchets grew (ruled in a commit message): ${grown.join("; ")}`);
}

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
  // (the host list is scripts/team/cdn-hosts.mjs, shared with test/no-cdn.test.js, and scripts/ is no longer exempt: only tests, docs and packaging are)
  if (!s2Exempt(f) && cdnHit(line))
    fail("S2", `${f}: shipped code points at a public CDN, font or analytics host (${cdnHit(line)}); vendor the file, pinned and hashed:\n    ${line.trim().slice(0, 160)}`);
  // T1: never hide a red: no new todo/skip in tests
  if (isTest(f) && /\.test\./.test(f) && /(\btest\.(todo|skip)\(|\bit\.(todo|skip)\(|\bdescribe\.skip\(|[{,]\s*(todo|skip)\s*:\s*(true|["'`]))/.test(line))
    fail("T1", `${f}: a new todo or skip hides a red; fix the cause, or ask the lead for a written ruling first:\n    ${line.trim().slice(0, 160)}`);
}

// ---- W1: edits in another team's paths (a warning, not a failure): the two ends of a seam talk first
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
  "test/http-single.test.js", "test/ids-single.test.js", "test/key-screens.test.js", "test/design-rules.test.js", "test/one-mechanism.test.js",
  "test/one-role-list.test.js", "test/one-person-surfaces.test.js", "test/outward-flags.test.js", "test/plain-session-writes.test.js",
  "test/project-arg.test.js", "test/reach-anyone.test.js", "test/reach-explicit.test.js", "test/reach-registry.test.js",
  "test/reach-module-calls.test.js", "test/reach-classes.test.js", "kernel/retrofit/agent-reach.test.js", "kernel/size.test.js",
  "test/scrub-single.test.js", "test/tools-budget.test.js", "test/module-sdk.test.js", "test/docs-build.test.js",
  "test/agent-docs.test.js", "test/docs-check.test.js", "test/credential-pins.test.js", "core/sessions/environment.test.js",
  "kernel/golden/allow.test.js",
  "test/errors-teach.test.js", "test/tools-find-quality.test.js",
  // The stored decisions: a branch that moves a cell re-records them with its ruling (node kernel/golden/index.js --write), so drift never reaches the tip.
  "kernel/golden/golden-box-plain.test.js", "kernel/golden/golden-local-plain.test.js",
  // Repo-wide hygiene rules that fail on any branch that breaks them (they were outside preflight and reached the full suite red).
  // The colour and VPN guards' own names are split so this list does not trip them (the guards split their patterns the same way).
  "test/no-" + "li" + "me.test.js", "test/no-" + "tail" + "scale.test.js", "test/person-label-hygiene.test.js", "test/within-hygiene.test.js",
  "test/chrome-flags.test.js", "test/architecture-map.test.js", "test/model-is-never-person.test.js", "test/docs-rulings.test.js",
  "test/tools-text-names.test.js", "test/provider-adapters.test.js", "apps/app/src/theme/raw-colours.test.js", "kernel/seal/budget.test.js",
  "kernel/contracts/contracts.test.js", "test/tools-find-quality.test.js",
  "test/references-not-values.test.js", "test/reach-person-split.test.js", "test/identity-from-input.test.js", "test/reach-anyone-behaviour.test.js",
].filter(f => fs.existsSync(f));
// Every seam's contract test is a guard too (FOUNDATION section 10): a change on either side of a seam runs them all.
if (fs.existsSync("test/contracts")) for (const t of fs.readdirSync("test/contracts")) if (/\.test\.m?js$/.test(t)) GUARDS.push(`test/contracts/${t}`);

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
  const r = spawnSync(process.execPath, ["scripts/test-counts.mjs", "run", ...list], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, env: { ...process.env, VYRE_TEST_FILE_LIMIT_MS: process.env.VYRE_TEST_FILE_LIMIT_MS || "240000" } });
  process.stdout.write(r.stdout || ""); process.stderr.write(r.stderr || "");
  // The files that failed, or ran fewer tests than recorded, from the runner's own summary.
  /** @type {Set<string>} */ const red = new Set();
  let section = "";
  /** @type {Set<string>} */ const short = new Set();
  for (const l of `${r.stdout}\n${r.stderr}`.split("\n")) {
    if (/^test-counts: files that failed/.test(l)) { section = "failed"; continue; }
    if (/^test-counts: tests that did not run/.test(l)) { section = "short"; continue; }
    if (section && /^  \S/.test(l)) { const f = l.trim().replace(/:.*$/, ""); (section === "short" ? short : red).add(f); continue; }
    section = "";
  }
  // A file that ran fewer tests than recorded is this branch's only when it touched that file or the counts.
  /** The counts file's entry for f, here and at the base. @param {string} rev @param {string} f */
  const countAt = (rev, f) => { try { const j = JSON.parse(rev ? git(["show", `${rev}:test/test-counts.json`]) : fs.readFileSync("test/test-counts.json", "utf8")); return JSON.stringify(j[f] ?? j.files?.[f] ?? Object.values(j).find(v => v && typeof v === "object" && f in v)?.[f]); } catch { return ""; } };
  for (const f of short) if (changed.includes(f) || countAt("", f) !== countAt(mergeBase, f)) red.add(f); else warns.push(`base red (count): ${f} runs fewer tests than test/test-counts.json records, before your change`);
  if (r.status !== 0 && !red.size) red.add("(the runner failed; see above)");
  // A red that is also red on the integration tip without this branch is not this branch's: it is reported, not blocking.
  /** @type {string[]} */ const baseRed = [];
  if (red.size && !red.has("(the runner failed; see above)")) {
    const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR || "/tmp", "preflight-base-"));
    try {
      execFileSync("git", ["worktree", "add", "-q", "--detach", tmp, mergeBase], { stdio: "ignore" });
      for (const nm of ["node_modules", "apps/app/node_modules"]) if (fs.existsSync(nm)) fs.symlinkSync(path.resolve(nm), path.join(tmp, nm));
      for (const g of GENERATORS) spawnSync(process.execPath, g, { cwd: tmp, stdio: "ignore" });
      for (const f of red) {
        if (!fs.existsSync(path.join(tmp, f))) continue;
        const b = spawnSync(process.execPath, ["--test", f], { cwd: tmp, stdio: "ignore", timeout: 240000 });
        if (b.status !== 0) baseRed.push(f);
      }
    } catch (e) { warns.push(`could not check the base for its own reds (${String(e).slice(0, 120)}); every red counts as yours`); }
    finally { try { execFileSync("git", ["worktree", "remove", "--force", tmp], { stdio: "ignore" }); } catch { /* left for git worktree prune */ } }
  }
  // Strict mode (scripts/team/STRICT exists): once the integration branch is fully green, nothing red lands, base or not.
  const strict = fs.existsSync("scripts/team/STRICT");
  const mineRed = strict ? [...red] : [...red].filter(f => !baseRed.includes(f));
  testsOk = !mineRed.length;
  if (baseRed.length) warns.push(`base red (already red on ${BASE} without your change; owned by release's red list, not blocking you):\n    ${baseRed.join("\n    ")}`);
  if (!testsOk) fail("T2", `red because of this branch:\n    ${mineRed.join("\n    ")}\n  A guard names its rule in its message; fix the cause, never loosen the guard.`);

  // T5 red first: a branch that changes behaviour must carry a test that FAILS without that change. Its changed tests run
  // against the base's source (the branch's tests and test helpers copied in, nothing else); at least one must fail there.
  // A behaviour-free change says so with [refactor] in a commit message.
  const changedTests = existing.filter(f => /\.test\.m?js$/.test(f) && !GUARDS.includes(f));
  const changedSource = existing.filter(f => /\.(m?js|ts|tsx)$/.test(f) && !/\.test\.|\/testing\/|^test\/|^scripts\/|^\.github\//.test(f));
  const refactor = /\[refactor\]/i.test(bodies);
  if (changedSource.length && !refactor) {
    // Proof is a changed test that fails on the base's code, or a guard that is red on the base and green here (a fix that turns a guard green).
    const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR || "/tmp", "preflight-red-first-"));
    try {
      execFileSync("git", ["worktree", "add", "-q", "--detach", tmp, mergeBase], { stdio: "ignore" });
      for (const nm of ["node_modules", "apps/app/node_modules"]) if (fs.existsSync(nm)) fs.symlinkSync(path.resolve(nm), path.join(tmp, nm));
      for (const f of existing.filter(f => /\.test\.|\/testing\/|^test\//.test(f))) { fs.mkdirSync(path.dirname(path.join(tmp, f)), { recursive: true }); fs.copyFileSync(f, path.join(tmp, f)); }
      const failsAtBase = (/** @type {string} */ f) => fs.existsSync(path.join(tmp, f)) && spawnSync(process.execPath, ["--test", f], { cwd: tmp, stdio: "ignore", timeout: 240000 }).status !== 0;
      const failedOnBase = changedTests.filter(failsAtBase);
      // The guards run on the base six at a time, four minutes each and ten minutes in all: one at a time they took most of an hour.
      const guardsAtBase = () => {
        const cands = GUARDS.filter(g => !red.has(g) && fs.existsSync(path.join(tmp, g)));
        if (!cands.length) return [];
        const pool = `const { spawn } = require("node:child_process"); const files = JSON.parse(process.argv[1]); const failed = []; let next = 0;
          const one = () => { const f = files[next++]; if (!f) return Promise.resolve(); return new Promise(res => { const c = spawn(process.execPath, ["--test", f], { stdio: "ignore" }); const t = setTimeout(() => c.kill("SIGKILL"), 240000); c.on("exit", code => { clearTimeout(t); if (code !== 0) failed.push(f); res(); }); }).then(one); };
          Promise.all(Array.from({ length: 6 }, one)).then(() => process.stdout.write(JSON.stringify(failed)));`;
        const r = spawnSync(process.execPath, ["-e", pool, JSON.stringify(cands)], { cwd: tmp, encoding: "utf8", timeout: 600000 });
        if (r.error || r.status !== 0) { warns.push(`T5: the guards did not finish on the base in ten minutes; no guard counts as proof`); return []; }
        const failed = new Set(JSON.parse(r.stdout || "[]"));
        return cands.filter(g => failed.has(g));
      };
      const guardsTurnedGreen = failedOnBase.length ? [] : guardsAtBase();
      if (failedOnBase.length) console.log(`preflight: red first OK (${failedOnBase.length} of ${changedTests.length} changed test files fail without the change)`);
      else if (guardsTurnedGreen.length) console.log(`preflight: red first OK (guards red without the change and green with it: ${guardsTurnedGreen.join(", ")})`);
      else fail("T5", changedTests.length
        ? `none of this branch's tests fail without its code change, so none of them proves it (${changedTests.join(", ")}). Write the test that would catch the bug or the missing behaviour; check it fails on ${BASE}.`
        : `this branch changes code (${changedSource.slice(0, 3).join(", ")}${changedSource.length > 3 ? ", ..." : ""}) with no test that proves it. Add a test that fails without the change, or mark a behaviour-free change [refactor] in a commit message.`);
    } catch (e) { warns.push(`could not run the red-first check (${String(e).slice(0, 120)})`); }
    finally { try { execFileSync("git", ["worktree", "remove", "--force", tmp], { stdio: "ignore" }); } catch { /* git worktree prune */ } }
  }

  // App types: any error fails, wherever it is (10 Oct ruling: fully green, no known fails). A branch that does not touch the app still runs it when the app's modules are installed, so an error that is already there cannot sit and be called "existing".
  if (fs.existsSync("apps/app/node_modules")) {
    const t = spawnSync("npx", ["tsc", "--noEmit", "-p", "apps/app"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    const errs = (t.stdout || "").split("\n").filter(l => /error TS/.test(l));
    if (errs.length) { tscOk = false; fail("T3", `app type errors (${errs.length}; every one counts, in any file):\n    ${errs.slice(0, 20).join("\n    ")}`); }
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
