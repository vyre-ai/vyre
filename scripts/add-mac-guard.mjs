import fs from "node:fs"; import path from "node:path"; import { execSync } from "node:child_process";
const files = execSync("git ls-files '*.test.js'", { encoding: "utf8" }).split("\n").filter(Boolean).filter(f => !/(^|\/)(fixtures|node_modules)\//.test(f));
let n = 0, skipped = [];
for (const f of files) {
  let src = fs.readFileSync(f, "utf8");
  // already first: nothing to do; present but not first (another import landed above it in a merge): take it out and put it first
  const has = /^import\s+["'][./]+\/(?:scripts\/)?mac-test-guard\.mjs["'];?\s*$/m;
  if (has.test(src)) {
    const lines0 = src.split("\n"); let j = 0, blk = false;
    for (; j < lines0.length; j++) { const t = lines0[j].trim(); if (blk) { if (t.includes("*/")) blk = false; continue; } if (t === "" || t.startsWith("//") || t.startsWith("#!")) continue; if (t.startsWith("/*")) { if (!t.includes("*/")) blk = true; continue; } if (/^["']use strict["'];?$/.test(t)) continue; break; }
    if (has.test(lines0[j] || "")) continue;
    src = src.replace(new RegExp(has.source + "\\n?", "m"), "");
  }
  const rel = path.relative(path.dirname(f), "scripts/mac-test-guard.mjs").split(path.sep).join("/");
  const imp = `import "${rel.startsWith(".") ? rel : "./" + rel}";`;
  const lines = src.split("\n"); let i = 0, inBlock = false;
  for (; i < lines.length; i++) {
    const t = lines[i].trim();
    if (inBlock) { if (t.includes("*/")) inBlock = false; continue; }
    if (t === "" || t.startsWith("//") || t.startsWith("#!")) continue;
    if (t.startsWith("/*")) { if (!t.includes("*/")) inBlock = true; continue; }
    if (/^["']use strict["'];?$/.test(t)) continue;
    break;
  }
  if (i >= lines.length) { skipped.push(f); continue; }
  lines.splice(i, 0, imp); fs.writeFileSync(f, lines.join("\n")); n++;
}
console.log("edited", n, "skipped", skipped);
