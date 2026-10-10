// @ts-check
// chrome.op.call and chrome.op.send end to end against a REAL Chrome (Chrome for Testing with the real Vyre extension and its native host), on a hosted runner or a test box, never a person's machine.
// It is test/site-mac-rung.test.js with the fake extension replaced by the real one: two real vyreds (the box and the Mac, test/link-harness.js), the Mac's Chrome bridge socket is what the native host
// dials, and a small site on 127.0.0.1 is the page the learned operations run in. The site checks what a real browser sends (its own cookie, the CSRF value from the page's storage), so a pass means
// the operation was signed by the browser and not by anyone else. Skipped unless VYRE_CHROME_LIVE=1.
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { until, pair } from "./link-harness.js";
import { learnOperation } from "../lib/siteops/learn.js";
import * as F from "../lib/siteops/fixtures.js";
import { selfSigned } from "../core/wink/control/testing/selfsigned.js";
import { HOST_NAME, hostManifest, launchChrome, prepareExtension, registerHost, resolveChrome, stopProcess, wrapperScript } from "../local/hands-chrome-mac/spike/harness/lib.mjs";

const LIVE = process.env.VYRE_CHROME_LIVE === "1";
const HERE = path.dirname(new URL(import.meta.url).pathname);
const EXT_SRC = path.join(HERE, "..", "local", "hands-chrome-mac", "extension");
const HOST_JS = path.join(HERE, "..", "local", "hands-chrome-mac", "native-host", "host.js");

/** The site: a feed page that keeps the CSRF value in the page's storage and sets the login cookie, a search that wants both, and a messages endpoint that wants both. @param {import("node:test").TestContext} t */
async function site(t) {
  /** @type {{ method: string, url: string, cookie: string, csrf: string, body: string }[]} */ const seen = [];
  const { cert, key } = selfSigned({ ips: ["127.0.0.1"], names: ["app.example.com"] });
  const server = https.createServer({ cert, key }, (req, res) => {
    const chunks = /** @type {Buffer[]} */ ([]);
    req.on("data", c => chunks.push(c));
    req.on("end", () => {
      const url = new URL(req.url || "/", "http://x");
      const cookie = String(req.headers.cookie || ""), csrf = String(req.headers["x-csrf-token"] || "");
      const signed = cookie.includes(`sid=${F.SECRET_COOKIE}`) && csrf === F.CSRF;
      if (url.pathname.startsWith("/api/")) seen.push({ method: String(req.method), url: url.pathname + url.search, cookie, csrf, body: Buffer.concat(chunks).toString("utf8") });
      if (url.pathname === "/feed" || url.pathname === "/inbox") {
        res.writeHead(200, { "content-type": "text/html", "set-cookie": [`sid=${F.SECRET_COOKIE}; Path=/`, "theme=dark; Path=/"] });
        return void res.end(`<!doctype html><title>Feed</title><script>localStorage.setItem("csrf", ${JSON.stringify(F.CSRF)})</script><h1>Feed</h1>`);
      }
      if (url.pathname === "/api/v2/search" && req.method === "GET") {
        if (!signed) { res.writeHead(401, { "content-type": "application/json" }); return void res.end('{"error":"not signed"}'); }
        const term = url.searchParams.get("q") || "x";
        const ex = /** @type {any} */ (F.pageRest(term).at(-1));
        res.writeHead(200, { "content-type": "application/json" });
        return void res.end(ex.response.body);
      }
      if (url.pathname === "/api/v2/messages" && req.method === "POST") {
        if (!signed) { res.writeHead(401, { "content-type": "application/json" }); return void res.end('{"error":"not signed"}'); }
        res.writeHead(200, { "content-type": "application/json" });
        return void res.end('{"ok":true,"id":"m-1"}');
      }
      res.writeHead(404); res.end();
    });
  });
  await new Promise(r => server.listen(0, "127.0.0.1", () => r(undefined)));
  t.after(() => { server.closeAllConnections(); server.close(); });
  // the site answers as https://app.example.com (the product takes an https origin); the browser is told where that name is
  return { origin: "https://app.example.com", port: /** @type {any} */ (server.address()).port, seen };
}

