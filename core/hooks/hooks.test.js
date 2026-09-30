// @ts-check
// The hooks module inside a real Registry, with a stand-in vault module and a presence verifier
// that finds a person only when the call carries a proof. Real HTTP to the loopback listener,
// the clock moved by hand, a fake tailscale for hooks.status, and the watcher runtime reading a
// delivery off hook.received. The secret is a distinctive string, and every log line, event,
// config file, tool result and HTTP response is searched for it at the end.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Registry, discover } from "../modules/index.js";
import { open } from "../store/index.js";
import { Events } from "../events/index.js";
import * as config from "../config/index.js";
import { tempHome, writeModule } from "../../test/helpers.js";
import { SCRATCH } from "../../test/scratch.mjs";
import { seams } from "./index.js";
import { sign } from "./verify.js";
import { Deliveries, MIGRATIONS, KEEP, KEEP_MS } from "./deliveries.js";
import { migrate } from "../store/index.js";

const CORE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SECRET = "nw-hook-secret-8c1f3a9e0d";
const STRIPE_SECRET = "whsec_nw_stripe_77aa13bc90";
const ORDER = JSON.stringify({ order: 1041, customer: "alex@example.com", items: ["rye loaf", "croissant"] });

/** Who has proved presence: a call with meta.proof === "present". */
const presence = {
  required: (_tool, def) => Boolean(def && def.presence),
  verify: async ({ proof }) => proof === "present" ? { ok: true, method: "test" } : { ok: false, message: "prove you are there", methods: ["tty"] },
  challenge: async () => ({ error: { code: "bad_input", message: "not in tests" } }),
};
const HERE = { proof: "present" };

function tmp(t, prefix) {
  const dir = fs.mkdtempSync(path.join(SCRATCH, prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A port nothing listens on right now. */
async function freePort() {
  const s = net.createServer();
  await new Promise(r => s.listen(0, "127.0.0.1", () => r(undefined)));
  const port = /** @type {any} */ (s.address()).port;
  await new Promise(r => s.close(() => r(undefined)));
  return port;
}

/**
 * A registry with the hooks module, a stand-in vault (vault.release from a map, recording who
 * asked), and optionally the watchers module with a stand-in projects module.
 */
async function registry(t, { hooks = {}, vault = { "northwind-orders-hook": SECRET, "northwind-stripe": STRIPE_SECRET }, watchers = false } = {}) {
  const root = tmp(t, "vyre-hooks-");
  const p = config.ensure(root);
  const clock = { now: Date.parse("2026-09-27T09:00:00Z") };
  seams.set(root, { now: () => clock.now });
  t.after(() => seams.delete(root));
  const mods = tmp(t, "vyre-mods-");
  const released = [];
  globalThis.__hooksVault = globalThis.__hooksVault || new Map();
  globalThis.__hooksVault.set(root, { values: vault, released });
  t.after(() => globalThis.__hooksVault.delete(root));
  writeModule(mods, "vault", { does: { tools: ["vault.release"] } }, `export default { async start(ctx) {
    const v = () => globalThis.__hooksVault.get(ctx.paths.root);
    ctx.tool("vault.release", { internal: true, run: async ({ name }, { caller }) => {
      v().released.push({ name, caller });
      if (caller !== "module:hooks" && caller !== "module:watchers") throw new Error("only modules may ask the vault for a value");
      if (!(name in v().values)) throw new Error(name + " is not granted to hooks · vyre vault grant " + name + " hooks");
      return { value: v().values[name] };
    } });
    return { async stop() {} };
  } };`);
  const names = ["hooks", ...(watchers ? ["watchers"] : [])];
  const found = [...discover([CORE]).filter(f => f.manifest && names.includes(f.manifest.name)), ...discover([mods])];
  if (watchers) {
    writeModule(mods, "projects", { does: { tools: ["projects.list"] } }, `export default { async start(ctx) {
      ctx.tool("projects.list", { run: async () => ({ projects: [{ slug: "northwind-bakery", name: "Northwind Bakery", home: "/work/northwind" }] }) });
      return { async stop() {} };
    } };`);
    found.push(...discover([mods]).filter(f => f.manifest.name === "projects"));
  }
  const db = open(p.db);
  const events = new Events(db);
  const logs = [];
  const cfg = { role: "box", hooks: { enabled: false, port: 0, routes: {}, ...hooks } };
  const reg = new Registry({ db, events, config: cfg, paths: p, presence, log: m => logs.push(String(m)) });
  await reg.start(found, { role: "box" });
  t.after(async () => { await reg.stop(); db.close(); });
  for (const n of names) assert.equal(reg.modules.get(n).state, "running", reg.modules.get(n).error);
  const results = [];
  /** A call that must succeed; its result is kept for the secret search. */
  const ok = async (tool, input = {}, caller = "cli", meta = HERE) => {
    const r = await reg.call(tool, input, caller, meta);
    results.push(r);
    if (r.error) throw Object.assign(new Error(`${tool}: ${r.error.message}`), { code: r.error.code });
    return r.data;
  };
  const no = async (tool, input, caller, code, meta = HERE) => {
    const r = await reg.call(tool, input, caller, meta);
    results.push(r);
    assert.ok(r.error, `${tool} by ${caller} should have been refused`);
    assert.equal(r.error.code, code, r.error.message);
    return r.error;
  };
  const evts = type => db.prepare("SELECT * FROM events WHERE type = ? ORDER BY id").all(type).map(e => ({ ...e, payload: JSON.parse(String(e.payload)) }));
  return { reg, db, root, p, clock, logs, released, results, ok, no, evts, cfg };
}

/** POST (or anything else) to the listener; resolves to { status, body, headers }. */
function send(port, { method = "POST", path: at = "/hooks/northwind-orders", headers = {}, body = ORDER, host = "127.0.0.1" } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host, port, method, path: at, headers: { "content-type": "application/json", ...headers } }, res => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString(), headers: res.headers }));
    });
    req.on("error", reject);
    if (body !== null) req.end(body); else req.end();
  });
}

