// @ts-check
// A small Markdown renderer for docs.vyre.run. Zero dependencies, on purpose: the package has no
// runtime dependencies and the docs build should not be the first.
//
// What it renders (CommonMark plus the GFM parts the docs use):
//
//   blocks   ATX and setext headings (unique GitHub-style ids), paragraphs, fenced code with ``` or
//            ~~~ (language class from the info string), bullet and ordered lists with nesting,
//            multi-paragraph items, tight/loose and task items, blockquotes (and GFM alerts,
//            `> [!NOTE]`, plus `> [!GAP]` for a known gap), GFM tables with alignment, horizontal
//            rules, link reference definitions
//   inline   emphasis and strong (CommonMark delimiter rules, so snake_case stays plain), ~~strike~~,
//            code spans, links and images (inline and reference), autolinks <https://...>, hard
//            breaks (two spaces or a backslash before the newline), backslash escapes, entities
//
// What it does not: indented code blocks (a four-space indent is a paragraph), raw HTML. Every `<`
// in the source is escaped and shows as text, which is what the docs want (`<you>.vyre.run`).
// HTML comments are dropped. One comment is special: a line `<!-- include: ../CHANGELOG.md -->`
// splices that file in, through the `include` option, with links inside it resolved from its own
// folder.
//
// Heading ids follow GitHub's rule (lowercase, drop punctuation, spaces to hyphens, `-1`, `-2` for
// repeats), so an anchor that works on github.com works here too.

/** @typedef {{ level: number, text: string, id: string }} Heading */
/** @typedef {{ href: string, url: string, base: string, kind: "link" | "image" | "autolink" }} Link */
/**
 * @typedef {object} RenderOptions
 * @property {(href: string, base: string) => string} [resolveLink] turns a link as written into
 *   the href to emit. `base` is the docs-relative folder of the file the link was written in.
 * @property {(path: string, base: string) => ({ text: string, base: string } | null)} [include]
 *   returns the text of an included file and its own base folder, or null to drop the include.
 * @property {string} [base] the base folder of the page itself ("" for docs/).
 */

const ESCAPABLE = "!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~";
const PUNCT = /[\p{P}\p{S}]/u;

