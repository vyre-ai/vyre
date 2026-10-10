// @ts-check
// Publish's builder against the real previews module on a real daemon: a folder holding a React page comes back as the site files the Preview pane's own compiler and library table make, and a page
// the pane could not show is refused in the pane's words. A test box, never a Mac.
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { start } from "../core/daemon/index.js";
import { tempHome, present } from "./helpers.js";

process.env.VYRE_SEAL_DEV = "1";
process.env.VYRE_KERNEL_PATH_RULE = "1";

test("a folder with App.jsx builds into index.html, compiled files and the libraries; a page with an unknown import is refused naming it", { timeout: 180_000 }, async t => {
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "alex", vault: { keystore: "file" } }));
  const d = await start({ root, presence: present, log: () => {} });
  t.after(() => d.stop());
  const site = fs.mkdtempSync(path.join(root, "site-"));
  fs.writeFileSync(path.join(site, "App.jsx"), `import { useState } from "react";\nexport default function App() { const [n] = useState(2); return <h1>Northwind {n}</h1>; }\n`);
  fs.writeFileSync(path.join(site, ".env"), "KEY=left-out");
  const build = (/** @type {string} */ ref) => d.registry.call("builder.build", { deployment: { id: "dep_a", source: { kind: "folder", ref }, build: { command: "", output_dir: ".", image: "static" } }, secretArgs: [] }, "module:publish");
  const ok = await build(site);
  assert.ok(!ok.error, JSON.stringify(ok.error));
  const names = ok.data.files.map((/** @type {any} */ f) => f.path);
  for (const want of ["index.html", "App.js", "__vyre/lib/react.js", "__vyre/lib/react-dom__client.js"]) assert.ok(names.includes(want), `${want} is in ${names.join(", ")}`);
  assert.ok(!names.includes("App.jsx") && !names.includes(".env"));
  assert.match(ok.data.logs, /React page App\.jsx compiled/);
  assert.match(ok.data.digest, /^sha256:[0-9a-f]{64}$/);
  const again = await build(site);
  assert.equal(again.data.digest, ok.data.digest, "the same folder is the same build");

  fs.writeFileSync(path.join(site, "App.jsx"), `import left from "left-pad";\nexport default () => <p>{left("x", 3)}</p>;\n`);
  const bad = await build(site);
  assert.equal(bad.error && bad.error.code, "refused");
  assert.match(bad.error.message, /left-pad/);
});
