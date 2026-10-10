// @ts-check
// FOUNDATION S6 (issue #133): strangers never carry the owner's session. Every public surface an app declares is walked as a stranger: each signing route in every catalog manifest by each of its methods, each
// public path, an open server (a site's server made by Publish) and a preview. The stranger sends everything a stranger could forge or reuse (a made-up Vyre cookie, another host's real session, the Vyre
// headers, an admin cookie name). The app behind it is a recording stand-in that answers the owner's session with owner data. A failure names the route and what leaked.
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import { createHostProxy, createTickets } from "../core/appmods/proxy.js";
import { matcher } from "../core/appmods/signing.js";

const BASE = "acme.vyre.run";
const OWNER_MARK = "ADMIN-SESSION-OWNER-ONLY";
const catalogDir = new URL("../core/appmods/catalog/", import.meta.url);
/** @type {{ name: string, app: any }[]} */
const catalog = fs.readdirSync(catalogDir).filter(f => f.endsWith(".json") && !f.endsWith(".kit.json")).map(f => JSON.parse(fs.readFileSync(new URL(f, catalogDir), "utf8"))).filter(m => m && m.app && m.name).map(m => ({ name: m.name, app: m.app }));

/** The app behind the front: records every request and answers the owner's session with owner data. */
async function standIn(/** @type {import("node:test").TestContext} */ t) {
  /** @type {{ method: string, url: string, headers: Record<string, any> }[]} */ const seen = [];
  const server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      seen.push({ method: String(req.method), url: String(req.url), headers: { ...req.headers } });
      const owner = String(req.headers.cookie || "").includes(OWNER_MARK);
      if (req.url === "/sign_in" && req.method === "GET") { res.writeHead(200, { "content-type": "text/html" }); return res.end('<input name="authenticity_token" value="tok1">'); }
      if (req.url === "/sign_in" && req.method === "POST") { res.writeHead(302, { location: "/", "set-cookie": [`_admin=${OWNER_MARK}; Path=/`] }); return res.end(); }
      res.writeHead(200, { "content-type": "text/plain", "set-cookie": ["_page=1; Path=/; Domain=127.0.0.1"] });
      res.end(owner ? `OWNER-DATA ${OWNER_MARK}` : "page");
    });
  });
  await new Promise(r => server.listen(0, "127.0.0.1", () => r(undefined)));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return { origin: `http://127.0.0.1:${/** @type {any} */ (server.address()).port}`, seen };
}

/** One front for several apps by name; `owner(name)` is a request the owner would make (a real ticket traded for a real session). */
async function front(/** @type {import("node:test").TestContext} */ t, /** @type {Record<string, any>} */ defs) {
  const tickets = createTickets();
  const stands = new Map();
  for (const name of Object.keys(defs)) stands.set(name, await standIn(t));
  const proxy = createHostProxy({ tickets, brand: async () => "", linkKey: () => Buffer.alloc(32, 7), app: async name => (defs[name] ? { ...defs[name], origin: stands.get(name).origin, origins: [stands.get(name).origin], credentials: async () => ({ login_email: "owner@example.test" }) } : null) });
  const server = http.createServer((req, res) => { proxy(req, res, { url: new URL(req.url || "/", "http://x") }).then(done => { if (!done) { res.writeHead(404); res.end(); } }); });
  await new Promise(r => server.listen(0, "127.0.0.1", () => r(undefined)));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const port = /** @type {any} */ (server.address()).port;
  const call = (/** @type {string} */ name, /** @type {string} */ method, /** @type {string} */ path, /** @type {Record<string, string>} */ headers = {}) => new Promise((resolve, reject) => {
    const r = http.request({ host: "127.0.0.1", port, method, path, headers: { host: `${name}.${BASE}`, ...headers } }, res => { const c = []; res.on("data", d => c.push(d)); res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(c).toString("utf8") })); });
    r.on("error", reject); r.end(["GET", "HEAD", "DELETE"].includes(method) ? undefined : "x=1");
  });
  const sessionFor = (/** @type {string} */ name) => `vyre_app=${tickets.trade(tickets.issue(name, `${name}.${BASE}`, "/"), `${name}.${BASE}`)?.sid}`;
  return { call, sessionFor, stands, seen: (/** @type {string} */ name) => stands.get(name).seen };
}

