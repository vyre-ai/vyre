// @ts-check
// J4, the Publish step, on a real daemon: a folder holding a React page and a stray .env goes live on ONE yes. The model-side call (publish.quick) only holds; the person's decision completes it; what lands
// in the site folder is the pane's own page with only the libraries it uses, and the .env is nowhere in it. A test box, never a Mac.
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import os from "node:os";
import { spawn, execFile } from "node:child_process";
import { headlessChrome } from "./headless-chrome.js";
import { CHROME_SAFE } from "../lib/chrome-flags/index.js";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { start } from "../core/daemon/index.js";
import { tempHome, present } from "./helpers.js";

process.env.VYRE_SEAL_DEV = "1";
process.env.VYRE_KERNEL_PATH_RULE = "1";
const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "standin-directory.mjs");
const freePort = () => new Promise(res => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = /** @type {any} */ (s.address()).port; s.close(() => res(p)); }); });

/** Every file under a folder, relative. @param {string} dir @returns {string[]} */
const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? walk(path.join(dir, e.name)).map(f => `${e.name}/${f}`) : [e.name]));

test("a React page in a folder goes live on one yes, as the pane showed it, with the .env left out", { timeout: 240_000 }, async t => {
  const port = await freePort();
  const child = spawn(process.execPath, [SCRIPT, "--port", String(port)], { stdio: ["ignore", "pipe", "inherit"] });
  t.after(() => { child.kill("SIGTERM"); });
  await new Promise((res, rej) => { child.stdout.on("data", d => { if (String(d).includes("stand-in names directory")) res(null); }); child.on("exit", c => rej(new Error(`the stand-in exited early (${c})`))); });
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "bakery-box", vault: { keystore: "file" }, names: { directory: `http://127.0.0.1:${port}` } }));
  const d = await start({ root, presence: present, log: () => {} });
  t.after(() => d.stop());
  // the person's chain, built from whoever owns the home NOW: claiming a name changes the owner's id
  const as = async (/** @type {string} */ tool, /** @type {any} */ input = {}) => {
    const owner = d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: d.kernel.id.owner, path: "direct", session: "s" });
    return d.registry.call(tool, input, "cli", { token: (await d.kernel.surfaces.open(owner, {})).token });
  };
  const made = await as("spaces.identity.create", { name: "alex" });
  assert.ok(!made.error, JSON.stringify(made.error));
  const sp = await as("spaces.create", { name: "bakery", home: { kind: "this-computer", confirmed: true } });
  assert.ok(!sp.error, JSON.stringify(sp.error));
  const site = fs.mkdtempSync(path.join(root, "bakery-"));
  fs.writeFileSync(path.join(site, "App.jsx"), `import { useState } from "react";\nexport default function App() { const [n] = useState(3); return <main><h1>Northwind Bakery</h1><p id="count">{n} loaves today</p></main>; }\n`);
  fs.writeFileSync(path.join(site, ".env"), "STRIPE_KEY=left-out-of-the-site\n");

  const q = await as("publish.quick", { name: "bakery", folder: site, space: "bakery.vyre.run" });
  assert.ok(!q.error, JSON.stringify(q.error));
  assert.equal(q.data.held, true, "nothing is live yet: the call holds for the person");
  assert.equal(q.data.deployment.stage, "Preview");
  assert.equal(q.data.public, false);
  assert.match(q.data.note, /^Public once the public door is on/);
  assert.ok(q.data.plan.files.paths.includes("index.html") && q.data.plan.files.paths.includes("App.js"), "the plan names what goes public");
  assert.ok(!q.data.plan.files.paths.some((/** @type {string} */ p) => /\.env|App\.jsx/.test(p)));
  assert.equal((await as("publish.status", { deployment: q.data.deployment.id })).data.stage, "Preview");

  const done = await as("publish.decide", { task: q.data.task, approve: true, plan_hash: q.data.plan.hash });
  assert.ok(!done.error, JSON.stringify(done.error));
  assert.equal(done.data.deployment.stage, "Production", "one yes: Preview to Approved to Production");
  assert.match(done.data.deployment.url, /^https:\/\//);

  // what was written for the edge: the page, the compiled file, the libraries it uses, and not the .env
  const sites = path.join(root, "publish");
  const written = walk(sites);
  for (const want of ["index.html", "App.js", "__vyre/lib/react.js", "__vyre/lib/react-dom__client.js"]) assert.ok(written.some(f => f.endsWith(want)), `${want} was written; got ${written.slice(0, 12).join(", ")}`);
  assert.ok(!written.some(f => /(^|\/)\.env$/.test(f)) && !written.some(f => f.endsWith("App.jsx")));
  const html = fs.readFileSync(path.join(sites, written.find(f => f.endsWith("index.html")) || ""), "utf8");
  assert.match(html, /import\("\/App\.js"\)/);
  assert.ok(!written.some(f => fs.readFileSync(path.join(sites, f)).includes("left-out-of-the-site")), "the .env value is in no published file");

  // opened in a real headless browser, served the way a static host serves it, the published files draw the page
  const siteDir = path.join(sites, path.dirname(written.find(f => f.endsWith("index.html")) || ""));
  const MIME = /** @type {Record<string, string>} */ ({ ".html": "text/html; charset=utf-8", ".js": "text/javascript" });
  const srv = http.createServer((req, res) => {
    const rel = decodeURIComponent(new URL(req.url || "/", "http://x").pathname).replace(/^\//, "") || "index.html";
    const f = path.join(siteDir, rel);
    if (!f.startsWith(siteDir) || !fs.existsSync(f) || !fs.statSync(f).isFile()) { res.writeHead(404); return void res.end(); }
    res.writeHead(200, { "content-type": MIME[path.extname(f)] || "application/octet-stream" });
    res.end(fs.readFileSync(f));
  });
  await new Promise(ok => srv.listen(0, "127.0.0.1", () => ok(undefined)));
  t.after(() => srv.close());
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-live-chrome-"));
  t.after(() => fs.rmSync(profile, { recursive: true, force: true }));
  const dom = await new Promise(ok => execFile(headlessChrome(), [...CHROME_SAFE, "--no-sandbox", "--disable-gpu", `--user-data-dir=${profile}`, "--virtual-time-budget=8000", "--dump-dom", `http://127.0.0.1:${/** @type {any} */ (srv.address()).port}/`], { encoding: "utf8", timeout: 40_000, maxBuffer: 8 << 20 }, (_e, out) => ok(String(out || ""))));
  assert.match(String(dom), /Northwind Bakery/);
  assert.match(String(dom), /3 loaves today/);
});