const refused = (port, host = "127.0.0.1") => new Promise(resolve => {
  const s = net.connect({ host, port });
  s.on("connect", () => { s.destroy(); resolve(false); });
  s.on("error", () => resolve(true));
});

const NW = { name: "northwind-orders", verify: { scheme: "hmac-sha256", header: "x-northwind-signature", secret: "northwind-orders-hook" } };
const signed = (body = ORDER) => ({ "x-northwind-signature": sign("hmac-sha256", SECRET, body) });

/** A registry with the listener on and the Northwind route open. */
async function live(t, opts = {}) {
  const r = await registry(t, opts);
  await r.ok("hooks.enable", { on: true });
  await r.ok("hooks.open", NW);
  const port = (await r.ok("hooks.list")).port;
  return { ...r, port };
}

test("hooks: off means no listener; on binds 127.0.0.1 only; off again closes it", async t => {
  const port = await freePort();
  const { ok, no } = await registry(t, { hooks: { port } });
  assert.equal((await ok("hooks.list")).listening, false);
  assert.ok(await refused(port), "something listens while hooks are off");

  await no("hooks.enable", { on: true }, "cli", "presence_required", {});
  await no("hooks.enable", { on: true }, "mcp:agent:kit", "denied");
  await no("hooks.enable", { on: true }, "tailnet-guest:sam@example.com", "denied");
  await no("hooks.enable", { on: true }, "module:glass", "denied");
  assert.ok(await refused(port));

  const on = await ok("hooks.enable", { on: true });
  assert.deepEqual([on.enabled, on.listening, on.host, on.port], [true, true, "127.0.0.1", port]);
  assert.equal(await refused(port), false, "the listener is not on 127.0.0.1");
  // No other address of this machine answers.
  const other = Object.values(os.networkInterfaces()).flat().find(a => a && a.family === "IPv4" && !a.internal);
  if (other) assert.ok(await refused(port, other.address), `the listener answers on ${other.address}`);

  await ok("hooks.enable", { on: false });
  assert.ok(await refused(port), "the listener stayed open after hooks.enable off");
});

