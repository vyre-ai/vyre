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
  const frontPort = (await call("appmods.front", {}, "cli")).data.port;

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
