// @ts-check
// The release gate for the signing key (ADR 0040 section 5). The site build and the release script
// run this and stop if a release would ship with a key nobody vouched for:
//   - RELEASE_KEY in core/vyre-core/release.js is still the placeholder, or
//   - the RELEASE_KEY line in scripts/install-mac-server.sh is not the same value (the install
//     script verifies the first install against its own copy).
// VYRE_ALLOW_PLACEHOLDER_KEY=1 lets a dry run (CI that publishes nothing) through; release.sh never
// passes it on.
//
//   node scripts/check-release-key.mjs [ROOT]

import fs from "node:fs";
import path from "node:path";

export const PLACEHOLDER = "MCowBQYDK2VwAyEAfFTFccqQNhkHQ3II6EniEoRfWgDDDjQn+GKEJZQIHoE=";

/** @param {string} root @returns {string[]} what is wrong, empty when the key is fit to ship */
export function keyProblems(root) {
  const out = [];
  const rel = /export const RELEASE_KEY = "([^"]+)"/.exec(fs.readFileSync(path.join(root, "core", "vyre-core", "release.js"), "utf8"))?.[1];
  const scr = /^RELEASE_KEY=(.*)$/m.exec(fs.readFileSync(path.join(root, "scripts", "install-mac-server.sh"), "utf8"))?.[1];
  // The box wrapper pins the same key (the updater on every Linux box), as a default in its seams block.
  const box = /^RELEASE_KEY=\$\{VYRE_RELEASE_KEY:-([^}]+)\}$/m.exec(fs.readFileSync(path.join(root, "box", "vyre"), "utf8"))?.[1];
  // The Windows install script pins the same key (the first install verifies the signature itself).
  const winPath = path.join(root, "scripts", "install-windows.ps1");
  if (fs.existsSync(winPath)) {
    const win = /\$ReleaseKey = if \(\$env:VYRE_RELEASE_KEY\) \{ \$env:VYRE_RELEASE_KEY \} else \{ "([^"]+)" \}/.exec(fs.readFileSync(winPath, "utf8"))?.[1];
    if (!win) out.push("scripts/install-windows.ps1 has no pinned $ReleaseKey");
    else if (rel && win !== rel) out.push("$ReleaseKey in scripts/install-windows.ps1 differs from core/vyre-core/release.js");
  }
  if (!box) out.push("box/vyre has no pinned RELEASE_KEY");
  else if (rel && box !== rel) out.push("RELEASE_KEY in box/vyre differs from core/vyre-core/release.js");
  if (!rel) out.push("core/vyre-core/release.js has no RELEASE_KEY");
  else if (rel === PLACEHOLDER) out.push("RELEASE_KEY in core/vyre-core/release.js is still the placeholder: a release signed by nobody's real key would install on Macs");
  if (!scr) out.push("scripts/install-mac-server.sh has no RELEASE_KEY line");
  else if (rel && scr !== rel) out.push("RELEASE_KEY in scripts/install-mac-server.sh differs from core/vyre-core/release.js");
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const root = path.resolve(process.argv[2] || ".");
  const problems = keyProblems(root);
  if (problems.length && process.env.VYRE_ALLOW_PLACEHOLDER_KEY === "1") {
    console.error(`check-release-key: ${problems.join("; ")} (allowed for this dry run)`);
  } else if (problems.length) {
    console.error(`check-release-key: ${problems.join("\n  ")}\n  set the real release key (lead) before publishing`);
    process.exit(1);
  }
}
