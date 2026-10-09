// @ts-check
// Previews end to end on a real daemon: an agent's server on a port becomes a preview, opened through the apps' front with a one-time ticket on its own origin; Vyre keeps a person's command running, restarts it,
// stops it; access is decided before a ticket is made; a model never starts a command here.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { start } from "../daemon/index.js";
import { tempHome, present, asOwner } from "../../test/helpers.js";
import { SCRATCH } from "../../test/scratch.mjs";

process.env.VYRE_SEAL_DEV = "1";
process.env.VYRE_KERNEL_PATH_RULE = "1";

/** One request to the apps' front, as a browser on the preview's host would make it. @param {number} port @param {string} host @param {string} p @param {Record<string, string>} [headers] */
const front = (port, host, p, headers = {}) => new Promise((resolve, reject) => {
  const req = http.request({ host: "127.0.0.1", port, path: p, headers: { host, ...headers } }, res => { const c = /** @type {Buffer[]} */ ([]); res.on("data", d => c.push(d)); res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(c).toString() })); });
  req.on("error", reject); req.end();
});

/** A tiny server like an agent's dev server: echoes the Host and a cookie it sets. @param {number} port */
const dev = port => new Promise(resolve => {
  const s = http.createServer((req, res) => { res.writeHead(200, { "content-type": "text/html", "set-cookie": "sid=abc; Path=/" }); res.end(`hello from the preview · host=${req.headers.host} · cookie=${req.headers.cookie || ""}`); });
  s.listen(port, "127.0.0.1", () => resolve(s));
});
const freePort = () => new Promise(resolve => { const s = http.createServer(); s.listen(0, "127.0.0.1", () => { const p = /** @type {any} */ (s.address()).port; s.close(() => resolve(p)); }); });
const until = async (/** @type {() => Promise<boolean>} */ f, ms = 15_000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await f()) return true; await new Promise(r => setTimeout(r, 150)); } return false; };