/** A route pattern made into a path a stranger would ask for. @param {string} p */
const concrete = p => p.replace(/:[a-z_]+/g, "abc123").replace(/\*$/, "x/y.pdf");

/** What a stranger sends: a made-up Vyre cookie, another host's real session, the Vyre headers, the admin cookie's name, the Vyre bearer. @param {string} otherSession */
const forged = otherSession => ({
  cookie: `vyre_app=FORGED-SESSION; ${otherSession}; _admin=guess; _page=mine`,
  "x-vyre-viewer": "owner", "x-vyre-person": "per_owner", "x-vyre-admin": "1",
});

/** Everything that must be true of one stranger request: the app never saw Vyre's session or headers, and the answer holds nothing of the owner's. @param {any} seen @param {any} r @param {string} what */
function nothingOfTheOwners(seen, r, what) {
  for (const s of seen) {
    const c = String(s.headers.cookie || "");
    assert.ok(!/vyre_app=/.test(c), `${what}: the app was sent Vyre's own cookie (${c})`);
    assert.ok(!c.includes(OWNER_MARK), `${what}: the app was sent the install's admin session`);
    assert.ok(!Object.keys(s.headers).some(k => k.startsWith("x-vyre-")), `${what}: the app was sent a Vyre header (${Object.keys(s.headers).filter(k => k.startsWith("x-vyre-")).join(", ")})`);
  }
  if (r) {
    assert.ok(!String(r.body).includes(OWNER_MARK) && !String(r.body).includes("OWNER-DATA"), `${what}: the answer held the owner's data`);
    const sc = [].concat(/** @type {any} */ (r.headers["set-cookie"] || [])).join(" | ");
    assert.ok(!sc.includes(OWNER_MARK) && !/vyre_app=/.test(sc), `${what}: the answer set the owner's session (${sc})`);
  }
}

test("S6: every signing route and public path the catalog declares is walked as a stranger, who never carries the owner's session and gets none of the owner's data", async t => {
  const apps = catalog.filter(c => (c.app.signing && (c.app.signing.routes || []).length) || (c.app.public || []).length);
  assert.ok(apps.length > 0, "the catalog has an app with a public surface (Documents)");
  let walked = 0;
  for (const { name, app } of apps) {
    const f = await front(t, { [name]: { login: app.login || { path: "/sign_in", token: "authenticity_token", fields: { "user[email]": "{login_email}" }, ok: [302] }, public: app.public || [], ...(app.signing ? { signing: app.signing } : {}) } });
    // the owner is in: the front holds the install's admin session for the app, which is exactly what a stranger must never be handed
    const own = await f.call(name, "GET", "/settings", { cookie: f.sessionFor(name) });
    assert.equal(own.status, 200, `${name}: the owner gets in`);
    assert.ok(String(own.body).includes(OWNER_MARK), `${name}: the stand-in answers the owner's session with owner data (the guard can fail)`);
    const other = f.sessionFor(name).replace("vyre_app=", "vyre_app_other=");
    const routes = [
      ...((app.signing && app.signing.routes) || []).flatMap((/** @type {any} */ r) => r.methods.filter((/** @type {string} */ m) => m !== "HEAD").map((/** @type {string} */ m) => [m, concrete(r.path)])),
      ...(app.public || []).map((/** @type {string} */ p) => ["GET", p]),
    ];
    const m = matcher(app.signing);
    for (const [method, path] of routes) {
      const before = f.seen(name).length;
      const r = await f.call(name, method, path, forged(other));
      const here = f.seen(name).slice(before);
      nothingOfTheOwners(here, /** @type {any} */ (r), `${name} ${method} ${path}`);
      assert.ok(m.open(method, path) || (app.public || []).includes(path), `${name} ${method} ${path} is declared`);
      walked++;
    }
    // what is not declared never reaches the app at all, whatever the stranger carries
    const before = f.seen(name).length;
    for (const [method, path] of [["GET", "/settings"], ["GET", "/api/users"], ["POST", "/api/submissions"], ["DELETE", "/s/abc/everything"], ["GET", "/s/abc/../../settings"]]) {
      const r = /** @type {any} */ (await f.call(name, method, path, forged(other)));
      assert.ok(r.status === 404 || r.status === 400, `${name} ${method} ${path}: a stranger got ${r.status}`);
      nothingOfTheOwners([], r, `${name} ${method} ${path}`);
    }
    assert.equal(f.seen(name).slice(before).filter((/** @type {any} */ s) => s.url !== "/sign_in").length, 0, `${name}: an undeclared path reached the app for a stranger`);
  }
  assert.ok(walked >= 10, `walked ${walked} declared routes`);
});

