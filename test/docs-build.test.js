// @ts-check
// scripts/build-docs and scripts/lib/docs: the Markdown renderer, front matter, the URL scheme,
// and a whole build of a small docs tree in a temp folder.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tempHome } from "./helpers.js";
import { renderMarkdown, slugify, colorsMarkdown, isDirective, directive, DEMOS } from "../scripts/lib/docs/markdown.js";
import { parseFrontMatter, listOf } from "../scripts/lib/docs/frontmatter.js";
import { loadDocs, pageUrl, htmlFile, resolveDocLink, isUnpublished } from "../scripts/lib/docs/load.js";
import { build, loadPalette, pngSize } from "../scripts/lib/docs/build.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const md = (/** @type {string} */ s, opts = {}) => renderMarkdown(s, opts).html;

/** The first 33 bytes of a PNG: signature and IHDR, which is all pngSize reads. */
function png(/** @type {number} */ w, /** @type {number} */ h) {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write("IHDR", 12, "latin1");
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b;
}

// ---- front matter ------------------------------------------------------------------------------

test("front matter: fields, trailing comments, quotes and lists", () => {
  const { data, body } = parseFrontMatter([
    "---",
    "title: The Capsule",
    "summary: \"Press Control twice: #1 way in.\"",
    "audience: users, builders            # users | builders | operators | agents",
    "owner: capsule-pro",
    "status: stable             # stable | draft | planned",
    "tags: [a, b]",
    "also:",
    "  - one",
    "  - two",
    "---",
    "# Body",
    "",
  ].join("\r\n"));
  assert.equal(data.title, "The Capsule");
  assert.equal(data.summary, "Press Control twice: #1 way in.");
  assert.deepEqual(listOf(data.audience), ["users", "builders"]);
  assert.equal(data.owner, "capsule-pro");
  assert.equal(data.status, "stable");
  assert.deepEqual(data.tags, ["a", "b"]);
  assert.deepEqual(data.also, ["one", "two"]);
  assert.equal(body, "# Body\n");
});

test("front matter: a page without it is all body", () => {
  const r = parseFrontMatter("# Vyre specification\n\ntext\n");
  assert.deepEqual(r.data, {});
  assert.equal(r.body, "# Vyre specification\n\ntext\n");
  // A horizontal rule later on is not front matter.
  assert.deepEqual(parseFrontMatter("text\n---\nmore\n---\n").data, {});
});

test("front matter: a redirect stub", () => {
  const { data } = parseFrontMatter("---\ntitle: Specification\nredirect: architecture/spec.md\n---\n\nMoved.\n");
  assert.equal(data.redirect, "architecture/spec.md");
});

// ---- blocks ------------------------------------------------------------------------------------

