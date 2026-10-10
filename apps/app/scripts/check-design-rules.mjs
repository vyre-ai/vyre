// The design checker (R031-58, "one product, one look"): the app's own screens take their colours, type and layout from @vyre/ui and its tokens, never from literals of their own. A
// ratchet, not a wish: every file that breaks a rule today is in design-rules.baseline.json with its count, a file may only go down, and a file not in the baseline may not start.
//   node scripts/check-design-rules.mjs            exit 1 and list each file over its baseline
//   node scripts/check-design-rules.mjs --update   lower the baseline to what the code has now (never raises it)
// Rules (each counts matching lines in the app's screens, src and routes):
//   raw-colour       a colour literal ("#1a2b3c", rgb(), rgba(), hsl()): use a token colour from useUiTheme or a class from the theme
//   type-literal     fontSize, fontFamily, fontWeight, lineHeight or letterSpacing set by hand: use a Text size and weight
//   style-sheet      StyleSheet.create: a hand-built layout beside the block set and the ui primitives
//   second-primitive an import of src/ui Button, Card, Row, IconButton, Banner, Icon, Avatar, List or Tag: @vyre/ui has the one of each (A1, one mechanism per job)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const BASELINE_FILE = path.join(ROOT, "scripts", "design-rules.baseline.json");
const SCAN = ["app", "src", "screens"];

/** Files that are allowed to speak in literals, and why. A path prefix or a whole path, from the app root. */
export const EXEMPT = /** @type {[string, string][]} */ ([
  ["src/theme/", "the theme itself: fonts and type roles are defined here, once"],
  ["src/terminal/palettes.ts", "terminal colour palettes are colours by nature"],
  ["app/shots-", "the picture routes: sample worlds for the screenshots"],
  ["app/keycheck.tsx", "a diagnostic route, not a screen"],
]);

export const RULES = /** @type {{ id: string, test: (line: string) => boolean }[]} */ ([
  { id: "raw-colour", test: (l) => /["'`]#[0-9a-fA-F]{3,8}["'`]/.test(l) || /\b(rgba?|hsla?)\(/.test(l) },
  { id: "type-literal", test: (l) => /\b(fontSize|fontFamily|fontWeight|lineHeight|letterSpacing)\s*:/.test(l) },
  { id: "style-sheet", test: (l) => /\bStyleSheet\.create\b/.test(l) },
  { id: "second-primitive", test: (l) => /^\s*import\b[^;]*\bfrom\s+["'](?:\.{1,2}\/)+(?:src\/)?ui\/(Button|Card|Row|IconButton|Banner|Icon|Avatar|List|Tag)["']/.test(l) || /^\s*import\b[^;]*\bfrom\s+["']\.\/(Button|Card|Row|IconButton|Banner|Icon|Avatar|List|Tag)["']/.test(l) },
]);

const isComment = (/** @type {string} */ l) => /^\s*(\/\/|\*|\/\*)/.test(l);

/** @param {string} root @returns {Record<string, Record<string, number>>} per file (from the app root), per rule, the count of lines that break it. */
export function scan(root = ROOT) {
  /** @type {Record<string, Record<string, number>>} */
  const out = {};
  const walk = (/** @type {string} */ dir) => {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== "node_modules") walk(p); continue; }
      if (!/\.tsx?$/.test(e.name) || /\.test\.|\.d\.ts$|\.generated\./.test(e.name)) continue;
      const rel = path.relative(root, p).split(path.sep).join("/");
      if (EXEMPT.some(([x]) => rel === x || rel.startsWith(x))) continue;
      // src/ui holds the legacy primitives themselves: the rules count who uses them, not what they are made of
      if (rel.startsWith("src/ui/")) continue;
      const counts = /** @type {Record<string, number>} */ ({});
      for (const line of fs.readFileSync(p, "utf8").split("\n")) {
        if (isComment(line)) continue;
        for (const r of RULES) if (r.test(line)) counts[r.id] = (counts[r.id] || 0) + 1;
      }
      if (Object.keys(counts).length) out[rel] = counts;
    }
  };
  for (const d of SCAN) walk(path.join(root, d));
  return out;
}

/** @param {Record<string, Record<string, number>>} found @param {Record<string, Record<string, number>>} baseline */
export function problems(found, baseline) {
  /** @type {string[]} */ const bad = [];
  for (const [file, counts] of Object.entries(found)) {
    for (const [rule, n] of Object.entries(counts)) {
      const allowed = baseline[file]?.[rule] ?? 0;
      if (n > allowed) bad.push(`${file}: ${rule} ${n}${allowed ? ` (was ${allowed})` : " (new)"}`);
    }
  }
  return bad;
}

/** Baseline entries the code has outgrown (fixed or gone): the list only shrinks, so these are named until the baseline is lowered with --update. */
export function stale(found, baseline) {
  /** @type {string[]} */ const out = [];
  for (const [file, counts] of Object.entries(baseline)) for (const [rule, n] of Object.entries(counts)) if ((found[file]?.[rule] ?? 0) < n) out.push(`${file}: ${rule} ${n} -> ${found[file]?.[rule] ?? 0}`);
  return out;
}

export const readBaseline = () => (fs.existsSync(BASELINE_FILE) ? JSON.parse(fs.readFileSync(BASELINE_FILE, "utf8")) : {});

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const found = scan();
  const baseline = readBaseline();
  if (process.argv.includes("--update")) {
    /** @type {Record<string, Record<string, number>>} */ const next = {};
    for (const [file, counts] of Object.entries(found)) for (const [rule, n] of Object.entries(counts)) {
      const keep = Math.min(n, baseline[file]?.[rule] ?? n);
      (next[file] ||= {})[rule] = keep;
    }
    fs.writeFileSync(BASELINE_FILE, JSON.stringify(Object.fromEntries(Object.entries(next).sort(([a], [b]) => a.localeCompare(b))), null, 1) + "\n");
    const total = Object.values(next).reduce((s, c) => s + Object.values(c).reduce((a, b) => a + b, 0), 0);
    console.log(`design rules: baseline written, ${Object.keys(next).length} files, ${total} lines`);
  } else {
    const bad = problems(found, baseline);
    const old = stale(found, baseline);
    if (old.length) console.log(`design rules: ${old.length} entries can go down (run with --update):\n  ${old.join("\n  ")}`);
    if (bad.length) { console.error(`design rules: over the baseline:\n  ${bad.join("\n  ")}\nUse @vyre/ui and its tokens (see the rule list at the top of this file), not a literal.`); process.exit(1); }
    console.log("design rules: clean");
  }
}
