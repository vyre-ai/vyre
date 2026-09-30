// The typed renderers (chart, diagram, deck, SVG cleaner): what they draw, what they refuse and
// say, and that nothing they draw can run a script or reach the network.
import test from "node:test";
import assert from "node:assert/strict";
import { drawChart, readChart } from "./draw/chart.js";
import { drawMermaid, drawSvg, parseFlow } from "./draw/diagram.js";
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