test("hooks: only POST /hooks/<open route>; everything else is a bare 404", async t => {
  const { port } = await live(t);
  for (const req of [
    { path: "/hooks/harlow-forms" }, { path: "/" }, { path: "/hooks/" }, { path: "/hooks/northwind-orders/x" },
    { path: "/v1/tools/vault.list" }, { path: "/hooks/Northwind-Orders" }, { path: "/hooks/constructor" }, { path: "/hooks/to-string" }, { method: "GET", body: null }, { method: "PUT" },
  ]) {
    const r = /** @type {any} */ (await send(port, { headers: signed(), ...req }));
    assert.equal(r.status, 404, JSON.stringify(req));
    assert.equal(r.body, "", "a 404 said something");
  }
  const good = /** @type {any} */ (await send(port, { headers: signed(), path: "/hooks/northwind-orders?x=1" }));
  assert.equal(good.status, 200, "a query string is ignored, not refused");
  assert.equal(good.body, "");
});

test("hooks: open and close need presence, refuse agents, guests and modules, and a route needs a scheme", async t => {
  const { ok, no, evts, p } = await registry(t);
  await no("hooks.open", NW, "cli", "presence_required", {});
  await no("hooks.open", NW, "mcp:agent:kit", "denied");
  await no("hooks.open", NW, "tailnet:agent:kit", "denied");
  await no("hooks.open", NW, "tailnet-guest:sam@example.com", "denied");
  await no("hooks.open", NW, "module:watchers", "denied");
  await no("hooks.open", { name: "northwind-orders", verify: { secret: "northwind-orders-hook" } }, "cli", "bad_input");
  await no("hooks.open", { name: "northwind-orders", verify: { scheme: "none", secret: "northwind-orders-hook" } }, "cli", "bad_input");
  await no("hooks.open", { name: "northwind-orders", verify: { scheme: "hmac-sha256", secret: "northwind-orders-hook" } }, "cli", "bad_input");
  await no("hooks.open", { name: "northwind-orders", verify: { scheme: "hmac-sha256", header: "content-type", secret: "northwind-orders-hook" } }, "cli", "bad_input");
  await no("hooks.open", { name: "../vault", verify: NW.verify }, "cli", "bad_input");
  assert.equal((await ok("hooks.list")).routes.length, 0);

  const opened = await ok("hooks.open", NW, "tailnet:alex@example.com", { ...HERE, person: { id: "s1", kind: "cookie" } });
  assert.equal(opened.ready, true);
  assert.equal(opened.path, "/hooks/northwind-orders");
  assert.equal(opened.funnel.open, "tailscale funnel --bg --https=8443 --set-path=/hooks/northwind-orders http://127.0.0.1:0/hooks/northwind-orders");
  assert.ok(opened.next.some(s => /hooks.enable/.test(s)), "the listener is off and the result does not say so");
  await no("hooks.open", NW, "cli", "conflict");
  // A secret the hooks module has no grant for: the route opens, and says what to run.
  const ungranted = await ok("hooks.open", { name: "harlow-forms", verify: { scheme: "github", secret: "harlow-github-hook" } });
  assert.equal(ungranted.ready, false);
  assert.equal(ungranted.grant, "vyre vault grant harlow-github-hook hooks");
  assert.deepEqual(evts("hook.opened").map(e => e.payload), [{ route: "northwind-orders", scheme: "hmac-sha256" }, { route: "harlow-forms", scheme: "github" }]);

  await no("hooks.close", { name: "northwind-orders" }, "cli", "presence_required", {});
  await no("hooks.close", { name: "northwind-orders" }, "mcp:agent:kit", "denied");
  await no("hooks.close", { name: "northwind-orders" }, "tailnet-guest:sam@example.com", "denied");
  const closed = await ok("hooks.close", { name: "northwind-orders" });
  assert.equal(closed.funnel.close, "tailscale funnel --https=8443 --set-path=/hooks/northwind-orders off");
  assert.equal(closed.funnel.off, undefined, "harlow-forms is still open");
  assert.equal((await ok("hooks.close", { name: "harlow-forms" })).funnel.off, "tailscale funnel --https=8443 off");
  await no("hooks.close", { name: "harlow-forms" }, "cli", "not_found");
  assert.deepEqual(evts("hook.closed").map(e => e.payload.route), ["northwind-orders", "harlow-forms"]);
  // The routes live in config.json, by vault item name.
  const saved = JSON.parse(fs.readFileSync(p.config, "utf8"));
  assert.deepEqual(saved.hooks.routes, {}, "a closed route stayed in config.json");
});