test("a files preview's card publishes its own folder: publish.quick { name, preview } holds for one yes, and a path never crosses the surface", { timeout: 240_000 }, async t => {
  const port = await freePort();
  const child = spawn(process.execPath, [SCRIPT, "--port", String(port)], { stdio: ["ignore", "pipe", "inherit"] });
  t.after(() => { child.kill("SIGTERM"); });
  await new Promise((res, rej) => { child.stdout.on("data", d => { if (String(d).includes("stand-in names directory")) res(null); }); child.on("exit", c => rej(new Error(`the stand-in exited early (${c})`))); });
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "bakery-box", vault: { keystore: "file" }, names: { directory: `http://127.0.0.1:${port}` } }));
  const d = await start({ root, presence: present, log: () => {} });
  t.after(() => d.stop());
  const as = async (/** @type {string} */ tool, /** @type {any} */ input = {}, caller = "cli") => {
    const owner = d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: d.kernel.id.owner, path: "direct", session: "s" });
    return d.registry.call(tool, input, caller, { token: (await d.kernel.surfaces.open(owner, {})).token });
  };
  assert.ok(!(await as("spaces.identity.create", { name: "alex" })).error);
  assert.ok(!(await as("spaces.create", { name: "bakery", home: { kind: "this-computer", confirmed: true } })).error);
  const site = fs.mkdtempSync(path.join(root, "pv-site-"));
  fs.writeFileSync(path.join(site, "index.html"), "<h1>Northwind</h1>");
  const opened = await as("previews.open", { title: "Northwind", path: site });
  assert.ok(!opened.error, JSON.stringify(opened.error));
  const id = opened.data.id;
  // a Space made a moment ago is set up in the background (its name is registered with the directory); the card's tap comes after that, so the walk waits for it the way a person's tap would
  let q = await as("publish.quick", { name: "bakery", preview: id, space: "bakery.vyre.run" });
  for (let n = 0; q.error && q.error.code === "no_space" && n < 60; n++) { await new Promise(r => setTimeout(r, 500)); q = await as("publish.quick", { name: "bakery", preview: id, space: "bakery.vyre.run" }); }
  assert.ok(!q.error, JSON.stringify(q.error));
  assert.equal(q.data.held, true);
  assert.deepEqual(q.data.plan.files.paths, ["index.html"]);
  assert.ok(!JSON.stringify(q).includes(site), "the answer does not carry the folder's path");
  const done = await as("publish.decide", { task: q.data.task, approve: true, plan_hash: q.data.plan.hash });
  assert.equal(done.data.deployment.stage, "Production");
  assert.match(done.data.deployment.url, /^https:\/\//);
  // both or neither is refused, a model cannot publish a preview, and a preview that is not a folder of files is refused in words
  assert.equal((await as("publish.quick", { name: "x", folder: site, preview: id, space: "bakery.vyre.run" })).error.code, "bad_input");
  assert.equal((await as("publish.quick", { name: "x", space: "bakery.vyre.run" })).error.code, "bad_input");
  assert.equal((await d.registry.call("publish.quick", { name: "x", preview: id }, "mcp", {})).error.code !== undefined, true);
  const server = await as("previews.open", { title: "A server", port: 5999 });
  const notFiles = server.error ? null : await as("publish.quick", { name: "y", preview: server.data.id, space: "bakery.vyre.run" });
  if (notFiles) assert.match(notFiles.error.message, /not a folder of files|running server/);
});

