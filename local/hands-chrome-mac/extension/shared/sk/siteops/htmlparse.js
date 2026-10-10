// GENERATED from lib/siteops/htmlparse.js by scripts/sync-copies.mjs (the extension cannot import from lib/). Do not edit here: change the original and run the script.
// @ts-check
// htmlparse: a small, forgiving HTML reader for learned website operations whose answer is a page (a docket, a registry, a search result served as HTML). PURE and dependency free.
// It builds a tree from the source text as the server sent it (never a browser's DOM, so a recipe learned from a page reads the next page the same way) and answers a CSS selector subset:
// tag, .class, #id, [attr], [attr=v] [attr^=v] [attr$=v] [attr*=v], :first-child, :nth-child(n), :nth-of-type(n), the descendant (space) and child (>) combinators, and commas.
// Scripts and styles are skipped, comments dropped, entities decoded for the common ones. A page that is not HTML gives an empty tree.

/**
 * @typedef {{ type: "el", tag: string, attrs: Record<string, string>, children: Node[], parent: El | null, index: number }} El
 * @typedef {{ type: "text", text: string, parent: El | null }} Txt
 * @typedef {El | Txt} Node
 */

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
const RAW = new Set(["script", "style", "textarea", "title"]);
const SKIP = new Set(["script", "style", "noscript", "template"]);
/** A start tag that closes an open one of these (a new `li` ends the last `li`, a new `tr` ends the last `td` and `tr`...). */
const CLOSES = /** @type {Record<string, string[]>} */ ({
  li: ["li"], dt: ["dt", "dd"], dd: ["dt", "dd"], p: ["p"], tr: ["tr", "td", "th"], td: ["td", "th"], th: ["td", "th"], option: ["option"], optgroup: ["optgroup", "option"],
  thead: ["tbody", "thead", "tfoot", "tr", "td", "th"], tbody: ["tbody", "thead", "tfoot", "tr", "td", "th"], tfoot: ["tbody", "thead", "tfoot", "tr", "td", "th"],
});
/** A boundary an implied close never crosses: a `td` inside a nested table does not close the outer row. */
const SCOPE = new Set(["table", "ul", "ol", "dl", "select", "body", "html"]);
const ENTITIES = /** @type {Record<string, string>} */ ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "-", mdash: "-", hellip: "...", copy: "(c)", reg: "(r)", rsquo: "'", lsquo: "'", ldquo: '"', rdquo: '"', middot: "·", bull: "·" });

/** @param {string} s */
export function decode(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === "#") { const n = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); try { return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m; } catch { return m; } }
    const v = ENTITIES[e.toLowerCase()];
    return v === undefined ? m : v;
  });
}

/**
 * @param {string} html
 * @returns {El} a root element (tag "#root") holding the page
 */
