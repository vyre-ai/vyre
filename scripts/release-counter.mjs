#!/usr/bin/env node
// release-counter: the number in a release's signed module list (modules.json "counter") that only ever goes up. It is made from the release version, with no state, so it
// cannot be forgotten, reset or reused: it orders exactly as semver does, a prerelease below the release it leads to (beta.N, then rc.N, then the release).
//   node scripts/release-counter.mjs 0.3.0-rc.2      prints 3004102
// counter = ((major * 1000 + minor) * 1000 + patch) * 100 + phase, with phase beta.N = N (1 to 39), rc.N = 40 + N (41 to 79) and a release = 99.
// A version outside those ranges is refused rather than numbered wrongly.
import { fileURLToPath } from "node:url";

/** @param {string} version @returns {number} */
export function releaseCounter(version) {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-(beta|rc)\.(\d+))?$/.exec(String(version).replace(/^v/, ""));
  if (!m) throw new Error(`not a release version: ${version}`);
  const [major, minor, patch] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (major > 999 || minor > 999 || patch > 999) throw new Error(`version out of range: ${version}`);
  let phase = 99;
  if (m[4]) {
    const n = Number(m[5]);
    if (!(n >= 1 && n <= 39)) throw new Error(`prerelease number out of range (1 to 39): ${version}`);
    phase = m[4] === "beta" ? n : 40 + n;
  }
  return ((major * 1000 + minor) * 1000 + patch) * 100 + phase;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { console.log(releaseCounter(process.argv[2] || "")); } catch (e) { console.error(`release-counter: ${/** @type {Error} */ (e).message}`); process.exit(1); }
}