test("headings: ATX and setext, GitHub-style unique ids, anchors on h2 to h4", () => {
  const r = renderMarkdown("# ADR 0004 · Presence\n\n## The problem ##\n\n## The problem\n\nSub\n---\n\nTop\n===\n\n#nospace\n");
  assert.deepEqual(r.headings.map(h => [h.level, h.id]), [[1, "adr-0004--presence"], [2, "the-problem"], [2, "the-problem-1"], [2, "sub"], [1, "top"]]);
  assert.match(r.html, /<h2 id="the-problem">The problem<a class="anchor" href="#the-problem"/);
  assert.match(r.html, /<h1 id="adr-0004--presence">ADR 0004 · Presence<\/h1>/);
  assert.match(r.html, /<p>#nospace<\/p>/);
  assert.equal(slugify("5. Security & the floor"), "5-security--the-floor");
});

test("paragraphs, soft and hard breaks", () => {
  assert.equal(md("one\ntwo"), "<p>one\ntwo</p>\n");
  assert.equal(md("one  \ntwo"), "<p>one<br>\ntwo</p>\n");
  assert.equal(md("one\\\ntwo"), "<p>one<br>\ntwo</p>\n");
  assert.equal(md("a\n\n\nb"), "<p>a</p>\n<p>b</p>\n");
});

test("fenced code: backticks and tildes, language class, content escaped, never parsed", () => {
  assert.equal(md("```sh\necho \"<hi>\" && ls *x*\n```"), `<pre><code class="language-sh">echo &quot;&lt;hi&gt;&quot; &amp;&amp; ls *x*\n</code></pre>\n`);
  assert.equal(md("~~~\n```\ninner\n```\n~~~"), "<pre><code>```\ninner\n```\n</code></pre>\n");
  assert.equal(md("````md\n# not a heading\n````"), `<pre><code class="language-md"># not a heading\n</code></pre>\n`);
  // Unclosed runs to the end.
  assert.equal(md("```\nopen"), "<pre><code>open\n</code></pre>\n");
  // Indented fence content loses the fence's indent.
  assert.equal(md("  ```\n  a\n    b\n  ```"), "<pre><code>a\n  b\n</code></pre>\n");
});

test("lists: bullets, ordered with start, nesting, tight and loose, multi-paragraph items, tasks", () => {
  assert.equal(md("- a\n- b\n  - c\n- d"), "<ul>\n<li>a</li>\n<li>b\n<ul>\n<li>c</li>\n</ul></li>\n<li>d</li>\n</ul>\n");
  assert.equal(md("3. x\n4. y"), `<ol start="3">\n<li>x</li>\n<li>y</li>\n</ol>\n`);
  const loose = md("1. First\n   continues\n\n   Second para\n2. Next");
  assert.match(loose, /<li>\n<p>First\ncontinues<\/p>\n<p>Second para<\/p>\n<\/li>/);
  assert.match(loose, /<li>\n<p>Next<\/p>\n<\/li>/);
  // Lazy continuation (a wrapped line not indented) stays in the item.
  assert.equal(md("- one\ntwo\n- three"), "<ul>\n<li>one\ntwo</li>\n<li>three</li>\n</ul>\n");
  // A code block inside an item.
  assert.match(md("- run:\n\n  ```sh\n  vyre up\n  ```"), /<li>\n<p>run:<\/p>\n<pre><code class="language-sh">vyre up\n<\/code><\/pre>\n<\/li>/);
  // A different bullet starts a new list; `* * *` is a rule, not an item.
  assert.equal((md("- a\n+ b").match(/<ul>/g) || []).length, 2);
  assert.match(md("- a\n\n* * *"), /<\/ul>\n<hr>/);
  const tasks = md("- [x] done\n- [ ] open");
  assert.match(tasks, /<ul class="tasks">/);
  assert.match(tasks, /<li class="task"><input type="checkbox" disabled checked> done<\/li>/);
  // A number mid-paragraph does not start a list.
  assert.equal(md("It was\n2024. A year."), "<p>It was\n2024. A year.</p>\n");
});

test("blockquotes, lazy lines, nesting and alerts", () => {
  assert.equal(md("> quote *x*\nlazy"), "<blockquote>\n<p>quote <em>x</em>\nlazy</p>\n</blockquote>\n");
  assert.equal(md("> a\n>\n> > b"), "<blockquote>\n<p>a</p>\n<blockquote>\n<p>b</p>\n</blockquote>\n</blockquote>\n");
  assert.match(md("> [!WARNING]\n> Deletes 214 files."), /<blockquote class="callout callout-warning">\n<p class="callout-title">Warning<\/p>\n<p>Deletes 214 files.<\/p>/);
  assert.match(md("> [!GAP]\n> Not wired yet."), /<blockquote class="callout callout-gap">\n<p class="callout-title">Known gap<\/p>\n<p>Not wired yet.<\/p>/);
});

test("tables: alignment, escaped pipes, pipes in code, ragged rows", () => {
  const h = md("| Tool | Count | Where |\n|:--|--:|:-:|\n| `a|b` | 2 \\| 3 | x |\n| short |");
  assert.match(h, /<th style="text-align:left">Tool<\/th><th style="text-align:right">Count<\/th><th style="text-align:center">Where<\/th>/);
  assert.match(h, /<td style="text-align:left"><code>a\|b<\/code><\/td><td style="text-align:right">2 \| 3<\/td>/);
  assert.match(h, /<tr><td style="text-align:left">short<\/td><td style="text-align:right"><\/td><td style="text-align:center"><\/td><\/tr>/);
  assert.match(h, /^<div class="table-wrap"><table>/);
  // Not a table without the delimiter row.
  assert.equal(md("a | b\nc | d"), "<p>a | b\nc | d</p>\n");
  // A table right after a paragraph line.
  assert.match(md("Intro:\n| a |\n| - |\n| 1 |"), /<p>Intro:<\/p>\n<div class="table-wrap">/);
});

test("horizontal rules", () => {
  assert.equal(md("a\n\n---\n\nb"), "<p>a</p>\n<hr>\n<p>b</p>\n");
  assert.equal(md("***"), "<hr>\n");
  assert.equal(md("_ _ _"), "<hr>\n");
});

test("alerts: a title after the marker, [!SNAG] with an anchor, [!WHY] as details", () => {
  const titled = md("> [!WARNING] The HTTPS switch is off\n> Turn it on.");
  assert.match(titled, /<blockquote class="callout callout-warning">\n<p class="callout-title">Warning<\/p>\n<p class="callout-heading">The HTTPS switch is off<\/p>\n<p>Turn it on.<\/p>/);
  // Without a title, the markup is what it was.
  assert.equal(md("> [!NOTE]\n> x"), `<blockquote class="callout callout-note">\n<p class="callout-title">Note</p>\n<p>x</p>\n</blockquote>\n`);

  const r = renderMarkdown("## Page not found\n\n> [!SNAG] Page not found\n> Check the `address`.\n\n> [!SNAG] The `vyre` command is missing\n> Open a new terminal.");
  assert.match(r.html, /<blockquote class="callout callout-snag" id="page-not-found-1">\n<p class="callout-title">If this happens<\/p>\n<p class="callout-heading">Page not found<a class="anchor" href="#page-not-found-1"/);
  assert.match(r.html, /id="the-vyre-command-is-missing">[\s\S]*<code>vyre<\/code> command is missing/);
  assert.deepEqual(r.snags, [
    { text: "Page not found", id: "page-not-found-1", body: "Check the address." },
    { text: "The vyre command is missing", id: "the-vyre-command-is-missing", body: "Open a new terminal." },
  ], "a snag's id comes from the same pool as the headings");
  assert.deepEqual(r.headings.map(h => h.id), ["page-not-found"], "a snag is not a heading");

  const why = md("> [!WHY] Why a server of my own?\n> Your agents keep working when the Mac sleeps.");
  assert.match(why, /^<details class="callout callout-why">\n<summary><span class="callout-title">Why<\/span> <span class="why-q">Why a server of my own\?<\/span><\/summary>\n<div class="why-body">\n<p>Your agents keep working/);
  assert.doesNotMatch(why, /<details[^>]* open/, "collapsed by default");
});

test("code: output blocks are labelled, shell prompts and console output are marked", () => {
  assert.equal(md("```output\n  Vyre is ready.\n```"),
    `<div class="output">\n<p class="output-label">You should see</p>\n<pre><code class="language-output">  Vyre is ready.\n</code></pre>\n</div>\n`);
  assert.equal(md("```sh\n$ vyre up\nvyre status\n```"), `<pre><code class="language-sh"><span class="gp">$ </span>vyre up\nvyre status\n</code></pre>\n`);
  const con = md("```console\n$ vyre up --box \\\n    --yes\nStarting vyred\n$ vyre status\nup\n```");
  assert.equal(con, `<pre><code class="language-console"><span class="gp">$ </span>vyre up --box \\\n    --yes\n<span class="go">Starting vyred\n</span><span class="gp">$ </span>vyre status\n<span class="go">up\n</span></code></pre>\n`);
  // What the Copy button copies: the text without .gp and .go.
  const copied = con.replace(/<span class="(?:gp|go)">[\s\S]*?<\/span>/g, "").replace(/<[^>]+>/g, "").replace(/\n+$/, "");
  assert.equal(copied, "vyre up --box \\\n    --yes\nvyre status");
  // A console block with no prompts at all is copied whole.
  assert.equal(md("```console\nvyre up\n```"), `<pre><code class="language-console">vyre up\n</code></pre>\n`);
});

test("tabs: stacked labelled sections, headings with anchors, nesting and fences inside", () => {
  const r = renderMarkdown([
    "Pick one.", "",
    "::: tabs",
    "::: tab On a server",
    "### Check it works", "",
    "```md", "::: tab Not a tab", ":::", "```",
    "::: tab On this Mac",
    "::: demo capsule",
    "Fallback.",
    ":::",
    "### Check it works",
    ":::",
    "After.",
  ].join("\n"));
  assert.match(r.html, /^<p>Pick one\.<\/p>\n<div class="tabs">\n<section class="tab-panel" data-tab="On a server">\n<p class="tab-label">On a server<\/p>\n<h3 id="check-it-works">/);
  assert.match(r.html, /<code class="language-md">::: tab Not a tab\n:::\n<\/code>/, "container lines in a fence are code");
  assert.match(r.html, /<section class="tab-panel" data-tab="On this Mac">\n<p class="tab-label">On this Mac<\/p>\n<div class="demo" data-demo="capsule">\n<p>Fallback\.<\/p>\n<\/div>\n<h3 id="check-it-works-1">/);
  assert.match(r.html, /<\/section>\n<\/div>\n<p>After\.<\/p>\n$/);
  assert.deepEqual(r.headings.map(h => [h.id, h.tab]), [["check-it-works", "On a server"], ["check-it-works-1", "On this Mac"]], "a heading in a tab knows its tab");
  assert.equal((r.html.match(/<section /g) || []).length, 2);
  // A paragraph ends at a container line; an unclosed group runs to the end.
  assert.match(md("text\n::: tabs\n::: tab A\na"), /^<p>text<\/p>\n<div class="tabs">\n<section class="tab-panel" data-tab="A">/);
  // Labels are escaped.
  assert.match(md("::: tabs\n::: tab <you>\nx\n:::"), /data-tab="&lt;you&gt;">\n<p class="tab-label">&lt;you&gt;<\/p>/);
});

test("demos: a container with its fallback, and the widget names the page uses", () => {
  const r = renderMarkdown("::: demo onboarding\n1. ![Your name, and your assistant's](shots/you.png \"You\")\n2. ![Claude Code](shots/claude.png)\n:::\n\n::: demo capsule\nx\n:::\n\n::: demo Capsule\ny\n:::");
  assert.match(r.html, /^<div class="demo" data-demo="onboarding">\n<ol>\n<li><figure class="shot"><img src="shots\/you.png" alt="Your name, and your assistant's" loading="lazy"><figcaption>You<\/figcaption><\/figure><\/li>/);
  assert.deepEqual(r.demos, ["capsule", "onboarding"]);
  assert.deepEqual(DEMOS, ["capsule", "onboarding"]);
  assert.match(md("::: demo <x>\nfallback\n:::"), /<div class="demo" data-demo="">\n<p>fallback<\/p>/, "a bad name mounts nothing and keeps the fallback");
});

test("figures: an image alone is a figure with a caption, sized, with a dark sibling", () => {
  const image = (/** @type {string} */ href) => href === "shots/a.png" ? { width: 1280, height: 800, dark: { src: "/using/shots/a.dark.png", width: 1280, height: 800 } }
    : href === "shots/b.png" ? { width: 640, height: 400 } : null;
  const a = md("![The Deck's home screen](shots/a.png)", { image });
  assert.equal(a, `<figure class="shot"><img class="shot-light" src="shots/a.png" alt="The Deck's home screen" width="1280" height="800" loading="lazy">` +
    `<img class="shot-dark" src="/using/shots/a.dark.png" alt="The Deck's home screen" width="1280" height="800" loading="lazy">` +
    `<figcaption aria-hidden="true">The Deck's home screen</figcaption></figure>\n`);
  const b = md(`![Alt says what it shows](shots/b.png "Settings, Devices")`, { image });
  assert.equal(b, `<figure class="shot"><img src="shots/b.png" alt="Alt says what it shows" width="640" height="400" loading="lazy"><figcaption>Settings, Devices</figcaption></figure>\n`);
  // An image inside text stays inline, still sized and paired.
  assert.match(md("See ![a](shots/a.png) here", { image }), /^<p>See <img class="shot-light" [^>]*><img class="shot-dark" [^>]*> here<\/p>/);
  assert.equal(md("![x](nope.png)"), `<figure class="shot"><img src="nope.png" alt="x" loading="lazy"><figcaption aria-hidden="true">x</figcaption></figure>\n`);
});

test("colors: a directive renders the palette as swatches, and as a Markdown table", () => {
  const palette = { colors: { dark: { graphite: "#0E0D0C", "signal-wash": "rgba(198,243,107,0.12)", bad: "red;x:y" } }, use: { graphite: "Page ground." } };
  const html = md("<!-- colors: dark -->", { palette });
  assert.match(html, /<table class="swatches" data-colors="dark">/);
  assert.match(html, /<tr><td><span class="swatch" style="background:#0E0D0C" aria-hidden="true"><\/span><\/td><td><code>--graphite<\/code><\/td><td><code>#0E0D0C<\/code><\/td><td>Page ground\.<\/td><\/tr>/);
  assert.match(html, /style="background:rgba\(198,243,107,0\.12\)"/);
  assert.match(html, /<tr><td><\/td><td><code>--bad<\/code>/, "a value that is not a colour gets no style");
  assert.match(md("<!-- colors: light -->", { palette }), /class="swatch-none"/);
  assert.equal(md("```md\n<!-- colors: dark -->\n```", { palette }), "<pre><code class=\"language-md\">&lt;!-- colors: dark --&gt;\n</code></pre>\n");
  assert.equal(colorsMarkdown("dark", palette).split("\n").slice(0, 3).join("\n"), "| Token | Value | Use |\n| --- | --- | --- |\n| `--graphite` | `#0E0D0C` | Page ground. |");
  assert.equal(colorsMarkdown("light", palette), "");
});

test("directives: which lines are page syntax", () => {
  for (const l of ["::: tabs", "::: tab On a server", ":::", "::: demo capsule", "<!-- colors: dark -->", "::: nonsense"]) assert.ok(isDirective(l), l);
  for (const l of ["text ::: tabs", ":::tabs", "<!-- include: x.md -->", "> [!SNAG] x"]) assert.ok(!isDirective(l), l);
  assert.deepEqual(directive("::: tab On this Mac"), { kind: "tab", arg: "On this Mac" });
  assert.deepEqual(directive("::: tabs"), { kind: "tabs", arg: "" });
  assert.deepEqual(directive(":::"), { kind: "close", arg: "" });
  assert.deepEqual(directive("<!-- colors: light -->"), { kind: "colors", arg: "light" });
  assert.equal(directive("plain"), null);
});

test("theme: core/config/theme.js is the palette TOKENS.md draws, each colour valid and with a use", () => {
  const pal = loadPalette(REPO);
  assert.ok(pal, "core/config/theme.js loads");
  const tokens = fs.readFileSync(path.join(REPO, "docs/design/TOKENS.md"), "utf8");
  assert.match(tokens, /^<!-- colors: dark -->$/m);
  assert.match(tokens, /^<!-- colors: light -->$/m);
  assert.doesNotMatch(tokens, /^\| `--[a-z0-9-]+` \| `(#|rgba)/m, "no hand-copied colour table left");
  for (const mode of ["dark", "light"]) {
    assert.ok(Object.keys(pal.colors[mode]).length > 5, mode);
    for (const [k, v] of Object.entries(pal.colors[mode])) {
      assert.match(String(v), /^(#[0-9A-Fa-f]{3}|#[0-9A-Fa-f]{6}|rgba\(\d+,\d+,\d+,(0|1|0?\.\d+)\))$/, `${mode}.${k}`);
      assert.ok(pal.use[k], `a use for ${k}`);
    }
  }
});

test("pngSize: width and height from the header, null for anything else", t => {
  const dir = tempHome(t);
  fs.writeFileSync(path.join(dir, "a.png"), png(1440, 900));
  fs.writeFileSync(path.join(dir, "b.png"), "not a png at all, just text");
  assert.deepEqual(pngSize(path.join(dir, "a.png")), { width: 1440, height: 900 });
  assert.equal(pngSize(path.join(dir, "b.png")), null);
  assert.equal(pngSize(path.join(dir, "missing.png")), null);
});

// ---- inline ------------------------------------------------------------------------------------

test("emphasis and strong follow CommonMark delimiter rules", () => {
  assert.equal(md("*em* _em_ **strong** __strong__ ***both*** ~~gone~~"),
    "<p><em>em</em> <em>em</em> <strong>strong</strong> <strong>strong</strong> <em><strong>both</strong></em> <del>gone</del></p>\n");
  assert.equal(md("snake_case_name and 2*3*4"), "<p>snake_case_name and 2<em>3</em>4</p>\n");
  assert.equal(md("a * b * c"), "<p>a * b * c</p>\n");
  assert.equal(md("**bold *nested* bold**"), "<p><strong>bold <em>nested</em> bold</strong></p>\n");
  assert.equal(md("**unclosed"), "<p>**unclosed</p>\n");
});

test("code spans: longer fences, stripped single spaces, no parsing inside", () => {
  assert.equal(md("`a *b* <c>`"), "<p><code>a *b* &lt;c&gt;</code></p>\n");
  assert.equal(md("`` a ` b ``"), "<p><code>a ` b</code></p>\n");
  assert.equal(md("`unclosed"), "<p>`unclosed</p>\n");
});

test("links, images, references, autolinks", () => {
  assert.equal(md(`[the spec](spec.md "Spec") ![mark](mark.svg)`), `<p><a href="spec.md" title="Spec">the spec</a> <img src="mark.svg" alt="mark" loading="lazy"></p>\n`);
  assert.equal(md("[a [b] c](x) [**bold**](<has space.md>)"), `<p><a href="x">a [b] c</a> <a href="has space.md"><strong>bold</strong></a></p>\n`);
  assert.equal(md("[docs][d] and [D]\n\n[d]: https://docs.vyre.run 'Docs'"), `<p><a href="https://docs.vyre.run" title="Docs">docs</a> and <a href="https://docs.vyre.run" title="Docs">D</a></p>\n`);
  assert.equal(md("<https://vyre.run/a?b=1&c=2> <alex@harlowlegal.example>"), `<p><a href="https://vyre.run/a?b=1&amp;c=2">https://vyre.run/a?b=1&amp;c=2</a> <a href="mailto:alex@harlowlegal.example">alex@harlowlegal.example</a></p>\n`);
  assert.equal(md("[not a link] and [x](javascript:alert(1))"), `<p>[not a link] and <a href="#">x</a></p>\n`);
  assert.equal(md("[a](b(c)d)"), `<p><a href="b(c)d">a</a></p>\n`);
});

test("escaping: raw HTML shown as text, comments dropped, backslash escapes, entities", () => {
  assert.equal(md("<script>alert('x')</script> <you>.vyre.run"), "<p>&lt;script&gt;alert('x')&lt;/script&gt; &lt;you&gt;.vyre.run</p>\n");
  assert.equal(md("<div>\nblock\n</div>"), "<p>&lt;div&gt;\nblock\n&lt;/div&gt;</p>\n");
  assert.equal(md("a <!-- hidden --> b"), "<p>a  b</p>\n");
  assert.equal(md("<!--\nmany\nlines\n-->\nafter"), "<p>after</p>\n");
  assert.equal(md("\\*not em\\* \\[not link\\] \\`x\\` \\q"), "<p>*not em* [not link] `x` \\q</p>\n");
  assert.equal(md("&amp; &copy; &#169; &#xA9; & AT&T"), "<p>&amp; &copy; &#169; &#xA9; &amp; AT&amp;T</p>\n");
  assert.equal(md(`a "quoted" 'word'`), "<p>a &quot;quoted&quot; 'word'</p>\n");
  // Attribute values are escaped too.
  assert.equal(md(`[x](a"onmouseover="b)`), `<p><a href="a&quot;onmouseover=&quot;b">x</a></p>\n`);
});

test("links: resolveLink rewrites and every link is returned", () => {
  const r = renderMarkdown("[p](../adr/0004-presence.md#decision) [e](https://vyre.run) <https://x.example> ![i](a.png) [s](#top)", {
    base: "using",
    resolveLink: (href, base) => (href.endsWith(".png") ? `/${base}/${href}` : href.replace(/^\.\.\/(.*)\.md/, "/$1")),
  });
  assert.match(r.html, /<a href="\/adr\/0004-presence#decision">p<\/a>/);
  assert.match(r.html, /<img src="\/using\/a.png"/);
  assert.deepEqual(r.links.map(l => [l.kind, l.href, l.url, l.base]), [
    ["link", "../adr/0004-presence.md#decision", "/adr/0004-presence#decision", "using"],
    ["link", "https://vyre.run", "https://vyre.run", "using"],
    ["autolink", "https://x.example", "https://x.example", "using"],
    ["image", "a.png", "/using/a.png", "using"],
    ["link", "#top", "#top", "using"],
  ]);
});

test("include: a comment line splices a file, with links resolved from its own folder", () => {
  const r = renderMarkdown("# Changelog\n\n<!-- include: ../CHANGELOG.md -->\n\nafter", {
    include: (p, base) => (p === "../CHANGELOG.md" && base === "" ? { text: "## Unreleased\n\n- see [spec](docs/SPEC.md)", base: ".." } : null),
    resolveLink: (href, base) => `${base}|${href}`,
  });
  assert.match(r.html, /<h2 id="unreleased">Unreleased/);
  assert.match(r.html, /<a href="\.\.\|docs\/SPEC.md">spec<\/a>/);
  assert.match(r.html, /<p>after<\/p>/);
  assert.equal(md("<!-- include: nope.md -->\ntext"), "<p>text</p>\n");
});

test("every Markdown file in docs/ and CHANGELOG.md renders", () => {
  const files = [path.join(REPO, "CHANGELOG.md")];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p); else if (e.name.endsWith(".md")) files.push(p);
    }
  })(path.join(REPO, "docs"));
  for (const f of files) {
    const { body } = parseFrontMatter(fs.readFileSync(f, "utf8"));
    const r = renderMarkdown(body);
    const prose = r.html.replace(/<pre>[\s\S]*?<\/pre>/g, "").replace(/<code>[\s\S]*?<\/code>/g, "");
    assert.doesNotMatch(prose, /\*\*|<(?!\/?(?:p|h[1-6]|a|em|strong|del|code|pre|ul|ol|li|blockquote|hr|br|img|table|thead|tbody|tr|th|td|div|input|figure|figcaption|details|summary|section|span)\b)/, path.relative(REPO, f));
  }
});