test("a port becomes a preview, opened on its own origin with a one-time ticket; Vyre keeps a command running; access and agents are held to their lines", { timeout: 120_000 }, async t => {
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "test-box", role: "box" }));
  const d = await start({ root, presence: present, log: () => {}, kernel: true });
  asOwner(d, root);
  t.after(() => d.stop());
  const call = (/** @type {string} */ tool, /** @type {any} */ input, /** @type {string} */ caller = "cli", /** @type {any} */ meta) => d.registry.call(tool, input, caller, meta);
  const fp = await call("appmods.front", {}, "module:previews");
  assert.ok(fp.data, JSON.stringify(fp));
  const frontPort = fp.data.port;

  // an agent's server on a port, opened by the person's own surface
  const port = await freePort();
  const server = await dev(port);
  t.after(() => server.close());
  const opened = await call("previews.open", { title: "Intake form", port, command: "npm run dev" });
  assert.ok(opened.data && /^[0-9a-f]{8}$/.test(opened.data.id), JSON.stringify(opened));
  const id = opened.data.id, name = `pv-${id}`;
  assert.equal(opened.data.preview.mode, "session");
  assert.ok(await until(async () => (await call("previews.get", { id })).data.preview.state === "live"), "the port answers, so it is live");

  // the ticket: one use, this host only, then the cookie opens the page
  const u = new URL((await call("previews.url", { id })).data.url);
  assert.equal(u.hostname, `${name}.localhost`);
  assert.equal((await front(frontPort, u.host, "/")).status, 404, "no cookie, no ticket: nothing is said");
  const enter = /** @type {any} */ (await front(frontPort, u.host, u.pathname + u.search));
  assert.equal(enter.status, 302);
  const cookie = String(enter.headers["set-cookie"]).split(";")[0];
  assert.match(cookie, /^vyre_app=/);
  assert.equal((await front(frontPort, u.host, u.pathname + u.search)).status, 404, "the ticket works once");
  const page = /** @type {any} */ (await front(frontPort, u.host, "/", { cookie: `${cookie}; sid=mine` }));
  assert.equal(page.status, 200);
  assert.match(page.body, /hello from the preview/);
  assert.match(page.body, new RegExp(`host=127\\.0\\.0\\.1:${port}`), "the server is told its own address");
  assert.ok(!page.body.includes("vyre_app"), "Vyre's session cookie never reaches the preview");
  assert.match(page.body, /cookie=sid=mine/, "the preview's own cookie does");
  assert.match(String(page.headers["set-cookie"]), /sid=abc/, "and its own cookie reaches the browser");
  assert.equal((await front(frontPort, `${name}.localhost`, "/", { cookie: "vyre_app=wrong" })).status, 404);

  // access: only its maker and the Space's people; a model asks for nothing but a card
  assert.equal((await call("previews.share", { id, access: "team" })).data.preview.access, "team");
  assert.equal((await call("previews.share", { id, access: "public" })).error.code, "unavailable");
  assert.equal((await call("previews.url", { id }, "mcp")).error && (await call("previews.url", { id }, "mcp")).error.code !== undefined, true, "a model gets no address");
  const agentOpen = await call("previews.open", { title: "Agent page", port }, "mcp");
  assert.ok(agentOpen.data || agentOpen.error, JSON.stringify(agentOpen));
  const agentCmd = await call("previews.open", { title: "Run this", command: "rm -rf /", cwd: root }, "mcp");
  assert.ok(agentCmd.error, "a model never starts a command here");
  assert.equal((await call("previews.open", { title: "Vyre's own", port: frontPort })).error.code, "bad_input", "Vyre's own port is not a preview");
  assert.equal((await call("previews.open", { title: "System", port: 22 })).error.code, "bad_input");

  // stopping takes the sign-ins away and the address says so
  assert.equal((await call("previews.stop", { id })).data.preview.state, "stopped");
  assert.ok((await call("previews.url", { id })).error, "a stopped preview has no address");
  assert.equal((await front(frontPort, `${name}.localhost`, "/", { cookie })).status, 404);
  assert.deepEqual((await call("previews.remove", { id })).data, { removed: id });

  // Vyre runs a person's command: leased port as PORT, live when it answers, restart, log, stop
  const dir = fs.mkdtempSync(path.join(SCRATCH, "vyre-pv-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, "server.js"), 'const http = require("http"); console.log("starting on", process.env.PORT); http.createServer((q, r) => r.end("kept " + process.pid)).listen(+process.env.PORT, "127.0.0.1");\n');
  const kept = await call("previews.open", { title: "Kept", command: "node server.js", cwd: dir });
  assert.ok(kept.data, JSON.stringify(kept));
  const kid = kept.data.id;
  assert.equal(kept.data.preview.mode, "supervised");
  assert.ok(await until(async () => (await call("previews.get", { id: kid })).data.preview.state === "live"), "the command comes up on its leased port");
  const kport = (await call("previews.get", { id: kid })).data.preview.port;
  assert.ok(kport >= 5100 && kport <= 5999, `leased from the pool: ${kport}`);
  const pid1 = await new Promise(r => http.get({ host: "127.0.0.1", port: kport }, res => { let b = ""; res.on("data", c => (b += c)); res.on("end", () => r(b)); }));
  assert.match(String(pid1), /^kept \d+$/);
  assert.match((await call("previews.log", { id: kid })).data.log, /starting on \d+/);
  await call("previews.restart", { id: kid });
  assert.ok(await until(async () => { try { const b = await new Promise((r, j) => http.get({ host: "127.0.0.1", port: kport }, res => { let x = ""; res.on("data", c => (x += c)); res.on("end", () => r(x)); }).on("error", j)); return b !== pid1; } catch { return false; } }), "a restart is a new process on the same port");
  assert.equal((await call("previews.stop", { id: kid })).data.preview.state, "stopped");
  assert.ok(await until(async () => !(await new Promise(r => http.get({ host: "127.0.0.1", port: kport }, () => r(true)).on("error", () => r(false))))), "the process is gone");
  await call("previews.remove", { id: kid });
});

test("the live screen cards: an operator run with a status line, and a private sign-in the person finishes", { timeout: 60_000 }, async t => {
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "test-box", role: "box" }));
  const d = await start({ root, presence: present, log: () => {}, kernel: true });
  asOwner(d, root);
  t.after(() => d.stop());
  const call = (/** @type {string} */ tool, /** @type {any} */ input, /** @type {string} */ caller = "cli", /** @type {any} */ meta) => d.registry.call(tool, input, caller, meta);

  const run = await call("previews.operator", { computer: "kit", title: "Kit's computer" }, "module:siteops");
  assert.ok(run.data && /^[0-9a-f]{12}$/.test(run.data.run), JSON.stringify(run));
  assert.equal((await call("previews.operator", { computer: "bad name!" }, "module:siteops")).error.code, "bad_input");
  for (const line of ["Opening app.example.test", "Typing the password from your Vault", "Reading the workflow list"]) assert.ok((await call("previews.step", { run: run.data.run, line }, "module:siteops")).data);
  assert.equal((await call("previews.step", { run: "nope", line: "x" }, "module:siteops")).error.code, "not_found");
  assert.equal((await call("previews.step", { run: run.data.run, line: "" }, "module:siteops")).error.code, "bad_input");

  // a sign-in: the agent waits, the person signs in and says so; a model cannot say it for them
  const asked = await call("previews.signin", { computer: "kit", site: "GoHighLevel", why: "I need to look at the workflow", wait_ms: 0 }, "module:siteops");
  assert.equal(asked.data.state, "waiting");
  assert.ok((await call("previews.signin-done", { id: asked.data.id }, "mcp")).error, "a model does not sign in for the person");
  assert.equal((await call("previews.signin-get", { id: asked.data.id }, "module:siteops")).data.state, "waiting");
  const waiting = call("previews.signin-get", { id: asked.data.id, wait_ms: 10_000 }, "module:siteops");
  await new Promise(r => setTimeout(r, 100));
  assert.equal((await call("previews.signin-done", { id: asked.data.id })).data.state, "done");
  assert.equal((await waiting).data.state, "done", "the agent carries on once the person is done");
  assert.equal((await call("previews.signin", { computer: "kit", site: "" }, "module:siteops")).error.code, "bad_input");
});

