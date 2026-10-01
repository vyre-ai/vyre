// The typed renderers (chart, diagram, deck, SVG cleaner): what they draw, what they refuse and
// say, and that nothing they draw can run a script or reach the network.
import test from "node:test";
import assert from "node:assert/strict";
import { drawChart, readChart } from "./draw/chart.js";
import { drawMermaid, drawSvg, parseFlow } from "./draw/diagram.js";
import { markdown as markdownOf } from "./render.js";
import { drawDeck } from "./draw/deck.js";
import { cleanSvg, removedSentence } from "./draw/svg.js";
import { page } from "./render.js";

const text = h => h.replace(/<style[\s\S]*?<\/style>/g, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
const ROWS = [{ month: "Apr", referrals: 22, consults: 14 }, { month: "May", referrals: 25, consults: 17 }, { month: "Jun", referrals: 31, consults: 19 }, { month: "Sep", referrals: 46, consults: 31 }];
const SPEC = JSON.stringify({ type: "line", x: "month", series: ["referrals", { key: "consults", name: "Consults" }] });

test("chart: a line chart has tabs, stat tiles in words, direct labels, line styles and a table", () => {
  const h = drawChart("Referrals", SPEC, JSON.stringify(ROWS));
  assert.match(h, /id="vt-chart"[\s\S]*id="vt-table"/);
  assert.match(text(h), /Referrals, Sep 46 up 15 on Jun/, "a change in words, never a colour");
  assert.match(h, /stroke-dasharray="6 4"/, "the second series is dashed");
  assert.ok(h.includes("<circle") && h.includes('rx="2"'), "round and square markers");
  assert.match(h, /aria-label="Referrals: Referrals, Consults by month"/);
  assert.match(h, /<table class="data">[\s\S]*<td class="num">46<\/td>/, "every chart has the table");
  assert.ok(!/#[0-9a-f]{3,6}\b/i.test(h.replace(/style="[^"]*"/g, "")), "tokens only, no hue");
});

test("chart: bars, more than three series, and what is wrong in words", () => {
  const bar = drawChart("New clients", JSON.stringify({ type: "bar", x: "month", series: ["referrals"] }), JSON.stringify(ROWS));
  assert.match(bar, /<path d="M[^"]*a4 4 0 0 1/, "rounded data ends");
  assert.match(bar, /class="v"[^>]*>46</, "the number above the last bar");
  const wide = drawChart("Many", JSON.stringify({ x: "m", series: ["a", "b", "c", "d"] }), JSON.stringify([{ m: 1, a: 1, b: 2, c: 3, d: 4 }]));
  assert.match(text(wide), /Showing 3 of 4 series\. The table has all of them/);
  assert.match(text(drawChart("T", "{}", "[]")), /Nothing to draw yet/);
  const bad = drawChart("T", JSON.stringify({ x: "month" }), JSON.stringify([{ when: "a", n: 1 }]));
  assert.match(text(bad), /Cannot draw this chart The data file has no column month \. The table view still shows what is there/);
  assert.ok(bad.includes('<table class="data">'), "the table is still offered");
  assert.match(text(drawChart("T", "{", "[]")), /not valid JSON/);
  assert.equal(readChart(SPEC, JSON.stringify({ rows: ROWS })).rows.length, 4, "data may be {rows}");
  assert.match(drawChart("<b>x</b>", SPEC, JSON.stringify([{ month: "<img src=x onerror=1>", referrals: 1, consults: 2 }])), /&lt;img src=x/);
});

test("svg: scripts, links, handlers, styles and foreign content go, shapes and text stay, and it says so", () => {
  const { svg, removed } = cleanSvg(`<?xml version="1.0"?><svg width="40" height="20" onload="x()"><script>alert(1)</script><a href="https://evil"><rect width="5" height="5" fill="red" style="fill:url(https://e/x)"/></a><image href="https://e/i.png"/><foreignObject><div>hi</div></foreignObject><text x="1">a &amp; b</text></svg>`);
  assert.equal(svg, '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><rect width="5" height="5" fill="red"/><text x="1">a &amp; b</text></svg>');
  assert.deepEqual(removed, { scripts: 2, links: 2, other: 2 });
  assert.equal(removedSentence(removed), "Vyre removed 2 scripts, 2 links and 2 other unsafe parts from this SVG. The shapes and text are unchanged.");
  assert.equal(removedSentence({ scripts: 1, links: 0, other: 0 }), "Vyre removed a script from this SVG. The shapes and text are unchanged.");
  assert.equal(cleanSvg("not svg at all").svg, "");
  assert.match(cleanSvg('<svg><text x="1" data-a="b">a</text><rect fill="a&b" width="1"/></svg>').svg, /fill="a&amp;b"/, "a bare & in an attribute is escaped so the picture still parses");
  const page1 = drawSvg("Logo", '<svg width="10"><circle r="3"/></svg>');
  assert.ok(page1.includes('src="data:image/svg+xml;base64,') && !page1.includes("Cleaned."), "a clean SVG shows no notice");
});

test("mermaid: a flowchart is parsed and laid out; every feature a model writes works", () => {
  const src = `flowchart LR
  %% a comment
  A[Intake form] ==> B["Screen the lead<br/>today"]
  B --> C{Fits?}
  C -->|yes| D([Book a consult]) & E((Done))
  C -- no --> F(Send resources)
  subgraph Office[Where leads go]
    D
    E
  end
  F -.-> B
  B --> B
  classDef x fill:#f00
  click A "https://evil.example"`;
  const g = parseFlow(src);
  assert.equal(g.dir, "LR");
  assert.deepEqual([...g.nodes.keys()], ["A", "B", "C", "D", "E", "F"]);
  assert.equal(g.nodes.get("B").label, "Screen the lead\ntoday");
  assert.equal(g.nodes.get("C").shape, "diamond");
  assert.deepEqual(g.edges.map(e => `${e.from}>${e.to}${e.label ? ":" + e.label : ""}${e.dashed ? "~" : ""}${e.thick ? "=" : ""}`), ["A>B=", "B>C", "C>D:yes", "C>E:yes", "C>F:no", "F>B~", "B>B"]);
  assert.equal(g.groups[0].title, "Where leads go");
  const h = drawMermaid("Intake", src);
  assert.match(h, /<svg[^>]*viewBox/);
  assert.match(text(h), /Intake form/);
  assert.ok(!h.includes("href=") && !/<a[ >]/.test(h), "a click handler or link is never drawn (the source pane shows it as text)");
  const inner = /<svg[\s\S]*<\/svg>/.exec(h)[0];
  const again = cleanSvg(inner);
  assert.deepEqual(again.removed, { scripts: 0, links: 0, other: 0 }, "what Vyre draws is itself clean SVG");
  for (const dir of ["TD", "TB", "BT", "RL"]) assert.match(drawMermaid("d", `graph ${dir}\nA-->B-->C`), /<svg/);
});

test("mermaid: sequence diagrams, errors with the parser's line, and other types named", () => {
  const seq = drawMermaid("S", "sequenceDiagram\n participant A as Lead\n A->>B: hi\n B-->>A: ok\n A->>A: think\n Note over A,B: fine\n loop daily\n end");
  assert.match(text(seq), /Lead[\s\S]*hi[\s\S]*ok[\s\S]*think[\s\S]*fine/);
  const err = drawMermaid("E", "flowchart TD\n  A --> B\n  B Fits?\n");
  assert.match(text(err), /Cannot draw this diagram Line 3: expected an arrow after B\. The source is below/);
  assert.ok(err.includes("<pre") && err.includes("B Fits?"), "the source is shown");
  assert.match(text(drawMermaid("P", "pie\n  \"a\": 1")), /Vyre draws flowcharts and sequence diagrams, and this is a pie/);
  assert.match(text(drawMermaid("P", "<img src=x>\n a")), /this is a &lt;img|this is a <img/, "the type is shown as text, never as markup");
  assert.ok(!drawMermaid("P", "<img onerror=1>").includes("<img onerror"));
  assert.match(text(drawMermaid("H", "hello")), /Line 1/);
  assert.match(text(drawMermaid("N", "  ")), /Nothing to draw yet/);
  assert.match(text(drawMermaid("U", "flowchart TD\n subgraph X\n A-->B")), /missing its end/);
  assert.ok(drawMermaid("X", "flowchart TD\nA[<script>alert(1)</script>] --> B").includes("alert(1)") === false || !drawMermaid("X", "flowchart TD\nA[<script>alert(1)</script>] --> B").includes("<script"), "label markup is never markup");
});

test("deck: layouts from Markdown, notes, a filmstrip, and one bad slide never spoils the rest", () => {
  const md = `Harlow Legal\n# Q3 review\nReferrals up 18 percent\n\nNotes: open with the number\n\n---\n\n# What changed\n- New intake form\n- Friday follow-ups\n\n---\n\n# 46\nreferrals in September\n\n---\n\n> Intake is the product.\n\n---\n\nLeft side\n\n...\n\nRight side\n\n---\n\n![A chart](data:image/png;base64,iVBORw0KGgo=)\n\n---\n\n![x](https://evil.example/x.png)`;
  const h = drawDeck("Q3", md);
  assert.equal((h.match(/class="frame[ "]/g) || []).length, 7);
  assert.match(h, /<p class="eyebrow">Harlow Legal<\/p><h1>Q3 review<\/h1>/);
  assert.match(h, /class="frame first" id="s1"/);
  assert.equal((h.match(/Harlow Legal/g) || []).length, 2, "the eyebrow is not repeated as a paragraph (the stage and its thumbnail)");
  assert.match(h, /<p class="big">46<\/p>/);
  assert.match(h, /<blockquote>/);
  assert.match(h, /class="cols"/);
  assert.match(h, /<figure><img alt="A chart" src="data:image\/png;base64/);
  assert.match(text(h), /Slide 7 cannot be shown It includes an image that is not inside the deck/);
  assert.match(text(h), /open with the number/);
  assert.match(h, /id="s3"[\s\S]*href="#s2"[\s\S]*3 of 7/);
  assert.equal((h.match(/class="strip"/g) || []).length, 1);
  assert.ok(!h.includes("evil.example/x.png"), "a remote image is never put in the page");
  assert.match(text(drawDeck("E", "  \n---\n  ")), /No slides yet/);
  assert.ok(!drawDeck("X", "# <script>alert(1)</script>").includes("<script"));
});

test("every typed page is static: no script, no network, tokens only, both colour modes", () => {
  const files = { slides: { "slides.md": "# A\n\n---\n\n- b" }, mermaid: { "diagram.mmd": "flowchart TD\nA-->B" }, svg: { "diagram.svg": '<svg width="5"><rect width="2" height="2"/></svg>' }, chart: { "chart.json": SPEC, "data.json": JSON.stringify(ROWS) } };
  for (const [format, f] of Object.entries(files)) {
    const p = page({ title: "T", format, files: f });
    assert.equal(p.scripts, false, format);
    assert.ok(!/<script|javascript:|https?:\/\//i.test(p.html.replace(/xmlns="http:\/\/www\.w3\.org\/2000\/svg"/g, "")), `${format}: no script or remote reference`);
    assert.match(p.html, /prefers-color-scheme:dark/, `${format}: paper and dark`);
    assert.ok(!/\burl\(/.test(p.html), `${format}: nothing loads`);
  }
});

// ---- the design is the agent's (user ruling, 1 Oct): style freedom, not network freedom ---------

import { themeCss, colorOf, fontOf, dataImageOf } from "./draw/theme.js";
import { pageHeaders } from "./render.js";

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

test("theme values: colours, fonts and data images pass; anything that could load or escape is dropped", () => {
  for (const ok of ["#fff", "#0e0d0cff", "rebeccapurple", "rgb(1, 2, 3)", "hsl(200 50% 40% / .5)", "oklch(60% .1 200)", "linear-gradient(135deg, #102a43, #243b53)"]) assert.equal(colorOf(ok), ok, ok);
  for (const bad of ["url(https://evil/x.png)", "red;}body{display:none", "#fff\;", "var(--x)", "expression(1)", "red /* x */", 'rgb(1,2,3)"', "javascript:1", "linear-gradient(url(x), #000)", "<b>", { a: 1 }, ""]) assert.equal(colorOf(bad), null, String(bad));
  assert.equal(fontOf("Georgia, serif"), "'Georgia', serif");
  assert.equal(fontOf("Inter, system-ui"), "'Inter', system-ui");
  for (const bad of ["a;}x{", "a'b", 'a"b', "url(x)", "a{b}"]) assert.equal(fontOf(bad), null, bad);
  assert.equal(dataImageOf(PNG), PNG);
  for (const bad of ["https://evil/x.png", "data:text/html;base64,AAAA", "data:image/png;base64,AA AA", "javascript:1"]) assert.equal(dataImageOf(bad), null, bad);
  const css = themeCss({ background: "#fff8e7", text: "#222", accent: "red;}x{", font: "Georgia, serif", dark: { background: "#101820", text: "#eee" } });
  assert.match(css, /--panel:#fff8e7/);
  assert.match(css, /prefers-color-scheme:dark\)\{:root\{[^}]*--panel:#101820/);
  assert.ok(!css.includes("red;}"), "a bad value is dropped, never repaired");
  assert.equal(themeCss("nope"), "");
});

test("chart: an agent's theme, series colours, markers, dashes and height survive; Vyre's palette is only the default", () => {
  const spec = { type: "line", x: "month", height: 260, stats: false, legend: false, title: "Pipeline",
    theme: { background: "#fff8e7", text: "#222222", font: "Georgia, serif", series: ["#c0392b", "#1a7f37", "#2455a4"] },
    series: ["referrals", { key: "consults", marker: "diamond", dash: "dotted" }, { key: "signed", color: "#ff00aa", marker: "none" }] };
  const rows = ROWS.map((r, i) => ({ ...r, signed: i }));
  const h = drawChart("T", JSON.stringify(spec), JSON.stringify(rows));
  assert.match(h, /<style>:root\{[^}]*--hover:color-mix\([^}]*--panel:#fff8e7;[^}]*--text:#222222/, "surfaces are derived from the theme, so Vyre's greys never show through");
  assert.match(h, /--font:'Georgia', serif/);
  assert.match(h, /stroke="#c0392b"/);
  assert.match(h, /stroke="#1a7f37"[^>]*stroke-dasharray="1\.5 4"/, "the agent's dash");
  assert.match(h, /stroke="#ff00aa"/, "a series' own colour beats the theme's");
  assert.match(h, /viewBox="0 0 308 260"/, "its height");
  assert.ok(!h.includes('class="stats"') && !h.includes('class="legend"'), "stats and legend can be switched off");
  const many = drawChart("M", JSON.stringify({ x: "m", series: [..."abcde"].map((k, i) => ({ key: k, color: `#00${i}00${i}` })) }), JSON.stringify([{ m: 1, a: 1, b: 2, c: 3, d: 4, e: 5 }]));
  assert.ok(!text(many).includes("Showing"), "with its own colours an agent draws up to eight series");
  const hostile = drawChart("H", JSON.stringify({ x: "m", series: [{ key: "a", color: "red\" onload=\"x" }], theme: { background: "url(https://evil/x)" } }), JSON.stringify([{ m: 1, a: 1 }]));
  assert.ok(!hostile.includes("onload") && !hostile.includes("evil"), "hostile values never reach the page");
});

test("deck: a theme, per-slide backgrounds, data-URI images and a brand mark survive", () => {
  const md = `@theme {"bg":"#102a43","text":"#f0f4f8","font":"Georgia, serif","logo":{"src":"${PNG}","position":"top-right","size":9,"alt":"Harlow"}}\n# Q3\n\n---\n@slide {"bg":"#c0392b","color":"#ffffff","align":"center","valign":"top","image":"${PNG}","fit":"contain"}\n# Chapter\n\n---\n@slide {"bg":"red;}x{","image":"https://evil/x.png","font":"a;}b"}\n# Plain`;
  const h = drawDeck("D", md);
  assert.match(h, /^<style>:root\{[^}]*--slide:#102a43/);
  assert.match(h, /--font:'Georgia', serif/);
  assert.match(h, /<img class="logo tr" alt="Harlow" src="data:image\/png;base64,/);
  assert.match(h, /style="background:#c0392b;background-image:url\(data:image\/png;base64,[^)]+\);background-size:contain;[^"]*--text:#ffffff[^"]*--align:center;--valign:flex-start"/);
  assert.ok(!h.includes("evil") && !h.includes("red;}") && !h.includes("a;}b"), "bad slide values are dropped");
  assert.match(text(h), /Plain/, "the slide still draws without them");
});

test("mermaid: %%theme and Mermaid's own style, classDef and ::: colour the diagram", () => {
  const h = drawMermaid("M", `%%theme {"canvas":"#101820","node":"#1f2a37","text":"#f5f5f5","edge":"#9fb3c8","font":"Georgia, serif"}\nflowchart TD\n A[Start]:::hot --> B{Ok?}\n B --> C[End]\n classDef hot fill:#c0392b,stroke:#7b241c,stroke-width:3px,color:#fff\n style C fill:#1a7f37,stroke-dasharray:4 2\n style B fill:url(https://evil/x)`);
  assert.match(h, /^<style>:root\{[^}]*--bg:#101820;--panel:#1f2a37/);
  assert.match(h, /<rect class="dn" [^>]*fill="#c0392b" stroke="#7b241c" stroke-width="3"/);
  assert.match(h, /fill="#1a7f37"[^>]*stroke-dasharray="4 2"/);
  assert.match(h, /style="fill:#fff"/, "node text colour");
  assert.ok(!/fill="url\(https/.test(h) && !h.replace(/<pre[\s\S]*?<\/pre>/, "").includes("evil"), "a url fill is dropped");
  assert.match(h, /<path class="dn" [^>]*fill="var\(--hover\)"/, "unstyled nodes keep Vyre's tokens");
});

test("svg: an agent's styles, style element, gradients and data-URI brand mark stay; loads and escapes go", () => {
  const src = `<svg width="200" height="100" viewBox="0 0 200 100"><style>.t{fill:#c0392b;font-family:Georgia}@media (prefers-color-scheme:dark){.t{fill:#fff}}</style><defs><linearGradient id="g"><stop offset="0" stop-color="#102a43"/><stop offset="1" stop-color="#243b53"/></linearGradient><filter id="f"><feGaussianBlur stdDeviation="2"/></filter></defs><rect width="200" height="100" fill="url(#g)" style="stroke:#fff;stroke-width:2"/><text class="t" x="10" y="50" filter="url(#f)">Brand</text><image href="${PNG}" x="150" y="5" width="40" height="40"/></svg>`;
  const { svg, removed } = cleanSvg(src);
  assert.deepEqual(removed, { scripts: 0, links: 0, other: 0 }, "nothing unsafe in it");
  for (const keep of ["<style>.t{fill:#c0392b", "linearGradient", 'fill="url(#g)"', 'style="stroke:#fff;stroke-width:2"', "<feGaussianBlur", `href="${PNG}"`, 'filter="url(#f)"']) assert.ok(svg.includes(keep), keep);
  const bad = cleanSvg(`<svg><style>@import url(https://evil/x.css);.a{fill:red}</style><style>.b{background:url(https://evil/i.png)}</style><rect style="fill:url(https://evil/x)" width="1" height="1"/><image href="https://evil/i.png"/><image href="data:image/svg+xml;base64,AAAA"/><use href="https://evil/s.svg#a"/><rect fill="red" width="1" height="1"/></svg>`);
  assert.ok(!bad.svg.includes("evil") && !bad.svg.includes("@import") && !bad.svg.includes("<image") && !bad.svg.includes("<use"), bad.svg);
  assert.ok(bad.svg.includes('<rect fill="red"'), "the safe shape stays");
  assert.ok(bad.removed.other >= 3 && bad.removed.links >= 2, JSON.stringify(bad.removed));
});

test("markdown documents take an @theme line; pages and apps keep their own CSS", () => {
  const p = page({ title: "Memo", format: "markdown", files: { "index.md": '@theme {"background":"#fff8e7","text":"#222","font":"Georgia, serif","code":"#eee","accent":"#c0392b"}\n# Memo\n\nBody' } });
  assert.match(p.html, /--doc-bg:#fff8e7/);
  assert.ok(!p.html.includes("@theme"), "the directive line is not shown");
  assert.match(p.html, /<h1>Memo<\/h1>/);
  const author = '<!doctype html><html><head><style>body{background:#0b3d2e;color:#f7f3e8;font-family:"Fraunces",Georgia,serif}.hero{background:url(data:image/png;base64,AAAA)}</style></head><body><h1 class="hero">Mine</h1></body></html>';
  const q = page({ title: "Mine", format: "html", files: { "index.html": author } });
  assert.equal(q.html, author, "an agent's page is served exactly as written");
  assert.equal(q.scripts, true);
  const csp = pageHeaders({ scripts: true, framedBy: "self" })["content-security-policy"];
  for (const ok of ["style-src 'unsafe-inline'", "img-src data: blob:", "font-src data:"]) assert.ok(csp.includes(ok), ok);
  for (const no of ["connect-src 'none'", "default-src 'none'", "form-action 'none'", "sandbox allow-scripts"]) assert.ok(csp.includes(no), no);
});

test("mermaid's own init themeVariables and a deck's text scale are honoured too", () => {
  const h = drawMermaid("I", `%%{init: {'theme':'base','themeVariables':{'primaryColor':'#1f2a37','primaryBorderColor':'#9fb3c8','primaryTextColor':'#f5f5f5','lineColor':'#9fb3c8','background':'#101820','fontFamily':'Georgia, serif'}}}%%\nflowchart TD\n A --> B`);
  assert.match(h, /^<style>:root\{[^}]*--panel:#1f2a37[^}]*--rs:#9fb3c8[^}]*--bg:#101820[^}]*--font:'Georgia', serif/);
  assert.match(h, /<svg[\s\S]*Diagram/);
  const d = drawDeck("S", '@theme {"scale":1.3}\n# Big\n\n---\n@slide {"scale":0.8}\n# Small');
  assert.match(d, /--k:1\.3/);
  assert.match(d, /style="--k:0\.8"/);
  assert.match(drawDeck("S", '@theme {"scale":99}\n# x'), /^<div class="deck">/, "an out of range scale is dropped");
});

test("hostile input is cleaned or refused in linear time (reviewer-2: a quadratic regex froze vyred)", () => {
  const time = (f) => { const s = performance.now(); const r = f(); return [performance.now() - s, r]; };
  const cases = [
    ["many < and no >", () => cleanSvg("<svg>" + "<a".repeat(40_000))],
    ["80 KB of <a", () => cleanSvg("<svg>" + "<a".repeat(40_000) + "</svg>")],
    ["a million <a", () => cleanSvg("<svg>" + "<a".repeat(1_000_000))],
    ["unterminated comments", () => cleanSvg("<svg>" + "<!--".repeat(200_000))],
    ["unterminated cdata and pi", () => cleanSvg("<svg>" + "<![CDATA[".repeat(100_000) + "<?".repeat(100_000))],
    ["unbalanced quotes", () => cleanSvg("<svg " + 'a="'.repeat(300_000))],
    ["a long attribute list", () => cleanSvg("<svg><rect " + 'a="b" '.repeat(300_000) + "/></svg>")],
    ["a megabyte of mermaid", () => drawMermaid("t", "flowchart TD\n" + "A-->B\n".repeat(160_000))],
    ["one huge mermaid line", () => drawMermaid("t", "flowchart TD\n" + "A --> B ".repeat(150_000))],
    ["a long chain of nodes", () => drawMermaid("t", "flowchart TD\n" + Array.from({ length: 19_000 }, (_, i) => `N${i}-->N${i + 1}`).join("\n"))],
    ["markdown stars", () => markdownOf("*a ".repeat(350_000))],
    ["markdown backticks", () => markdownOf("`".repeat(1_000_000))],
    ["a thousand slides", () => drawDeck("t", "# a\n\n---\n".repeat(100_000))],
  ];
  for (const [name, f] of cases) { const [ms] = time(f); assert.ok(ms < 1500, `${name}: ${Math.round(ms)} ms`); }
  const [ms80] = time(() => cleanSvg("<svg>" + "<a".repeat(40_000)));
  assert.ok(ms80 < 200, `80 KB of <a took ${Math.round(ms80)} ms`);
  assert.match(text(drawMermaid("t", "flowchart TD\n" + Array.from({ length: 400 }, (_, i) => `N${i}-->N${i + 1}`).join("\n"))), /too many to draw/);
  assert.match(text(drawMermaid("t", "x".repeat(300_000))), /longer than 200 KB/);
  assert.match(text(drawSvg("t", "<svg>" + "<a".repeat(150_000) + "</svg>")), /larger than 256 KB/, "a 256 KB cap on SVG input");
  assert.ok(cleanSvg("<svg>" + "x".repeat(400_000) + "</svg>").svg.length <= 256 * 1024 + 100, "the cleaner itself never reads past the cap");
});

test("names that exist on every object are not themes, dashes, markers or positions", () => {
  assert.equal(themeCss({ constructor: "#fff", __proto__: "#000", toString: "#111" }), "");
  const c = drawChart("T", JSON.stringify({ x: "m", series: [{ key: "a", marker: "constructor", dash: "__proto__" }, { key: "b", marker: "__proto__", dash: "toString" }] }), JSON.stringify([{ m: 1, a: 1, b: 2 }]));
  assert.match(c, /<svg/, "a bogus marker or dash falls back to the default");
  const d = drawDeck("D", `@theme {"logo":{"src":"${PNG}","position":"constructor"}}\n# x`);
  assert.match(d, /class="logo br"/);
  assert.match(text(drawMermaid("t", "flowchart TD\n A-->B\n classDef constructor fill:#f00\n class A constructor")), /A/);
  assert.equal(cleanSvg('<svg><constructor/><use href="#a"/><rect width="1" height="1"/></svg>').svg.includes("use"), false);
  for (const bad of ["image-set('a.png' 1x)", "-webkit-image-set(\"a\" 1x)", "cross-fade(url(#a), red)", "src(\"x\")", "image(\"x\")", "element(#a)", "paint(x)"]) {
    assert.equal(colorOf(bad), null, bad);
    assert.ok(cleanSvg(`<svg><rect width="1" height="1" style="background:${bad}"/></svg>`).svg.includes("style=") === false, `style ${bad}`);
    assert.ok(!cleanSvg(`<svg><style>.a{background:${bad}}</style></svg>`).svg.includes("<style>"), `style element ${bad}`);
  }
});

test("an init block is found without a lazy scan, and a repeated unclosed one is cheap", () => {
  const s = performance.now();
  drawMermaid("t", "%%{init:{".repeat(25_000) + "\nflowchart TD\nA-->B");
  assert.ok(performance.now() - s < 100, `${Math.round(performance.now() - s)} ms`);
  assert.match(drawMermaid("t", `%%{init: {"themeVariables": {"primaryColor": "#123456"}}}%%\nflowchart TD\nA-->B`), /--panel:#123456/);
});
