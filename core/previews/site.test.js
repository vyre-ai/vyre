// @ts-check
// A folder's React page as a static site (previews/site): the same shell, compiler and library table the pane uses, written out as files. The last test opens the result in a real browser, served the
// way a static host serves files, and reads what the page drew.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawnSync } from "node:child_process";
import { siteOf } from "./site.js";
import { libs, bareImports } from "./jsx.js";
import { findChrome } from "./thumb.js";

const file = (/** @type {string} */ p, /** @type {string} */ c) => ({ path: p, content: Buffer.from(c) });
const PAGE = [
  file("App.jsx", `import { useState } from "react";\nimport Card from "./parts/Card.jsx";\nexport default function App() { const [n] = useState(3); return <main><h1>Northwind Bakery</h1><Card count={n} /></main>; }\n`),
  file("parts/Card.tsx", `type P = { count: number };\nexport default function Card({ count }: P) { return <p id="count">{count} loaves today</p>; }\n`),
  file("logo.svg", "<svg xmlns='http://www.w3.org/2000/svg'/>"),
];

test("a folder with an index.html, or with no React page, comes back as it is", async () => {
  const site = [file("index.html", "<p>hi</p>"), file("app.jsx", "export default () => null")];
  const r = await siteOf(site);
  assert.equal(r.react, false);
  assert.deepEqual(r.files, site);
  assert.equal((await siteOf([file("a.txt", "x")])).react, false);
  assert.equal((await siteOf([file("lib.ts", "export const x = 1")])).react, false, "a .ts file with no page to mount is not a page");
});

test("a React page becomes index.html, compiled files under their .js names, and only the libraries it uses (and they use)", async () => {
  const r = await siteOf(PAGE);
  assert.equal(r.react, true);
  const by = new Map(r.files.map(f => [f.path, f.content.toString("utf8")]));
  assert.ok(by.has("index.html") && by.has("App.js") && by.has("parts/Card.js") && by.has("logo.svg"));
  assert.ok(!by.has("App.jsx") && !by.has("parts/Card.tsx"), "the sources are not published as they were");
  assert.match(by.get("App.js") || "", /from "\.\/parts\/Card\.js"/, "a relative import follows the file to its new name");
  assert.match(by.get("index.html") || "", /import\("\/App\.js"\)/);
  assert.ok(by.has("__vyre/lib/react.js") && by.has("__vyre/lib/react-dom__client.js") && by.has("__vyre/lib/tailwind.js"));
  assert.ok(!by.has("__vyre/lib/recharts.js") && !by.has("__vyre/lib/three.js"), "a library the page does not use is not published");
  // every address the page's import map names is a file of the site, and every bare import in any of it is in the map
  const map = libs();
  const map2 = JSON.parse(/<script type="importmap">(.*?)<\/script>/s.exec(by.get("index.html") || "")?.[1] || "{}").imports;
  assert.deepEqual(map2, map);
  for (const [p, text] of by) if (p.endsWith(".js")) for (const n of bareImports(text)) {
    assert.ok(n in map, `${p} imports ${n}, which is not in the map`);
    assert.ok(by.has(map[n].slice(1)), `${n} is in the map but its file is not published`);
  }
});

test("a page that imports what Vyre does not provide is refused with the name, and so is a source that does not compile", async () => {
  await assert.rejects(() => siteOf([file("App.jsx", `import left from "left-pad";\nexport default () => <p>{left("x", 3)}</p>;`)]), { code: "refused", message: /left-pad/ });
  await assert.rejects(() => siteOf([file("App.jsx", `export default function App() {\n  return <div>\n}\n`)]), { message: /^App\.jsx:\d+: / });
  await assert.rejects(() => siteOf([file("App.jsx", "export default () => null"), file("App.tsx", "export default () => null")]), { message: /App\.js is both a source file and its compiled name/ });
});

test("opened in a real browser, served as a static host serves it, the page draws", { skip: !findChrome() && "no Chrome on this machine" }, async t => {
  const r = await siteOf(PAGE);
  const MIME = /** @type {Record<string, string>} */ ({ ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".svg": "image/svg+xml" });
  const srv = http.createServer((req, res) => {
    const p = decodeURIComponent(new URL(req.url || "/", "http://x").pathname).replace(/^\//, "") || "index.html";
    const f = r.files.find(x => x.path === p);
    if (!f) { res.writeHead(404); return void res.end("no"); }
    res.writeHead(200, { "content-type": MIME[path.extname(p)] || "application/octet-stream" });
    res.end(f.content);
  });
  await new Promise(ok => srv.listen(0, "127.0.0.1", () => ok(undefined)));
  t.after(() => srv.close());
  const port = /** @type {import("node:net").AddressInfo} */ (srv.address()).port;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-site-chrome-"));
  t.after(() => fs.rmSync(profile, { recursive: true, force: true }));
  let dom = "";
  for (const sandbox of [true, false]) {
    const out = spawnSync(String(findChrome()), ["--headless", "--disable-gpu", "--no-first-run", `--user-data-dir=${profile}`, "--virtual-time-budget=8000", "--dump-dom", ...(sandbox ? [] : ["--no-sandbox"]), `http://127.0.0.1:${port}/`], { encoding: "utf8", timeout: 40_000 });
    dom = out.stdout || "";
    if (dom.includes("Northwind")) break;
  }
  assert.match(dom, /Northwind Bakery/);
  assert.match(dom, /3 loaves today/);
  assert.ok(!/vyre-problem"[^>]*>\S/.test(dom), "no problem message on the page");
});
