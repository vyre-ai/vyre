// @ts-check
// releases: the hosted web app's published builds this box knows (ADR 0026 section 10, point 5).
// A web device names its release and manifest hash in the hello; a build not in releases.json is
// shown as "unknown build". A hostile build can lie, so this catches mistakes, not a determined
// attacker. The release pipeline appends to releases.json; the box ships with it.

import fs from "node:fs";

/** @type {Map<string, string> | null} */
let known = null;

/** @returns {Map<string, string>} release -> manifest sha256 hex */
function load() {
  if (known) return known;
  known = new Map();
  try {
    const j = JSON.parse(fs.readFileSync(new URL("./releases.json", import.meta.url), "utf8"));
    for (const r of Array.isArray(j.releases) ? j.releases : []) if (r && typeof r.release === "string" && typeof r.manifest === "string") known.set(r.release, r.manifest);
  } catch {}
  return known;
}

/** Whether this release and manifest hash are a build this box knows. */
export const knownBuild = (release, manifest) => Boolean(release && manifest && load().get(release) === manifest);