test("hooks: each scheme through the listener, good and bad, and a replayed Stripe timestamp", async t => {
  const r = await live(t);
  const { port, ok, clock } = r;
  assert.equal(/** @type {any} */ (await send(port, { headers: signed() })).status, 200);
  assert.equal(/** @type {any} */ (await send(port, { headers: { "x-northwind-signature": sign("hmac-sha256", "wrong", ORDER) } })).status, 401);
  assert.equal(/** @type {any} */ (await send(port, {})).status, 401, "no signature at all");

  await ok("hooks.open", { name: "harlow-github", verify: { scheme: "github", secret: "northwind-orders-hook" } });
  const push = JSON.stringify({ ref: "refs/heads/main", repository: { full_name: "harlow-legal/site" } });
  const gh = { "x-github-event": "push", "x-github-delivery": "72d3162e-cc78-11e3-81ab-4c9367dc0958", "user-agent": "GitHub-Hookshot/abc" };
  assert.equal(/** @type {any} */ (await send(port, { path: "/hooks/harlow-github", body: push, headers: { ...gh, "x-hub-signature-256": sign("github", SECRET, push) } })).status, 200);
  assert.equal(/** @type {any} */ (await send(port, { path: "/hooks/harlow-github", body: push, headers: { ...gh, "x-hub-signature-256": sign("github", SECRET, push + " ") } })).status, 401);

  await ok("hooks.open", { name: "northwind-stripe", verify: { scheme: "stripe", secret: "northwind-stripe" } });
  const paid = JSON.stringify({ id: "evt_1", type: "checkout.session.completed" });
  const t0 = Math.floor(clock.now / 1000);
  assert.equal(/** @type {any} */ (await send(port, { path: "/hooks/northwind-stripe", body: paid, headers: { "stripe-signature": sign("stripe", STRIPE_SECRET, paid, t0) } })).status, 200);
  // The same signed request ten minutes later: a replay, refused on its timestamp.
  clock.now += 10 * 60_000;
  const replay = /** @type {any} */ (await send(port, { path: "/hooks/northwind-stripe", body: paid, headers: { "stripe-signature": sign("stripe", STRIPE_SECRET, paid, t0) } }));
  assert.equal(replay.status, 401);
  assert.ok(r.logs.some(l => /internet:northwind-stripe: refused, the timestamp is more than 5 minutes/.test(l)), r.logs.join("\n"));
  // The same body again inside the tolerance is a repeat: accepted, not stored or announced twice.
  const t1 = Math.floor(clock.now / 1000);
  assert.equal(/** @type {any} */ (await send(port, { path: "/hooks/northwind-stripe", body: paid, headers: { "stripe-signature": sign("stripe", STRIPE_SECRET, paid, t1) } })).status, 200);
  assert.equal(r.evts("hook.received").filter(e => e.payload.route === "northwind-stripe").length, 1);
  // Only the route's own secret was ever fetched, and only by the hooks module.
  assert.deepEqual([...new Set(r.released.map(x => `${x.caller} ${x.name}`))].sort(), ["module:hooks northwind-orders-hook", "module:hooks northwind-stripe"]);
});

