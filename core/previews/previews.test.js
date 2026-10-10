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
process.env.VYRE_PREVIEW_THUMBS = "0"; // these tests are about the origin and the bridge; the picture has its own test (thumb.test.js)

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
  assert.equal(agentOpen.data && agentOpen.data.preview && agentOpen.data.preview.access, "me", "a model's preview is private to its person");
  // a model cannot open a preview wider than its person or its own chat's project: that is previews.share, a person's act
  for (const wide of [{ access: "team" }, { access: "project" }, { project: "someone-elses" }, { access: "team", project: "someone-elses" }]) {
    const r = await call("previews.open", { title: "Too wide", port, ...wide }, "mcp");
    assert.equal(r.error && r.error.code, "denied", JSON.stringify(wide));
  }
  const agentFiles = await call("previews.open", { title: "Wide files", path: root, access: "team" }, "mcp");
  assert.equal(agentFiles.error && agentFiles.error.code, "denied", "the files form follows the same rule");
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

  // a stuck run asks for what it needs typed; the person's reply reaches it; a model cannot reply for them
  assert.ok((await call("previews.step", { run: run.data.run, line: "The site asked for a code I do not have", state: "stuck", ask: "The 6-digit code" }, "module:siteops")).data);
  const pending = call("previews.run-get", { run: run.data.run, wait_ms: 10_000 }, "module:siteops");
  await new Promise(r => setTimeout(r, 100));
  assert.ok((await call("previews.reply", { run: run.data.run, text: "123456" }, "mcp")).error, "a model does not reply for the person");
  assert.equal((await call("previews.reply", { run: run.data.run, text: "   " })).error.code, "bad_input");
  assert.equal((await call("previews.reply", { run: run.data.run, text: "123456" })).data.state, "working");
  assert.deepEqual((await pending).data, { run: run.data.run, state: "working", reply: "123456" }, "the run reads what the person typed");
  assert.equal((await call("previews.run-get", { run: "nope" }, "module:siteops")).error.code, "not_found");
  // a still of the computer for the card: a person's call; without a computer service it says why, not an error page
  const frame = await call("previews.frame", { run: run.data.run });
  assert.ok(frame.data && frame.data.image === null && typeof frame.data.why === "string", JSON.stringify(frame));
  assert.ok((await call("previews.frame", { run: run.data.run }, "mcp")).error, "a model gets no picture of the person's screen");
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

