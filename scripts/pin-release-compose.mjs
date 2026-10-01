#!/usr/bin/env node
// pin-release-compose: the released compose.yml, with literal digest lines (what the updater requires; see scripts/check-release-dist.mjs).
//   node scripts/pin-release-compose.mjs <compose.yml> <box-ref> <computer-ref>
// Every `image: ${VAR:-default}` line becomes `image: <ref>`: the box image's line (VYRE_IMAGE) takes the box ref, any other takes its own default,
// which must already be pinned by digest (a third-party image is pinned in the source). The default of VYRE_COMPUTERS_IMAGE takes the computers ref.
// A line that cannot be made literal fails the build; nothing is left as a variable a .env could replace. Rewrites the file in place.
import fs from "node:fs";

/** @param {string} text @param {string} box @param {string} computer */
export function pin(text, box, computer) {
  const DIGEST = /^ghcr\.io\/vyre-ai\/[a-z-]+@sha256:[0-9a-f]{64}$/;
  if (!DIGEST.test(box) || !DIGEST.test(computer)) throw new Error("the box and computers refs must be ghcr.io/vyre-ai/...@sha256:<64 hex>");
  let boxLines = 0;
  const out = text.split("\n").map(line => {
    const m = /^([ \t]*image:[ \t]*)\$\{([A-Z0-9_]+):-([^}]*)\}[ \t]*$/.exec(line);
    if (m) {
      if (m[2] === "VYRE_IMAGE") { boxLines++; return `${m[1]}${box}`; }
      if (!/@sha256:[0-9a-f]{64}$/.test(m[3])) throw new Error(`${m[2]}'s default (${m[3]}) is not pinned by digest in the source compose.yml`);
      return `${m[1]}${m[3]}`;
    }
    if (/^[ \t]*image:/.test(line) && /\$\{|\$[A-Z]/.test(line)) throw new Error(`cannot make this image line literal: ${line.trim()}`);
    return line.replace(/\$\{VYRE_COMPUTERS_IMAGE:-[^}]*\}/, () => `\${VYRE_COMPUTERS_IMAGE:-${computer}}`);
  }).join("\n");
  if (boxLines === 0) throw new Error("no `image: ${VYRE_IMAGE:-...}` line found to pin");
  return out;
}

if (process.argv[1] && process.argv[1].endsWith("pin-release-compose.mjs")) {
  const [file, box, computer] = process.argv.slice(2);
  if (!file || !box || !computer) { console.error("usage: node scripts/pin-release-compose.mjs <compose.yml> <box-ref> <computer-ref>"); process.exit(2); }
  try { fs.writeFileSync(file, pin(fs.readFileSync(file, "utf8"), box, computer)); } catch (e) { console.error(`pin-release-compose: ${/** @type {Error} */ (e).message}`); process.exit(1); }
}