test("hooks: body limit, content types and the per-route rate limit", async t => {
  const { port, clock } = await live(t);
  const big = JSON.stringify({ pad: "x".repeat(256 * 1024) });
  assert.equal(/** @type {any} */ (await send(port, { body: big, headers: signed(big) })).status, 413);
  // Chunked, with no length to refuse up front: cut while reading.
  const chunked = await new Promise((resolve) => {
    const req = http.request({ host: "127.0.0.1", port, method: "POST", path: "/hooks/northwind-orders", headers: { "content-type": "application/json", "transfer-encoding": "chunked" } },
      res => { res.resume(); resolve(res.statusCode); });
    req.on("error", () => resolve("reset"));
    for (let i = 0; i < 40; i++) req.write("x".repeat(8 * 1024));
    req.end();
  });
  assert.ok(chunked === 413 || chunked === "reset", String(chunked));
  const form = "order=1042&customer=alex%40example.com";
  assert.equal(/** @type {any} */ (await send(port, { body: form, headers: { "content-type": "application/x-www-form-urlencoded", ...signed(form) } })).status, 200);
  assert.equal(/** @type {any} */ (await send(port, { body: "<xml/>", headers: { "content-type": "text/xml", ...signed("<xml/>") } })).status, 415);

  // A fresh route's bucket: 30 requests, then 429 until the clock refills it (one per 2 seconds).
  const { port: p2, clock: c2 } = await live(t);
  const codes = [];
  for (let i = 0; i < 31; i++) codes.push(/** @type {any} */ (await send(p2, { headers: { "x-northwind-signature": "0".repeat(64) } })).status);
  assert.deepEqual([...new Set(codes.slice(0, 30))], [401], "the first 30 reach the signature check");
  assert.equal(codes[30], 429);
  c2.now += 2_000;
  assert.equal(/** @type {any} */ (await send(p2, { headers: signed(JSON.stringify({ n: 1 })), body: JSON.stringify({ n: 1 }) })).status, 200);
  assert.equal(/** @type {any} */ (await send(p2, { headers: signed() })).status, 429);
  void clock;
});

test("hooks: a slow sender is cut at the read deadline", async t => {
  const { port } = await live(t);
  const started = Date.now();
  const outcome = await new Promise(resolve => {
    const s = net.connect({ host: "127.0.0.1", port }, () => s.write("POST /hooks/northwind-orders HTTP/1.1\r\nhost: x\r\ncontent-type: application/json\r\ncontent-length: 100\r\n\r\n{"));
    s.on("close", () => resolve("closed"));
    s.on("error", () => {});
  });
  assert.equal(outcome, "closed");
  const took = Date.now() - started;
  assert.ok(took >= 4_500 && took < 9_000, `cut after ${took}ms`);
});