test("chrome.op.call and chrome.op.send drive a page in a real Chrome through a paired Mac: a read at once, a submit refused by .call, a send only with the box's signed yes, revoke stops it", { skip: !LIVE && "set VYRE_CHROME_LIVE=1 (a hosted runner or a test box)", timeout: 300_000 }, async t => {
  const web = await site(t);
  const ORIGIN = web.origin;
  const re = (/** @type {any} */ x) => x;
  const cookies = [{ name: "sid", value: F.SECRET_COOKIE }];
  const read = learnOperation({ name: "searchPeople", exchanges: re(F.pageRest("alpha corp")), exchanges2: re(F.pageRest("beta works")), examples: [{ query: "alpha corp" }, { query: "beta works" }], cookies, storage: F.restStorage, trigger: { url: `${ORIGIN}/search?q={query}` } }).operation;
  const send = learnOperation({ name: "sendMessage", kind: "send", exchanges: re(F.pageSend("ada-lovelace", "hello there friend")), exchanges2: re(F.pageSend("grace-hopper", "second text here")), examples: [{ recipient: "ada-lovelace", text: "hello there friend" }, { recipient: "grace-hopper", text: "second text here" }], cookies, storage: F.restStorage, trigger: { url: `${ORIGIN}/inbox` } }).operation;
  const ENTRIES = [{ name: "searchPeople", kind: "read", op: read }, { name: "sendMessage", kind: "send", op: send }];

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-cor-"));
  const sockDir = fs.mkdtempSync("/tmp/vyre-co-");
  t.after(() => { fs.rmSync(tmp, { recursive: true, force: true }); fs.rmSync(sockDir, { recursive: true, force: true }); });
  const sockPath = path.join(sockDir, "c.sock");
  const s = await pair(t, { macConfig: { modules: { disable: ["hands"] }, chrome: { sockPath, extensionOrigin: null } } });
  await until(async () => { const m = (await s.boxCall("link.macs")).data; return m.length === 1 && m[0].online && m; });
  for (const call of [s.macCall, s.boxCall]) {
    const r = await call("memory.site.put", { origin: ORIGIN, target: "origin", patch: { key: ORIGIN, ops: ENTRIES } });
    assert.equal(r.data && r.data.accepted, true, JSON.stringify(r));
  }

  // the real Chrome with the real extension and native host, its host dialling the Mac vyred's bridge socket
  const udd = path.join(tmp, "profile"); fs.mkdirSync(udd);
  const ext = prepareExtension(EXT_SRC, path.join(tmp, "extension"));
  const wrapper = path.join(tmp, "run-host.sh");
  fs.writeFileSync(wrapper, wrapperScript({ node: process.execPath, hostJs: HOST_JS, sock: sockPath, home: path.join(tmp, "host-home") }), { mode: 0o755 });
  registerHost({ manifestObj: hostManifest({ wrapper, id: ext.id }), dir: tmp, userDataDir: udd });
  void HOST_NAME;
  const chrome = resolveChrome({});
  const launched = launchChrome({ chrome: chrome.path, userDataDir: udd, url: `${ORIGIN}/feed`, extraArgs: [`--load-extension=${ext.dir}`, `--disable-extensions-except=${ext.dir}`, `--host-resolver-rules=MAP app.example.com 127.0.0.1:${web.port}`, "--ignore-certificate-errors"], headless: process.env.VYRE_CHROME_HEADED === "1" ? false : "new", logFile: path.join(tmp, "chrome.log") });
  t.after(() => stopProcess(launched.child));
  await until(async () => (await s.macCall("chrome.status")).data.connected, 60_000);

  const made = await s.boxCall("connectors.site.connect", { site: ORIGIN, label: "LinkedIn" });
  assert.ok(made.data, JSON.stringify(made));
  const run = (/** @type {any} */ input = { query: { query: "gamma labs" } }) => s.boxCall("connectors.operation.run", { connection: "linkedin", operation: "search_people", input });

  // not allowed yet: the Mac refuses, and the real page is never asked
  const before = await run();
  assert.equal(web.seen.length, 0, "nothing reached the site before the person allowed it");
  assert.match(JSON.stringify(before), /has not allowed the box|link\.ops\.allow/);
  assert.equal((await s.macCall("link.ops.allow", { site: ORIGIN, name: "searchPeople" })).data.allowed, true);

  // a read runs at once, in the real page, signed by the real browser's own cookie and the page's own storage
  const out = await run();
  assert.ok(!out.error, JSON.stringify(out));
  assert.equal(out.data.status, 200, JSON.stringify(out.data));
  assert.deepEqual((out.data.body || []).map((/** @type {any} */ p) => p.name).slice(0, 1), ["gamma labs one"]);
  const hit = web.seen.find(x => x.url.startsWith("/api/v2/search"));
  assert.ok(hit, "the site was asked");
  assert.equal(hit.csrf, F.CSRF, "the browser sent the page's CSRF value");
  assert.ok(hit.cookie.includes(`sid=${F.SECRET_COOKIE}`), "and its own login cookie");
  for (const raw of [F.SECRET_COOKIE, F.CSRF]) assert.ok(!JSON.stringify(out).includes(raw), `the answer leaked ${raw}`);

  // a submit through chrome.op.call is refused and points to chrome.op.send; the site sees nothing
  await s.macCall("link.ops.allow", { site: ORIGIN, name: "sendMessage" });
  const before2 = web.seen.length;
  const viaCall = await s.boxCall("link.macs.call", { tool: "chrome.op.call", input: { site: ORIGIN, name: "sendMessage", inputs: { recipient: "alan-turing", text: "a fresh note" } } }, "module:connectors");
  assert.equal(viaCall.data[0].ok, false);
  assert.match(JSON.stringify(viaCall), /chrome\.op\.send/);
  assert.equal(web.seen.length, before2, "a refused submit sent nothing");

  // chrome.op.send: only the connectors module, only with the approval the box signed for exactly this call, once
  const call = { tool: "chrome.op.send", input: { site: ORIGIN, name: "sendMessage", inputs: { recipient: "alan-turing", text: "a fresh note" }, approved: true } };
  for (const caller of ["module:flows", "mcp", "deck"]) assert.ok((await s.boxCall("link.macs.call", call, caller)).error, `${caller} may not ask for an approved outward call`);
  assert.ok((await s.boxCall("link.macs.call", { tool: "chrome.op.send", input: { ...call.input, approved: false } }, "module:connectors")).error, "a send carries the approval");
  assert.equal(web.seen.filter(x => x.method === "POST").length, 0, "no send left before the yes");
  const ok = await s.boxCall("link.macs.call", call, "module:connectors");
  assert.equal(ok.data[0].ok, true, JSON.stringify(ok));
  const posts = web.seen.filter(x => x.method === "POST");
  assert.equal(posts.length, 1, "exactly one message left");
  assert.deepEqual(JSON.parse(posts[0].body), { recipient: "alan-turing", body: "a fresh note", channel: "direct" });
  assert.equal(posts[0].csrf, F.CSRF);

  // revoke: the read stops at once
  assert.equal((await s.macCall("link.ops.revoke", { site: ORIGIN, name: "searchPeople" })).data.revoked, true);
  const nSearch = web.seen.filter(x => x.url.startsWith("/api/v2/search")).length;
  const after = await run();
  assert.ok(after.error || after.data.status >= 400, "revoked: the read no longer runs");
  assert.equal(web.seen.filter(x => x.url.startsWith("/api/v2/search")).length, nSearch, "and the site was not asked");
});