export function parseHtml(html) {
  const src = String(html || "");
  /** @type {El} */ const root = { type: "el", tag: "#root", attrs: {}, children: [], parent: null, index: 0 };
  /** @type {El[]} */ const stack = [root];
  const top = () => stack[stack.length - 1];
  const push = (/** @type {Node} */ n) => { const p = top(); n.parent = p; if (n.type === "el") n.index = p.children.length; p.children.push(n); };
  let i = 0;
  const n = src.length;
  while (i < n) {
    const lt = src.indexOf("<", i);
    if (lt < 0) { addText(src.slice(i)); break; }
    if (lt > i) addText(src.slice(i, lt));
    i = lt;
    if (src.startsWith("<!--", i)) { const e = src.indexOf("-->", i + 4); i = e < 0 ? n : e + 3; continue; }
    if (src[i + 1] === "!" || src[i + 1] === "?") { const e = src.indexOf(">", i); i = e < 0 ? n : e + 1; continue; }
    if (src[i + 1] === "/") {
      const m = /^<\/([a-zA-Z][^\s>/]*)[^>]*>/.exec(src.slice(i, i + 200));
      if (!m) { i++; continue; }
      i += m[0].length;
      closeTag(m[1].toLowerCase());
      continue;
    }
    const m = /^<([a-zA-Z][^\s>/]*)/.exec(src.slice(i, i + 80));
    if (!m) { addText("<"); i++; continue; }
    const tag = m[1].toLowerCase();
    i += m[0].length;
    /** @type {Record<string, string>} */ const attrs = {};
    let selfClose = false;
    // attributes up to the closing >, quotes respected
    while (i < n) {
      while (i < n && /\s/.test(src[i])) i++;
      if (src[i] === ">") { i++; break; }
      if (src[i] === "/" && src[i + 1] === ">") { selfClose = true; i += 2; break; }
      if (src[i] === "/") { i++; continue; }
      const a = /^[^\s=>/]+/.exec(src.slice(i, i + 200));
      if (!a) { i++; continue; }
      const name = a[0].toLowerCase();
      i += a[0].length;
      while (i < n && /\s/.test(src[i])) i++;
      let val = "";
      if (src[i] === "=") {
        i++;
        while (i < n && /\s/.test(src[i])) i++;
        if (src[i] === '"' || src[i] === "'") { const q = src[i]; const e = src.indexOf(q, i + 1); val = src.slice(i + 1, e < 0 ? n : e); i = e < 0 ? n : e + 1; }
        else { const v = /^[^\s>]+/.exec(src.slice(i, i + 2000)); val = v ? v[0] : ""; i += val.length; }
      }
      if (!(name in attrs)) attrs[name] = decode(val);
    }
    if (SKIP.has(tag) || RAW.has(tag)) {
      // raw text up to the matching close tag
      const re = new RegExp(`</${tag}\\s*>`, "i");
      const rest = src.slice(i);
      const mm = re.exec(rest);
      const body = mm ? rest.slice(0, mm.index) : rest;
      i += mm ? mm.index + mm[0].length : rest.length;
      if (tag === "title" || tag === "textarea") { openTag(tag, attrs, false); addText(body); closeTag(tag); }
      continue;
    }
    openTag(tag, attrs, selfClose || VOID.has(tag));
  }
  return root;

  function addText(/** @type {string} */ raw) {
    const t = decode(raw);
    if (!t) return;
    const p = top();
    const last = p.children[p.children.length - 1];
    if (last && last.type === "text") { last.text += t; return; }
    push({ type: "text", text: t, parent: p });
  }
  function openTag(/** @type {string} */ tag, /** @type {Record<string, string>} */ attrs, /** @type {boolean} */ leaf) {
    const closes = CLOSES[tag];
    if (closes) {
      // everything from the lowest open element this tag ends (a new row ends the open cell and the open row), never past a table or a list
      let cut = -1;
      for (let k = stack.length - 1; k > 0; k--) {
        const t = stack[k].tag;
        if (SCOPE.has(t)) break;
        if (closes.includes(t)) cut = k;
      }
      if (cut > 0) stack.length = cut;
    }
    /** @type {El} */ const el = { type: "el", tag, attrs, children: [], parent: null, index: 0 };
    push(el);
    if (!leaf) stack.push(el);
  }
  function closeTag(/** @type {string} */ tag) {
    for (let k = stack.length - 1; k > 0; k--) {
      if (stack[k].tag === tag) { stack.length = k; return; }
      // a stray close tag inside a table or a list does not end the table or the list
      if (stack[k].tag === "table" || stack[k].tag === "ul" || stack[k].tag === "ol") return;
    }
  }
}

/** The text an element shows: its text nodes in order, whitespace collapsed. @param {Node} node */
export function textOf(node) {
  if (node.type === "text") return node.text.replace(/\s+/g, " ").trim();
  /** @type {string[]} */ const out = [];
  const walk = (/** @type {Node} */ x) => {
    if (x.type === "text") { out.push(x.text); return; }
    if (x.tag === "br" || /^(p|div|tr|li|h[1-6]|table|ul|ol|section|article)$/.test(x.tag)) out.push(" ");
    for (const c of x.children) walk(c);
    if (x.tag === "td" || x.tag === "th") out.push(" ");
  };
  walk(node);
  return out.join("").replace(/\s+/g, " ").trim();
}

/** @param {El} el @returns {El[]} the element children */
export const elements = el => /** @type {El[]} */ (el.children.filter(c => c.type === "el"));

/** @param {El} root @returns {El[]} every element under root, document order */
export function all(root) {
  /** @type {El[]} */ const out = [];
  const walk = (/** @type {El} */ e) => { for (const c of e.children) if (c.type === "el") { out.push(c); walk(c); } };
  walk(root);
  return out;
}

/* ----------------------------------------------------------------- selectors */

/** @typedef {{ tag?: string, id?: string, classes: string[], attrs: { name: string, op: string, value: string }[], first?: boolean, nth?: number, nthOfType?: number }} Simple */

