// @ts-check
// A server Publish made from a built image, as an app module (team/contracts/builder.md, the container path): the manifest it is given and the rules it is held to, and how the apps' front serves it to
// strangers: every route, its own cookies, none of Vyre's. The real build and the real container are core/appmods/published-live.test.js.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { publishedManifest, checkPublished, IMAGE_ID, CEILING } from "./published.js";
import { checkAppModule } from "./manifest.js";
import { createHostProxy, createTickets } from "./proxy.js";
import { runArgs, namesOf } from "./runtime.js";

const IMG = "sha256:" + "a".repeat(64);
const dep = (/** @type {any} */ over = {}) => ({ id: "dep_0123456789abcdef", name: "northwind", version: 3, runtime: { kind: "image", image: IMG, port: 8080, health: { path: "/", ok: [200, 404] } }, secrets: ["API_KEY"], ...over });
const mk = (/** @type {any} */ over = {}, pub = true) => publishedManifest(dep(over), { catalogNames: ["documents", "pdf"], public: pub });
const refused = (/** @type {() => any} */ f, /** @type {RegExp} */ words) => assert.throws(f, (/** @type {any} */ e) => { assert.equal(e.code, "bad_input"); assert.match(e.message, words); return true; });

test("a published server's manifest: its image by local id, one data volume, a read-only root, the secrets by name, nothing that reaches out, and the catalog's own checks pass", () => {
  const m = mk();
  assert.deepEqual(checkPublished(m), []);
  assert.deepEqual([m.name, m.version, m.app.image, m.app.port, m.app.readOnly, m.app.open], ["northwind", "0.0.3", IMG, 8080, true, true]);
  assert.deepEqual(m["x-publish"], { deployment: "dep_0123456789abcdef", secrets: ["API_KEY"], public: true });
  assert.deepEqual(m.app.volumes, [{ name: "data", path: "/data" }]);
  assert.deepEqual(m.app.limits, { memoryMb: 512, cpus: 0.5, pids: 256 }, "the defaults");
  assert.equal(m.app.egress, undefined, "no way out");
  assert.equal(m.app.hookPort, undefined, "no webhook door");
  assert.equal(m.app.env, undefined, "no plain values; secrets are names and are read from the files Publish wrote");
  assert.equal(mk({}, false).app.open, undefined, "not open until it is live");
  const { "x-publish": _x, ...catalogLike } = m;
  assert.ok(checkAppModule({ ...catalogLike, app: { ...catalogLike.app, image: "x/y@sha256:" + "0".repeat(64) } }).some(p => p.path === "app.open"), "an open catalog app is refused");
});

test("what a published server may not be: a name that is Vyre's, an image that is not the build's, limits past the ceiling, a secret that is not an environment name", () => {
  refused(() => mk({ name: "documents" }), /ships with Vyre/);
  refused(() => mk({ name: "pdf" }), /ships with Vyre/);
  refused(() => mk({ name: "www" }), /keeps for itself/);
  refused(() => mk({ name: "pv-0123abcd" }), /keeps for itself/);
  refused(() => mk({ name: "Bad Name" }), /lowercase/);
  refused(() => mk({ runtime: { kind: "static" } }), /not a built image/);
  refused(() => mk({ runtime: { kind: "image", image: "nginx:latest", port: 80 } }), /not a built image/);
  refused(() => mk({ runtime: { kind: "image", image: IMG.toUpperCase().replace("SHA256", "sha256"), port: 80 } }), /not a built image/);
  refused(() => mk({ limits: { memoryMb: CEILING.memoryMb + 1 } }), /memoryMb is at most 2048/);
  refused(() => mk({ limits: { cpus: 0 } }), /cpus/);
  refused(() => mk({ secrets: ["lower"] }), /not a name an environment variable/);
  refused(() => mk({ secrets: ["A", "A"] }), /named twice/);
  refused(() => mk({ id: "dep_x" }), /not a deployment/);
  assert.deepEqual(mk({ limits: { memoryMb: 2048, cpus: 2, pids: 512 } }).app.limits, { memoryMb: 2048, cpus: 2, pids: 512 }, "the ceiling itself is allowed");
  assert.ok(IMAGE_ID.test(IMG) && !IMAGE_ID.test("sha256:abc"));
  const bad = mk(); bad.app.port = 0;
  assert.ok(checkPublished(bad).some(p => p.path === "app.port"));
  assert.ok(checkPublished({ ...mk(), app: { ...mk().app, image: "nope" } }).some(p => p.path === "app.image"));
});

