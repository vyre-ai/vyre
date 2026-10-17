// check-export-names: every file of the web export has a name the release manifest accepts (relay/app/manifest.js PATH). The release job lists the export's files in a signed manifest and refuses a name outside
// that rule, so a chunk named with a new character would break the release at its last step; this fails the app's own CI the day the name appears.
//   node scripts/check-export-names.mjs <export dir>
import fs from "node:fs";
import path from "node:path";
import { PATH } from "../../../relay/app/manifest.js";

/** The files of a folder, as paths relative to it. @param {string} dir @param {string} [rel] @returns {string[]} */
export function filesOf(dir, rel = "") {
  /** @type {string[]} */ const out = [];
  for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    const p = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...filesOf(dir, p)); else out.push(p);
  }
  return out;
}

/** The names a manifest would refuse. @param {string[]} names */
export const refused = names => names.filter(n => !PATH.test(n));

if (import.meta.url === `file://${process.argv[1]}`) {
  const dir = process.argv[2];
  if (!dir || !fs.existsSync(dir)) { console.error("usage: check-export-names.mjs <export dir>"); process.exit(2); }
  const files = filesOf(dir), bad = refused(files);
  if (bad.length) { console.error(`${bad.length} file name(s) in ${dir} that relay/app/manifest.js would refuse:\n  ${bad.slice(0, 20).join("\n  ")}\nAllow the character in PATH (and its test) or rename the chunk.`); process.exit(1); }
  console.log(`${files.length} files in ${dir}: every name is one the manifest accepts`);
}
