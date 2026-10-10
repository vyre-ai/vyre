// @ts-check
// Markdown for chat, a closed set (design, R-chat): paragraphs, headings, bold, italic, lists (nested, ordered), links, inline code, fenced code, blockquotes, tables, rules.
// No HTML ever: a tag in the words is just words. A link opens only if it is http, https or mailto. Tolerant of half-written input (a reply streams in): an unclosed fence is a code block that is still
// open, an unclosed mark is its own characters. Pure, no dependencies; the renderer (Markdown.tsx) draws the tree with the design system's own components.
//
// Block: { t: "p", c: Inline[] } | { t: "h", level: 1..6, c } | { t: "code", lang: string, text: string, open: boolean } | { t: "quote", c: Block[] } | { t: "list", ordered: boolean, start: number, items: Block[][] }
//        | { t: "table", head: Inline[][], rows: Inline[][][], align: ("left"|"center"|"right"|null)[] } | { t: "rule" }
// Inline: { t: "text", v } | { t: "b" | "i", c: Inline[] } | { t: "code", v } | { t: "a", href: string, c: Inline[] } | { t: "br" }

/** @typedef {{ t: string, [k: string]: any }} Node */

const SAFE = /^(https?:\/\/|mailto:)/i;
/** A link target that may be opened: http, https or mailto, nothing else. @param {string} href */
export const safeHref = (href) => SAFE.test(String(href).trim());

