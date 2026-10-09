// @ts-check
// The guarded CSS escape hatch (0.3.1, R031-61). A screen or the space may carry a little custom CSS, written by the Engineer, approved by the owner, and held to rules a linter can check:
//   - selectors reach only the design language's own hooks: [data-screen="id"] and [data-block="key"] (and what is inside them), never the page, a form or a button by itself
//   - properties come from a short list that styles and never hides, moves or re-lays-out; every colour, space, radius and size is a design token, var(--name), never a value
//   - no @import, url(), expression, escapes or !important; @media only for width and colour scheme
// Re-checked on every start and update (verify): CSS that no longer passes, or names a token that went away, is turned off with the reason, and the screen draws as if it were not there.
import crypto from "node:crypto";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const TOKENS_FILE = fileURLToPath(new URL("../theme/tokens.json", import.meta.url));

/** The custom properties a style may name: the colour roles of the shipped tokens, the accent roles, the space, radius and type steps. */
export function tokenNames() {
  const t = JSON.parse(fs.readFileSync(TOKENS_FILE, "utf8"));
  const kebab = (/** @type {string} */ s) => s.replace(/[A-Z0-9]/g, c => "-" + c.toLowerCase());
  const names = new Set(Object.keys(t.v2.color.dark).map(k => "--" + kebab(k)));
  for (const n of ["--accent", "--accent-ink", "--accent-wash", "--tint"]) names.add(n);
  for (const n of t.v3.spaceSteps) names.add(`--s-${n}`);
  for (const k of t.v3.corners.applies) names.add(`--r-${k}`);
  names.add("--r-full");
  for (const r of ["caption", "secondary", "body", "headline", "control", "read", "title", "page", "display", "micro"]) { names.add(`--fs-${r}`); names.add(`--lh-${r}`); }
  return names;
}

/** A short hash of the token names: CSS verified against one version is re-checked when it changes. */
export const tokensVersion = (names = tokenNames()) => crypto.createHash("sha256").update([...names].sort().join(",")).digest("hex").slice(0, 12);

const COLOR_PROPS = new Set(["color", "background-color", "border-color", "outline-color"]);
const SPACE_PROPS = new Set(["padding", "padding-top", "padding-right", "padding-bottom", "padding-left", "margin", "margin-top", "margin-right", "margin-bottom", "margin-left", "gap", "row-gap", "column-gap"]);
const RADIUS_PROPS = new Set(["border-radius", "border-top-left-radius", "border-top-right-radius", "border-bottom-left-radius", "border-bottom-right-radius"]);
const ENUM_PROPS = /** @type {Record<string, string[]>} */ ({
  "font-weight": ["400", "500", "600"], "text-transform": ["none", "uppercase", "capitalize"], "text-align": ["left", "center", "right"], "border-style": ["solid", "none"], "border-width": ["0", "1px"], "box-shadow": ["none"], "text-decoration": ["none", "underline"],
});
const SIZE_PROPS = new Set(["font-size", "line-height", "letter-spacing"]);