test("hooks: a verified delivery is stored with allowlisted headers, the event carries no body, and hooks.delivery is for the owner and watchers", async t => {
  const { port, ok, no, evts, db } = await live(t);
  const headers = { ...signed(), "user-agent": "Northwind-Forms/2", cookie: "session=abc", authorization: "Bearer nope", "x-forwarded-for": "203.0.113.9" };
  assert.equal(/** @type {any} */ (await send(port, { headers })).status, 200);
  const [e] = evts("hook.received");
  assert.deepEqual(Object.keys(e.payload).sort(), ["at", "bytes", "id", "route"]);
  assert.equal(e.payload.route, "northwind-orders");
  assert.equal(e.payload.bytes, Buffer.byteLength(ORDER));
  assert.ok(!JSON.stringify(e).includes("rye loaf"), "the event carries the body");
  const d = await ok("hooks.delivery", { id: e.payload.id }, "module:watchers", {});
  assert.equal(d.body, ORDER);
  assert.equal(d.route, "northwind-orders");
  assert.deepEqual(d.headers, { "content-type": "application/json", "user-agent": "Northwind-Forms/2" }, "a header off the allowlist was kept");
  assert.equal(String(/** @type {any} */ (db.prepare("SELECT caller FROM hooks_deliveries").get()).caller), "internet:northwind-orders");
  assert.equal((await ok("hooks.delivery", { id: e.payload.id }, "cli", {})).body, ORDER);
  await no("hooks.delivery", { id: e.payload.id }, "mcp:agent:kit", "denied", {});
  await no("hooks.delivery", { id: e.payload.id }, "tailnet-guest:sam@example.com", "denied", {});
  await no("hooks.delivery", { id: e.payload.id }, "internet:northwind-orders", "denied", {});
  await no("hooks.delivery", { id: "hd_nope" }, "cli", "not_found", {});
  const list = await ok("hooks.list", {}, "cli", {});
  assert.equal(list.routes[0].deliveries, 1);
  assert.deepEqual(Object.keys(list.routes[0].recent[0]).sort(), ["at", "bytes", "id"]);
});

test("hooks: deliveries keep the newest 500 and nothing older than 7 days", t => {
  const root = tempHome(t);
  const db = open(path.join(root, "vyre.db"));
  t.after(() => db.close());
  migrate(db, "hooks", MIGRATIONS);
  const clock = { now: Date.parse("2026-09-01T00:00:00Z") };
  const store = new Deliveries(db, () => clock.now);
  const first = store.add("northwind-orders", {}, Buffer.from('{"n":0}'));
  clock.now += KEEP_MS + 1;
  const ids = [];
  for (let i = 1; i <= KEEP + 20; i++) { clock.now += 1; ids.push(store.add("northwind-orders", {}, Buffer.from(JSON.stringify({ n: i }))).id); }
  assert.equal(store.get(first.id), null, "a week-old delivery survived");
  assert.equal(Number(/** @type {any} */ (db.prepare("SELECT COUNT(*) n FROM hooks_deliveries").get()).n), KEEP);
  assert.equal(store.get(ids[19]), null, "an old one past the 500 survived");
  assert.ok(store.get(ids[20]) && store.get(ids.at(-1)));
  assert.equal(store.add("northwind-orders", {}, Buffer.from(JSON.stringify({ n: KEEP + 20 }))).duplicate, true);
});

