// GENERATED from lib/siteops/htmlread.js by scripts/sync-copies.mjs (the extension cannot import from lib/). Do not edit here: change the original and run the script.
// @ts-check
// htmlread: read the repeated items of a page into rows, and learn how from one example row. For a learned website operation whose answer is a page (a docket, a registry, a search result
// served as HTML). PURE and dependency free (htmlparse.js is the reader).
//
// A recipe is { items: "<selector of one result>", fields: { name: "<selector inside the item>" | { sel, attr? } } }. `readHtml` applies one to a page; `suggestRecipe` finds one from the text a
// person (or their agent) saw in the first row: it finds the smallest repeated structure that holds every example, names each field by where it sits inside the item, and proves the recipe
// by reading the same page back. The same source parser reads the page at learn time and at run time, so a recipe never depends on what a browser would make of the markup.

import { parseHtml, textOf, elements, all, select, selectOne } from "./htmlparse.js";

/** @typedef {import("./htmlparse.js").El} El */

const MAX_ROWS = 500;
const norm = (/** @type {string} */ s) => String(s).toLowerCase().replace(/\s+/g, " ").trim();

/** A class a site keeps across loads, as opposed to state, position or a build's hash. @param {string} c */
const stableClass = c => !/^(odd|even|first|last|active|selected|current|hover|focus|open|show|hidden|visible|clearfix)$/.test(c) && !/^(js|is|has|ng)-/.test(c) && !/^(css|sc|jsx|styled)-/.test(c) && !/\d{3,}/.test(c) && !(/^[a-z0-9]{8,}$/.test(c) && /\d/.test(c) && /[a-z]/.test(c));
/** @param {El} el */
const classesOf = el => (el.attrs.class || "").split(/\s+/).filter(c => c && stableClass(c));
/** @param {El} el */
const sigOf = el => `${el.tag}.${classesOf(el).sort().join(".")}`;
/** One element as a simple selector: tag, and its stable classes. @param {El} el */
const simpleOf = el => el.tag + classesOf(el).map(c => `.${c}`).join("");
/** An id worth anchoring on. @param {El} el */
const anchorOf = el => (el.attrs.id && !/\d{6,}/.test(el.attrs.id) && /^[A-Za-z][\w-]*$/.test(el.attrs.id) ? `#${el.attrs.id}` : "");

/**
 * The rows a page holds under a recipe: one object per item, a field left out when the item has nothing there, an item with no field at all dropped.
 * @param {string} body @param {{ items: string, fields: Record<string, string | { sel: string, attr?: string }>, limit?: number }} recipe
 * @returns {Record<string, string>[]}
 */
export function readHtml(body, recipe) {
  const root = parseHtml(body);
  const limit = Math.min(Number(recipe.limit) || MAX_ROWS, MAX_ROWS);
  /** @type {Record<string, string>[]} */ const rows = [];
  for (const item of select(root, recipe.items)) {
    /** @type {Record<string, string>} */ const row = {};
    for (const [name, spec] of Object.entries(recipe.fields || {})) {
      const sel = typeof spec === "string" ? spec : spec.sel;
      const attr = typeof spec === "string" ? "" : spec.attr || "";
      const target = sel ? selectOne(item, sel) : item;
      if (!target) continue;
      const v = attr ? target.attrs[attr] : textOf(target);
      if (v !== undefined && String(v).trim()) row[name] = String(v).trim();
    }
    if (Object.keys(row).length) rows.push(row);
    if (rows.length >= limit) break;
  }
  return rows;
}

const NONE = /\b(no|zero|0)\s+(matching\s+)?(results?|records?|matches|cases?|entries|items|documents|listings|people|rows)\b|\bnothing\s+(was\s+)?found\b|\bdid\s+not\s+match\s+any\b|\bno\s+matching\b/i;

/** Does the page say there is nothing to list (so an items selector that matches nothing is not a changed site)? @param {string} body @param {string} items */
export function emptyResults(body, items) {
  try {
    const root = parseHtml(body);
    if (select(root, items).length) return false;
    return NONE.test(textOf(root).slice(0, 200_000));
  } catch { return false; }
}

/** The lowest element that holds every one of these. @param {El[]} els @returns {El} */
function commonAncestor(els) {
  if (els.length === 1) return els[0];
  /** @type {El[][]} */ const chains = els.map(e => { const c = []; for (let x = /** @type {El | null} */ (e); x; x = x.parent) c.unshift(x); return c; });
  let common = chains[0][0];
  for (let k = 0; k < chains[0].length; k++) {
    const e = chains[0][k];
    if (chains.every(c => c[k] === e)) common = e; else break;
  }
  return common;
}

