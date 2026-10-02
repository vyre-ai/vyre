#!/usr/bin/env node
// @ts-check
// patch-release: the fast lane for a patch. One command turns fix commits into a ready-to-tag hotfix branch off the last stable release.
//
//   node scripts/patch-release.mjs <commit>... [--base vX.Y.Z] [--push]
//
// It makes a worktree off the base tag (default: the newest stable tag), cherry-picks the commits in order (authors kept, no trailers added),
// moves every version place to x.y.(z+1) with scripts/bump-version.mjs, writes release/notes/x.y.(z+1).md from the commits' subjects and
// commits that as "release: x.y.z (version and notes)" on the branch hotfix/vX.Y.Z. Read and edit the notes (the first line is the summary),
// push the branch (--push does it), wait for its hosted runs, and tag the commit: release.yml accepts a commit on main, the 0.2 stage line or a
// hotfix/* branch, builds, signs after the `release` approval and publishes. After the release run completes, release-verify.yml runs the
// release checks and site-deploy.yml puts vyre.run on the new tag, each behind its own approval where it deploys.
// A conflict stops it and leaves the worktree to fix by hand (the path is printed); nothing is pushed or tagged by this script.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const STABLE = /^v(\d+)\.(\d+)\.(\d+)$/;

/** @param {string[]} tags @returns {string|null} the newest stable tag */
export function newestStable(tags) {
  const ok = tags.filter(t => STABLE.test(t)).map(t => ({ t, n: /** @type {RegExpMatchArray} */ (t.match(STABLE)).slice(1).map(Number) }));
  ok.sort((a, b) => a.n[0] - b.n[0] || a.n[1] - b.n[1] || a.n[2] - b.n[2]);
  return ok.length ? ok[ok.length - 1].t : null;
}

/** @param {string} tag @returns {string} the next patch version, without the v */
export function nextPatch(tag) {
  const m = tag.match(STABLE);
  if (!m) throw new Error(`${tag} is not a stable tag (vX.Y.Z)`);
  return `${m[1]}.${m[2]}.${Number(m[3]) + 1}`;
}

/** Notes from commit subjects: a summary line, then one plain line per fix. @param {string[]} subjects @param {string} version */
export function notesFrom(subjects, version) {
  const lines = subjects.map(s => {
    const body = s.replace(/^[a-z]+(\([^)]*\))?!?:\s*/i, "").replace(/,?\s*(fixes|closes|fix|close)\s+#\d+\s*$/i, "").replace(/\s*\(#\d+\)\s*$/, "").trim();
    const issue = (s.match(/(?:fixes|closes|fix|close)\s+#(\d+)/i) || [])[1];
    return `- ${body.charAt(0).toUpperCase()}${body.slice(1)}${/[.!?]$/.test(body) ? "" : "."}${issue ? ` (#${issue})` : ""}`;
  });
  return `Vyre ${version} is a patch release. Edit this summary line to say what a person gets.\n\n## Fixed\n\n${lines.join("\n")}\n\n## Updating\n\nA Linux server updates from Settings, or with \`vyre update\`. The stable channel takes this release. Your data, vault and sign-ins stay as they are.\n`;
}

/** @param {string} cwd @param {string[]} args */
const git = (cwd, args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

/** @param {{ repo: string, commits: string[], base?: string, push?: boolean }} o @returns {{ branch: string, dir: string, version: string, notes: string }} */
export function patchRelease({ repo, commits, base, push = false }) {
  if (!commits.length) throw new Error("give at least one fix commit");
  const tag = base || newestStable(git(repo, ["tag", "--list", "v*"]).split("\n").filter(Boolean));
  if (!tag) throw new Error("no stable release tag here (git fetch --tags)");
  const version = nextPatch(tag), branch = `hotfix/v${version}`;
  const remote = (() => { try { return git(repo, ["ls-remote", "--heads", "origin", branch]); } catch { return ""; } })();
  if (git(repo, ["branch", "--list", branch]) || remote.includes(branch)) throw new Error(`${branch} already exists`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-patch-"));
  fs.rmdirSync(dir);
  git(repo, ["worktree", "add", "-b", branch, dir, `${tag}^{commit}`]);
  const subjects = [];
  for (const c of commits) {
    try { git(dir, ["cherry-pick", c]); }
    catch (e) { throw new Error(`${c} does not apply on ${tag}; fix it by hand in ${dir} (branch ${branch}), then bump and commit: ${String(/** @type {any} */ (e).stderr || e).split("\n")[0]}`); }
    subjects.push(git(dir, ["log", "-1", "--format=%s"]));
  }
  execFileSync("node", ["scripts/bump-version.mjs", version], { cwd: dir, stdio: "pipe" });
  const notes = path.join("release", "notes", `${version}.md`);
  fs.mkdirSync(path.join(dir, "release", "notes"), { recursive: true });
  fs.writeFileSync(path.join(dir, notes), notesFrom(subjects, version));
  git(dir, ["add", notes, "package.json", "package-lock.json", "harness/.claude-plugin/plugin.json"]);
  git(dir, ["commit", "-m", `release: ${version} (version and notes)`]);
  if (push) git(dir, ["push", "origin", `${branch}:refs/heads/${branch}`]);
  return { branch, dir, version, notes };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const args = process.argv.slice(2);
  const bi = args.indexOf("--base");
  const base = bi >= 0 ? args[bi + 1] : undefined;
  const commits = args.filter((a, i) => !a.startsWith("--") && i !== bi + 1);
  try {
    const r = patchRelease({ repo: process.cwd(), commits, base, push: args.includes("--push") });
    console.log(`patch-release: ${r.branch} is ready in ${r.dir}`);
    console.log(`  1. read and edit ${r.notes} (the first line is the summary), commit it`);
    console.log(`  2. ${args.includes("--push") ? "the branch is pushed" : `git -C ${r.dir} push origin ${r.branch}`}, wait for its hosted runs`);
    console.log(`  3. with the user's go: set VYRE_RELEASES=go and tag v${r.version} on that commit`);
  } catch (e) { console.error(`patch-release: ${/** @type {Error} */ (e).message}`); process.exit(1); }
}
