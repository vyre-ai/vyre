// @ts-check
// vault.agent.fill (ADR 0028, decision 3; R031-93), end to end against a real headless Chrome and a login-page replica on loopback. The replica logs every credential it is sent, so the test can say
// two things at once: the sign-in HAPPENED (the exact username and password reached the page once) and the secret went NOWHERE else (a canary scan of every result, event, audit row, log line and
// error the fill produced finds no sentinel). A grant or a # tag lends the login; another conversation, another origin or no lending gets nothing, and the replica then sees no request at all.

import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { open, migrate } from "../store/index.js";
import { Vault, MIGRATIONS } from "./vault.js";
import { Access } from "./access.js";
import { kernelRig } from "./kernel-rig.js";
import { SaidIntents, matchIntent, USE_IDLE_MS } from "./said.js";
import { agentFill } from "./agent-fill.js";
import { totp } from "./totp.js";
import { SCRATCH } from "../../test/scratch.mjs";
import { CHROME_SAFE } from "../../lib/chrome-flags/index.js";

const CHROME_BIN = process.env.CHROME_BIN || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const HAVE_CHROME = fs.existsSync(CHROME_BIN);
const fake = label => `fixture-${label}-${crypto.randomBytes(10).toString("hex")}`;
const SEED = "JBSWY3DPEHPK3PXP";

/** One headless Chrome with its own profile; resolves to its DevTools port. */
async function chrome(t) {
  const dir = fs.mkdtempSync(path.join(SCRATCH, "vyre-fill-chrome-"));
  const child = spawn(CHROME_BIN, ["--headless=new", "--remote-debugging-port=0", ...CHROME_SAFE, `--user-data-dir=${dir}`, "--no-first-run", "--disable-gpu", "--disable-extensions", ...(process.platform === "linux" ? ["--no-sandbox"] : []), "about:blank"], { stdio: "ignore", detached: true });
  t.after(async () => { try { process.kill(-(/** @type {number} */ (child.pid)), "SIGKILL"); } catch {} await new Promise(r => setTimeout(r, 200)); try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch {} });
  for (let i = 0; i < 400; i++) {
    try { const port = Number(fs.readFileSync(path.join(dir, "DevToolsActivePort"), "utf8").split("\n")[0]); if (port && (await fetch(`http://127.0.0.1:${port}/json/version`)).ok) return port; } catch {}
    await new Promise(r => setTimeout(r, 50));
  }
  throw new Error("Chrome did not come up");
}

/** The login-page replica. `mode`: "one" (username and password on one page) or "two" (username page, then password page, then a code page). Every credential POST is logged. */
async function site(t, { user, pass, mode }) {
  const log = [];
  const sessions = new Set();
  const page = (title, body) => `<!doctype html><title>${title}</title><body><h1>${title}</h1>${body}</body>`;
  const form = (action, fields) => `<form method="post" action="${action}">${fields}<button type="submit">Go</button></form>`;
  const parse = req => new Promise(r => { let b = ""; req.on("data", c => { b += c; }); req.on("end", () => r(Object.fromEntries(new URLSearchParams(b)))); });
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://x");
    const cookie = String(req.headers.cookie || "");
    const send = (code, html, h = {}) => { res.writeHead(code, { "content-type": "text/html", ...h }); res.end(html); };
    const go = (to, h = {}) => { res.writeHead(302, { location: to, ...h }); res.end(); };
    if (url.pathname === "/redirect") return go(`http://localhost:${server.address().port}/login`);
    if (url.pathname === "/login" && req.method === "GET") {
      return send(200, page("Sign in", mode === "two"
        ? form("/login", `<input type="email" name="email" autocomplete="username">`)
        : form("/login", `<input type="email" name="email" autocomplete="username"><input type="password" name="password" autocomplete="current-password">`)));
    }
    if (url.pathname === "/login" && req.method === "POST") {
      const b = await parse(req);
      log.push({ path: "/login", ...b });
      if (mode === "two" && b.password === undefined) return go(`/password?email=${encodeURIComponent(b.email)}`);
      if (b.email === user && b.password === pass) return go("/code");
      return send(401, page("Wrong", ""));
    }
    if (url.pathname === "/password" && req.method === "GET") {
      return send(200, page("Password", form("/login", `<input type="hidden" name="email" value="${user}"><input type="password" name="password" autocomplete="current-password">`)));
    }
    if (url.pathname === "/code" && req.method === "GET") {
      return send(200, page("Code", form("/code", `<input type="text" name="code" autocomplete="one-time-code">`)));
    }
    if (url.pathname === "/code" && req.method === "POST") {
      const b = await parse(req);
      log.push({ path: "/code", ...b });
      const ok = [-1, 0, 1].some(d => totp(SEED, { at: Date.now() + d * 30_000 }).code === b.code);
      if (!ok) return send(401, page("Wrong code", ""));
      const sid = crypto.randomBytes(8).toString("hex"); sessions.add(sid);
      return go("/home", { "set-cookie": `sid=${sid}; Path=/` });
    }
    if (url.pathname === "/home") return send(200, page(sessions.has(/sid=([a-f0-9]+)/.exec(cookie)?.[1] || "") ? "Signed in" : "Signed out", ""));
    send(404, page("None", ""));
  });
  await new Promise(r => server.listen(0, "127.0.0.1", () => r(undefined)));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const origin = `http://127.0.0.1:${/** @type {any} */ (server.address()).port}`;
  return { origin, log };
}

