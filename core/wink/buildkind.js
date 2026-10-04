// @ts-check
// buildkind: is this a RELEASE build? It follows the build KIND the one place that stamps it says (lib/build-kind.js: "development" in a checkout and in a dev-kind image built from one, "release" in the
// signed package), the same word vault's dev check reads (BUILD_KIND !== "development"). It is NOT "is this a packaged image": a dev-kind image built from a checkout is exactly what the walks, the packaged-boot
// proof and a first walk run on, and its software prover is accepted. With a `root` (tests) the kind is read from that folder's lib/build-kind.js text, so a fixture can be either kind.
import fs from "node:fs";
import path from "node:path";
import { BUILD_KIND } from "../../lib/build-kind.js";
import { DEV_LINE } from "../../lib/build-kind-text.js";

/** @param {string} [root] @returns {boolean} true only for a release-stamped build */
export function isReleaseBuild(root) {
  if (root === undefined) return BUILD_KIND !== "development";
  try { return !fs.readFileSync(path.join(root, "lib", "build-kind.js"), "utf8").includes(DEV_LINE); } catch { return true; }
}

/** A developer switch honoured only when the build kind is development (never in a release build). @param {string | undefined} value @param {string} [root] */
export const devKindSwitch = (value, root) => value === "1" && !isReleaseBuild(root);