/** @param {string} part one compound selector, such as `tr.row[data-x="1"]:nth-child(2)` @returns {Simple} */
function compound(part) {
  /** @type {Simple} */ const s = { classes: [], attrs: [] };
  let rest = part;
  const t = /^[a-zA-Z][\w-]*|^\*/.exec(rest);
  if (t) { if (t[0] !== "*") s.tag = t[0].toLowerCase(); rest = rest.slice(t[0].length); }
  while (rest) {
    let m;
    if ((m = /^#([\w-]+)/.exec(rest))) { s.id = m[1]; rest = rest.slice(m[0].length); }
    else if ((m = /^\.([\w-]+)/.exec(rest))) { s.classes.push(m[1]); rest = rest.slice(m[0].length); }
    else if ((m = /^\[\s*([\w:-]+)\s*(?:([~^$*|]?=)\s*(?:"([^"]*)"|'([^']*)'|([^\]\s]*)))?\s*\]/.exec(rest))) { s.attrs.push({ name: m[1].toLowerCase(), op: m[2] || "", value: m[3] ?? m[4] ?? m[5] ?? "" }); rest = rest.slice(m[0].length); }
    else if ((m = /^:first-child/.exec(rest))) { s.first = true; rest = rest.slice(m[0].length); }
    else if ((m = /^:nth-child\(\s*(\d+)\s*\)/.exec(rest))) { s.nth = Number(m[1]); rest = rest.slice(m[0].length); }
    else if ((m = /^:nth-of-type\(\s*(\d+)\s*\)/.exec(rest))) { s.nthOfType = Number(m[1]); rest = rest.slice(m[0].length); }
    else throw new Error(`selector "${part.slice(0, 60)}" is not supported here`);
  }
  return s;
}

/** @param {string} selector @returns {{ simple: Simple, via: " " | ">" }[][]} a list of chains; each step carries how it joins the one before */
export function parseSelector(selector) {
  const out = [];
  for (const group of String(selector).split(",")) {
    const text = group.trim();
    if (!text) continue;
    /** @type {{ simple: Simple, via: " " | ">" }[]} */ const chain = [];
    let via = /** @type {" " | ">"} */ (" ");
    for (const tok of text.replace(/\s*>\s*/g, " > ").split(/\s+/)) {
      if (tok === ">") { via = ">"; continue; }
      chain.push({ simple: compound(tok), via });
      via = " ";
    }
    out.push(chain);
  }
  if (!out.length) throw new Error("an empty selector");
  return out;
}

/** @param {El} el @param {Simple} s */
function matchSimple(el, s) {
  if (s.tag && el.tag !== s.tag) return false;
  if (s.id && el.attrs.id !== s.id) return false;
  if (s.classes.length) { const have = (el.attrs.class || "").split(/\s+/); if (!s.classes.every(c => have.includes(c))) return false; }
  for (const a of s.attrs) {
    const v = el.attrs[a.name];
    if (v === undefined) return false;
    if (a.op === "=" && v !== a.value) return false;
    if (a.op === "^=" && !v.startsWith(a.value)) return false;
    if (a.op === "$=" && !v.endsWith(a.value)) return false;
    if (a.op === "*=" && !v.includes(a.value)) return false;
    if (a.op === "~=" && !v.split(/\s+/).includes(a.value)) return false;
  }
  if (s.first || s.nth !== undefined || s.nthOfType !== undefined) {
    const sibs = el.parent ? elements(el.parent) : [el];
    const pos = sibs.indexOf(el) + 1;
    if (s.first && pos !== 1) return false;
    if (s.nth !== undefined && pos !== s.nth) return false;
    if (s.nthOfType !== undefined && sibs.filter(x => x.tag === el.tag).indexOf(el) + 1 !== s.nthOfType) return false;
  }
  return true;
}

/** Does `el` match the chain, with `within` the element the selector is scoped to (not matched itself)? @param {El} el @param {{ simple: Simple, via: " " | ">" }[]} chain @param {El | null} within */
function matchChain(el, chain, within) {
  let k = chain.length - 1;
  if (!matchSimple(el, chain[k].simple)) return false;
  /** @type {El | null} */ let cur = el;
  while (k > 0) {
    const via = chain[k].via;
    cur = cur.parent;
    k--;
    if (via === ">") { if (!cur || cur === within || !matchSimple(cur, chain[k].simple)) return false; continue; }
    while (cur && cur !== within && !matchSimple(cur, chain[k].simple)) cur = cur.parent;
    if (!cur || cur === within) return false;
  }
  return true;
}

/** The elements under `root` that match, in document order. @param {El} root @param {string} selector */
export function select(root, selector) {
  const chains = parseSelector(selector);
  return all(root).filter(el => chains.some(c => matchChain(el, c, root)));
}

/** The first element under `root` that matches, or null. @param {El} root @param {string} selector */
export function selectOne(root, selector) { return select(root, selector)[0] || null; }