/** A vault with the replica's login, a kernel behind it, and every output the fill could leak into captured. */
async function world(t, { origin, user, pass, url }) {
  const home = fs.mkdtempSync(path.join(SCRATCH, "vyre-agent-fill-"));
  const db = open(path.join(home, "vyre.db"));
  migrate(db, "vault", MIGRATIONS);
  const rig = await kernelRig({});
  const events = [];
  const v = new Vault({ db, dir: path.join(home, "vault"), config: { name: "harlow-box", vault: { keystore: "file" } }, emit: (type, p) => events.push({ type, p }), log: () => {}, clock: rig.clock });
  v.access = new Access(v, rig.ctx);
  t.after(() => { db.close(); fs.rmSync(home, { recursive: true, force: true }); });
  await v.put({ name: "northwind-app", kind: "login", fields: { username: user, password: pass, totp: SEED }, url: url || `${origin}/login`, hosts: [origin] }, "cli");
  const said = new SaidIntents(v);
  const logs = [];
  return { v, db, rig, events, said, logs, home };
}

/** The deps agentFill gets: computers.fill.begin / end stand in for the real ones and say what the fill asked for. */
function deps(w, port) {
  const calls = [];
  return { calls, d: { vault: w.v, said: w.said, log: m => w.logs.push(m), call: async (name, input) => {
    calls.push({ name, input });
    if (name === "computers.fill.begin") return { data: { fill: "fill-1", cdpUrl: `http://127.0.0.1:${port}`, token: "" } };
    return { data: { agent: input.agent, ended: true } };
  } } };
}

/** Everything the fill produced anywhere, as one string, for the canary scan. */
const everything = (w, result, extra = []) => JSON.stringify({ result, events: w.events, audit: w.db.prepare("SELECT * FROM vault_audit").all(), logs: w.logs, extra });

/** Read the page a tab shows, over a second CDP connection (proof that the cookie the fill earned is in the tab handed back). */
async function title(port, targetId) {
  const { Cdp } = await import("../../lib/cdp.js");
  const c = new Cdp({ cdpUrl: `http://127.0.0.1:${port}` });
  try {
    await c.connect();
    const { sessionId } = await c.send("Target.attachToTarget", { targetId, flatten: true });
    return (await c.send("Runtime.evaluate", { expression: "document.title", returnByValue: true }, sessionId)).result.value;
  } finally { await c.close(); }
}

const lend = (w, origin, agent = "kit") => w.v.access.lend({ agent, item: "northwind-app", origin, expires: w.rig.clock() + 86_400_000 }, { caller: "cli" }, false);

test("a lent login signs the agent in; the replica sees the exact login once, and no sentinel appears anywhere else", { skip: !HAVE_CHROME && "no Chrome here" }, async t => {
  const user = `alex.${crypto.randomBytes(5).toString("hex")}@harlow.test`, pass = fake("password");
  const port = await chrome(t);
  const s = await site(t, { user, pass, mode: "one" });
  const w = await world(t, { origin: s.origin, user, pass });
  await lend(w, s.origin);
  const { d, calls } = deps(w, port);
  const r = await agentFill(d, { agent: "kit", item: "northwind-app" });
  assert.deepEqual(r.filled, ["username", "password", "code"]);
  assert.equal(r.origin, s.origin);
  assert.equal(r.navigated, true);
  assert.equal(await title(port, r.tab), "Signed in", "the tab handed back carries the session the fill earned");
  assert.deepEqual(s.log.map(x => [x.path, x.email ?? null, x.password ?? null, x.code ? "code" : null]), [["/login", user, pass, null], ["/code", null, null, "code"]], "the page got each credential exactly once");
  assert.deepEqual(calls.map(c => c.name), ["computers.fill.begin", "computers.fill.end"], "the shield is raised, then lowered");
  assert.equal(calls[1].input.target, r.tab);
  assert.equal(calls[0].input.agent, "kit");
  // The canary scan: the login's values (and the code the page accepted) are in no result, event, audit row or log line.
  const code = s.log.find(x => x.path === "/code").code;
  const blob = everything(w, r);
  assert.ok(blob.includes("northwind-app") && blob.includes(s.origin), "the scan really covers the audit and the result");
  for (const secret of [user, pass, code, SEED]) assert.ok(!blob.includes(secret), "a value of the login leaked");
  assert.equal(w.db.prepare("SELECT COUNT(*) AS n FROM vault_audit WHERE action='agent-fill' AND ok=1").get().n, 1);
  assert.equal(w.events.filter(e => e.type === "vault.filled").length, 1);
});