// ---- URL scheme --------------------------------------------------------------------------------

test("URL scheme: pretty URLs, index pages, output files, link targets", () => {
  assert.equal(pageUrl("index.md"), "/");
  assert.equal(pageUrl("using/capsule.md"), "/using/capsule");
  assert.equal(pageUrl("architecture/index.md"), "/architecture/");
  assert.equal(htmlFile("using/capsule.md"), "using/capsule.html");
  assert.equal(htmlFile("index.md"), "index.html");
  assert.deepEqual(resolveDocLink("../adr/0004-presence.md#decision", "using"), { kind: "doc", path: "adr/0004-presence.md", hash: "decision" });
  assert.deepEqual(resolveDocLink("../CHANGELOG.md", ""), { kind: "repo", path: "CHANGELOG.md", hash: "" });
  assert.deepEqual(resolveDocLink("docs/SPEC.md#3-x", ".."), { kind: "doc", path: "SPEC.md", hash: "3-x" });
  assert.equal(resolveDocLink("https://vyre.run", "").kind, "external");
  assert.equal(resolveDocLink("#top", "").kind, "anchor");
  assert.equal(resolveDocLink("/using/capsule", "").kind, "absolute");
  assert.ok(isUnpublished("work/docs.md") && isUnpublished("design/boards/x.md") && !isUnpublished("design/TOKENS.md"));
});

