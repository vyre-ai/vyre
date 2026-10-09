// @ts-check
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { poster, readPage, colour } from "./poster.js";
import { start } from "../daemon/index.js";
import { tempHome, present, asOwner } from "../../test/helpers.js";
import { SCRATCH } from "../../test/scratch.mjs";

process.env.VYRE_SEAL_DEV = "1";

test("a poster says the page's own title and heading on the page's own colour", () => {
  const html = `<!doctype html><html><head><title>Quarterly intake</title><meta name="theme-color" content="#102a43"></head><body><h1>Cases <b>this</b> week</h1></body></html>`;
  assert.deepEqual(readPage(html), { title: "Quarterly intake", heading: "Cases this week", bg: "#102a43" });
  const svg = poster({ html });
  assert.match(svg, /^<svg /);
  assert.match(svg, /Quarterly intake/);
  assert.match(svg, /Cases this week/);
  assert.match(svg, /fill="#102a43"/);
  assert.match(svg, /fill="#f6f5f1"/, "light text on a dark page");
});

test("the colour comes from the stylesheet when there is no theme colour, and a name with no page gives a soft stand-in", () => {
  assert.equal(readPage(`<style>body { margin:0; background: #fff8e1; }</style>`).bg, "#fff8e1");
  assert.equal(readPage(`<style>:root{--x:1} html, body {background-color: rgb(250, 250, 250)}</style>`).bg, "#fafafa");
  assert.match(poster({ title: "Leads" }), /Leads/);
  assert.equal(poster({ title: "Leads" }), poster({ title: "Leads" }), "the same name gives the same poster");
  assert.equal(colour("red"), "#dc2626");
  assert.equal(colour("url(http://evil)"), null);
});

test("nothing from the page can carry script or a link into the poster", () => {
  const svg = poster({ html: `<title>&lt;script&gt;alert(1)&lt;/script&gt; "x" <img src=x onerror=1></title><meta name="theme-color" content="red;} </style><script>"><h1>a</h1>` });
  assert.doesNotMatch(svg, /<script|onerror|href|<img/i);
  assert.equal((svg.match(/<svg/g) || []).length, 1);
  assert.doesNotMatch(poster({ title: "x", html: `<style>body{background:url(http://evil/x.png)}</style>` }), /evil/);
});

test("with no browser on the machine the card still gets a poster drawn from the page, and removing the preview removes it", { timeout: 60_000 }, async t => {
  const was = process.env.PATH;
  process.env.PATH = "/nonexistent"; delete process.env.VYRE_CHROME; process.env.VYRE_PREVIEW_THUMBS = "1";
  t.after(() => { process.env.PATH = was; });
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "test-box", role: "box" }));
  const d = await start({ root, presence: present, log: () => {}, kernel: true });
  asOwner(d, root);
  t.after(() => d.stop());
  const call = (/** @type {string} */ tool, /** @type {any} */ input) => d.registry.call(tool, input, "cli");
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(SCRATCH, "vyre-poster-")));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, "index.html"), "<!doctype html><title>Sam's intake board</title><h1>Open matters</h1>");
  const id = (await call("previews.open", { title: "Board", path: dir })).data.id;
  let got = null;
  for (let i = 0; i < 100 && !got; i++) { const r = (await call("previews.thumb", { id })).data; if (r.svg) got = r; else await new Promise(r2 => setTimeout(r2, 150)); }
  assert.ok(got, "a poster arrives");
  assert.equal(got.image, null);
  assert.match(got.svg, /Sam&#39;s intake board/);
  assert.match(got.svg, /Open matters/);
  await call("previews.remove", { id });
  assert.ok(!fs.readdirSync(path.join(root, "previews-thumbs")).some(f => f.startsWith(id)));
});