/** `var(--name)` or `var(--name, var(--other))` where every name is a token. @param {string} v @param {Set<string>} names */
function tokenValue(v, names) {
  const m = /^var\((--[a-z0-9-]+)\)$/.exec(v.trim());
  return Boolean(m && names.has(m[1]));
}
/** @param {string} v @param {Set<string>} names @returns {string[]} the `--tokens` a value names that do not exist */
const unknownTokens = (v, names) => [...v.matchAll(/var\((--[a-z0-9-]+)/g)].map(m => m[1]).filter(n => !names.has(n));

const HOOK = /^\[data-(screen|block)="[a-z0-9-]{1,31}"\]$/;
const PART = /^(\[data-block="[a-z0-9]{1,24}"\]|div|span|img|\*)$/;

/**
 * Check a stylesheet.
 * @param {string} css @param {{ scope: string, names?: Set<string>, maxBytes?: number }} o scope: "space" or "screen:<id>"
 * @returns {{ ok: boolean, problems: string[] }}
 */
export function lintCss(css, { scope, names = tokenNames(), maxBytes = 8 * 1024 }) {
  /** @type {string[]} */ const problems = [];
  const text = String(css);
  if (Buffer.byteLength(text) > maxBytes) return { ok: false, problems: [`the stylesheet is larger than ${maxBytes / 1024} KB`] };
  if (/\\/.test(text)) problems.push("no backslash escapes");
  if (/@import|url\(|expression\(|javascript:|behavior|-moz-binding|!\s*important|</i.test(text)) problems.push("no @import, url(), expression, !important or markup");
  const clean = text.replace(/\/\*[\s\S]*?\*\//g, "");
  const screenId = scope.startsWith("screen:") ? scope.slice(7) : "";
  let i = 0, depth = 0;
  const stack = /** @type {string[]} */ ([]);
  while (i < clean.length) {
    const open = clean.indexOf("{", i), close = clean.indexOf("}", i);
    if (open === -1 && close === -1) { if (clean.slice(i).trim()) problems.push("text outside a rule"); break; }
    if (open !== -1 && (close === -1 || open < close)) {
      const head = clean.slice(i, open).trim();
      i = open + 1;
      if (head.startsWith("@")) {
        if (depth !== 0 || !/^@media\s*\((max-width|min-width):\s*\d{2,4}px\)$|^@media\s*\(prefers-color-scheme:\s*(dark|light)\)$/.test(head)) problems.push(`${head.slice(0, 40)}: only @media on width or colour scheme`);
        stack.push("media"); depth++;
        continue;
      }
      const selectors = head.split(",").map(s => s.trim());
      for (const sel of selectors) {
        const parts = sel.replace(/(:hover|:focus-visible)\s*$/, "").trim().split(/\s+/);
        const [hook, ...rest] = parts;
        const hm = HOOK.exec(hook || "");
        if (!hm) problems.push(`selector "${sel.slice(0, 50)}": start with [data-screen="id"] or [data-block="key"]`);
        else if (screenId && hook !== `[data-screen="${screenId}"]`) problems.push(`selector "${sel.slice(0, 50)}": a screen's styling starts at [data-screen="${screenId}"]`);
        for (const p of rest) if (!PART.test(p)) problems.push(`selector "${sel.slice(0, 50)}": "${p}" is not an allowed part (a block hook, a tag or *)`);
        if (rest.length > 4) problems.push(`selector "${sel.slice(0, 50)}": up to four levels`);
      }
      stack.push("rule"); depth++;
      const bodyEnd = clean.indexOf("}", i);
      if (bodyEnd === -1) { problems.push("a rule is not closed"); break; }
      const body = clean.slice(i, bodyEnd);
      i = bodyEnd + 1; depth--; stack.pop();
      for (const decl of body.split(";").map(d => d.trim()).filter(Boolean)) {
        const k = decl.indexOf(":");
        if (k < 1) { problems.push(`"${decl.slice(0, 40)}" is not a declaration`); continue; }
        const prop = decl.slice(0, k).trim().toLowerCase(), value = decl.slice(k + 1).trim();
        if (COLOR_PROPS.has(prop) || RADIUS_PROPS.has(prop) || SIZE_PROPS.has(prop) || SPACE_PROPS.has(prop)) {
          const parts = value.split(/\s+/);
          const okPart = (/** @type {string} */ p) => tokenValue(p, names) || (SPACE_PROPS.has(prop) || RADIUS_PROPS.has(prop)) && p === "0";
          if (parts.length > 4 || !parts.every(okPart)) problems.push(`${prop}: use design tokens, like var(--${COLOR_PROPS.has(prop) ? "accent" : SIZE_PROPS.has(prop) ? "fs-body" : RADIUS_PROPS.has(prop) ? "r-card" : "s-3"}); got "${value.slice(0, 30)}"`);
          for (const u of unknownTokens(value, names)) problems.push(`${prop}: ${u} is not a token`);
        } else if (prop === "opacity") {
          const n = Number(value);
          if (!Number.isFinite(n) || n < 0.6 || n > 1) problems.push("opacity: from 0.6 to 1 (a style may soften, never hide)");
        } else if (ENUM_PROPS[prop]) {
          if (!ENUM_PROPS[prop].includes(value)) problems.push(`${prop}: one of ${ENUM_PROPS[prop].join(", ")}`);
        } else problems.push(`${prop} is not a property the language lets a style change`);
      }
      continue;
    }
    // a closing brace of a @media block
    i = close + 1;
    if (stack.pop() !== "media") problems.push("an unexpected }");
    depth = Math.max(0, depth - 1);
  }
  if (depth !== 0) problems.push("a block is not closed");
  return { ok: problems.length === 0, problems: [...new Set(problems)].slice(0, 12) };
}
