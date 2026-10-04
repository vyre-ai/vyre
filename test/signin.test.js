import "../scripts/mac-test-guard.mjs";
// @ts-check
// `vyre signin` (core/signin): the phone approves, one terminal login holds a person session. The module with fakes, the session kind that is pinned to a login, and the route on a real daemon.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import signin from "../core/signin/index.js";
import { PersonSessions } from "../core/presence/person.js";
import { open } from "../core/store/index.js";
import { surfaceAncestry, start } from "../core/daemon/index.js";
import { setPeerHosting } from "../core/daemon/peer.js";
import { readSession, writeSession, clearSession, sessionFile } from "../lib/cli-session.js";
import { tempHome, writeModule } from "./helpers.js";

/** The module's tools with a fake kernel, fake session store and a clock. */
async function mod({ checkOk = true, dev = false, person = true } = {}) {
  /** @type {Record<string, any>} */ const tools = {};
  let t = 1_000_000; const started = [], ended = [];
  const ctx = {
    now: () => t, kernel: { chain: async () => (person ? { hops: [{ actor: { kind: "person", id: "per_x" } }] } : { hops: [{ actor: { kind: "agent", id: "a" } }] }), proofFrom: () => ({ p: 1 }) }, devStandIn: () => dev, events: { emit: () => {} },
    cliSigninPayload: (/** @type {string} */ ask, /** @type {string} */ term) => ({ op: "grant.cli_signin", space: "spc", fields: { ask, terminal: term.slice(0, 4) }, payload_hash: `h(${ask})` }),
    cliSigninCheck: async () => (checkOk ? { ok: true } : { ok: false, why: "bad" }),
    cliSessions: { startStandIn: (/** @type {string} */ n) => { started.push("dev:" + n); return { id: "id1", token: "id12345678.secret0123456789abcdef", expires: t + 1000 }; }, start: (/** @type {string} */ k) => { started.push(k); return { token: "id12345678.secret0123456789abcdef", expires: t + 1000 }; }, end: (/** @type {string} */ k) => { ended.push(k); return 1; } },
    tool: (/** @type {string} */ name, /** @type {any} */ def) => { tools[name] = def.run; },
  };
  await signin.start(ctx);
  return { tools, started, ended, tick: (/** @type {number} */ ms) => { t += ms; } };
}
process.env.VYRE_SEAL_DEV = "1";
process.env.VYRE_KERNEL_PATH_RULE = "1";
const T = { key: "ttys003#812@1" }, OTHER = { key: "ttys009#900@2" };

test("signin.ask needs a terminal login and is rate limited; a second ask from the same terminal returns the same id", async () => {
  const m = await mod();
  await assert.rejects(() => m.tools["signin.ask"]({}, {}), { code: "no_terminal" });
  await assert.rejects(() => m.tools["signin.ask"]({}, { terminal: null }), { code: "no_terminal" });
  const a = await m.tools["signin.ask"]({}, { terminal: T });
  assert.match(a.id, /^si_/);
  assert.equal((await m.tools["signin.ask"]({}, { terminal: T })).id, a.id);
  await assert.rejects(() => m.tools["signin.ask"]({}, { terminal: OTHER }), { code: "rate_limited" });
});

test("pending shows the card to sign; a yes with a good proof makes the session for that terminal; only that terminal reads the credential, once", async () => {
  const m = await mod();
  const a = await m.tools["signin.ask"]({}, { terminal: T });
  const card = await m.tools["signin.pending"]({}, {});
  assert.equal(card.id, a.id); assert.equal(card.op, "grant.cli_signin"); assert.equal(card.payload_hash, `h(${a.id})`);
  assert.deepEqual(await m.tools["signin.status"]({ id: a.id }, { terminal: T }), { state: "waiting" });
  assert.deepEqual(await m.tools["signin.answer"]({ id: a.id, approve: true }, {}), { answered: "approved" });
  assert.deepEqual(m.started, [T.key], "the session is made for the terminal that asked");
  assert.deepEqual(await m.tools["signin.status"]({ id: a.id }, { terminal: OTHER }), { state: "none" }, "another terminal learns nothing");
  assert.deepEqual(await m.tools["signin.status"]({ id: a.id }, {}), { state: "none" }, "a program with no login learns nothing");
  const got = await m.tools["signin.status"]({ id: a.id }, { terminal: T });
  assert.equal(got.state, "approved"); assert.match(got.token, /^id12345678\./);
  assert.deepEqual(await m.tools["signin.status"]({ id: a.id }, { terminal: T }), { state: "none" }, "read once");
});

