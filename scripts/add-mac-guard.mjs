import fs from "node:fs"; import path from "node:path"; import { execSync } from "node:child_process";
const files = execSync("git ls-files '*.test.js'", { encoding: "utf8" }).split("\n").filter(Boolean).filter(f => !/(^|\/)(fixtures|node_modules)\//.test(f));
let n = 0, skipped = [];
for (const f of files) {
  const src = fs.readFileSync(f, "utf8");
  if (src.includes("mac-test-guard.mjs")) continue;
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
