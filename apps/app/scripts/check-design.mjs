// The one-look rule: a screen is made of blocks and tokens, so no screen carries a colour, a type size, a spacing number or a hand-made style sheet of its own.
// ui/ (the design system) and the token files are where those numbers live; everything else says "primary", "gap-s3", <Text size="caption">.
//   node scripts/check-design.mjs            exit 1 and list each place that is over its allowance
//   node scripts/check-design.mjs --write    lower the allowance to what the code now has (never raises it)
//   node scripts/check-design.mjs --init     write the first allowance (only when design-baseline.json does not exist yet)
// The allowance (design-baseline.json) is what the code carried when this check began. It can only go down: a file over it fails, and so does a file under it, until the
// allowance is lowered with --write, so a cleaned file stays clean. A line that must carry a raw value says why with `design-ok: <reason>` on that line or the one above.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASELINE = path.join(ROOT, "scripts", "design-baseline.json");
const SCAN = ["app", "src", "screens"];
/** Where the numbers legitimately live, relative to apps/app. */
const SKIP = [/(^|\/)node_modules\//, /\.test\.[mc]?[jt]sx?$/, /\.generated\./, /^src\/theme\//, /^src\/terminal\/palettes\.ts$/, /^app\/(shots-screens|keycheck)\.tsx$/];

/** One rule per kind of thing a screen must take from the system. */
export const RULES = {
  colour: { re: /["'`(\s,]#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})\b|\b(?:rgba?|hsla?)\(/, why: "a raw colour; use a colour token (a class such as bg-surface-2 or a tone prop)" },
  type: { re: /\b(?:fontSize|lineHeight|letterSpacing)\s*:\s*\d/, why: "a raw type size; use <Text size=...>" },
  space: { re: /\b(?:padding|margin|gap|rowGap|columnGap)(?:Top|Bottom|Left|Right|Horizontal|Vertical|Start|End)?\s*:\s*\d|\bborderRadius\s*:\s*\d/, why: "a raw spacing or radius number; use gap-s*, p-s* and rounded-* classes" },
  arbitrary: { re: /\b[a-z][a-z-]*-\[[^\]\s]*(?:px|rem|em|#)[^\]\s]*\]/, why: "an arbitrary value in a class; use a token class" },
  sheet: { re: /\bStyleSheet\.create\s*\(/, why: "a hand-made style sheet; build the screen from blocks and ui/ components" },
};

/** The rules a piece of source breaks, counted. @param {string} text @returns {Record<string, number>} */
export function scan(text) {
  /** @type {Record<string, number>} */ const out = {};
  const lines = text.split("\n");
  lines.forEach((line, i) => {
    const t = line.trim();
    if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) return;
    if (/design-ok:/.test(line) || /design-ok:/.test(lines[i - 1] ?? "")) return;
    for (const [name, r] of Object.entries(RULES)) if (r.re.test(line)) out[name] = (out[name] ?? 0) + 1;
  });
  return out;
}

/** Every scanned file's counts. @returns {Record<string, Record<string, number>>} */
export function measure(root = ROOT) {
  /** @type {Record<string, Record<string, number>>} */ const out = {};
  const walk = (/** @type {string} */ dir) => {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      const rel = path.relative(root, p).split(path.sep).join("/");
      if (SKIP.some((re) => re.test(rel + (e.isDirectory() ? "/" : "")))) continue;
      if (e.isDirectory()) { walk(p); continue; }
      if (!/\.(tsx?|jsx?)$/.test(e.name)) continue;
      const c = scan(fs.readFileSync(p, "utf8"));
      if (Object.keys(c).length) out[rel] = c;
    }
  };
  for (const d of SCAN) walk(path.join(root, d));
  return out;
}

/** Compare what the code has with the allowance. @param {Record<string, Record<string, number>>} now @param {Record<string, Record<string, number>>} allowed */
export function problems(now, allowed) {
  /** @type {string[]} */ const out = [];
  const files = new Set([...Object.keys(now), ...Object.keys(allowed)]);
  for (const f of [...files].sort()) for (const rule of Object.keys(RULES)) {
    const have = now[f]?.[rule] ?? 0, may = allowed[f]?.[rule] ?? 0;
    if (have > may) out.push(`${f}: ${have} x ${rule} (allowed ${may}): ${RULES[/** @type {keyof typeof RULES} */ (rule)].why}. Use the token or block, or mark the line \`design-ok: <reason>\`.`);
    else if (have < may) out.push(`${f}: ${rule} is down to ${have} (allowance ${may}): run \`node scripts/check-design.mjs --write\` to lock the gain in.`);
  }
  return out;
}

export const readBaseline = () => (fs.existsSync(BASELINE) ? JSON.parse(fs.readFileSync(BASELINE, "utf8")) : {});
const sorted = (/** @type {Record<string, Record<string, number>>} */ o) => Object.fromEntries(Object.keys(o).sort().map((k) => [k, Object.fromEntries(Object.keys(o[k]).sort().map((r) => [r, o[k][r]]))]));

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const now = measure();
  if (process.argv.includes("--init")) {
    if (fs.existsSync(BASELINE)) { console.error("design-baseline.json exists; use --write to lower it"); process.exit(2); }
    fs.writeFileSync(BASELINE, JSON.stringify(sorted(now), null, 2) + "\n"); console.log(`wrote ${Object.keys(now).length} files`); process.exit(0);
  }
  const allowed = readBaseline();
  if (process.argv.includes("--write")) {
    const lowered = problems(now, allowed).filter((p) => p.includes("is down to") || p.includes("--write")).length;
    /** @type {Record<string, Record<string, number>>} */ const next = {};
    for (const f of Object.keys(allowed)) for (const r of Object.keys(allowed[f])) { const v = Math.min(allowed[f][r], now[f]?.[r] ?? 0); if (v) (next[f] ??= {})[r] = v; }
    fs.writeFileSync(BASELINE, JSON.stringify(sorted(next), null, 2) + "\n"); console.log(`lowered ${lowered} entries`); process.exit(0);
  }
  const bad = problems(now, allowed);
  for (const b of bad) console.log(b);
  process.exit(bad.length ? 1 : 0);
}