test("a bad proof, a no from a label, a no from the person's session, a stale id and a timeout change nothing", async () => {
  let m = await mod({ checkOk: false });
  let a = await m.tools["signin.ask"]({}, { terminal: T });
  await assert.rejects(() => m.tools["signin.answer"]({ id: a.id, approve: true }, {}), { code: "needs_presence" });
  assert.deepEqual(m.started, []);
  await assert.rejects(() => m.tools["signin.answer"]({ id: "si_other", approve: true }, {}), { code: "not_found" });
  assert.deepEqual(await m.tools["signin.answer"]({ id: a.id, approve: false }, {}), { answered: "ignored", why: "a no needs your signed-in session" });
  assert.deepEqual(await m.tools["signin.answer"]({ id: a.id, approve: false }, { person: { id: "p" } }), { answered: "refused" });
  assert.deepEqual(await m.tools["signin.status"]({ id: a.id }, { terminal: T }), { state: "refused" });
  m = await mod(); a = await m.tools["signin.ask"]({}, { terminal: T });
  m.tick(6 * 60_000);
  assert.deepEqual(await m.tools["signin.pending"]({}, {}), { none: true });
  await assert.rejects(() => m.tools["signin.answer"]({ id: a.id, approve: true }, {}), { code: "not_found" });
});

test("signin.end ends this terminal's sessions and needs a terminal", async () => {
  const m = await mod();
  await assert.rejects(() => m.tools["signin.end"]({}, {}), { code: "no_terminal" });
  assert.deepEqual(await m.tools["signin.end"]({}, { terminal: T }), { ended: 1 });
  assert.deepEqual(m.ended, [T.key]);
});

test("a command-line session is carried as the bearer header, signed by no key, and honoured only for its own terminal login", t => {
  const db = open(path.join(tempHome(t), "p.db"));
  let now = 1_000_000_000;
  const p = new PersonSessions({ db, now: () => now });
  const s = p.start({ node: `cli:${T.key}`, kind: "cli", label: "command line" });
  const headers = { authorization: `Vyre ${s.token}` };
  assert.deepEqual(p.check({ headers, node: `cli:${T.key}` }), { ok: true, id: s.id, kind: "cli" });
  assert.equal(p.check({ headers, node: `cli:${OTHER.key}` })?.ok, false, "another login cannot present it");
  assert.equal(p.check({ headers, node: null })?.ok, false, "a caller with no login key cannot present it");
  assert.equal(p.check({ headers: { authorization: `Vyre ${s.id}.${"x".repeat(43)}` }, node: `cli:${T.key}` })?.ok, false, "a wrong secret");
  now += 29 * 24 * 3600_000; assert.equal(p.check({ headers, node: `cli:${T.key}` })?.ok, true, "used within 30 days");
  now += 29 * 24 * 3600_000; assert.equal(p.check({ headers, node: `cli:${T.key}` })?.ok, true, "the 30 days slide with use");
  now += 31 * 24 * 3600_000; assert.equal(p.check({ headers, node: `cli:${T.key}` })?.ok, false, "30 days unused lapses");
  const s2 = p.start({ node: `cli:${T.key}`, kind: "cli" });
  assert.equal(p.revokeNode(`cli:${T.key}`), 1);
  assert.equal(p.check({ headers: { authorization: `Vyre ${s2.token}` }, node: `cli:${T.key}` })?.ok, false, "signed out");
});

test("a live command-line session counts as outside for callerFacts, and a model's shell never does", () => {
  assert.deepEqual(surfaceAncestry({ model: false, outside: false }, false, true), { inside: false, outside: true });
  assert.deepEqual(surfaceAncestry({ model: true, outside: false }, false, true), { inside: true, outside: false });
  assert.deepEqual(surfaceAncestry({ model: false, outside: false }, false, false), { inside: false, outside: false });
});

test("the session file is 0600 and only a well-formed credential is read", t => {
  const root = tempHome(t);
  assert.equal(readSession(root), null);
  writeSession("id12345678.secret0123456789abcdef", root);
  assert.equal(readSession(root), "id12345678.secret0123456789abcdef");
  assert.equal(fs.statSync(sessionFile(root)).mode & 0o777, 0o600);
  fs.writeFileSync(sessionFile(root), "not a token\n"); assert.equal(readSession(root), null);
  clearSession(root); assert.equal(fs.existsSync(sessionFile(root)), false);
});