const reFence = /^( {0,3})(`{3,}|~{3,})(.*)$/;
const reAtx = /^ {0,3}(#{1,6})(?=[ \t]|$)(.*)$/;
const reHr = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const reQuote = /^ {0,3}> ?/;
const reList = /^( {0,3})([-+*]|(\d{1,9})([.)]))(?=[ \t]|$)(.*)$/;
const reComment = /^ {0,3}<!--/;
const reInclude = /^ {0,3}<!--\s*include:\s*(\S+?)\s*-->\s*$/;
const reSetext1 = /^ {0,3}=+[ \t]*$/;
const reSetext2 = /^ {0,3}-+[ \t]*$/;
const reDelimRow = /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;
const reRefDef = /^ {0,3}\[([^\]]+)\]:[ \t]*<?([^\s>]+)>?(?:[ \t]+(?:"([^"]*)"|'([^']*)'|\(([^)]*)\)))?[ \t]*$/;
const reAlert = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION|GAP)\][ \t]*$/i;
// `> [!GAP]` is Vyre's own: a place the code does not yet do what the docs or the spec say.
const ALERT_LABEL = { gap: "Known gap" };

/** @param {string} s */
export function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** GitHub's heading anchor rule. @param {string} text */
export function slugify(text) {
  return text.toLowerCase().trim().replace(/[^\p{L}\p{N}\s_-]/gu, "").replace(/\s/g, "-");
}

/**
 * @param {string} md
 * @param {RenderOptions} [opts]
 * @returns {{ html: string, headings: Heading[], links: Link[] }}
 */
export function renderMarkdown(md, opts = {}) {
  const ctx = {
    resolveLink: opts.resolveLink || (h => h),
    include: opts.include || null,
    base: opts.base || "",
    /** @type {Heading[]} */ headings: [],
    /** @type {Link[]} */ links: [],
    /** @type {Map<string, number>} */ slugs: new Map(),
    /** @type {Map<string, { href: string, title?: string, base: string }>} */ refs: new Map(),
    depth: 0,
  };
  const lines = collectRefs(prepare(md), ctx);
  const blocks = parseBlocks(lines, ctx);
  const html = renderBlocks(blocks, ctx, false);
  return { html: html ? html + "\n" : "", headings: ctx.headings, links: ctx.links };
}

// ---- blocks ------------------------------------------------------------------------------------

/** @param {string} md */
function prepare(md) {
  return md.replace(/^﻿/, "").replace(/\r\n?/g, "\n").split("\n")
    .map(l => l.replace(/^[ \t]+/, ws => expandTabs(ws)));
}

/** @param {string} ws */
function expandTabs(ws) {
  let out = "";
  for (const ch of ws) out += ch === "\t" ? " ".repeat(4 - (out.length % 4)) : ch;
  return out;
}

/** @param {string} l */
const isBlank = l => l === undefined || /^[ \t]*$/.test(l);
/** @param {string} l */
const indentOf = l => /^ */.exec(l)?.[0].length ?? 0;
/** @param {string} label */
const normLabel = label => label.trim().replace(/\s+/g, " ").toLowerCase();

/** Pull link reference definitions out (outside fences), and return the remaining lines. */
function collectRefs(/** @type {string[]} */ lines, /** @type {any} */ ctx) {
  const out = [];
  /** @type {string | null} */
  let fence = null;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const f = reFence.exec(l);
    if (f) {
      if (!fence) fence = f[2][0];
      else if (f[2][0] === fence && !f[3].trim()) fence = null;
    }
    const m = !fence && !f ? reRefDef.exec(l) : null;
    if (m && (i === 0 || isBlank(lines[i - 1]) || reRefDef.test(lines[i - 1]))) {
      const key = normLabel(m[1]);
      if (!ctx.refs.has(key)) ctx.refs.set(key, { href: unescapeMd(m[2]), title: m[3] ?? m[4] ?? m[5], base: ctx.base });
      continue;
    }
    out.push(l);
  }
  return out;
}

/**
 * A list marker at the start of a line, and where that item's content starts.
 * @param {string} line
 */
function listMarker(line) {
  const m = reList.exec(line);
  if (!m) return null;
  const indent = m[1].length;
  const marker = m[2];
  const rest = m[5];
  const spaces = /^[ \t]*/.exec(rest)?.[0].length ?? 0;
  const blank = isBlank(rest);
  const pad = blank || spaces >= 5 ? 1 : spaces;
  const content = indent + marker.length + pad;
  return {
    ordered: !!m[3],
    ch: m[3] ? m[4] : marker,
    start: m[3] ? Number(m[3]) : 1,
    content,
    first: blank ? "" : rest.slice(pad),
  };
}

/** Whether a line starts a block that ends a paragraph. @param {string} l */
function interrupts(l) {
  if (reAtx.test(l) || reHr.test(l) || reQuote.test(l) || reComment.test(l)) return true;
  const f = reFence.exec(l);
  if (f && !(f[2][0] === "`" && f[3].includes("`"))) return true;
  const mk = listMarker(l);
  return !!mk && mk.first.trim() !== "" && (!mk.ordered || mk.start === 1);
}

/** @param {string} line */
function splitRow(line) {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  const cells = [];
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\\" && s[i + 1] === "|") { cur += "|"; i++; continue; }
    if (s[i] === "`") {
      // A pipe inside a code span stays in the cell. GFM would split there; the docs mean code.
      const run = /^`+/.exec(s.slice(i))?.[0] || "`";
      const close = s.indexOf(run, i + run.length);
      if (close > 0 && s[close + run.length] !== "`") { cur += s.slice(i, close + run.length); i = close + run.length - 1; continue; }
      cur += run; i += run.length - 1; continue;
    }
    if (s[i] === "|") { cells.push(cur.trim()); cur = ""; continue; }
    cur += s[i];
  }
  cells.push(cur.trim());
  return cells;
}

/** @param {string[]} lines @param {number} i */
function tableAt(lines, i) {
  const head = lines[i], delim = lines[i + 1];
  if (delim === undefined || !head.includes("|") || !reDelimRow.test(delim)) return false;
  if (!delim.includes("|") && !/^\s*\|/.test(head)) return false;
  return splitRow(head).length === splitRow(delim).length;
}

/**
 * @param {string[]} lines
 * @param {any} ctx
 * @returns {any[]}
 */