// ---- a whole build -----------------------------------------------------------------------------

/** A small docs tree: two sections, an ADR, a draft, a stub, internal pages, an include. */
function fixture(/** @type {string} */ root) {
  const w = (/** @type {string} */ rel, /** @type {string} */ text) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  };
  const fm = (/** @type {Record<string, string>} */ d) => `---\n${Object.entries(d).map(([k, v]) => `${k}: ${v}`).join("\n")}\n---\n`;
  w("package.json", JSON.stringify({ description: "Claude Code on a machine you own." }));
  w("site/favicon.svg", "<svg xmlns=\"http://www.w3.org/2000/svg\"/>");
  w("CHANGELOG.md", "# Changelog\n\n## Unreleased\n\n- Vault: see [ADR 0004](docs/adr/0004-presence.md).\n");
  w("docs/nav.json", JSON.stringify({
    site: { title: "Vyre docs", url: "https://docs.vyre.run", repo: "https://github.com/vyre-ai/vyre" },
    sections: [
      { title: "Start here", pages: ["index.md"] },
      { title: "Using Vyre", pages: ["using/capsule.md", "using/vault.md", "using/missing.md"] },
      { title: "Architecture", pages: ["adr/0004-presence.md", "work/docs.md"] },
      { title: "Changelog", pages: ["changelog.md"] },
    ],
    unpublished: ["work/", "proposals/", "design/boards/"],
  }));
  w("docs/index.md", fm({ title: "Vyre docs", summary: "Start here.", audience: "users", owner: "docs", status: "stable" }) +
    "Welcome, alex. Open [the Capsule](using/capsule.md) or read [presence](adr/0004-presence.md#decision).\n");
  w("docs/using/capsule.md", fm({ title: "The Capsule", summary: "Press Control twice.", audience: "users", owner: "capsule-pro", status: "stable" }) +
    "Ask about Northwind Bakery.\n\n## Open it\n\nPress Control twice.\n\n```sh\nvyre capsule\n```\n\n### From the menu bar\n\nClick the mark.\n\n## Ask\n\nSee [the vault](vault.md) and [the old spec](../SPEC.md#floor).\n\n![shot](capsule.png)\n\n" +
    "::: tabs\n::: tab On a server\n### Check the box\n\nRun it there.\n::: tab On this Mac\nRun it here.\n:::\n\n> [!SNAG] The bar does not open\n> Allow Input Monitoring.\n\n::: demo capsule\n![The Capsule](shots/deck.png)\n:::\n\n![Plain](shots/plain.png \"A plain shot\")\n");
  w("docs/using/capsule.png", "png");
  w("docs/using/vault.md", fm({ title: "The vault", summary: "Secrets kit can use without seeing.", audience: "users, agents", owner: "docs", status: "draft" }) +
    "# The vault\n\nkit uses the Harlow Legal login by name. Internal notes: [work](../work/docs.md).\n\n## Colours\n\n<!-- colors: dark -->\n");
  w("docs/adr/0004-presence.md", "# ADR 0004 · Presence\n\n## Decision\n\njuno proves presence.\n");
  w("docs/changelog.md", fm({ title: "Changelog", summary: "Every change.", audience: "users", owner: "integrator", status: "stable" }) +
    "<!-- include: ../CHANGELOG.md -->\n\nTo add a changelog page:\n\n```md\n<!-- include: ../CHANGELOG.md -->\n```\n");
  w("docs/SPEC.md", "---\ntitle: Specification\nredirect: adr/0004-presence.md\n---\n\nMoved.\n");
  w("docs/work/docs.md", "# Internal\n\nsecret plans\n");
  w("docs/work/old.md", "---\ntitle: Old\nredirect: index.md\n---\n");
  w("docs/proposals/idea.md", "# Idea\n");
  w("core/config/theme.js", `// test palette\nexport const THEME_COLORS = { dark: { graphite: "#0E0D0C" }, light: { paper: "#F4F1EA" } };\nexport const THEME_USE = { graphite: "Page ground.", paper: "Ground" };\n`);
  w("docs/using/shots/deck.png", /** @type {any} */ (png(1280, 800)));
  w("docs/using/shots/deck.dark.png", /** @type {any} */ (png(1280, 800)));
  w("docs/using/shots/plain.png", /** @type {any} */ (png(640, 480)));
}

