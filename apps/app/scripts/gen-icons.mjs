// The app's icon drawings, from the one icon source every surface reads
// (docs/design/one-app/icons.txt), into src/ui/icons.generated.ts. A line of the set is a
// lowercase name, then the SVG child elements that draw it; every other line (the notes, the Vyre
// mark) is skipped.
//
//   node scripts/gen-icons.mjs            write src/ui/icons.generated.ts
//   node scripts/gen-icons.mjs --check    exit 1 if the file would change

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const HEADER = "// generated from docs/design/one-app/icons.txt by apps/app/scripts/gen-icons.mjs; do not edit";

/** The elements a drawing may use, and each one's attributes (in the order they are written out). */
const TAGS = {
  path: ["d"],
  circle: ["cx", "cy", "r"],
  rect: ["x", "y", "width", "height", "rx"],
  line: ["x1", "y1", "x2", "y2"],
  polyline: ["points"],
};
const TEXT = new Set(["d", "points"]);
const LINE = /^([a-z][a-z0-9-]*)\s+(<.+)$/;
const ELEMENT = /<([a-z]+)((?:\s+[a-z][a-z0-9-]*="[^"]*")*)\s*(?:\/>|><\/\1>)/g;
const ATTR = /([a-z][a-z0-9-]*)="([^"]*)"/g;

/**
 * The set, in its order: [name, elements] where an element is {el, ...attributes}, numbers as
 * numbers and path data as written. Throws on an unknown element or attribute, a duplicate name,
 * or anything on a line that is not an element. Pure.
 * @param {string} text
 * @returns {[string, Record<string, string | number>[]][]}
 */
export function parseIcons(text) {
  /** @type {[string, Record<string, string | number>[]][]} */
  const out = [];
  const seen = new Set();
  for (const raw of text.split(/\r?\n/)) {
    const m = LINE.exec(raw.trim());
    if (!m) continue;
    const [, name, body] = m;
    if (seen.has(name)) throw new Error(`icons.txt: ${name} is listed twice`);
    seen.add(name);
    const els = [];
    let rest = body;
    for (const e of body.matchAll(ELEMENT)) {
      const [whole, tag, attrs] = e;
      const allowed = TAGS[/** @type {keyof typeof TAGS} */ (tag)];
      if (!allowed) throw new Error(`icons.txt: ${name} uses <${tag}>, not one of ${Object.keys(TAGS).join(", ")}`);
      /** @type {Record<string, string | number>} */
      const el = { el: tag };
      for (const [, k, v] of attrs.matchAll(ATTR)) {
        if (!allowed.includes(k)) throw new Error(`icons.txt: ${name} gives <${tag}> a ${k}`);
        el[k] = TEXT.has(k) ? v : Number(v);
      }
      for (const k of allowed) if (k !== "rx" && !(k in el)) throw new Error(`icons.txt: ${name}'s <${tag}> has no ${k}`);
      els.push(el);
      rest = rest.replace(whole, "");
    }
    if (rest.trim() || !els.length) throw new Error(`icons.txt: ${name} has something that is not an element: ${rest.trim() || "(empty)"}`);
    out.push([name, els]);
  }
  return out;
}

/** One element as a TypeScript object literal, attributes in the element's order. */
function literal(/** @type {Record<string, string | number>} */ el) {
  const keys = ["el", ...TAGS[/** @type {keyof typeof TAGS} */ (el.el)].filter((k) => k in el)];
  return `{ ${keys.map((k) => `${k}: ${typeof el[k] === "number" ? el[k] : JSON.stringify(el[k])}`).join(", ")} }`;
}

/**
 * The generated module's text. Pure.
 * @param {[string, Record<string, string | number>[]][]} icons
 */
export function renderIcons(icons) {
  const key = (/** @type {string} */ n) => (/^[a-z]+$/.test(n) ? n : JSON.stringify(n));
  return [
    HEADER,
    "",
    "/** One element of a drawing on the 16 grid: its SVG tag and attributes, as icons.txt writes them. */",
    "export type IconElement =",
    '  | { el: "path"; d: string }',
    '  | { el: "circle"; cx: number; cy: number; r: number }',
    '  | { el: "rect"; x: number; y: number; width: number; height: number; rx?: number }',
    '  | { el: "line"; x1: number; y1: number; x2: number; y2: number }',
    '  | { el: "polyline"; points: string };',
    "",
    "export type IconName =",
    ...icons.map(([n], i) => `  | ${JSON.stringify(n)}${i === icons.length - 1 ? ";" : ""}`),
    "",
    "export const ICONS: Record<IconName, readonly IconElement[]> = {",
    ...icons.map(([n, els]) => `  ${key(n)}: [${els.map(literal).join(", ")}],`),
    "};",
    "",
  ].join("\n");
}

/** --check: the file on disk (null when missing) differs from what would be written. Pure. */
export function isStale(/** @type {string | null} */ current, /** @type {string} */ next) {
  return current !== next;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const src = path.resolve(here, "..", "..", "..", "docs", "design", "one-app", "icons.txt");
  const dest = path.resolve(here, "..", "src", "ui", "icons.generated.ts");
  const next = renderIcons(parseIcons(readFileSync(src, "utf8")));
  const current = existsSync(dest) ? readFileSync(dest, "utf8") : null;
  if (process.argv.includes("--check")) {
    if (isStale(current, next)) {
      console.error("src/ui/icons.generated.ts is out of date with icons.txt: run npm run icons");
      process.exit(1);
    }
    console.log("icons: up to date");
  } else if (isStale(current, next)) {
    writeFileSync(dest, next);
    console.log(`icons: wrote ${path.relative(process.cwd(), dest)}`);
  } else console.log("icons: up to date");
}