function parseBlocks(lines, ctx) {
  const out = [];
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const line = lines[i];
    if (isBlank(line)) { i++; continue; }
    let m;

    if ((m = reFence.exec(line)) && !(m[2][0] === "`" && m[3].includes("`"))) {
      const indent = m[1].length, fch = m[2][0], flen = m[2].length;
      const lang = m[3].trim().split(/\s+/)[0] || "";
      const close = new RegExp(`^ {0,3}${fch === "`" ? "`" : "~"}{${flen},}[ \\t]*$`);
      const body = [];
      i++;
      while (i < n) {
        if (close.test(lines[i])) { i++; break; }
        body.push(lines[i].slice(Math.min(indent, indentOf(lines[i]))));
        i++;
      }
      out.push({ type: "code", lang, text: body.join("\n") });
      continue;
    }

    if ((m = reAtx.exec(line))) {
      const text = m[2].replace(/(?:^|[ \t]+)#+[ \t]*$/, "").trim();
      out.push({ type: "heading", level: m[1].length, text });
      i++;
      continue;
    }

    if (reComment.test(line)) {
      const inc = reInclude.exec(line);
      if (inc) {
        const got = ctx.include && ctx.depth < 4 ? ctx.include(inc[1], ctx.base) : null;
        if (got) {
          const saved = ctx.base;
          ctx.base = got.base;
          ctx.depth++;
          const blocks = parseBlocks(collectRefs(prepare(got.text), ctx), ctx);
          ctx.depth--;
          ctx.base = saved;
          out.push({ type: "include", base: got.base, blocks });
        }
        i++;
        continue;
      }
      const start = line.indexOf("<!--") + 4;
      let j = i;
      if (!line.includes("-->", start)) { j++; while (j < n && !lines[j].includes("-->")) j++; }
      i = j + 1;
      continue;
    }

    if (reHr.test(line)) { out.push({ type: "hr" }); i++; continue; }

    if (reQuote.test(line)) {
      const buf = [];
      while (i < n) {
        const l = lines[i];
        if (reQuote.test(l)) { buf.push(l.replace(reQuote, "")); i++; continue; }
        if (!isBlank(l) && buf.length && !isBlank(buf[buf.length - 1]) && !interrupts(l)) { buf.push(l); i++; continue; }
        break;
      }
      let alert = null;
      const firstIdx = buf.findIndex(l => !isBlank(l));
      if (firstIdx >= 0) {
        const a = reAlert.exec(buf[firstIdx].trim());
        if (a) { alert = a[1].toLowerCase(); buf.splice(firstIdx, 1); }
      }
      out.push({ type: "quote", alert, blocks: parseBlocks(buf, ctx) });
      continue;
    }

    const first = listMarker(line);
    if (first) {
      const items = [];
      let loose = false;
      while (i < n) {
        const mk = listMarker(lines[i]);
        if (!mk || mk.ordered !== first.ordered || mk.ch !== first.ch || reHr.test(lines[i])) break;
        const body = [mk.first];
        i++;
        while (i < n) {
          const l = lines[i];
          if (isBlank(l)) { body.push(""); i++; continue; }
          if (indentOf(l) >= mk.content) { body.push(l.slice(mk.content)); i++; continue; }
          // Not indented enough: a lazy paragraph continuation, or the end of this item.
          if (isBlank(body[body.length - 1]) || interrupts(l) || listMarker(l)) break;
          body.push(l);
          i++;
        }
        let trailing = 0;
        while (body.length && isBlank(body[body.length - 1])) { body.pop(); trailing++; }
        let task = null;
        const t = /^\[([ xX])\][ \t]+/.exec(body[0] || "");
        if (t) { task = t[1] !== " " ? "done" : "open"; body[0] = body[0].slice(t[0].length); }
        if (blankSeparatesTop(body)) loose = true;
        const next = i < n ? listMarker(lines[i]) : null;
        const continues = !!next && next.ordered === first.ordered && next.ch === first.ch && !reHr.test(lines[i]);
        if (trailing && continues) loose = true;
        items.push({ task, blocks: parseBlocks(body, ctx) });
        if (!continues) break;
      }
      out.push({ type: "list", ordered: first.ordered, start: first.start, loose, items });
      continue;
    }

    if (tableAt(lines, i)) {
      const head = splitRow(lines[i]);
      const align = splitRow(lines[i + 1]).map(c => {
        const l = c.startsWith(":"), r = c.endsWith(":");
        return l && r ? "center" : r ? "right" : l ? "left" : "";
      });
      i += 2;
      const rows = [];
      while (i < n && !isBlank(lines[i]) && !interrupts(lines[i])) {
        const cells = splitRow(lines[i]);
        rows.push(head.map((_, k) => cells[k] ?? ""));
        i++;
      }
      out.push({ type: "table", head, align, rows });
      continue;
    }

    // A paragraph, or a setext heading if an underline follows.
    const buf = [line.replace(/^[ \t]+/, "")];
    i++;
    let setext = 0;
    while (i < n) {
      const l = lines[i];
      if (isBlank(l)) break;
      if (reSetext1.test(l)) { setext = 1; i++; break; }
      if (reSetext2.test(l)) { setext = 2; i++; break; }
      if (interrupts(l) || tableAt(lines, i)) break;
      buf.push(l.replace(/^[ \t]+/, ""));
      i++;
    }
    const text = buf.join("\n").replace(/[ \t]+$/, "");
    out.push(setext ? { type: "heading", level: setext, text } : { type: "para", text });
  }
  return out;
}

