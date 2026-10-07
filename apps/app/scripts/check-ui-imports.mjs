// The one-UI-library rule: only ui/ (@vyre/ui) may import a UI library. Screens and the rest of the app take components from "@vyre/ui".
//   node scripts/check-ui-imports.mjs     exit 1 and list each offending import
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const BANNED = [/^@rn-primitives\//, /^@tanstack\//, /^@dnd-kit\//, /^class-variance-authority$/, /^tailwind-merge$/, /^clsx$/, /^nativewind(\/|$)/, /^react-native-reusables(\/|$)/, /^@radix-ui\//, /^lucide-react/];
const SCAN = ["app", "src", "screens"];
const IMPORT = /(?:import\s[^'"]*?from\s*|import\s*|require\(\s*|import\(\s*)['"]([^'"]+)['"]/g;

/** @returns {{ file: string, spec: string }[]} */
export function offenders(root = ROOT) {
  const out = [];
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== "node_modules") walk(p); continue; }
      if (!/\.(tsx?|jsx?|mjs)$/.test(e.name) || /\.test\.js$/.test(e.name)) continue;
      const text = fs.readFileSync(p, "utf8");
      for (const m of text.matchAll(IMPORT)) if (BANNED.some((re) => re.test(m[1]))) out.push({ file: path.relative(root, p), spec: m[1] });
    }
  };
  for (const d of SCAN) walk(path.join(root, d));
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const bad = offenders();
  for (const b of bad) console.log(`${b.file}: imports ${b.spec}; take it from @vyre/ui`);
  process.exit(bad.length ? 1 : 0);
}