test("build: a fixture tree produces the expected site", t => {
  const dir = tempHome(t);
  const root = path.join(dir, "repo");
  const out = path.join(dir, "out");
  fixture(root);
  const logs = [];
  const res = build({ root, out, log: m => logs.push(m) });
  assert.equal(res.pages, 5);
  assert.equal(res.redirects, 1);
  assert.deepEqual(res.missing, ["using/missing.md"]);
  assert.match(logs.join("\n"), /using\/missing\.md/);

  const read = (/** @type {string} */ rel) => fs.readFileSync(path.join(out, rel), "utf8");
  const has = (/** @type {string} */ rel) => fs.existsSync(path.join(out, rel));
  for (const f of ["index.html", "index.md", "using/capsule.html", "using/capsule.md", "using/vault.html", "adr/0004-presence.html",
    "changelog.html", "changelog.md", "search-index.json", "llms.txt", "llms-full.txt", "sitemap.xml", "robots.txt", "404.html",
    "_redirects", "_headers", "favicon.svg", "using/capsule.png"]) assert.ok(has(f), `missing ${f}`);

  // Never published: internal folders, stubs as pages.
  for (const f of ["work/docs.html", "work/docs.md", "work/old.md", "proposals/idea.html", "SPEC.html", "SPEC.md"]) assert.ok(!has(f), `published ${f}`);

  const assets = fs.readdirSync(path.join(out, "assets")).sort();
  assert.equal(assets.length, 4);
  for (const re of [/^docs\.[0-9a-f]{10}\.css$/, /^docs\.[0-9a-f]{10}\.js$/, /^demos\.[0-9a-f]{10}\.css$/, /^demos\.[0-9a-f]{10}\.js$/]) {
    assert.equal(assets.filter(a => re.test(a)).length, 1, assets.join(" "));
  }

  // Links: .md to pretty URLs on the HTML side, kept in the raw copy.
  const home = read("index.html");
  assert.match(home, /<a href="\/using\/capsule">the Capsule<\/a>/);
  assert.match(home, /<a href="\/adr\/0004-presence#decision">presence<\/a>/);
  assert.match(read("index.md"), /\[the Capsule\]\(using\/capsule\.md\)/);
  assert.match(read("index.md"), /^---\ntitle: Vyre docs/);
  const cap = read("using/capsule.html");
  assert.match(cap, /<a href="\/using\/vault">the vault<\/a>/);
  assert.match(cap, /<a href="\/adr\/0004-presence#floor">the old spec<\/a>/, "a link to a stub goes to where it moved");
  assert.match(cap, /<img src="\/using\/capsule.png"/);
  assert.match(read("using/vault.html"), /href="https:\/\/github.com\/vyre-ai\/vyre\/blob\/main\/docs\/work\/docs.md"/, "unpublished pages link to GitHub");

  // The page frame.
  assert.match(cap, /<title>The Capsule · Vyre docs<\/title>/);
  assert.match(cap, /<a href="\/using\/capsule" aria-current="page">The Capsule<\/a>/);
  assert.match(cap, /<link rel="canonical" href="https:\/\/docs.vyre.run\/using\/capsule">/);
  assert.match(cap, /<aside class="toc" aria-label="On this page">.*href="#open-it".*class="toc-3"><a href="#from-the-menu-bar">.*href="#ask"/s);
  assert.match(cap, /href="https:\/\/github.com\/vyre-ai\/vyre\/blob\/main\/docs\/using\/capsule.md">Edit this page/);
  assert.match(cap, /<a href="\/using\/capsule.md" type="text\/markdown">View as markdown/);
  assert.match(cap, /Owner <b>capsule-pro<\/b>/);
  assert.match(cap, /rel="prev"><span class="lbl">Previous<\/span><span class="pn-t">Vyre docs<\/span>/);
  assert.match(cap, /rel="next"><span class="lbl">Next<\/span><span class="pn-t">The vault<\/span>/);
  assert.match(cap, /<h1>The Capsule<\/h1>/, "a page without an h1 gets its title as one");
  assert.match(cap, /data-theme/);
  assert.match(cap, /localStorage/);
  assert.doesNotMatch(cap, /badge-/);
  const vault = read("using/vault.html");
  assert.match(vault, /<span class="badge badge-draft">Draft<\/span>/);
  assert.equal((vault.match(/<h1/g) || []).length, 1, "a page with its own h1 keeps just that one");
  assert.match(read("adr/0004-presence.html"), /<title>ADR 0004 · Presence · Vyre docs<\/title>/, "no front matter: title from the first heading");

  // Round 2 syntax, built: tabs, a snag, a demo that loads the demo assets, figures sized from the
  // PNG with the dark sibling copied, the palette.
  assert.match(cap, /<div class="tabs">\n<section class="tab-panel" data-tab="On a server">/);
  assert.match(cap, /<h3 id="check-the-box">/);
  assert.match(cap, /<a href="#check-the-box">Check the box<span class="toc-tab">On a server<\/span><\/a>/, "the TOC names a heading's tab");
  assert.match(cap, /<blockquote class="callout callout-snag" id="the-bar-does-not-open">/);
  assert.match(cap, /<script src="\/assets\/demos\.[0-9a-f]{10}\.js" defer><\/script>/);
  assert.match(cap, /<link rel="stylesheet" href="\/assets\/demos\.[0-9a-f]{10}\.css">/);
  assert.doesNotMatch(home, /demos\./, "only pages with a demo load the demo assets");
  assert.match(cap, /<div class="demo" data-demo="capsule">\n<figure class="shot"><img class="shot-light" src="\/using\/shots\/deck\.png" alt="The Capsule" width="1280" height="800" loading="lazy"><img class="shot-dark" src="\/using\/shots\/deck\.dark\.png" alt="The Capsule" width="1280" height="800" loading="lazy">/);
  assert.match(cap, /<figure class="shot"><img src="\/using\/shots\/plain\.png" alt="Plain" width="640" height="480" loading="lazy"><figcaption>A plain shot<\/figcaption><\/figure>/);
  for (const f of ["using/shots/deck.png", "using/shots/deck.dark.png", "using/shots/plain.png"]) assert.ok(has(f), `missing ${f}`);
  assert.match(vault, /<span class="swatch" style="background:#0E0D0C" aria-hidden="true"><\/span><\/td><td><code>--graphite<\/code><\/td><td><code>#0E0D0C<\/code><\/td><td>Page ground\.<\/td>/);
  assert.match(read("using/vault.md"), /## Colours\n\n\| Token \| Value \| Use \|\n\| --- \| --- \| --- \|\n\| `--graphite` \| `#0E0D0C` \| Page ground\. \|\n/);
  assert.doesNotMatch(read("using/vault.md"), /colors:/, "the raw page gets the table in place of the directive");
  assert.match(read("llms-full.txt"), /\| `--graphite` \| `#0E0D0C` \| Page ground\. \|/);

  // Include spliced, in HTML and in the .md copy.
  assert.match(read("changelog.html"), /<h2 id="unreleased">Unreleased/);
  assert.match(read("changelog.html"), /<a href="\/adr\/0004-presence">ADR 0004<\/a>/);
  assert.match(read("changelog.md"), /## Unreleased/);
  assert.equal(read("changelog.md").match(/include:/g)?.length, 1, "an include line inside fenced code is shown, not spliced");
  assert.equal(read("changelog.html").match(/<h2 id="unreleased">/g)?.length, 1);
  assert.match(read("changelog.html"), /&lt;!-- include: \.\.\/CHANGELOG\.md --&gt;/);

  // Redirects: pretty and .md, only for stubs outside unpublished folders.
  assert.equal(read("_redirects"), "/SPEC /adr/0004-presence 301\n/SPEC.md /adr/0004-presence.md 301\n");

  // Headers.
  const headers = read("_headers");
  assert.match(headers, /\n\/using\/capsule\.md\n {2}Content-Type: text\/markdown; charset=utf-8\n/);
  assert.match(headers, /\n\/llms\.txt\n {2}Content-Type: text\/plain; charset=utf-8\n/);
  assert.match(headers, /\n\/llms-full\.txt\n {2}Content-Type: text\/plain; charset=utf-8\n/);
  assert.match(headers, /\/assets\/\*\n {2}Cache-Control: public, max-age=31536000, immutable/);

  // llms.txt: title, summary, sections in nav order, one line per page.
  assert.equal(read("llms.txt").split("\n\n## ")[0].split("\n")[0], "# Vyre docs");
  const llms = read("llms.txt");
  assert.match(llms, /^# Vyre docs\n\n> Claude Code on a machine you own\.\n/);
  assert.match(llms, /\n## Start here\n\n- \[Vyre docs\]\(https:\/\/docs\.vyre\.run\/index\.md\): Start here\.\n/);
  assert.match(llms, /\n## Using Vyre\n\n- \[The Capsule\]\(https:\/\/docs\.vyre\.run\/using\/capsule\.md\): Press Control twice\.\n- \[The vault\]\(https:\/\/docs\.vyre\.run\/using\/vault\.md\): Secrets kit can use without seeing\.\n/);
  assert.match(llms, /\n## Architecture\n\n- \[ADR 0004 · Presence\]\(https:\/\/docs\.vyre\.run\/adr\/0004-presence\.md\)\n/);
  assert.doesNotMatch(llms, /work\/docs|Internal/);
  const full = read("llms-full.txt");
  assert.ok(full.indexOf("url: https://docs.vyre.run/index.md") < full.indexOf("url: https://docs.vyre.run/using/capsule.md"));
  assert.match(full, /---\ntitle: The Capsule\nurl: https:\/\/docs\.vyre\.run\/using\/capsule\.md\n---\n\nAsk about Northwind Bakery\./);
  assert.doesNotMatch(full, /secret plans/);

  // Search index: the pages, then one item per page intro, heading and snag, with its anchor.
  const idx = JSON.parse(read("search-index.json"));
  assert.deepEqual(idx.pages.map((/** @type {any} */ d) => d.u), ["/", "/using/capsule", "/using/vault", "/adr/0004-presence", "/changelog"]);
  assert.deepEqual(idx.pages[1], { t: "The Capsule", u: "/using/capsule", s: "Using Vyre", d: "Press Control twice." });
  const capItems = idx.items.filter((/** @type {any} */ it) => it.p === 1);
  assert.deepEqual(capItems.map((/** @type {any} */ it) => [it.h, it.a]), [
    ["", ""], ["Open it", "open-it"], ["From the menu bar", "from-the-menu-bar"], ["Ask", "ask"], ["Check the box · On a server", "check-the-box"],
    ["If this happens: The bar does not open", "the-bar-does-not-open"],
  ]);
  assert.equal(capItems[0].b, "Ask about Northwind Bakery.");
  assert.equal(capItems[1].b, "Press Control twice. vyre capsule");
  assert.equal(capItems[4].b, "Run it there. On this Mac Run it here. If this happens The bar does not open Allow Input Monitoring. The Capsule A plain shot");
  assert.equal(capItems[5].b, "Allow Input Monitoring.");
  for (const it of idx.items) assert.doesNotMatch(it.b, /<\/?[a-z][^>]*>/, "no tags in search text");
  assert.ok(idx.items.every((/** @type {any} */ it) => it.b.length <= 1000));

  // Sitemap, robots, 404.
  assert.match(read("sitemap.xml"), /<loc>https:\/\/docs\.vyre\.run\/using\/capsule<\/loc>/);
  assert.doesNotMatch(read("sitemap.xml"), /work/);
  assert.match(read("robots.txt"), /Sitemap: https:\/\/docs\.vyre\.run\/sitemap\.xml/);
  assert.match(read("404.html"), /noindex/);
  assert.match(read("404.html"), /href="\/assets\/docs\.[0-9a-f]{10}\.css"/, "404 uses absolute asset paths");
});

test("build: the same tree builds the same bytes", t => {
  const dir = tempHome(t);
  const root = path.join(dir, "repo");
  fixture(root);
  build({ root, out: path.join(dir, "a") });
  build({ root, out: path.join(dir, "b") });
  const list = (/** @type {string} */ d) => {
    /** @type {string[]} */
    const out = [];
    (function walk(rel) {
      for (const e of fs.readdirSync(path.join(d, rel), { withFileTypes: true })) {
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) walk(r); else out.push(r);
      }
    })("");
    return out.sort();
  };
  const a = list(path.join(dir, "a"));
  assert.deepEqual(a, list(path.join(dir, "b")));
  for (const f of a) assert.ok(fs.readFileSync(path.join(dir, "a", f)).equals(fs.readFileSync(path.join(dir, "b", f))), f);
});

test("loadDocs: pages in nav order with section, url and data; stubs and missing pages listed", t => {
  const dir = tempHome(t);
  fixture(dir);
  const docs = loadDocs(dir);
  assert.deepEqual(docs.map(p => [p.path, p.url, p.section]), [
    ["index.md", "/", "Start here"],
    ["using/capsule.md", "/using/capsule", "Using Vyre"],
    ["using/vault.md", "/using/vault", "Using Vyre"],
    ["adr/0004-presence.md", "/adr/0004-presence", "Architecture"],
    ["changelog.md", "/changelog", "Changelog"],
  ]);
  assert.equal(docs[1].data.owner, "capsule-pro");
  assert.match(docs[1].body, /^Ask about/);
  assert.deepEqual(docs.redirects.map(r => [r.from, r.to]), [["SPEC.md", "adr/0004-presence.md"]]);
  assert.deepEqual(docs.missing, [{ path: "using/missing.md", section: "Using Vyre" }]);
  assert.equal(docs.site.url, "https://docs.vyre.run");
});

test("scripts/build-docs runs as a command", async t => {
  const dir = tempHome(t);
  const { spawnSync } = await import("node:child_process");
  const out = path.join(dir, "site");
  const r = spawnSync(process.execPath, [path.join(REPO, "scripts", "build-docs"), "--out", out], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /build-docs: \d+ pages/);
  assert.ok(fs.existsSync(path.join(out, "llms.txt")));
  const bad = spawnSync(process.execPath, [path.join(REPO, "scripts", "build-docs"), "--nope"], { encoding: "utf8" });
  assert.equal(bad.status, 1);
});