test("S6: a session from another host is a stranger's here, so a real owner session cannot be carried to an app it was not made for", async t => {
  const def = { login: { path: "/sign_in", token: "authenticity_token", fields: { "user[email]": "{login_email}" }, ok: [302] }, public: [], signing: { routes: [{ methods: ["GET"], path: "/s/:slug" }] } };
  const f = await front(t, { documents: def, notes: { ...def, signing: { routes: [] } } });
  const mine = f.sessionFor("documents");
  const own = /** @type {any} */ (await f.call("documents", "GET", "/settings", { cookie: mine }));
  assert.equal(own.status, 200, "the session works at its own host");
  const r = /** @type {any} */ (await f.call("notes", "GET", "/settings", { cookie: mine }));
  assert.equal(r.status, 404, "and not at another app's host");
  assert.equal(f.seen("notes").length, 0, "the other app was never touched");
  const s = /** @type {any} */ (await f.call("documents", "GET", "/s/abc", { cookie: mine.replace("vyre_app=", "vyre_app=x") }));
  nothingOfTheOwners(f.seen("documents").filter((/** @type {any} */ x) => x.url === "/s/abc"), s, "documents GET /s/abc with a damaged session");
});

test("S6: a site's server made by Publish serves everyone, and still never receives Vyre's session or headers, and the owner's ticket cookie is not its cookie", async t => {
  const f = await front(t, { "site-ab12cd": { login: null, public: [], passCookies: true, open: true } });
  const mine = f.sessionFor("site-ab12cd");
  for (const [who, cookie] of [["a stranger", "vyre_app=FORGED; visitor=1"], ["the owner", `${mine}; visitor=1`]]) {
    for (const [method, path] of [["GET", "/"], ["GET", "/admin"], ["POST", "/api/form"], ["DELETE", "/x"]]) {
      const before = f.seen("site-ab12cd").length;
      const r = /** @type {any} */ (await f.call("site-ab12cd", method, path, { cookie, "x-vyre-viewer": "owner", "x-vyre-person": "per_owner", authorization: "Bearer visitor-token" }));
      assert.equal(r.status, 200, `${who} ${method} ${path}`);
      const here = f.seen("site-ab12cd").slice(before);
      nothingOfTheOwners(here, r, `${who} ${method} ${path}`);
      assert.equal(here[0].headers.authorization, "Bearer visitor-token", "the visitor's own credentials reach the site they are using");
      assert.match(String(here[0].headers.cookie || ""), /visitor=1/, "and the visitor's own cookies");
    }
  }
});

test("S6: a preview is the owner's alone: a stranger gets nothing from it, whatever Vyre cookie or viewer header they bring", async t => {
  const f = await front(t, { "preview-ab12cd": { login: null, public: [], rewriteHost: true, passCookies: true, allowEmbed: true, viewerKey: Buffer.alloc(32, 5).toString("hex") } });
  for (const [method, path] of [["GET", "/"], ["GET", "/src/main.js"], ["POST", "/api/x"]]) {
    const r = /** @type {any} */ (await f.call("preview-ab12cd", method, path, { cookie: "vyre_app=FORGED", "x-vyre-viewer": "owner" }));
    assert.equal(r.status, 404, `${method} ${path}: a stranger got ${r.status}`);
  }
  assert.equal(f.seen("preview-ab12cd").length, 0, "the preview's server was never touched");
});