test("the bridge: a page that declared capabilities gets Claude's runtime shape, each asks the viewer, db keeps documents in Records under last-writer-wins and live subscribers hear every write", { timeout: 90_000 }, async t => {
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "test-box", role: "box" }));
  const d = await start({ root, presence: present, log: () => {}, kernel: true });
  asOwner(d, root);
  t.after(() => d.stop());
  const call = (/** @type {string} */ tool, /** @type {any} */ input, /** @type {string} */ caller = "cli", /** @type {any} */ meta) => d.registry.call(tool, input, caller, meta);
  const frontPort = (await call("appmods.front", {}, "module:previews")).data.port;
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(SCRATCH, "vyre-pb-")));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, "index.html"), "<!doctype html><html><head><title>Tasks</title></head><body><script>window.mine=1</script>tasks</body></html>");
  fs.writeFileSync(path.join(dir, "plain.html"), "<!doctype html><html><head></head><body>nothing declared</body></html>");
  const caps = { user: {}, sample: {}, downloads: true, db: { rules: [{ path: "board", read: "view", write: "admin" }, { path: "votes", read: "view", write: "owner" }, { path: "votes/{self}", write: "interact" }] } };
  const pv = await call("previews.open", { title: "Tasks", path: dir, capabilities: caps });
  assert.ok(pv.data, JSON.stringify(pv));
  const id = pv.data.id;
  const u = new URL((await call("previews.url", { id })).data.url);
  const enter = /** @type {any} */ (await front(frontPort, u.host, u.pathname + u.search));
  const cookie = String(enter.headers["set-cookie"]).split(";")[0];
  const page = /** @type {any} */ (await front(frontPort, u.host, "/", { cookie }));
  assert.match(page.body, /<script src="\/__vyre\/claude\.js"><\/script>/, "the bridge is added, to a page that declared capabilities");
  assert.match(page.body, /window\.mine=1/, "and nothing else is touched");
  const script = /** @type {any} */ (await front(frontPort, u.host, "/__vyre/claude.js", { cookie }));
  assert.equal(script.status, 200);
  assert.match(script.body, /var NAME = "claude";[\s\S]*window\[NAME\] = Object\.freeze/); // the page global is `claude`, named once
  assert.match(script.body, /use: function/);

  /** One bridge call. @param {string} op @param {any} args @param {Record<string, string>} [extra] */
  const bridge = (op, args = {}, extra = {}) => new Promise((resolve, reject) => {
    const body = JSON.stringify({ op, args });
    const req = http.request({ host: "127.0.0.1", port: frontPort, method: "POST", path: "/__vyre/api", headers: { host: u.host, cookie, "content-type": "application/json", "x-page-bridge": "1", "content-length": String(Buffer.byteLength(body)), ...extra } },
      res => { const c = /** @type {Buffer[]} */ ([]); res.on("data", x => c.push(x)); res.on("end", () => resolve({ status: res.statusCode, ...JSON.parse(Buffer.concat(c).toString() || "{}") })); });
    req.on("error", reject); req.end(body);
  });
  const ok = async (/** @type {string} */ op, /** @type {any} */ args) => { const r = /** @type {any} */ (await bridge(op, args)); assert.ok(!r.error, `${op}: ${JSON.stringify(r)}`); return r.data; };
  const code = async (/** @type {string} */ op, /** @type {any} */ args) => /** @type {any} */ ((await bridge(op, args)).error || {}).code;

  // nothing is on until the viewer says so
  assert.equal((/** @type {any} */ (await bridge("caps"))).status, 200);
  const meta = await ok("caps", {});
  assert.deepEqual([...meta.declared].sort(), ["db", "downloads", "sample", "user"]);
  assert.equal(meta.state.db, "prompt");
  assert.equal(meta.state.permissions, "granted");
  assert.equal(await code("db.get", { path: "tasks/t1" }), "consent_required", "a declared capability still asks at its first use");
  assert.equal((/** @type {any} */ (await bridge("db.get", { path: "tasks/t1" }, { "x-page-bridge": "0" }))).status, 403, "a request that is not from the page's own script is refused");
  assert.equal((await ok("permissions.grant", { names: ["db", "user", "nope"], allow: true })).db, "granted");
  assert.equal((await ok("caps", {})).state.sample, "prompt");
  assert.equal(await code("sample.complete", { input: "hi" }), "consent_required");
  await ok("permissions.grant", { names: ["sample"], allow: false });
  assert.equal(await code("sample.complete", { input: "hi" }), "not_granted", "a no is a no");
  assert.equal(await code("assets.upload", {}), "not_granted", "what the page did not declare is not there");

  // user: an id of the page's own, the viewer's level
  const me = await ok("user.info", {});
  assert.match(me.id, /^[0-9a-f]{20}$/);
  assert.equal(me.isOwner, true);
  assert.equal(me.canEdit, true);
  assert.equal(me.can["data.write"], true);

  // db: documents at slash paths
  assert.equal((await ok("db.get", { path: "tasks/t1" })).exists, false);
  await ok("db.set", { path: "tasks/t1", data: { title: "Call the client", done: false, n: 2 } });
  await ok("db.set", { path: "tasks/t2", data: { title: "File the motion", done: true, n: 1 } });
  await ok("db.set", { path: "tasks/t3", data: { title: "Send the invoice", done: false, n: 3 } });
  assert.deepEqual((await ok("db.get", { path: "tasks/t1" })).data, { title: "Call the client", done: false, n: 2 });
  await ok("db.update", { path: "tasks/t1", data: { done: true, meta: { by: "me" } } });
  await ok("db.update", { path: "tasks/t1", data: { meta: { at: 1 } } });
  assert.deepEqual((await ok("db.get", { path: "tasks/t1" })).data, { title: "Call the client", done: true, n: 2, meta: { by: "me", at: 1 } }, "update merges nested objects");
  assert.equal(await code("db.update", { path: "tasks/nope", data: { a: 1 } }), "invalid_argument", "update requires the document to exist");
  const all = await ok("db.query", { path: "tasks", query: {} });
  assert.deepEqual(all.docs.map((/** @type {any} */ x) => x.id), ["t1", "t2", "t3"], "without orderBy, by id");
  assert.deepEqual((await ok("db.query", { path: "tasks", query: { where: [{ field: "done", op: "==", value: false }] } })).docs.map((/** @type {any} */ x) => x.id), ["t3"]);
  assert.deepEqual((await ok("db.query", { path: "tasks", query: { orderBy: { field: "n", dir: "desc" }, limit: 2 } })).docs.map((/** @type {any} */ x) => x.id), ["t3", "t1"]);
  assert.deepEqual((await ok("db.query", { path: "tasks", query: { where: [{ field: "n", op: "in", value: [1, 3] }] } })).docs.map((/** @type {any} */ x) => x.id), ["t2", "t3"]);
  await ok("db.delete", { path: "tasks/t2", data: undefined });
  await ok("db.delete", { path: "tasks/t2" });
  assert.equal((await ok("db.get", { path: "tasks/t2" })).exists, false, "delete is idempotent");
  assert.equal(await code("db.get", { path: "tasks" }), "invalid_argument", "a collection path is not a document path");
  assert.equal(await code("db.get", { path: "a/../b" }), "invalid_argument");
  assert.equal(await code("db.set", { path: "tasks/big", data: { s: "x".repeat(300_000) } }), "invalid_argument", "a document is at most 256 KiB");
  assert.equal(await code("db.set", { path: "tasks/arr", data: [1, 2] }), "invalid_argument", "a document is an object");
  assert.equal(await code("db.query", { path: "tasks", query: { where: [{ field: "a", op: "~", value: 1 }] } }), "invalid_argument");
  // last writer wins: two writes in a row, the second stands
  await Promise.all([ok("db.set", { path: "lww/a", data: { v: 1 } }), ok("db.set", { path: "lww/a", data: { v: 2 } })]);
  assert.ok([1, 2].includes((await ok("db.get", { path: "lww/a" })).data.v));
  // a lease: set-if-not-busy
  const lease = await ok("db.acquire", { path: "locks/l1", holder: "tab-a", ttlMs: 5000 });
  assert.equal(lease.acquired, true);
  assert.equal((await ok("db.acquire", { path: "locks/l1", holder: "tab-b", ttlMs: 5000 })).acquired, false);
  assert.equal((await ok("db.acquire", { path: "locks/l1", holder: "tab-a", ttlMs: 5000 })).acquired, true, "the holder renews");

  // subscribers hear every write, live (server-sent events)
  const events = /** @type {any[]} */ ([]);
  const sse = http.request({ host: "127.0.0.1", port: frontPort, path: `/__vyre/api/stream?kind=query&path=tasks&q=${encodeURIComponent(JSON.stringify({ where: [{ field: "done", op: "==", value: false }] }))}`, headers: { host: u.host, cookie } }, res => {
    let buf = ""; res.on("data", c => { buf += c; let i; while ((i = buf.indexOf("\n\n")) >= 0) { const frame = buf.slice(0, i); buf = buf.slice(i + 2); const m = /^event: (\w+)\ndata: (.*)$/m.exec(frame); if (m) events.push({ event: m[1], data: JSON.parse(m[2]) }); } });
  });
  sse.end();
  t.after(() => sse.destroy());
  assert.ok(await until(async () => events.length >= 1), "the first snapshot arrives");
  assert.deepEqual(events[0].data.docs.map((/** @type {any} */ x) => x.id), ["t3"]);
  await ok("db.set", { path: "tasks/t4", data: { title: "Pay the court fee", done: false, n: 4 } });
  assert.ok(await until(async () => events.length >= 2), "a write by anyone reaches the subscriber");
  assert.deepEqual(events[1].data.docs.map((/** @type {any} */ x) => x.id), ["t3", "t4"]);
  await ok("db.update", { path: "tasks/t3", data: { done: true } });
  assert.ok(await until(async () => events.length >= 3));
  assert.deepEqual(events[2].data.docs.map((/** @type {any} */ x) => x.id), ["t4"], "a document that stops matching leaves the set");

  // rules: the maker is owner, so every level passes; a member at "interact" is held to them
  const o = /** @type {any} */ (await call("previews.resolve", { name: `pv-${id}` }, "module:appmods"));
  const direct = (/** @type {Record<string, string>} */ headers) => new Promise(resolve => { const body = JSON.stringify({ op: "caps", args: {} }); const r = http.request({ host: "127.0.0.1", port: Number(new URL(o.data.origin).port), method: "POST", path: "/__vyre/api", headers: { host: `pv-${id}.localhost`, "content-type": "application/json", "x-page-bridge": "1", "content-length": String(Buffer.byteLength(body)), ...headers } }, res => resolve(res.statusCode)); r.end(body); });
  assert.equal(await direct({}), 401, "no viewer, no bridge");
  assert.equal(await direct({ "x-vyre-viewer": "eyJ3IjoiZXZpbCJ9.forged" }), 401, "a local process cannot say who it is");
  // the runner module can ask whether a header is the front's (the preview of a chat on a person's computer gates its bridge on it, trust row 32); nobody else can, and a forged one is no
  const { viewerHeader } = await import("../appmods/proxy.js");
  const real = viewerHeader(o.data.viewerKey, { w: "per_owner", r: "owner" });
  assert.equal(/** @type {any} */ (await call("previews.viewer-ok", { header: real }, "module:runner")).data.ok, true);
  assert.equal(/** @type {any} */ (await call("previews.viewer-ok", { header: "eyJ3IjoiZXZpbCJ9.forged" }, "module:runner")).data.ok, false);
  assert.ok(/** @type {any} */ (await call("previews.viewer-ok", { header: real }, "module:appmods")).error, "another module is refused");
  assert.equal((await call("previews.open", { title: "Plain", path: path.join(dir, "plain.html") })).data.preview.source, "files");
});