test("its container is run as every app's is, and its root cannot be written", () => {
  const n = namesOf("spc_abcdefghijkl", "northwind");
  const argv = runArgs({ names: n, manifest: mk(), envFile: "/tmp/env", hostPort: true });
  const j = argv.join(" ");
  for (const want of ["--cap-drop ALL", "--security-opt no-new-privileges", "--memory 512m", "--pids-limit 256", "--read-only", "--tmpfs /tmp:rw,size=64m,mode=1777", "--restart unless-stopped", "--env-file /tmp/env"]) assert.ok(j.includes(want), want);
  assert.equal(argv[argv.length - 1], IMG);
  assert.ok(!j.includes("--privileged") && !j.includes("docker.sock"));
  assert.ok(!runArgs({ names: n, manifest: { ...mk(), app: { ...mk().app, readOnly: undefined } }, envFile: "/e" }).includes("--read-only"), "only when the manifest says so");
});

// ---- the front: an open server answers strangers on every route, with its own cookies and nothing of Vyre's
const HOST = "northwind.acme.vyre.run";
async function front(/** @type {import("node:test").TestContext} */ t, /** @type {any} */ appOver = {}) {
  /** @type {any[]} */ const seen = [];
  const upstream = http.createServer((req, res) => {
    const chunks = /** @type {Buffer[]} */ ([]); req.on("data", d => chunks.push(d)); req.on("end", () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() });
      res.writeHead(200, { "content-type": "text/plain", "set-cookie": ["sess=abc; Path=/; HttpOnly; Domain=.acme.vyre.run", "pref=dark; Path=/"], "x-powered-by": "it" });
      res.end("hello from northwind");
    });
  });
  upstream.on("upgrade", (req, sock) => {
    seen.push({ method: req.method, url: req.url, headers: req.headers, upgrade: true });
    sock.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n"); sock.on("data", d => sock.write(Buffer.concat([Buffer.from("echo:"), d]))); sock.on("error", () => {});
  });
  await new Promise(r => upstream.listen(0, "127.0.0.1", () => r(undefined)));
  const origin = `http://127.0.0.1:${/** @type {any} */ (upstream.address()).port}`;
  const tickets = createTickets();
  const proxy = createHostProxy({ tickets, app: async name => (name === "northwind" ? { origin, origins: [origin], login: null, public: [], passCookies: true, ...appOver, credentials: async () => ({}) } : null) });
  const server = http.createServer((req, res) => { proxy(req, res, { url: new URL(req.url || "/", "http://x") }).then(done => { if (!done) { res.writeHead(404); res.end(); } }); });
  server.on("upgrade", (req, sock, head) => { proxy.upgrade(req, sock, head).then(done => { if (!done) sock.destroy(); }); });
  await new Promise(r => server.listen(0, "127.0.0.1", () => r(undefined)));
  t.after(() => { server.closeAllConnections(); server.close(); upstream.closeAllConnections(); upstream.close(); });
  const port = /** @type {any} */ (server.address()).port;
  const call = (/** @type {string} */ method, /** @type {string} */ p, /** @type {Record<string, string>} */ headers = {}, body = "") => new Promise((resolve, reject) => {
    const r = http.request({ host: "127.0.0.1", port, method, path: p, headers: { host: HOST, ...headers, ...(body ? { "content-length": String(Buffer.byteLength(body)) } : {}) } }, res => { const c = /** @type {Buffer[]} */ ([]); res.on("data", d => c.push(d)); res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(c).toString() })); });
    r.on("error", reject); r.end(body);
  });
  const ws = (/** @type {Record<string, string>} */ headers = {}) => new Promise(resolve => {
    const c = net.connect(port, "127.0.0.1", () => c.write(`GET /live HTTP/1.1\r\nHost: ${HOST}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZQ==\r\nSec-WebSocket-Version: 13\r\n${Object.entries(headers).map(([k, v]) => `${k}: ${v}\r\n`).join("")}\r\n`));
    let got = ""; c.on("data", d => { got += d; if (got.includes("\r\n\r\n") && !got.includes("echo:")) c.write("ping"); if (got.includes("echo:ping")) { c.destroy(); resolve(got); } });
    c.on("error", () => resolve(got)); c.on("close", () => resolve(got)); setTimeout(() => { c.destroy(); resolve(got); }, 1500).unref();
  });
  const ticket = () => { const tk = tickets.issue("northwind", HOST, "/"); return `vyre_app=${tickets.trade(tk, HOST)?.sid}`; };
  return { seen, call, ticket, ws };
}

