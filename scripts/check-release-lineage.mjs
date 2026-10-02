#!/usr/bin/env node
// @ts-check
// check-release-lineage: the tag's commit is not on main or the 0.2 stage line, so it must be a proper patch release (the patch fast lane).
//
//   node scripts/check-release-lineage.mjs <sha> <tag>        (run by release.yml's guard; exit 1 names every refusal)
//
// All three must hold, or the release is not built or signed:
//   1. the newest PUBLISHED stable release (gh release list, not just a tag) is an ancestor of the commit,
//   2. the tag is that release's next patch (v0.2.1 -> v0.2.2, nothing else),
//   3. the commit is on origin/hotfix/<tag>, the branch scripts/patch-release.mjs makes.
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const STABLE = /^v(\d+)\.(\d+)\.(\d+)$/;

/** @param {string} tag @returns {string|null} the next patch tag, or null when tag is not a stable tag */
export function nextPatchTag(tag) {
  const m = tag.match(STABLE);
  return m ? `v${m[1]}.${m[2]}.${Number(m[3]) + 1}` : null;
}

/** @param {string[]} tags @returns {string|null} the newest stable tag */
export function newestStable(tags) {
  const ok = tags.filter(t => STABLE.test(t)).map(t => ({ t, n: /** @type {RegExpMatchArray} */ (t.match(STABLE)).slice(1).map(Number) }));
  ok.sort((a, b) => a.n[0] - b.n[0] || a.n[1] - b.n[1] || a.n[2] - b.n[2]);
  return ok.length ? ok[ok.length - 1].t : null;
}

/** @param {{ tag: string, prev: string|null, prevIsAncestor: boolean, onHotfixBranch: boolean }} o @returns {string[]} the refusals, empty when it may be released */
export function lineage({ tag, prev, prevIsAncestor, onHotfixBranch }) {
  /** @type {string[]} */ const out = [];
  if (!prev) return ["there is no published stable release for this commit to descend from"];
  if (!prevIsAncestor) out.push(`the newest published stable release ${prev} is not an ancestor of this commit`);
  if (nextPatchTag(prev) !== tag) out.push(`${tag} is not the next patch after ${prev} (${nextPatchTag(prev)})`);
  if (!onHotfixBranch) out.push(`this commit is not on origin/hotfix/${tag}`);
  return out;
}

/** @param {string[]} a */
const run = a => execFileSync(a[0], a.slice(1), { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
/** @param {string} x @param {string} y */
const isAncestor = (x, y) => { try { execFileSync("git", ["merge-base", "--is-ancestor", x, y], { stdio: "ignore" }); return true; } catch { return false; } };

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const [sha, tag] = process.argv.slice(2);
  if (!sha || !tag) { console.error("usage: check-release-lineage.mjs <sha> <tag>"); process.exit(2); }
  const published = run(["gh", "release", "list", "--limit", "100", "--json", "tagName,isPrerelease,isDraft", "-q", ".[]|select(.isPrerelease==false and .isDraft==false)|.tagName"]).split("\n").filter(Boolean);
  const prev = newestStable(published.filter(t => t !== tag));
  const problems = lineage({ tag, prev, prevIsAncestor: Boolean(prev) && isAncestor(`refs/tags/${prev}`, sha), onHotfixBranch: isAncestor(sha, `origin/hotfix/${tag}`) });
  for (const p of problems) console.error(`release-lineage: ${p}`);
  if (problems.length) process.exit(1);
  console.log(`release-lineage: ${tag} is the next patch after ${prev} and ${sha.slice(0, 9)} is on origin/hotfix/${tag}`);
}
