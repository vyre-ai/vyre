// The app's icon drawings, from the one 24-grid family (team/0.3/assets/icons: 95 icons, stroke 1.6, round caps and joins, currentColor) in
// src/ui/icons.source.json, into src/ui/icons.generated.ts: a typed IconName union plus the element data both Icon components draw with
// react-native-svg. Every name the earlier 16-grid set had still works through ALIASES (chev-r is chevron, faceid is face).
//
//   node scripts/gen-ui-icons.mjs            write src/ui/icons.generated.ts
//   node scripts/gen-ui-icons.mjs --check    exit 1 if the file would change

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const HEADER = "// generated from src/ui/icons.source.json by apps/app/scripts/gen-ui-icons.mjs; do not edit";
export const GRID = 24;

/** The old 16-grid names, each mapped to the drawing that replaces it. */
export const ALIASES = {
  "chev-r": "chevron", "chev-l": "chevron-left", "chev-d": "chevron-down", planner: "cal", failed: "error", terminal: "term", faceid: "face",
  "wifi-off": "offline", alarm: "bell", todo: "task", box: "kits",
};

const TAGS = { path: ["d"], circle: ["cx", "cy", "r"], rect: ["x", "y", "width", "height", "rx"], ellipse: ["cx", "cy", "rx", "ry"] };
const ELEMENT = /<([a-z]+)((?:\s+[a-z][a-z0-9-]*="[^"]*")*)\s*\/>/g;
const ATTR = /([a-z][a-z0-9-]*)="([^"]*)"/g;

/** One drawing's fragment as elements, numbers as numbers. Throws on an unknown element or attribute, or anything that is not an element. Pure. */
export function parseFragment(name, body) {
  const els = [];
  let rest = body;
  for (const e of body.matchAll(ELEMENT)) {
    const [whole, tag, attrs] = e;
    const allowed = TAGS[tag];
    if (!allowed) throw new Error(`${name} uses <${tag}>, not one of ${Object.keys(TAGS).join(", ")}`);
    const el = { el: tag };
    for (const [, k, v] of attrs.matchAll(ATTR)) {
      if (!allowed.includes(k)) throw new Error(`${name} gives <${tag}> a ${k}`);
      el[k] = k === "d" ? v : Number(v);
    }
    for (const k of allowed) if (k !== "rx" && !(k in el)) throw new Error(`${name}'s <${tag}> has no ${k}`);
    els.push(el);
    rest = rest.replace(whole, "");
  }
  if (rest.trim() || !els.length) throw new Error(`${name} has something that is not an element: ${rest.trim() || "(empty)"}`);
  return els;
}

/** The set as [name, elements][] in name order. Pure. */
export function parseSet(json) {
  return Object.keys(json).sort().map((n) => [n, parseFragment(n, json[n])]);
}

const key = (n) => (/^[a-z]+$/.test(n) ? n : JSON.stringify(n));
function literal(el) {
  const keys = ["el", ...TAGS[el.el].filter((k) => k in el)];
  return `{ ${keys.map((k) => `${k}: ${typeof el[k] === "number" ? el[k] : JSON.stringify(el[k])}`).join(", ")} }`;
}

/** The generated module's text. Pure. */
export function renderIcons(icons, aliases = ALIASES) {
  const names = new Set(icons.map(([n]) => n));
  for (const [a, t] of Object.entries(aliases)) {
    if (!names.has(t)) throw new Error(`alias ${a} points at ${t}, which is not in the set`);
    if (names.has(a)) throw new Error(`alias ${a} is also a drawing`);
  }
  const all = [...icons.map(([n]) => n), ...Object.keys(aliases)];
  return [
    HEADER,
    "",
    `/** The grid every drawing is on. */`,
    `export const ICON_GRID = ${GRID};`,
    "",
    "/** One element of a drawing on the 24 grid: its SVG tag and attributes. */",
    "export type IconElement =",
    '  | { el: "path"; d: string }',
    '  | { el: "circle"; cx: number; cy: number; r: number }',
    '  | { el: "rect"; x: number; y: number; width: number; height: number; rx?: number }',
    '  | { el: "ellipse"; cx: number; cy: number; rx: number; ry: number };',
    "",
    "export type IconName =",
    ...all.map((n, i) => `  | ${JSON.stringify(n)}${i === all.length - 1 ? ";" : ""}`),
    "",
    "const SET = {",
    ...icons.map(([n, els]) => `  ${key(n)}: [${els.map(literal).join(", ")}],`),
    "} as const satisfies Record<string, readonly IconElement[]>;",
    "",
    "export const ICONS: Record<IconName, readonly IconElement[]> = {",
    "  ...SET,",
    ...Object.entries(aliases).map(([a, t]) => `  ${key(a)}: SET[${JSON.stringify(t)}],`),
    "};",
    "",
  ].join("\n");
}

export function isStale(current, next) {
  return current !== next;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const src = path.resolve(here, "..", "src", "ui", "icons.source.json");
  const dest = path.resolve(here, "..", "src", "ui", "icons.generated.ts");
  const next = renderIcons(parseSet(JSON.parse(readFileSync(src, "utf8"))));
  const current = existsSync(dest) ? readFileSync(dest, "utf8") : null;
  if (process.argv.includes("--check")) {
    if (isStale(current, next)) {
      console.error("src/ui/icons.generated.ts is out of date with icons.source.json: run npm run icons");
      process.exit(1);
    }
    console.log("icons: up to date");
  } else if (isStale(current, next)) {
    writeFileSync(dest, next);
    console.log(`icons: wrote ${path.relative(process.cwd(), dest)}`);
  } else console.log("icons: up to date");
}