test("an open server answers a stranger on every route and method, keeps its own cookies and never sees Vyre's, and its cookies stay on its own host", async t => {
  const f = await front(t, { open: true });
  const r = /** @type {any} */ (await f.call("POST", "/api/orders?x=1", { cookie: "vyre_app=FORGED; theme=light", "x-vyre-viewer": "owner", authorization: "Bearer visitors-own", "content-type": "application/json" }, '{"a":1}'));
  assert.equal(r.status, 200);
  assert.equal(r.body, "hello from northwind");
  const hit = f.seen[0];
  assert.deepEqual([hit.method, hit.url, hit.body], ["POST", "/api/orders?x=1", '{"a":1}']);
  assert.equal(hit.headers.cookie, "theme=light", "the visitor's own cookie goes through; Vyre's does not");
  assert.equal(hit.headers["x-vyre-viewer"], undefined);
  assert.equal(hit.headers.authorization, "Bearer visitors-own", "the visitor's own credentials are theirs to send to the site they are using");
  assert.deepEqual(r.headers["set-cookie"], ["sess=abc; Path=/; HttpOnly", "pref=dark; Path=/"], "the site's cookies come back without a Domain");
  for (const [m, p] of [["GET", "/"], ["PUT", "/a/b/c"], ["DELETE", "/x"], ["PATCH", "/y"], ["HEAD", "/z"], ["OPTIONS", "/"]]) assert.equal(/** @type {any} */ (await f.call(m, p)).status, 200, `${m} ${p}`);
  // the owner with their ticket is served as the same site, with the ticket cookie removed on the way
  const owner = /** @type {any} */ (await f.call("GET", "/me", { cookie: `${f.ticket()}; theme=dark` }));
  assert.equal(owner.status, 200);
  assert.equal(f.seen.at(-1).headers.cookie, "theme=dark");
  // a body past the stranger's limit is refused before it reaches the site
  const before = f.seen.length;
  const big = /** @type {any} */ (await f.call("POST", "/up", { "content-length": String(30 * 1024 * 1024) }));
  assert.equal(big.status, 413);
  assert.equal(f.seen.length, before);
});

test("a server that is not open is the owner's alone: a stranger gets the plain 404 and the site never sees the request", async t => {
  const f = await front(t, {});
  const r = /** @type {any} */ (await f.call("GET", "/", { cookie: "vyre_app=FORGED" }));
  assert.equal(r.status, 404);
  assert.equal(f.seen.length, 0);
  assert.equal(/** @type {any} */ (await f.call("GET", "/", { cookie: f.ticket() })).status, 200, "with the owner's ticket it answers");
});

test("an open server takes a stranger's WebSocket with the visitor's own cookies and credentials and none of Vyre's; one that is not open is the owner's alone", async t => {
  const f = await front(t, { open: true });
  const got = await f.ws({ cookie: "vyre_app=FORGED; theme=dark", "x-vyre-viewer": "owner", authorization: "Bearer visitors-own" });
  assert.match(got, /^HTTP\/1\.1 101 /);
  assert.match(got, /echo:ping/);
  const h = f.seen.find(x => x.upgrade).headers;
  assert.equal(h.cookie, "theme=dark", "Vyre's cookie is removed, the visitor's own stays");
  assert.equal(h.authorization, "Bearer visitors-own");
  assert.equal(h["x-vyre-viewer"], undefined);
  const owner = await f.ws({ cookie: `${f.ticket()}; theme=dark` });
  assert.match(owner, /^HTTP\/1\.1 101 /, "the owner with a ticket opens the same socket");
  const closed = await front(t, {});
  const no = await closed.ws({ cookie: "vyre_app=FORGED" });
  assert.doesNotMatch(no, /101/);
  assert.equal(closed.seen.filter(x => x.upgrade).length, 0, "a stranger's socket never reached a site that is not open");
  assert.match(await closed.ws({ cookie: closed.ticket() }), /^HTTP\/1\.1 101 /, "and the owner's ticket opens it");
});