const FENCE = /^ {0,3}(`{3,}|~{3,})[ \t]*([^\s`]*)[^`]*$/;
const HEADING = /^ {0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/;
const RULE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const QUOTE = /^ {0,3}>[ \t]?(.*)$/;
const ITEM = /^( *)([-*+]|\d{1,9}[.)])([ \t]+)(.*)$/;
const SEP = /^\s*\|?\s*:?-{1,}:?\s*(?:\|\s*:?-{1,}:?\s*)*\|?\s*$/;

/** @param {string} s */
const cells = (s) => {
  let t = s.trim();
  if (t.startsWith("|")) t = t.slice(1);
  if (t.endsWith("|") && !t.endsWith("\\|")) t = t.slice(0, -1);
  return t.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));
};

/** Does this line start a block that may interrupt a paragraph? @param {string} l */
const interrupts = (l) => FENCE.test(l) || HEADING.test(l) || RULE.test(l) || QUOTE.test(l) || /^ {0,3}(?:[-*+]|1[.)])[ \t]+\S/.test(l);

/** @param {string} src @returns {Node[]} */
export function parse(src) {
  const lines = String(src ?? "").replace(/\r\n?/g, "\n").split("\n");
  return blocks(lines);
}

/** @param {string[]} lines @returns {Node[]} */
function blocks(lines) {
  /** @type {Node[]} */ const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    let m = FENCE.exec(line);
    if (m) {
      const fence = m[1], indent = line.length - line.trimStart().length;
      const body = [];
      i++;
      let closed = false;
      while (i < lines.length) {
        const l = lines[i];
        const c = new RegExp(`^ {0,3}${fence[0] === "`" ? "`" : "~"}{${fence.length},}[ \\t]*$`).exec(l);
        if (c) { closed = true; i++; break; }
        body.push(l.slice(0, indent).trim() === "" ? l.slice(Math.min(indent, l.length - l.trimStart().length)) : l);
        i++;
      }
      out.push({ t: "code", lang: m[2].toLowerCase(), text: body.join("\n"), open: !closed });
      continue;
    }
    if ((m = HEADING.exec(line))) { out.push({ t: "h", level: m[1].length, c: inline(m[2]) }); i++; continue; }
    if (RULE.test(line)) { out.push({ t: "rule" }); i++; continue; }
    if (QUOTE.test(line)) {
      const inner = [];
      while (i < lines.length && (m = QUOTE.exec(lines[i]))) { inner.push(m[1]); i++; }
      out.push({ t: "quote", c: blocks(inner) });
      continue;
    }
    if (line.includes("|") && i + 1 < lines.length && SEP.test(lines[i + 1]) && lines[i + 1].includes("-") && (lines[i + 1].includes("|") || cells(line).length > 1)) {
      const head = cells(line);
      const align = cells(lines[i + 1]).map((c) => (c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "right" : c.startsWith(":") ? "left" : null));
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].trim() && lines[i].includes("|")) { rows.push(cells(lines[i]).map(inline)); i++; }
      out.push({ t: "table", head: head.map(inline), rows, align });
      continue;
    }
    if ((m = ITEM.exec(line))) {
      const r = list(lines, i);
      out.push(r.node); i = r.next;
      continue;
    }
    // a paragraph: lines until a blank line or a block that interrupts
    const para = [line];
    i++;
    while (i < lines.length && lines[i].trim() && !interrupts(lines[i])) { para.push(lines[i]); i++; }
    out.push({ t: "p", c: inline(para.join("\n")) });
  }
  return out;
}

/** @param {string[]} lines @param {number} at @returns {{ node: Node, next: number }} */
function list(lines, at) {
  const first = /** @type {RegExpExecArray} */ (ITEM.exec(lines[at]));
  const base = first[1].length;
  const ordered = /\d/.test(first[2]);
  const start = ordered ? parseInt(first[2], 10) : 1;
  /** @type {Node[][]} */ const items = [];
  let i = at;
  while (i < lines.length) {
    const m = ITEM.exec(lines[i]);
    if (!m || m[1].length !== base || /\d/.test(m[2]) !== ordered) break;
    const content = m[1].length + m[2].length + m[3].length;
    const body = [m[4]];
    i++;
    while (i < lines.length) {
      const l = lines[i];
      if (!l.trim()) {
        // a blank line stays in the item only when the next non-blank line is indented under it
        let j = i; while (j < lines.length && !lines[j].trim()) j++;
        if (j < lines.length && lines[j].length - lines[j].trimStart().length >= content) { body.push(""); i++; continue; }
        break;
      }
      const ind = l.length - l.trimStart().length;
      if (ind >= content || (ind > base && !ITEM.test(l))) { body.push(l.slice(Math.min(ind, content))); i++; continue; }
      if (ind > base) { body.push(l.slice(Math.min(ind, base + 2))); i++; continue; }
      if (ind === base && ITEM.test(l)) break;
      if (!interrupts(l) && ind > base - 1 && body[body.length - 1].trim()) { body.push(l.trim()); i++; continue; }
      break;
    }
    items.push(blocks(body));
  }
  return { node: { t: "list", ordered, start, items }, next: i };
}

const PUNCT = /[\\`*_{}\[\]()#+\-.!|~<>"'$%&,/:;=?@^]/;
const isWordish = (/** @type {string | undefined} */ c) => c !== undefined && /[\p{L}\p{N}]/u.test(c);

/** @param {string} s @returns {Node[]} */
export function inline(s) {
  /** @type {Node[]} */ const out = [];
  let buf = "";
  const flush = () => { if (buf) { out.push({ t: "text", v: buf }); buf = ""; } };
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch === "\\" && i + 1 < s.length) {
      if (s[i + 1] === "\n") { flush(); out.push({ t: "br" }); i += 2; continue; }
      if (PUNCT.test(s[i + 1])) { buf += s[i + 1]; i += 2; continue; }
    }
    if (ch === "\n") {
      if (/ {2,}$/.test(buf)) { buf = buf.replace(/ +$/, ""); flush(); out.push({ t: "br" }); } else { buf = buf.replace(/ +$/, "") + " "; }
      i++; while (s[i] === " ") i++;
      continue;
    }
    if (ch === "`") {
      let n = 1; while (s[i + n] === "`") n++;
      const fence = "`".repeat(n);
      const end = s.indexOf(fence, i + n);
      if (end > 0 && s[end + n] !== "`") {
        flush();
        let v = s.slice(i + n, end).replace(/\n/g, " ");
        if (v.length > 2 && v.startsWith(" ") && v.endsWith(" ") && v.trim()) v = v.slice(1, -1);
        out.push({ t: "code", v });
        i = end + n; continue;
      }
      buf += fence; i += n; continue;
    }
    if (ch === "[") {
      const close = matchBracket(s, i);
      if (close > 0 && s[close + 1] === "(") {
        const end = matchParen(s, close + 1);
        if (end > 0) {
          const raw = s.slice(close + 2, end).trim();
          const url = raw.startsWith("<") && raw.includes(">") ? raw.slice(1, raw.indexOf(">")) : raw.split(/\s+/)[0];
          flush();
          const label = inline(s.slice(i + 1, close));
          out.push(safeHref(url) ? { t: "a", href: url, c: label } : { t: "text", v: "" }, ...(safeHref(url) ? [] : label));
          i = end + 1; continue;
        }
      }
    }
    if (ch === "<") {
      const m = /^<((?:https?:\/\/|mailto:)[^\s<>]+)>/i.exec(s.slice(i));
      if (m) { flush(); out.push({ t: "a", href: m[1], c: [{ t: "text", v: m[1] }] }); i += m[0].length; continue; }
    }
    if ((ch === "h" || ch === "H") && /^https?:\/\//i.test(s.slice(i, i + 8)) && !isWordish(s[i - 1])) {
      const m = /^https?:\/\/[^\s<>]+/i.exec(s.slice(i));
      if (m) {
        const url = m[0].replace(/[.,;:!?)\]}'"]+$/, "");
        flush(); out.push({ t: "a", href: url, c: [{ t: "text", v: url }] }); i += url.length; continue;
      }
    }
    if (ch === "*" || ch === "_") {
      let n = 1; while (s[i + n] === ch) n++;
      const run = Math.min(n, 3);
      const next = s[i + n], prev = s[i - 1];
      const canOpen = next !== undefined && !/\s/.test(next) && (ch === "*" || !isWordish(prev));
      if (canOpen && n <= 3) {
        const close = findClose(s, i + n, ch, run);
        if (close > 0) {
          flush();
          const inner = s.slice(i + n, close);
          const node = run === 3 ? { t: "b", c: [{ t: "i", c: inline(inner) }] } : { t: run === 2 ? "b" : "i", c: inline(inner) };
          out.push(node);
          i = close + run; continue;
        }
      }
      buf += s.slice(i, i + n); i += n; continue;
    }
    buf += ch; i++;
  }
  flush();
  return out;
}

