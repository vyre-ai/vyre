// @ts-check
// A React page written for Claude's artifact runtime: turned into JavaScript, held to the reviewed list of libraries, and a plain message (never a blank page) when it cannot be built.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { build, bareImports, entryIn, shell, failing, libs, libFile } from "./jsx.js";
import { SCRATCH } from "../../test/scratch.mjs";

const tmp = () => fs.mkdtempSync(path.join(SCRATCH, "vyre-jsx-"));

test("a .jsx page becomes JavaScript with the automatic runtime, and a .tsx page loses its types", async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, "App.jsx"), `import { useState } from "react";\nimport { Heart } from "lucide-react";\nexport default function App() { const [n, setN] = useState(0); return <button onClick={() => setN(n + 1)}><Heart /> {n}</button>; }\n`);
  const r = await build(path.join(dir, "App.jsx"));
  assert.ok(r.ok, JSON.stringify(r));
  assert.match(r.ok ? r.js : "", /from "react\/jsx-runtime"/);
  assert.ok(!/<button/.test(r.ok ? r.js : ""), "the JSX is gone");
  assert.deepEqual(bareImports(r.ok ? r.js : "").sort(), ["lucide-react", "react", "react/jsx-runtime"]);
  fs.writeFileSync(path.join(dir, "T.tsx"), `import React from "react";\ntype P = { n: number };\nexport default function T({ n }: P): JSX.Element { return <b>{n as number}</b>; }\n`);
  const t = await build(path.join(dir, "T.tsx"));
  assert.ok(t.ok && !/type P|: number|JSX\.Element/.test(t.js), JSON.stringify(t));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("an import the list does not have is a plain message naming what is provided; a syntax error names the file and line", async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, "A.jsx"), `import left from "left-pad";\nimport { sum } from "./local.js";\nexport default () => <p>{left("x", 3)}{sum(1, 2)}</p>;\n`);
  const a = await build(path.join(dir, "A.jsx"));
  assert.equal(a.ok, false);
  assert.match(a.ok ? "" : a.error, /imports "left-pad", which Vyre does not provide\. It provides: react, react-dom, recharts, lucide-react/);
  assert.ok(!(a.ok ? "" : a.error).includes("./local.js"), "a relative import is the folder's own");
  fs.writeFileSync(path.join(dir, "B.jsx"), `export default function B() {\n  return <div>\n}\n`);
  const b = await build(path.join(dir, "B.jsx"));
  assert.equal(b.ok, false);
  assert.match(b.ok ? "" : b.error, /^B\.jsx:\d+: /);
  assert.equal((await build(path.join(dir, "missing.jsx"))).ok, false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("the import list is one reviewed table, pinned, and the page that mounts a component says what is wrong on the page itself", () => {
  const L = libs();
  for (const [k, v] of Object.entries(L)) { assert.match(v, /^\/__vyre\/lib\/[A-Za-z0-9._-]+\.js$/, `${k} comes from this box`); assert.ok(libFile(v.slice("/__vyre/lib/".length)), `${k} is the file the manifest recorded`); }
  assert.ok(["react", "react-dom/client", "react/jsx-runtime", "recharts", "lucide-react", "d3", "lodash"].every(k => k in L));
  assert.equal(libFile("../manifest.json"), null, "only listed files are served");
  assert.ok(libFile("tailwind.js"));
  const html = shell({ title: "Case <tasks>", entry: "src/App.jsx", bridge: true });
  assert.match(html, /<title>Case &lt;tasks&gt;<\/title>/);
  assert.match(html, /<script src="\/__vyre\/claude\.js"><\/script><script type="importmap">/, "the bridge comes before the page's own code");
  assert.match(html, /import\("\/src\/App\.jsx"\)/);
  assert.match(html, /id="vyre-problem" role="alert"/);
  assert.ok(!shell({ title: "x", entry: "App.jsx", bridge: false }).includes("claude.js"), "nothing is added to a page that declared nothing");
  assert.match(failing('say "hi"'), /^throw new Error\("say \\"hi\\""\);/);
});

test("a folder's React page is index.jsx, index.tsx, App.jsx or App.tsx", () => {
  const dir = tmp();
  assert.equal(entryIn(dir), null);
  fs.writeFileSync(path.join(dir, "App.tsx"), "export default () => null");
  assert.equal(entryIn(dir), "App.tsx");
  fs.writeFileSync(path.join(dir, "index.jsx"), "export default () => null");
  assert.equal(entryIn(dir), "index.jsx");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a page that imports nothing from anyone else: no address outside this box in the shell", () => {
  const html = shell({ title: "x", entry: "App.jsx", bridge: true });
  assert.doesNotMatch(html, /https?:\/\//, "no third-party address in the page");
});