/** The selector that picks exactly this group of siblings (and nothing outside it, where that can be done), anchored on stable parents. @param {El} root @param {El[]} group */
function itemsSelector(root, group) {
  const first = group[0];
  /** @type {string[]} */ const ups = [];
  for (let p = first.parent, k = 0; p && p.tag !== "#root" && k < 4; p = p.parent, k++) ups.push((anchorOf(p) || simpleOf(p)));
  const base = simpleOf(first);
  const want = new Set(group);
  /** @type {string | null} */ let best = null; let bestExtra = Infinity;
  const tries = [base, ...ups.map((_, k) => `${ups.slice(0, k + 1).reverse().join(" > ")} > ${base}`)];
  for (const sel of tries) {
    let got;
    try { got = select(root, sel); } catch { continue; }
    if (!group.every(g => got.includes(g))) continue;
    const extra = got.filter(g => !want.has(g)).length;
    if (extra === 0) return sel;
    if (extra < bestExtra) { best = sel; bestExtra = extra; }
  }
  return best || base;
}

/** The shortest selector inside `item` that picks exactly `hit`. @param {El} item @param {El} hit */
function fieldSelector(item, hit) {
  if (hit === item) return "";
  /** @type {string[]} */ const steps = [];
  for (let e = /** @type {El | null} */ (hit); e && e !== item; e = e.parent) {
    const sameTag = e.parent ? elements(e.parent).filter(x => x.tag === e.tag) : [e];
    const needNth = sameTag.length > 1 && sameTag.filter(x => sigOf(x) === sigOf(e)).length > 1;
    steps.unshift(simpleOf(e) + (needNth ? `:nth-of-type(${sameTag.indexOf(e) + 1})` : ""));
  }
  for (let n = 1; n <= steps.length; n++) {
    const sel = steps.slice(-n).join(" ");
    try { const got = select(item, sel); if (got.length === 1 && got[0] === hit) return sel; } catch { /* try longer */ }
  }
  return steps.join(" > ");
}

/**
 * Find a recipe from what was seen in one row. `fields` maps a field name to the text (or the link) as it showed in the first row. The answer is the recipe, the rows it reads back (a preview),
 * how many, and the fields it could not place. A recipe that does not read the examples back from the same page is not offered.
 * @param {string} body @param {Record<string, string>} fields
 * @returns {{ recipe: { items: string, fields: Record<string, { sel: string, attr?: string }> } | null, rows: Record<string, string>[], count: number, missing: string[], reason?: string }}
 */
export function suggestRecipe(body, fields) {
  const root = parseHtml(body);
  const els = all(root);
  /** @type {Map<El, string>} */ const text = new Map();
  const tx = (/** @type {El} */ e) => { let t = text.get(e); if (t === undefined) { t = norm(textOf(e)); text.set(e, t); } return t; };
  /** @type {Record<string, { el: El, attr?: string }>} */ const found = {};
  /** @type {string[]} */ const missing = [];
  for (const [name, example] of Object.entries(fields || {})) {
    const v = norm(example);
    if (!v) { missing.push(name); continue; }
    // a link: the element whose href is it
    if (/^(https?:\/\/|\/)/.test(String(example).trim())) {
      const a = els.find(e => e.tag === "a" && e.attrs.href && (e.attrs.href === String(example).trim() || e.attrs.href.endsWith(String(example).trim())));
      if (a) { found[name] = { el: a, attr: "href" }; continue; }
    }
    // the deepest element that shows it
    const hit = els.find(e => tx(e).includes(v) && !elements(e).some(c => tx(c).includes(v)));
    if (hit) found[name] = { el: hit }; else missing.push(name);
  }
  const names = Object.keys(found);
  if (!names.length) return { recipe: null, rows: [], count: 0, missing, reason: "none of the example text is on this page" };
  const hits = names.map(n => found[n].el);
  const start = commonAncestor(hits);
  /** @type {El | null} */ let item = null; /** @type {El[]} */ let group = [];
  const sibsOf = (/** @type {El} */ a) => (a.parent ? elements(a.parent).filter(x => sigOf(x) === sigOf(a)) : [a]);
  if (hits.length > 1) {
    for (let a = /** @type {El | null} */ (start); a && a.tag !== "#root" && a.tag !== "body" && a.tag !== "html"; a = a.parent) { const s = sibsOf(a); if (s.length >= 2) { item = a; group = s; break; } }
  } else {
    // one example cannot tell a row from a cell: the repeated structure with the most members is the list
    for (let a = /** @type {El | null} */ (start); a && a.tag !== "#root" && a.tag !== "body" && a.tag !== "html"; a = a.parent) { const s = sibsOf(a); if (s.length >= 2 && s.length > group.length) { item = a; group = s; } }
  }
  if (!item) { item = start; group = [start]; }
  const items = itemsSelector(root, group);
  /** @type {Record<string, { sel: string, attr?: string }>} */ const recipeFields = {};
  for (const n of names) recipeFields[n] = { sel: fieldSelector(item, found[n].el), ...(found[n].attr ? { attr: found[n].attr } : {}) };
  const recipe = { items, fields: recipeFields };
  const rows = readHtml(body, recipe);
  // proof: some row reads back every example
  const back = rows.some(r => names.every(n => norm(r[n] || "").includes(norm(fields[n])) || (found[n].attr && (r[n] || "").endsWith(String(fields[n]).trim()))));
  if (!back) return { recipe: null, rows: rows.slice(0, 5), count: rows.length, missing, reason: "the recipe found does not read the examples back from this page" };
  return { recipe, rows: rows.slice(0, 5), count: rows.length, missing };
}