test("two pages: the username page, then the password page, then the code page", { skip: !HAVE_CHROME && "no Chrome here" }, async t => {
  const user = `alex.${crypto.randomBytes(5).toString("hex")}@harlow.test`, pass = fake("password");
  const port = await chrome(t);
  const s = await site(t, { user, pass, mode: "two" });
  const w = await world(t, { origin: s.origin, user, pass });
  await lend(w, s.origin);
  const r = await agentFill(deps(w, port).d, { agent: "kit", item: "northwind-app" });
  assert.deepEqual(r.filled, ["username", "password", "code"]);
  assert.equal(await title(port, r.tab), "Signed in");
  assert.deepEqual(s.log.map(x => x.path), ["/login", "/login", "/code"]);
});

test("no lending, another agent, another conversation, or an ended conversation: refused before the computer is touched, and the page sees nothing", { skip: !HAVE_CHROME && "no Chrome here" }, async t => {
  const user = `alex.${crypto.randomBytes(5).toString("hex")}@harlow.test`, pass = fake("password");
  const port = await chrome(t);
  const s = await site(t, { user, pass, mode: "one" });
  const w = await world(t, { origin: s.origin, user, pass });
  const { d, calls } = deps(w, port);
  await assert.rejects(agentFill(d, { agent: "kit", item: "northwind-app" }), /is not lent to kit/);
  await lend(w, s.origin, "kit");
  await assert.rejects(agentFill(d, { agent: "juno", item: "northwind-app" }), /is not lent to juno/, "a login lent to kit is not juno's");
  await assert.rejects(agentFill(d, { agent: "kit", item: "northwind-app", origin: "http://127.0.0.1:1" }), /is not for http:\/\/127.0.0.1:1/);
  await assert.rejects(agentFill(d, { agent: "kit", item: "no-such" }), /no login named/);
  // A # tag: this conversation only, until it ends.
  const w2 = await world(t, { origin: s.origin, user, pass });
  const { d: d2, calls: calls2 } = deps(w2, port);
  await w2.said.record({ thread: "t-1", said: "mention:northwind-app", kind: "use", to: ["northwind-app"], what: "use northwind-app", standing: false, limits: { hosts: [s.origin] } }, "module:sessions");
  await assert.rejects(agentFill(d2, { agent: "kit", item: "northwind-app", thread: "t-2" }), /is not lent to kit/, "another conversation has nothing");
  await assert.rejects(agentFill(d2, { agent: "kit", item: "northwind-app" }), /is not lent to kit/, "no conversation has nothing");
  w2.said.dropThread("t-1", "module:test");
  await assert.rejects(agentFill(d2, { agent: "kit", item: "northwind-app", thread: "t-1" }), /is not lent to kit/, "the conversation ended");
  assert.deepEqual([...calls, ...calls2], [], "no computer was shielded for any refusal");
  assert.deepEqual(s.log, [], "the page saw no request");
  assert.ok(w.db.prepare("SELECT COUNT(*) AS n FROM vault_audit WHERE action='agent-fill' AND ok=0").get().n >= 4, "every refusal is audited");
});

test("a # tag lends the login to its own conversation: the fill works there, and the tag lists and ends", { skip: !HAVE_CHROME && "no Chrome here" }, async t => {
  const user = `alex.${crypto.randomBytes(5).toString("hex")}@harlow.test`, pass = fake("password");
  const port = await chrome(t);
  const s = await site(t, { user, pass, mode: "one" });
  const w = await world(t, { origin: s.origin, user, pass });
  const id = (await w.said.record({ thread: "t-1", said: "mention:northwind-app", kind: "use", to: ["northwind-app"], what: "use northwind-app", standing: false, limits: { hosts: [s.origin] } }, "module:sessions")).id;
  const r = await agentFill(deps(w, port).d, { agent: "kit", item: "northwind-app", thread: "t-1" });
  assert.equal(await title(port, r.tab), "Signed in");
  assert.ok(!everything(w, r).includes(pass));
  const row = w.db.prepare("SELECT used FROM vault_said_intents WHERE id=?").get(id);
  assert.ok(row.used > 0, "using the tag restarts its idle clock");
  w.said.revoke({ id }, "cli");
  await assert.rejects(agentFill(deps(w, port).d, { agent: "kit", item: "northwind-app", thread: "t-1" }), /is not lent to kit/, "the person took it back");
});

