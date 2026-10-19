// check-release-routes: the release web export holds no sample-world or proof page. metro.config.js leaves those pages out of a real build; this reads the finished export and fails if one got in (a chunk named
// after the page, or the router's file map naming it), so a changed config or a new page cannot slip a demo into a release.
//   node scripts/check-release-routes.mjs <export dir>
import fs from "node:fs";
import path from "node:path";
import { MOCK_ONLY, PROOF_OR_MOCK } from "./sample-routes.js";

/** A pattern for each blocked page as the export spells it: its chunk file name starts with the last part of the path, and the router's file map has "./<path>.tsx". */
const names = [...MOCK_ONLY, ...PROOF_OR_MOCK];
const escapeRe = (/** @type {string} */ s) => s.replace(/[.*+?^${}()|\\]/g, "\\$&");
const pat = (/** @type {string} */ n) => n.split("/").map((part) => part.replace(/\[a-z\]\+/g, "\u0000").split("\u0000").map(escapeRe).join("[a-z]+")).join("/");

/** The blocked pages found in an export. @param {string[]} files paths relative to the export @param {(file: string) => string} read the text of a file @returns {string[]} */
export function leaks(files, read) {
  const found = new Set();
  for (const n of names) {
    const last = pat(n.split("/").pop() ?? n);
    const chunk = new RegExp(`(^|/)${last}-[0-9a-f]{6,}\\.(js|css|html)$`);
    const html = new RegExp(`(^|/)${pat(n)}\\.html$`);
    const map = new RegExp(`["'./]${pat(n)}\\.tsx["']`);
    for (const f of files) {
      if (chunk.test(f) || html.test(f)) found.add(`${n} (file ${f})`);
      else if (/\.js$/.test(f) && map.test(read(f))) found.add(`${n} (named in ${f})`);
    }
  }
  return [...found];
}

/** @param {string} dir @param {string} [rel] @returns {string[]} */
function filesOf(dir, rel = "") {
  /** @type {string[]} */ const out = [];
  for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    const p = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...filesOf(dir, p)); else out.push(p);
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dir = process.argv[2];
  if (!dir || !fs.existsSync(dir)) { console.error("usage: check-release-routes.mjs <export dir>"); process.exit(2); }
  const files = filesOf(dir);
  const bad = leaks(files, (f) => fs.readFileSync(path.join(dir, f), "utf8"));
  if (bad.length) { console.error(`${bad.length} sample-world or proof page(s) in the release export ${dir}:\n  ${bad.join("\n  ")}\nmetro.config.js should have left them out (scripts/sample-routes.js lists them).`); process.exit(1); }
  console.log(`${files.length} files in ${dir}: none of the ${names.length} sample-world or proof pages is in it`);
}