test("hooks.status: what Funnel publishes, read with a fake tailscale, and every mismatch", async t => {
  const r = await live(t);
  await r.ok("hooks.open", { name: "northwind-stripe", verify: { scheme: "stripe", secret: "northwind-stripe" } });
  const dir = tmp(t, "vyre-ts-");
  const bin = path.join(dir, "tailscale");
  const host = "vyre.tail0000.ts.net";
  const funnel = {
    TCP: { 8443: { HTTPS: true } },
    Web: { [`${host}:8443`]: { Handlers: {
      "/hooks/northwind-orders": { Proxy: `http://127.0.0.1:${r.port}/hooks/northwind-orders` },
      "/hooks/harlow-forms": { Proxy: `http://127.0.0.1:${r.port}/hooks/harlow-forms` },
    } } },
    AllowFunnel: { [`${host}:8443`]: true },
  };
  const status = { BackendState: "Running", Self: { DNSName: `${host}.`, CapMap: { funnel: null, https: null } } };
  fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify({ funnel, status }));
  fs.writeFileSync(bin, `#!/usr/bin/env node
const fs = require("fs"), path = require("path");
const args = process.argv.slice(2), st = JSON.parse(fs.readFileSync(path.join(__dirname, "state.json"), "utf8"));
fs.appendFileSync(path.join(__dirname, "calls.log"), JSON.stringify(args) + "\\n");
if (args.join(" ") === "funnel status --json") { process.stdout.write(JSON.stringify(st.funnel)); process.exit(0); }
if (args.join(" ") === "status --json") { process.stdout.write(JSON.stringify(st.status)); process.exit(0); }
process.stderr.write("unexpected"); process.exit(2);
`, { mode: 0o755 });
  const prev = process.env.VYRE_TAILSCALE_BIN;
  process.env.VYRE_TAILSCALE_BIN = bin;
  t.after(() => { if (prev === undefined) delete process.env.VYRE_TAILSCALE_BIN; else process.env.VYRE_TAILSCALE_BIN = prev; });

  const s = await r.ok("hooks.status", {}, "cli", {});
  assert.equal(s.funnel.read, true);
  assert.deepEqual(s.node, { dnsName: host, funnel: true, https: true, ports: null });
  assert.equal(s.urls["northwind-orders"], `https://${host}:8443/hooks/northwind-orders`);
  assert.deepEqual(s.mismatches.map(m => [m.kind, m.route]).sort(), [["funnel-without-route", "harlow-forms"], ["route-not-served", "northwind-stripe"]]);
  assert.equal(s.mismatches.find(m => m.kind === "funnel-without-route").harmless, true);
  assert.equal(s.mismatches.find(m => m.kind === "route-not-served").fix, `tailscale funnel --bg --https=8443 --set-path=/hooks/northwind-stripe http://127.0.0.1:${r.port}/hooks/northwind-stripe`);
  // Read-only: status and funnel status, nothing else.
  const calls = fs.readFileSync(path.join(dir, "calls.log"), "utf8").trim().split("\n").map(l => JSON.parse(l).join(" "));
  assert.deepEqual([...new Set(calls)].sort(), ["funnel status --json", "status --json"]);

  // A node the policy does not let Funnel publish, and no tailscale at all.
  fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify({ funnel: {}, status: { Self: { DNSName: `${host}.`, CapMap: {} } } }));
  const kinds = (await r.ok("hooks.status", {}, "cli", {})).mismatches.map(m => m.kind);
  assert.ok(kinds.includes("no-funnel-attr") && kinds.includes("no-https"), kinds.join());
  process.env.VYRE_TAILSCALE_BIN = path.join(dir, "missing");
  const gone = await r.ok("hooks.status", {}, "cli", {});
  assert.deepEqual([gone.funnel.read, gone.funnel.why], [false, "Tailscale is not installed"]);
  await r.no("hooks.status", {}, "tailnet-guest:sam@example.com", "denied", {});
});

test("hooks: a watcher on hook.received for its route gets the delivery, and no other route's", async t => {
  const r = await live(t, { watchers: true });
  await r.ok("hooks.open", { name: "harlow-forms", verify: { scheme: "hmac-sha256", header: "x-northwind-signature", secret: "northwind-orders-hook" } });
  const dir = path.join(r.p.watchers, "northwind-orders");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "watcher.json"), JSON.stringify({ name: "northwind-orders", project: "northwind-bakery", on: "hook.received", where: { route: "northwind-orders" }, emits: "order.received" }));
  fs.writeFileSync(path.join(dir, "watch.js"), `export default async function watch({ hook, emit, log }) {
    if (!hook) return log("dry run with no delivery");
    const order = JSON.parse(hook.delivery.body);
    log("order", order.order, "from", hook.route);
    emit({ id: String(order.order), title: "Order " + order.order + ": " + order.items.join(", ") });
  }`);
  const dry = await r.ok("watchers.test", { name: "northwind-orders" }, "cli", {});
  assert.equal(dry.ok, true, JSON.stringify(dry));
  assert.equal(dry.every, "on hook.received where route is northwind-orders");
  await r.ok("watchers.create", { name: "northwind-orders" }, "cli", {});

  const other = JSON.stringify({ order: 9, items: ["not bread"] });
  assert.equal(/** @type {any} */ (await send(r.port, { path: "/hooks/harlow-forms", body: other, headers: signed(other) })).status, 200);
  assert.equal(/** @type {any} */ (await send(r.port, { headers: signed() })).status, 200);
  let items = [];
  for (let i = 0; i < 100 && !items.length; i++) {
    await new Promise(res => setTimeout(res, 50));
    items = (await r.ok("watchers.items", { name: "northwind-orders" }, "cli", {}));
  }
  await new Promise(res => setTimeout(res, 300));
  items = await r.ok("watchers.items", { name: "northwind-orders" }, "cli", {});
  assert.deepEqual(items.map(i => i.title), ["Order 1041: rye loaf, croissant"]);
  const runs = await r.ok("watchers.logs", { name: "northwind-orders" }, "cli", {});
  assert.deepEqual(runs.filter(x => x.trigger === "event").length, 1, "the watcher ran for another route's delivery");

  // A dry run on a real delivery must match where, and is the owner's.
  const [e] = r.evts("hook.received").filter(x => x.payload.route === "harlow-forms");
  const mismatch = await r.ok("watchers.test", { name: "northwind-orders", event: e.payload }, "cli", {});
  assert.equal(mismatch.ok, false);
  assert.match(mismatch.problems[0], /does not match where/);
  const [mine] = r.evts("hook.received").filter(x => x.payload.route === "northwind-orders");
  assert.equal((await r.ok("watchers.test", { name: "northwind-orders", event: mine.payload }, "cli", {})).items[0].id, "1041");
  await r.no("watchers.test", { name: "northwind-orders", event: mine.payload }, "mcp:agent:kit", "failed", {});
});

