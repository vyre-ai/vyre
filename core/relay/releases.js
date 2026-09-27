// @ts-check
// releases: the hosted web app's published builds this box knows (ADR 0026 section 10, point 5).
// A web device names its release and manifest hash in the hello; a build not in releases.json is
// shown as "unknown build". A hostile build can lie, so this catches mistakes, not a determined
// attacker. The release pipeline appends to releases.json; the box ships with it.

import fs from "node:fs";

/** @typedef {{ release: string, sha: string, manifest: string }} Release */
/** @type {Map<string, Release> | null} */
let known = null;
/** @type {string | URL} */
let file = new URL("./releases.json", import.meta.url);
const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

/** @returns {Map<string, Release>} by release */
function load() {
  if (known) return known;
  known = new Map();
  try {
    const j = JSON.parse(fs.readFileSync(file, "utf8"));
    for (const r of Array.isArray(j.releases) ? j.releases : []) {
      if (r && SEMVER.test(r.release) && /^[a-f0-9]{64}$/.test(r.manifest) && /^[a-f0-9]{12,64}$/.test(r.sha)) known.set(r.release, { release: r.release, sha: r.sha, manifest: r.manifest });
    }
  } catch {}
  return known;
}

/** Whether this release and manifest hash are a build this box knows. */
export const knownBuild = (release, manifest) => Boolean(release && manifest && load().get(release)?.manifest === manifest);

/** One known release by name, or null. */
export const findRelease = release => load().get(String(release)) || null;

/** The newest known release, or null when the box knows none. */
export function newestRelease() {
  const key = r => (SEMVER.exec(r.release) || []).slice(1).map(Number);
  const newer = (a, b) => { const [x, y] = [key(a), key(b)]; return (x[0] - y[0] || x[1] - y[1] || x[2] - y[2]) > 0; };
  let best = null;
  for (const r of load().values()) if (!best || newer(r, best)) best = r;
  return best;
}

/** For tests: read the list from another file (or the shipped one again, with no argument). */
export const useReleasesFile = f => { file = f || new URL("./releases.json", import.meta.url); known = null; };