/** The index of the ] that closes the [ at `at`, or -1. @param {string} s @param {number} at */
function matchBracket(s, at) {
  let depth = 0;
  for (let i = at; i < s.length; i++) {
    if (s[i] === "\\") { i++; continue; }
    if (s[i] === "`") { const e = s.indexOf("`", i + 1); if (e > 0) { i = e; continue; } }
    if (s[i] === "[") depth++;
    else if (s[i] === "]" && --depth === 0) return i;
    else if (s[i] === "\n" && s[i + 1] === "\n") return -1;
  }
  return -1;
}
/** @param {string} s @param {number} at */
function matchParen(s, at) {
  let depth = 0;
  for (let i = at; i < s.length; i++) {
    if (s[i] === "\\") { i++; continue; }
    if (s[i] === "(") depth++;
    else if (s[i] === ")" && --depth === 0) return i;
    else if (s[i] === "\n") return -1;
  }
  return -1;
}
/** The index of the closing run of `run` marks for an opener, or -1: the char before it is not a space and (for _) the next is not a letter. @param {string} s @param {number} from @param {string} ch @param {number} run */
function findClose(s, from, ch, run) {
  const mark = ch.repeat(run);
  for (let i = from; i < s.length; i++) {
    if (s[i] === "\\") { i++; continue; }
    if (s[i] === "`") { const e = s.indexOf("`", i + 1); if (e > 0) { i = e; continue; } }
    if (s.startsWith(mark, i) && i > from && !/\s/.test(s[i - 1]) && (s[i + run] !== ch) && (ch === "*" || !isWordish(s[i + run]))) return i;
    if (s[i] === "\n" && s[i + 1] === "\n") return -1;
  }
  return -1;
}

/** The plain words of inline nodes (for an accessibility label or a table cell's text). @param {Node[]} nodes @returns {string} */
export const plainOf = (nodes) => nodes.map((n) => (n.t === "text" || n.t === "code" ? n.v : n.t === "br" ? " " : plainOf(n.c || []))).join("");
