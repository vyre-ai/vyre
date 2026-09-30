// @ts-check
// Turns a Claude Code turn or a user message, untrusted text, possibly adversarial, into DOM,
// built only with h()/add()/createTextNode. No innerHTML anywhere, so raw HTML in the input (a
// prompt-injected <img onerror=...>, a fake heading trying to take over the page) can never
// become markup: it is text, or it is nothing. Not full CommonMark, just what Claude Code's own
// output looks like: paragraphs, headings, fences, inline code, lists, links, blockquotes.

import { h, add } from "../../js/dom.js";
import { highlight } from "./highlight.js";

const CAP = 50_000; // past this, truncate rather than parse, keeps pathological input cheap
const MAX_LIST_DEPTH = 8; // nesting is clamped, not rejected, so a "list" 500 levels deep is flat past here
const MAX_INLINE_DEPTH = 4; // bold-inside-italic-inside-bold... stops mattering past this

/**
 * @param {string} text
 * @returns {DocumentFragment}
 */
export function renderMarkdown(text) {
  let src = text == null ? "" : String(text);
  let truncated = false;
  if (src.length > CAP) { src = src.slice(0, CAP); truncated = true; }
  const frag = document.createDocumentFragment();
  add(frag, parseBlocks(src));
  if (truncated) add(frag, h("p", { class: "md-truncated" }, "(message truncated: too long to render in full)"));
  return frag;
}

// ---- block level --------------------------------------------------------

function parseBlocks(src) {
  const lines = src.split(/\r\n|\r|\n/);
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === "") { i++; continue; }

    const fence = /^```[ \t]*(\S*)[ \t]*$/.exec(line);
    if (fence) { const r = parseFence(lines, i, fence[1]); out.push(r.node); i = r.next; continue; }

    const heading = /^(#{1,6})[ \t]+(.*)$/.exec(line);
    if (heading) { out.push(h(`h${heading[1].length}`, null, ...inline(heading[2].trim()))); i++; continue; }

    if (/^ {0,3}>/.test(line)) { const r = parseQuote(lines, i); out.push(r.node); i = r.next; continue; }

    if (/^\s*(?:[-*]|\d+\.)\s+/.test(line)) { const r = parseList(lines, i); out.push(r.node); i = r.next; continue; }

    const r = parseParagraph(lines, i);
    out.push(r.node);
    i = r.next;
  }
  return out;
}

function parseFence(lines, i, lang) {
  const code = [];
  let j = i + 1;
  while (j < lines.length && lines[j].trim() !== "```") { code.push(lines[j]); j++; }
  const text = code.join("\n");
  const cls = `lang-${lang || "text"}`;
  const codeEl = h("code", { class: cls });
  for (const tok of highlight(text, lang || "text")) add(codeEl, tok.cls ? h("span", { class: tok.cls }, tok.text) : tok.text);
  return { node: h("pre", null, codeEl), next: j + 1 };
}

function parseQuote(lines, i) {
  const inner = [];
  let j = i;
  while (j < lines.length && /^ {0,3}>/.test(lines[j])) { inner.push(lines[j].replace(/^ {0,3}>[ ]?/, "")); j++; }
  return { node: h("blockquote", null, ...inline(inner.join(" ").trim())), next: j };
}

function parseParagraph(lines, i) {
  const inner = [];
  let j = i;
  while (j < lines.length && lines[j].trim() !== "" && !isBlockStart(lines[j])) { inner.push(lines[j]); j++; }
  if (!inner.length) { inner.push(lines[i]); j = i + 1; } // a line that only looked like a block start
  return { node: h("p", null, ...inline(inner.join(" ").trim())), next: j };
}

function isBlockStart(line) {
  return /^```/.test(line) || /^(#{1,6})[ \t]+/.test(line) || /^ {0,3}>/.test(line) || /^\s*(?:[-*]|\d+\.)\s+/.test(line);
}

// ---- lists ----------------------------------------------------------------
// Flat scan (no recursion) so breadth is unbounded and safe; the tree we build from it clamps
// depth to MAX_LIST_DEPTH, so DOM-building recursion below is bounded no matter how "deep" an
// adversarial input claims to be indented.

function parseList(lines, i) {
  const items = [];
  let j = i;
  while (j < lines.length) {
    const m = /^(\s*)([-*]|\d+\.)\s+(.*)$/.exec(lines[j]);
    if (!m) break;
    const indent = m[1].replace(/\t/g, "    ").length;
    items.push({ level: Math.min(Math.floor(indent / 2), MAX_LIST_DEPTH), ordered: /\d+\./.test(m[2]), text: m[3] });
    j++;
  }
  const tree = buildListTree(items);
  return { node: renderListLevel(tree), next: j };
}

function buildListTree(items) {
  const root = { level: -1, children: [] };
  const stack = [root];
  for (const it of items) {
    while (stack.length > 1 && stack[stack.length - 1].level >= it.level) stack.pop();
    const node = { level: it.level, ordered: it.ordered, text: it.text, children: [] };
    stack[stack.length - 1].children.push(node);
    stack.push(node);
  }
  return root.children;
}

function renderListLevel(nodes) {
  const list = h(nodes[0]?.ordered ? "ol" : "ul");
  for (const n of nodes) {
    const li = h("li", null, ...inline(n.text));
    if (n.children.length) add(li, renderListLevel(n.children));
    add(list, li);
  }
  return list;
}

// ---- inline level -----------------------------------------------------------

/** Bold/italic/code/links within one line of text. Returns a mix of strings and elements. */
function inline(text, depth = 0) {
  if (depth > MAX_INLINE_DEPTH) return [text];
  // A fresh regex per call: inline() recurses (bold containing italic, say), and a shared
  // module-level /g regex would have its lastIndex clobbered by the inner call, corrupting the
  // outer scan and looping forever.
  const re = /`[^`\n]+`|\[[^\]\n]*\]\([^)\s]+\)|\*\*[^*\n]+\*\*|__[^_\n]+__|\*[^*\n]+\*|_[^_\n]+_/g;
  const out = [];
  let last = 0, m;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push(inlineToken(m[0], depth));
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function inlineToken(tok, depth) {
  if (tok[0] === "`") return h("code", null, tok.slice(1, -1));
  if (tok[0] === "[") {
    const m = /^\[([^\]]*)\]\(([^)\s]+)\)$/.exec(tok);
    if (m && isSafeUrl(m[2])) return h("a", { href: m[2], target: "_blank", rel: "noopener noreferrer" }, m[1]);
    return tok; // an unsafe or unparseable link renders as literal text, never a live anchor
  }
  if (tok.startsWith("**") || tok.startsWith("__")) return h("strong", null, ...inline(tok.slice(2, -2), depth + 1));
  return h("em", null, ...inline(tok.slice(1, -1), depth + 1));
}

/** http(s) or a relative path only, never javascript:, data:, vbscript:, or protocol-relative //. */
function isSafeUrl(url) {
  if (/^https?:\/\//i.test(url)) return true;
  if (/^\/\//.test(url)) return false;
  if (/^[a-zA-Z][a-zA-Z0-9+.\-]*:/.test(url)) return false;
  return true;
}
