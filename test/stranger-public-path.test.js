// @ts-check
// S6 (issue #133): a stranger on an app's public path is a stranger to the app. The front used to sign in as the install's admin and send that session with the stranger's request.
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createHostProxy, createTickets } from "../core/appmods/proxy.js";

const MARK = "ADMIN-SESSION-OWNER-ONLY";

test("a stranger on a public path is sent none of the install's admin session; the owner still is", async t => {
  /** @type {string[]} */ const cookies = [];
  const app = http.createServer((req, res) => {
    req.resume();
    if (req.url === "/sign_in" && req.method === "GET") { res.writeHead(200, { "content-type": "text/html" }); return res.end('<input name="authenticity_token" value="t">'); }
    if (req.url === "/sign_in") { res.writeHead(302, { location: "/", "set-cookie": [`_admin=${MARK}; Path=/`] }); return res.end(); }
    cookies.push(String(req.headers.cookie || ""));
    res.writeHead(200, { "content-type": "text/plain" }); res.end(String(req.headers.cookie || "").includes(MARK) ? "OWNER-DATA" : "page");
  });
  await new Promise(r => app.listen(0, "127.0.0.1", () => r(undefined)));
  const tickets = createTickets();
  const origin = `http://127.0.0.1:${/** @type {any} */ (app.address()).port}`;
  const proxy = createHostProxy({ tickets, app: async () => ({ origin, origins: [origin], login: { path: "/sign_in", token: "authenticity_token", fields: {}, ok: [302] }, public: ["/manifest.json"], credentials: async () => ({}) }) });
  const front = http.createServer((req, res) => { proxy(req, res, { url: new URL(req.url || "/", "http://x") }).then(done => { if (!done) { res.writeHead(404); res.end(); } }); });
  await new Promise(r => front.listen(0, "127.0.0.1", () => r(undefined)));
  t.after(() => { front.closeAllConnections(); front.close(); app.close(); });
  const HOST = "documents.acme.vyre.run";
  const call = (/** @type {string} */ path, /** @type {string} */ cookie) => new Promise((resolve, reject) => {
    http.get({ host: "127.0.0.1", port: /** @type {any} */ (front.address()).port, path, headers: { host: HOST, ...(cookie ? { cookie } : {}) } }, res => { let b = ""; res.on("data", d => { b += d; }); res.on("end", () => resolve({ status: res.statusCode, body: b })); }).on("error", reject);
  });
  const sid = `vyre_app=${tickets.trade(tickets.issue("documents", HOST, "/"), HOST)?.sid}`;
  const own = /** @type {any} */ (await call("/settings", sid));
  assert.equal(own.body, "OWNER-DATA", "the owner gets in with the install's session (the test can fail)");
  cookies.length = 0;
  const r = /** @type {any} */ (await call("/manifest.json", "vyre_app=FORGED"));
  assert.equal(r.status, 200);
  assert.equal(r.body, "page", "the stranger got the page, not the owner's data");
  assert.ok(!cookies.join("|").includes(MARK), "the app was never sent the install's admin session");
});