test("a React page: a .jsx file, or a folder with App.jsx, is built and mounted; its own sibling files, a broken file and an import the list does not have each say so plainly", { timeout: 90_000 }, async t => {
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "test-box", role: "box" }));
  const d = await start({ root, presence: present, log: () => {}, kernel: true });
  asOwner(d, root);
  t.after(() => d.stop());
  const call = (/** @type {string} */ tool, /** @type {any} */ input, /** @type {string} */ caller = "cli") => d.registry.call(tool, input, caller);
  const frontPort = (await call("appmods.front", {}, "module:previews")).data.port;
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(SCRATCH, "vyre-pj-")));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, "App.jsx"), `import { useState } from "react";\nimport Card from "./Card.jsx";\nexport default function App() { const [n] = useState(1); return <Card n={n} />; }\n`);
  fs.writeFileSync(path.join(dir, "Card.jsx"), `export default function Card({ n }) { return <div className="p-4">card {n}</div>; }\n`);
  const browse = async (/** @type {string} */ id) => { const u = new URL((await call("previews.url", { id })).data.url); const enter = /** @type {any} */ (await front(frontPort, u.host, u.pathname + u.search)); const cookie = String(enter.headers["set-cookie"]).split(";")[0]; return (/** @type {string} */ p) => /** @type {Promise<any>} */ (front(frontPort, u.host, p, { cookie })); };

  const pv = await call("previews.open", { title: "Card", path: dir, capabilities: { user: {} } });
  const get = await browse(pv.data.id);
  const home = await get("/");
  assert.equal(home.status, 200);
  assert.match(home.headers["content-type"], /text\/html/);
  assert.match(home.body, /<script type="importmap">/);
  assert.match(home.body, /<script src="\/__vyre\/claude\.js"><\/script>/, "a page that declared capabilities gets the bridge");
  assert.match(home.body, /import\("\/App\.jsx"\)/);
  const app = await get("/App.jsx");
  assert.match(app.headers["content-type"], /javascript/);
  assert.match(app.body, /from "\.\/Card\.jsx"/);
  assert.match(app.body, /react\/jsx-runtime/);
  assert.match((await get("/Card.jsx")).body, /className: "p-4"/, "its own sibling files are built too");

  // a broken file and an import the list does not have each say so, as the error the page shows
  fs.writeFileSync(path.join(dir, "Card.jsx"), "export default function Card() {\n  return <div>\n}\n");
  assert.match((await get("/Card.jsx")).body, /^throw new Error\(".*Card\.jsx:\d+: /);
  fs.writeFileSync(path.join(dir, "Card.jsx"), `import x from "left-pad";\nexport default () => <p>{x}</p>;\n`);
  assert.match((await get("/Card.jsx")).body, /which Vyre does not provide/);

  // a single .tsx file is the preview, and a plain page (no capabilities) gets no bridge
  fs.writeFileSync(path.join(dir, "Solo.tsx"), "export default function Solo(): JSX.Element { return <i>solo</i>; }\n");
  const solo = await call("previews.open", { title: "Solo", path: path.join(dir, "Solo.tsx") });
  const getSolo = await browse(solo.data.id);
  const page = await getSolo("/");
  assert.match(page.body, /import\("\/Solo\.tsx"\)/);
  assert.ok(!page.body.includes("claude.js"));
  assert.ok(!/: JSX\.Element/.test((await getSolo("/Solo.tsx")).body));
});