test("the page is a different origin than the login's: nothing is filled, the refusal names the origin it saw, and the page gets no credential", { skip: !HAVE_CHROME && "no Chrome here" }, async t => {
  const user = `alex.${crypto.randomBytes(5).toString("hex")}@harlow.test`, pass = fake("password");
  const port = await chrome(t);
  const s = await site(t, { user, pass, mode: "one" });
  // The login's own address redirects to localhost: same server, a different origin.
  const w = await world(t, { origin: s.origin, user, pass, url: `${s.origin}/redirect` });
  await lend(w, s.origin);
  const { d, calls } = deps(w, port);
  const err = await agentFill(d, { agent: "kit", item: "northwind-app" }).then(() => null, e => e);
  assert.ok(err, "refused");
  assert.match(err.message, /the page is http:\/\/localhost:\d+, not http:\/\/127\.0\.0\.1:\d+; nothing was filled/);
  assert.deepEqual(s.log, [], "the page saw no credential");
  assert.deepEqual(calls.map(c => c.name), ["computers.fill.begin", "computers.fill.end"], "the shield is lowered even on a refusal");
  assert.ok(!everything(w, err.message).includes(pass));
});

test("a # tag stops matching after 8 hours idle, and a use restarts the clock", () => {
  const intent = { id: "s1", thread: "t-1", kind: "use", to: ["northwind-app"], standing: false, limits: { hosts: ["https://a.test"] }, at: 1_000_000, revoked: null, used: null };
  const call = at => ({ kind: "use", to: ["northwind-app"], hosts: ["https://a.test"], at });
  assert.ok(matchIntent(call(1_000_000 + USE_IDLE_MS - 1), [intent], ["t-1"]), "just inside");
  assert.equal(matchIntent(call(1_000_000 + USE_IDLE_MS + 1), [intent], ["t-1"]), null, "idle for 8 hours");
  assert.ok(matchIntent(call(1_000_000 + USE_IDLE_MS + 1), [{ ...intent, used: 1_000_000 + 3_600_000 }], ["t-1"]), "a use an hour in restarts the clock");
  assert.equal(matchIntent(call(1_000_000), [intent], ["t-2"]), null, "another conversation");
});

test("the tools: who may sign an agent in, and the person's view and removal of a # tag", async t => {
  const { register } = await import("./tools/agent-fill.js");
  const user = "alex@harlow.test", pass = fake("password");
  const w = await world(t, { origin: "http://127.0.0.1:9", user, pass });
  const tools = new Map();
  const asked = [];
  register({ ctx: { call: async (n, i) => { asked.push(n); return { error: { code: "no_driver", message: "no computer here" } }; }, log: () => {} }, vault: w.v, said: w.said, tool: (name, callers, description, input, run) => tools.set(name, { callers, run }) });
  const fill = tools.get("vault.agent.fill");
  assert.deepEqual(fill.callers, ["mcp", "harness", "module"]);
  // a module other than Vyre Computer, a model that names no agent, and a person's surface are all refused before anything is touched
  await assert.rejects(fill.run({ item: "northwind-app", agent: "kit" }, { caller: "module:flows" }), /only Vyre Computer/);
  await assert.rejects(fill.run({ item: "northwind-app" }, { caller: "mcp" }), /names no agent/);
  await assert.rejects(fill.run({ item: "northwind-app", agent: "kit" }, { caller: "cli" }), /only an agent|names no agent/);
  assert.deepEqual(asked, []);
  // the tag is listed with names and hosts only, and ends when the person takes it back
  const id = (await w.said.record({ thread: "t-1", said: "mention:northwind-app", kind: "use", to: ["northwind-app"], what: "use northwind-app", standing: false, limits: { hosts: ["http://127.0.0.1:9"] } }, "module:sessions")).id;
  const listed = tools.get("vault.tagged").run({}, { caller: "cli" });
  assert.deepEqual(listed.tags.map(x => [x.id, x.item, x.thread, x.hosts]), [[id, "northwind-app", "t-1", ["http://127.0.0.1:9"]]]);
  assert.ok(!JSON.stringify(listed).includes(pass));
  assert.deepEqual(tools.get("vault.tagged").run({ item: "other" }, { caller: "cli" }).tags, []);
  assert.deepEqual(tools.get("vault.tagged").callers.includes("mcp"), false, "a model does not list who has what");
  tools.get("vault.untag").run({ id }, { caller: "cli" });
  assert.deepEqual(tools.get("vault.tagged").run({}, { caller: "cli" }).tags, []);
});