/** Whether a blank line separates two top-level blocks of a list item (which makes it loose). */
function blankSeparatesTop(/** @type {string[]} */ body) {
  /** @type {string | null} */
  let fence = null;
  for (let k = 0; k < body.length; k++) {
    const l = body[k];
    const f = reFence.exec(l);
    if (f && indentOf(l) === 0) {
      if (!fence) fence = f[2][0];
      else if (f[2][0] === fence) fence = null;
      continue;
    }
    if (!fence && k > 0 && isBlank(l) && !isBlank(body[k + 1]) && indentOf(body[k + 1]) === 0) return true;
  }
  return false;
}

/**
 * @param {any[]} blocks
 * @param {any} ctx
 * @param {boolean} tight paragraphs render without <p> (a tight list item)
 * @returns {string}
 */
function renderBlocks(blocks, ctx, tight) {
  const out = [];
  for (const b of blocks) {
    switch (b.type) {
      case "para": {
        const html = renderInline(b.text, ctx);
        out.push(tight ? html : `<p>${html}</p>`);
        break;
      }
      case "heading": {
        const nodes = parseInlines(b.text, ctx);
        const text = nodesToText(nodes).trim();
        const id = uniqueSlug(text, ctx);
        ctx.headings.push({ level: b.level, text, id });
        const anchor = b.level >= 2 && b.level <= 4 ? `<a class="anchor" href="#${escapeHtml(encodeURIComponent(id))}" aria-hidden="true" tabindex="-1">#</a>` : "";
        out.push(`<h${b.level} id="${escapeHtml(id)}">${nodesToHtml(nodes, ctx)}${anchor}</h${b.level}>`);
        break;
      }
      case "code": {
        const lang = /^[\w+#.-]+$/.test(b.lang) ? b.lang : "";
        const cls = lang ? ` class="language-${escapeHtml(lang)}"` : "";
        out.push(`<pre><code${cls}>${escapeHtml(b.text)}${b.text ? "\n" : ""}</code></pre>`);
        break;
      }
      case "hr": out.push("<hr>"); break;
      case "quote": {
        const inner = renderBlocks(b.blocks, ctx, false);
        if (b.alert) {
          const label = ALERT_LABEL[b.alert] || b.alert[0].toUpperCase() + b.alert.slice(1);
          out.push(`<blockquote class="callout callout-${b.alert}">\n<p class="callout-title">${label}</p>\n${inner}\n</blockquote>`);
        } else out.push(`<blockquote>\n${inner}\n</blockquote>`);
        break;
      }
      case "list": {
        const tag = b.ordered ? "ol" : "ul";
        const start = b.ordered && b.start !== 1 ? ` start="${b.start}"` : "";
        const hasTask = b.items.some((/** @type {any} */ it) => it.task);
        const items = b.items.map((/** @type {any} */ it) => {
          const box = it.task ? `<input type="checkbox" disabled${it.task === "done" ? " checked" : ""}> ` : "";
          const inner = renderBlocks(it.blocks, ctx, !b.loose);
          const cls = it.task ? ` class="task"` : "";
          return b.loose ? `<li${cls}>${box}\n${inner}\n</li>` : `<li${cls}>${box}${inner}</li>`;
        });
        out.push(`<${tag}${start}${hasTask ? ` class="tasks"` : ""}>\n${items.join("\n")}\n</${tag}>`);
        break;
      }
      case "table": {
        const al = (/** @type {number} */ k) => (b.align[k] ? ` style="text-align:${b.align[k]}"` : "");
        const head = b.head.map((/** @type {string} */ c, /** @type {number} */ k) => `<th${al(k)}>${renderInline(c, ctx)}</th>`).join("");
        const rows = b.rows.map((/** @type {string[]} */ r) => `<tr>${r.map((c, k) => `<td${al(k)}>${renderInline(c, ctx)}</td>`).join("")}</tr>`);
        out.push(`<div class="table-wrap"><table>\n<thead><tr>${head}</tr></thead>\n${rows.length ? `<tbody>\n${rows.join("\n")}\n</tbody>\n` : ""}</table></div>`);
        break;
      }
      case "include": {
        const saved = ctx.base;
        ctx.base = b.base;
        const inner = renderBlocks(b.blocks, ctx, false);
        ctx.base = saved;
        if (inner) out.push(inner);
        break;
      }
    }
  }
  return out.join("\n");
}

/** @param {string} text @param {any} ctx */
function uniqueSlug(text, ctx) {
  const base = slugify(text) || "section";
  let id = base;
  for (let k = 1; ctx.slugs.has(id); k++) id = `${base}-${k}`;
  ctx.slugs.set(id, 1);
  return id;
}

// ---- inline ------------------------------------------------------------------------------------

/** @param {string} src @param {any} ctx */
function renderInline(src, ctx) {
  return nodesToHtml(parseInlines(src, ctx), ctx);
}

/** @param {string} s */
function unescapeMd(s) {
  return s.replace(/\\([!-/:-@[-`{-~])/g, "$1");
}

/** @param {string} before @param {string} after @param {string} ch */
function flanking(before, after, ch) {
  const ws = (/** @type {string} */ s) => /\s/.test(s);
  const pu = (/** @type {string} */ s) => PUNCT.test(s);
  const left = !ws(after) && (!pu(after) || ws(before) || pu(before));
  const right = !ws(before) && (!pu(before) || ws(after) || pu(after));
  if (ch === "_") return { open: left && (!right || pu(before)), close: right && (!left || pu(after)) };
  return { open: left, close: right };
}

/**
 * The `(dest "title")` after a link's closing bracket.
 * @param {string} src @param {number} p index of the `(`
 */
function parseLinkTail(src, p) {
  if (src[p] !== "(") return null;
  const n = src.length;
  let j = p + 1;
  const skip = () => { while (j < n && /\s/.test(src[j])) j++; };
  skip();
  let href = "";
  if (src[j] === "<") {
    const k = src.indexOf(">", j);
    if (k < 0 || src.slice(j + 1, k).includes("\n")) return null;
    href = src.slice(j + 1, k);
    j = k + 1;
  } else {
    let depth = 0;
    const s = j;
    while (j < n) {
      const ch = src[j];
      if (ch === "\\" && j + 1 < n) { j += 2; continue; }
      if (/\s/.test(ch)) break;
      if (ch === "(") depth++;
      else if (ch === ")") { if (depth === 0) break; depth--; }
      j++;
    }
    href = src.slice(s, j);
  }
  skip();
  let title;
  if (src[j] === '"' || src[j] === "'" || (src[j] === "(" && j > p + 1)) {
    const close = src[j] === "(" ? ")" : src[j];
    let k = j + 1;
    while (k < n && src[k] !== close) { if (src[k] === "\\") k++; k++; }
    if (k >= n) return null;
    title = unescapeMd(src.slice(j + 1, k));
    j = k + 1;
    skip();
  }
  if (src[j] !== ")") return null;
  return { href: unescapeMd(href), title, end: j + 1 };
}

/**
 * @param {string} src
 * @param {any} ctx
 * @returns {any[]}
 */
function parseInlines(src, ctx) {
  /** @type {any[]} */
  const nodes = [];
  /** @type {{ idx: number, image: boolean, active: boolean, pos: number }[]} */
  const brackets = [];
  let text = "";
  const flush = () => { if (text) { nodes.push({ t: "text", v: text }); text = ""; } };
  const n = src.length;
  let i = 0;
  while (i < n) {
    const c = src[i];
    if (c === "\\") {
      const nx = src[i + 1];
      if (nx === "\n") { flush(); nodes.push({ t: "br" }); i += 2; while (src[i] === " ") i++; continue; }
      if (nx !== undefined && ESCAPABLE.includes(nx)) { text += nx; i += 2; continue; }
      text += c; i++; continue;
    }
    if (c === "`") {
      const run = /^`+/.exec(src.slice(i))?.[0] || "`";
      let j = i + run.length, found = -1;
      while (j < n) {
        const k = src.indexOf("`", j);
        if (k < 0) break;
        const r = /^`+/.exec(src.slice(k))?.[0] || "`";
        if (r.length === run.length) { found = k; break; }
        j = k + r.length;
      }
      if (found < 0) { text += run; i += run.length; continue; }
      let code = src.slice(i + run.length, found).replace(/\n/g, " ");
      if (code.length >= 2 && code[0] === " " && code[code.length - 1] === " " && /[^ ]/.test(code)) code = code.slice(1, -1);
      flush();
      nodes.push({ t: "code", v: code });
      i = found + run.length;
      continue;
    }
    if (c === "<") {
      if (src.startsWith("<!--", i)) {
        const k = src.indexOf("-->", i + 4);
        if (k >= 0) { i = k + 3; continue; }
      }
      const rest = src.slice(i);
      const auto = /^<([a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^\s<>]*)>/.exec(rest);
      if (auto) { flush(); nodes.push({ t: "autolink", href: auto[1], v: auto[1] }); i += auto[0].length; continue; }
      const mail = /^<([a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*)>/.exec(rest);
      if (mail) { flush(); nodes.push({ t: "autolink", href: "mailto:" + mail[1], v: mail[1] }); i += mail[0].length; continue; }
      text += c; i++; continue;
    }
    if (c === "&") {
      const ent = /^&(?:#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[A-Za-z][A-Za-z0-9]{1,31});/.exec(src.slice(i, i + 40));
      if (ent) { flush(); nodes.push({ t: "entity", v: ent[0] }); i += ent[0].length; continue; }
      text += c; i++; continue;
    }
    if (c === "\n") {
      const sp = / {2,}$/.exec(text);
      if (sp) { text = text.slice(0, -sp[0].length); flush(); nodes.push({ t: "br" }); }
      else text = text.replace(/ +$/, "") + "\n";
      i++;
      while (src[i] === " ") i++;
      continue;
    }
    if (c === "*" || c === "_" || c === "~") {
      let j = i;
      while (src[j] === c) j++;
      const run = j - i;
      if (c === "~" && run > 2) { text += src.slice(i, j); i = j; continue; }
      const f = flanking(i === 0 ? " " : src[i - 1], j >= n ? " " : src[j], c);
      flush();
      nodes.push({ t: "delim", ch: c, n: run, orig: run, open: f.open, close: f.close });
      i = j;
      continue;
    }
    if (c === "!" && src[i + 1] === "[") {
      flush();
      brackets.push({ idx: nodes.length, image: true, active: true, pos: i + 2 });
      nodes.push({ t: "text", v: "![" });
      i += 2;
      continue;
    }
    if (c === "[") {
      flush();
      brackets.push({ idx: nodes.length, image: false, active: true, pos: i + 1 });
      nodes.push({ t: "text", v: "[" });
      i++;
      continue;
    }
    if (c === "]") {
      flush();
      const op = brackets.pop();
      if (!op || !op.active) { nodes.push({ t: "text", v: "]" }); i++; continue; }
      /** @type {{ href: string, title?: string, base?: string } | null} */
      let dest = null;
      let after = i + 1;
      const tail = parseLinkTail(src, i + 1);
      if (tail) { dest = tail; after = tail.end; }
      else {
        const full = /^\[([^\]]*)\]/.exec(src.slice(i + 1));
        const label = full && full[1] ? full[1] : src.slice(op.pos, i);
        const def = ctx.refs.get(normLabel(label));
        if (def) { dest = def; after = full ? i + 1 + full[0].length : i + 1; }
      }
      if (!dest) { nodes.push({ t: "text", v: "]" }); i++; continue; }
      const children = nodes.splice(op.idx + 1);
      nodes.pop();
      processEmphasis(children);
      nodes.push({ t: op.image ? "img" : "link", href: dest.href, title: dest.title, base: dest.base, children });
      if (!op.image) for (const b of brackets) if (!b.image) b.active = false;
      i = after;
      continue;
    }
    text += c;
    i++;
  }
  flush();
  processEmphasis(nodes);
  return nodes;
}

/** CommonMark's delimiter matching, on one list of sibling nodes. @param {any[]} nodes */
function processEmphasis(nodes) {
  let i = 0;
  while (i < nodes.length) {
    const closer = nodes[i];
    if (closer.t !== "delim" || !closer.close || closer.n === 0) { i++; continue; }
    let found = -1;
    for (let j = i - 1; j >= 0; j--) {
      const op = nodes[j];
      if (op.t !== "delim" || op.ch !== closer.ch || !op.open || op.n === 0) continue;
      if (closer.ch === "~") { if (op.n !== closer.n) continue; }
      else if ((op.close || closer.open) && (op.orig + closer.orig) % 3 === 0 && !(op.orig % 3 === 0 && closer.orig % 3 === 0)) continue;
      found = j;
      break;
    }
    if (found < 0) { i++; continue; }
    const op = nodes[found];
    const use = closer.ch === "~" ? closer.n : op.n >= 2 && closer.n >= 2 ? 2 : 1;
    const t = closer.ch === "~" ? "del" : use === 2 ? "strong" : "em";
    const wrap = { t, children: nodes.slice(found + 1, i) };
    op.n -= use;
    closer.n -= use;
    nodes.splice(found + 1, i - found - 1, wrap);
    i = found + 2;
    if (op.n === 0) { nodes.splice(found, 1); i--; }
    if (closer.n === 0) nodes.splice(i, 1);
  }
}

/** @param {string} href */
function safeHref(href) {
  const h = href.trim();
  if (/^(?:javascript|vbscript|file):/i.test(h.replace(/[\s\u0000-\u001f]/g, ""))) return "#";
  if (/^data:/i.test(h) && !/^data:image\/(?:png|gif|jpeg|webp);/i.test(h)) return "#";
  return h;
}

/** @param {any[]} nodes @param {any} ctx @returns {string} */
function nodesToHtml(nodes, ctx) {
  let out = "";
  for (const nd of nodes) {
    switch (nd.t) {
      case "text": out += escapeHtml(nd.v); break;
      case "code": out += `<code>${escapeHtml(nd.v)}</code>`; break;
      case "br": out += "<br>\n"; break;
      case "entity": out += nd.v; break;
      case "delim": out += escapeHtml(nd.ch.repeat(nd.n)); break;
      case "em": out += `<em>${nodesToHtml(nd.children, ctx)}</em>`; break;
      case "strong": out += `<strong>${nodesToHtml(nd.children, ctx)}</strong>`; break;
      case "del": out += `<del>${nodesToHtml(nd.children, ctx)}</del>`; break;
      case "autolink": {
        const url = safeHref(nd.href);
        ctx.links.push({ href: nd.href, url, base: ctx.base, kind: "autolink" });
        out += `<a href="${escapeHtml(url)}">${escapeHtml(nd.v)}</a>`;
        break;
      }
      case "link":
      case "img": {
        const base = nd.base ?? ctx.base;
        const url = safeHref(ctx.resolveLink(nd.href, base));
        ctx.links.push({ href: nd.href, url, base, kind: nd.t === "img" ? "image" : "link" });
        const title = nd.title ? ` title="${escapeHtml(nd.title)}"` : "";
        if (nd.t === "img") out += `<img src="${escapeHtml(url)}" alt="${escapeHtml(nodesToText(nd.children))}"${title} loading="lazy">`;
        else out += `<a href="${escapeHtml(url)}"${title}>${nodesToHtml(nd.children, ctx)}</a>`;
        break;
      }
    }
  }
  return out;
}

/** Plain text of inline nodes, entities decoded. @param {any[]} nodes @returns {string} */
function nodesToText(nodes) {
  let out = "";
  for (const nd of nodes) {
    if (nd.t === "text" || nd.t === "code" || nd.t === "autolink") out += nd.v;
    else if (nd.t === "entity") out += decodeEntities(nd.v);
    else if (nd.t === "delim") out += nd.ch.repeat(nd.n);
    else if (nd.t === "br") out += " ";
    else if (nd.children) out += nodesToText(nd.children);
  }
  return out;
}

const NAMED = /** @type {Record<string, string>} */ ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", middot: "·", hellip: "…", mdash: "—", ndash: "–", rarr: "→", larr: "←", copy: "©", times: "×", bull: "•" });

/** Decode the entities HTML text can carry (for search text and titles). @param {string} s */
export function decodeEntities(s) {
  return s.replace(/&(#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[A-Za-z][A-Za-z0-9]{1,31});/g, (all, e) => {
    if (e[0] === "#") {
      const cp = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : "�";
    }
    return NAMED[e] ?? all;
  });
}