test("hooks: the secret appears in no log line, event, error, tool result, response or config", async t => {
  const r = await live(t);
  await r.ok("hooks.open", { name: "northwind-stripe", verify: { scheme: "stripe", secret: "northwind-stripe" } });
  const bodies = [];
  const push = async o => { const res = /** @type {any} */ (await send(r.port, o)); bodies.push(JSON.stringify(res)); };
  await push({ headers: signed() });
  await push({ headers: { "x-northwind-signature": sign("hmac-sha256", "wrong", ORDER) } });
  await push({ headers: { "x-northwind-signature": "not hex" } });
  await push({ path: "/hooks/northwind-stripe", headers: { "stripe-signature": sign("stripe", STRIPE_SECRET, ORDER, 1) } });
  await push({ path: "/hooks/northwind-stripe", headers: { "stripe-signature": "t=x" } });
  await push({ path: "/hooks/nope" });
  // A route whose secret the vault will not release.
  await r.ok("hooks.open", { name: "harlow-forms", verify: { scheme: "github", secret: "harlow-github-hook" } });
  await push({ path: "/hooks/harlow-forms", headers: { "x-hub-signature-256": sign("github", SECRET, ORDER) } });
  for (const tool of ["hooks.list", "hooks.status"]) await r.ok(tool, {}, "cli", {});
  await r.no("hooks.open", { name: "northwind-orders", verify: NW.verify }, "cli", "conflict");
  await r.no("hooks.open", NW, "mcp:agent:kit", "denied");

  const events = r.db.prepare("SELECT * FROM events").all().map(e => JSON.stringify(e)).join("\n");
  const cfgFile = fs.readFileSync(r.p.config, "utf8");
  const everything = [r.logs.join("\n"), events, JSON.stringify(r.results), bodies.join("\n"), cfgFile, JSON.stringify(r.cfg)].join("\n");
  assert.ok(r.logs.some(l => /internet:northwind-orders: refused, the signature does not match/.test(l)), "the refusals were not logged");
  assert.ok(r.logs.some(l => /internet:harlow-forms: refused, its secret harlow-github-hook is not available/.test(l)));
  for (const s of [SECRET, STRIPE_SECRET, sign("hmac-sha256", SECRET, ORDER)]) assert.ok(!everything.includes(s), `found ${s.slice(0, 6)}...`);
  assert.ok(cfgFile.includes('"secret": "northwind-orders-hook"'), "the config names the vault item");
});