test("on a real daemon the credential counts only from the login it was made for, and the daemon's own measurement of that login is what pins it", { timeout: 120_000, skip: process.platform === "win32" }, async t => {
  const root = tempHome(t);
  globalThis.__sess = [];
  writeModule(path.join(root, "modules"), "probe", { does: { tools: ["probe.who"] }, needs: { kernel: { actions: [] } } }, `export default { async start(ctx) {
    ctx.tool("probe.who", { input: { type: "object" }, callers: ["cli"], run: async (_i, meta) => { globalThis.__sess.push(meta.person ? meta.person.kind : "none"); return {}; } });
    return {};
  } };`);
  let login = "ttys001#1@1";
  const d = await start({ root, log: () => {}, kernel: true, firstPartyRoots: [path.join(root, "modules")], person: async () => ({ key: login, tty: null }) });
  t.after(() => d.stop());
  const dir = fs.mkdtempSync(path.join(root, "si-"));
  const js = path.join(dir, "c.mjs");
  fs.writeFileSync(js, `import http from "node:http";
const h = { "content-type": "application/json", "content-length": 2, "x-vyre-caller": "cli" }; if (process.env.TOK) h.authorization = "Vyre " + process.env.TOK;
const req = http.request({ socketPath: ${JSON.stringify(d.paths.socket)}, path: "/v1/tools/probe.who", method: "POST", headers: h }, res => { res.resume(); res.on("end", () => process.exit(0)); });
req.on("error", () => process.exit(0)); req.end("{}");`);
  const run = (/** @type {string} */ tok) => new Promise(r => spawn(process.execPath, [js], { stdio: "ignore", env: { ...process.env, ...(tok ? { TOK: tok } : {}) } }).on("close", r));
  // the sessions the daemon holds: ask its own deps for one (the module does exactly this after the phone's yes)
  const s = d.registry.deps.cliSessions.start("ttys001#1@1");
  setPeerHosting(true);
  try {
    await run(s.token); await run(""); await run(s.token.replace(/.$/, "x"));
    login = "ttys999#9@9"; await run(s.token);
    d.registry.deps.cliSessions.end("ttys001#1@1"); login = "ttys001#1@1"; await run(s.token);
  } finally { setPeerHosting(false); }
  // a model's shell: the same process, the right login (the seam answers it) and the right secret, under a fake claude: relabelled mcp, so the cli session never counts
  const fakeDir = path.join(dir, "claude-dir"); fs.mkdirSync(fakeDir, { recursive: true });
  fs.writeFileSync(path.join(fakeDir, "claude"), `#!${process.execPath}\nconst c = require("node:child_process").spawn(process.execPath, [${JSON.stringify(js)}], { stdio: "ignore" });\nc.on("exit", code => process.exit(code ?? 1));\n`, { mode: 0o755 });
  const before = globalThis.__sess.length;
  await new Promise(r => spawn(process.execPath, [path.join(fakeDir, "claude")], { stdio: "ignore", env: { ...process.env, TOK: d.registry.deps.cliSessions.start("ttys001#1@1").token } }).on("close", r));
  assert.equal(globalThis.__sess.length, before, "a call from under a claude never reaches a cli-only tool, session or not: " + JSON.stringify(globalThis.__sess));
  assert.deepEqual(globalThis.__sess.slice(0, 5), ["cli", "none", "none", "none", "none"], "the right login with the right secret is the only one; another login, no secret, a wrong secret and a signed-out session are not");
});

test("signin.dev makes the walk's person session only on a dev build with the stand-in file, from a caller counted as the owner", async () => {
  let m = await mod({ dev: false });
  await assert.rejects(() => m.tools["signin.dev"]({ node: "n1" }, {}), { code: "dev_only" });
  m = await mod({ dev: true, person: false });
  await assert.rejects(() => m.tools["signin.dev"]({ node: "n1" }, {}), { code: "denied" });
  m = await mod({ dev: true });
  await assert.rejects(() => m.tools["signin.dev"]({ node: "bad node!" }, {}), { code: "bad_input" });
  const r = await m.tools["signin.dev"]({ node: "n1" }, {});
  assert.equal(r.kind, "cookie"); assert.equal(r.method, "stand-in"); assert.deepEqual(m.started, ["dev:n1"]);
});