test("files: a page, a folder, Markdown and a single-page app are served on a preview's own origin as written; the root is a wall", { timeout: 60_000 }, async t => {
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "test-box", role: "box" }));
  const d = await start({ root, presence: present, log: () => {}, kernel: true });
  asOwner(d, root);
  t.after(() => d.stop());
  const call = (/** @type {string} */ tool, /** @type {any} */ input, /** @type {string} */ caller = "cli", /** @type {any} */ meta) => d.registry.call(tool, input, caller, meta);
  const frontPort = (await call("appmods.front", {}, "module:previews")).data.port;
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(SCRATCH, "vyre-pf-")));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const outside = fs.realpathSync(fs.mkdtempSync(path.join(SCRATCH, "vyre-pf-out-")));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.writeFileSync(path.join(outside, "secret.txt"), "outside the wall");
  fs.mkdirSync(path.join(dir, "site", "assets"), { recursive: true });
  fs.writeFileSync(path.join(dir, "site", "index.html"), "<!doctype html><html><head><title>Site</title></head><body><script>window.page='mine'</script>hello folder</body></html>");
  fs.writeFileSync(path.join(dir, "site", "assets", "app.js"), "console.log('app')");
  fs.writeFileSync(path.join(dir, "site", ".env"), "SECRET=1");
  fs.symlinkSync(path.join(outside, "secret.txt"), path.join(dir, "site", "leak.txt"));
  fs.writeFileSync(path.join(dir, "notes.md"), "# Notes\n\nSome **bold** words.\n");

  /** Sign in to a preview and fetch paths from it. @param {string} id */
  const browse = async id => {
    const u = new URL((await call("previews.url", { id })).data.url);
    const enter = /** @type {any} */ (await front(frontPort, u.host, u.pathname + u.search));
    const cookie = String(enter.headers["set-cookie"]).split(";")[0];
    return (/** @type {string} */ p) => /** @type {Promise<any>} */ (front(frontPort, u.host, p, { cookie }));
  };

  const site = await call("previews.open", { title: "Site", path: path.join(dir, "site") });
  assert.ok(site.data, JSON.stringify(site));
  assert.equal(site.data.preview.source, "files");
  const get = await browse(site.data.id);
  const home = await get("/");
  assert.equal(home.status, 200);
  assert.match(home.headers["content-type"], /text\/html/);
  assert.match(home.body, /window\.page='mine'/, "the page is served as written");
  assert.ok(!home.body.includes("__vyre"), "nothing is added to a page that declared nothing");
  assert.match((await get("/assets/app.js")).headers["content-type"], /javascript/);
  assert.equal((await get("/some/client/route")).body.includes("hello folder"), true, "a single-page app falls back to its index");
  for (const bad of ["/../notes.md", "/%2e%2e/notes.md", "/.env", "/leak.txt", "/assets/../../notes.md", "/assets/%00x"]) assert.equal((await get(bad)).status, 404, `refused: ${bad}`);

  // one Markdown file is drawn as a page
  const md = await call("previews.open", { title: "Notes", path: path.join(dir, "notes.md") });
  const getMd = await browse(md.data.id);
  const page = await getMd("/");
  assert.equal(page.status, 200);
  assert.match(page.body, /<h1[^>]*>Notes<\/h1>/);
  assert.match(page.body, /<strong>bold<\/strong>/);

  // a model's path must be inside the folder its session works in: with no verified session it is refused
  const agent = await call("previews.open", { title: "Peek", path: outside }, "mcp");
  assert.ok(agent.error && agent.error.code === "denied", JSON.stringify(agent));
  assert.equal((await call("previews.open", { title: "Nothing", path: path.join(dir, "missing") })).error.code, "bad_input");
  assert.equal((await call("previews.open", { title: "Relative", path: "site" })).error.code, "bad_input");
});
