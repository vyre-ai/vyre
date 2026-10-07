// @ts-check
// Two things a practice-management provider needs without code changes: OAuth settings that leave `scope` out, and a per-credential rate limit that is the Space's (every caller shares it)
// and that waits out a provider's own "too many requests" instead of failing. Fakes only: DNS, transport, a clock that the fake sleep moves.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { open, migrate } from "../store/index.js";
import { Vault, MIGRATIONS } from "./vault.js";
import * as saidTools from "./said.js";
import { register } from "./request.js";
import { normalize } from "./api-request.js";
import { SCRATCH } from "../../test/scratch.mjs";

const fake = l => `fixture-${l}-${crypto.randomBytes(12).toString("hex")}`;
const json = (status, body, headers = {}) => ({ status, headers: { "content-type": "application/json", ...headers }, body: Buffer.from(JSON.stringify(body)) });
const cfgOf = (extra = {}) => JSON.stringify({ auth: { type: "bearer" }, hosts: ["app.pm.test"], endpoints: [{ method: "GET", path: "/api/*", kind: "read" }], ...extra });

async function mk(t) {
  const home = fs.mkdtempSync(path.join(SCRATCH, "vyre-rate-")), db = open(path.join(home, "vyre.db")); migrate(db, "vault", MIGRATIONS);
  const v = new Vault({ db, dir: path.join(home, "vault"), config: { name: "harlow-box", vault: { keystore: "file" } }, emit: () => {}, log: () => {} });
  t.after(() => { db.close(); fs.rmSync(home, { recursive: true, force: true }); });
  let clock = 1_800_000_000_000; const sleeps = /** @type {number[]} */ ([]);
  const net = { calls: /** @type {any[]} */ ([]), script: /** @type {(r: any) => any} */ (() => json(200, { ok: true })) };
  const lookup = async () => [{ address: "203.0.113.10", family: 4 }];
  const transport = async r => { net.calls.push({ host: r.url.hostname, path: r.url.pathname, method: r.method, body: r.body, at: clock }); return net.script(r); };
  const tools = new Map(), tool = (n, c, d, i, run) => tools.set(n, { run }), internal = (n, d, i, run) => tools.set(n, { run });
  const said = saidTools.register({ vault: v, internal });
  register({ vault: v, tool, internal, call: async () => ({ error: { code: "no_such_tool", message: "x" } }), said, deps: { lookup, transport, now: () => clock, sleep: async ms => { sleeps.push(ms); clock += ms; } } });
  const run = (name, input, caller = "cli") => tools.get(name).run(input, { caller });
  await v.put({ name: "pm", kind: "api-credential", fields: { config: cfgOf({ rate: { per_minute: 3 } }), secret: fake("pm") } }, "cli");
  const ask = (caller = "cli", name = "pm") => run("vault.request", { credential: name, method: "GET", url: "https://app.pm.test/api/v4/matters" }, caller);
  const add = (name, extra = {}) => v.put({ name, kind: "api-credential", fields: { config: cfgOf(extra), secret: fake(name) } }, "cli");
  return { v, net, run, ask, add, sleeps, tick: ms => { clock += ms; }, now: () => clock };
}

test("the rate is checked: a whole number of requests a minute, or nothing", () => {
  const base = { auth: { type: "bearer" }, hosts: ["a.test"] };
  assert.deepEqual(normalize({ ...base, rate: { per_minute: 50 } }).rate, { per_minute: 50 }); assert.equal(normalize(base).rate, undefined, "no limit of ours by default");
  for (const bad of [{ per_minute: 0 }, { per_minute: 1.5 }, { per_minute: "50" }, { per_minute: 100000 }, 50, {}]) assert.throws(() => normalize({ ...base, rate: bad }), /rate is/, JSON.stringify(bad));
});

test("a credential at its limit waits for the allowance, shared by every caller, and a wait that is too long is refused with the seconds to wait", async t => {
  const m = await mk(t);
  await m.ask("cli"); m.tick(20_000); await m.ask("local"); m.tick(20_000); await m.ask("deck"); assert.equal(m.sleeps.length, 0, "three a minute, three made");
  await m.ask("capsule"); assert.deepEqual(m.sleeps, [20_000], "the fourth, from a different caller, waited for the first to age out of the minute");
  assert.equal(m.net.calls.length, 4);
  const m3 = await mk(t); await m3.add("slow", { rate: { per_minute: 1 } });
  await m3.ask("cli", "slow"); const e = await m3.ask("cli", "slow").then(() => null, x => x); assert.equal(e?.code, "rate_limited"); assert.ok(e.retryAfter > 0 && e.retryAfter <= 60); assert.equal(m3.net.calls.length, 1, "the second never went out");
  m3.tick(61_000); await m3.ask("cli", "slow"); assert.equal(m3.net.calls.length, 2, "allowed again after the minute");
});

test("the provider's own 'too many requests': its Retry-After is waited out, a retry is bounded, a long one goes back to the caller, and the cooldown is the credential's", async t => {
  const m = await mk(t); await m.add("free");
  let n = 0; m.net.script = () => (n++ === 0 ? json(429, { error: "slow down" }, { "retry-after": "2" }) : json(200, { ok: true }));
  const r = await m.ask("cli", "free"); assert.equal(r.status, 200); assert.deepEqual(m.sleeps, [2000], "waited the provider's two seconds"); assert.equal(m.net.calls.length, 2);
  const m2 = await mk(t); await m2.add("free"); m2.net.script = () => json(429, { error: "no" }, { "retry-after": "1" });
  const r2 = await m2.ask("cli", "free"); assert.equal(r2.status, 429); assert.equal(r2.headers["retry-after"], "1"); assert.equal(m2.net.calls.length, 3, "one call and two retries, then the answer");
  const m3 = await mk(t); await m3.add("free"); m3.net.script = () => json(429, {}, { "retry-after": "3600" });
  const r3 = await m3.ask("cli", "free"); assert.equal(r3.status, 429); assert.equal(m3.net.calls.length, 1); assert.deepEqual(m3.sleeps, [], "too long to wait: handed back");
  // Another caller arriving during the cooldown waits for what is left of it.
  const m4 = await mk(t); await m4.add("free"); let k = 0; m4.net.script = () => (k++ === 0 ? json(429, {}, { "retry-after": "5" }) : json(200, {}));
  const first = m4.ask("capsule", "free"); await first; assert.deepEqual(m4.sleeps, [5000]);
});

test("an OAuth credential with no scopes: accepted, and the refresh request carries no scope at all", async t => {
  const m = await mk(t); await m.v.put({ name: "pm-app", kind: "env-set", fields: { client_id: "client-abc", client_secret: fake("cs") } }, "cli");
  const cfg = { auth: { type: "oauth", client: { item: "pm-app" }, authorize_uri: "https://app.pm.test/oauth/authorize", token_uri: "https://app.pm.test/oauth/token" }, hosts: ["app.pm.test"], endpoints: [{ method: "GET", path: "/api/*", kind: "read" }] };
  assert.deepEqual(normalize(cfg).auth.scopes, []); assert.deepEqual(normalize({ ...cfg, auth: { ...cfg.auth, scopes: [] } }).auth.scopes, []);
  assert.throws(() => normalize({ ...cfg, auth: { ...cfg.auth, scopes: "read" } }), /scopes must be a list/);
  await m.v.put({ name: "clio-like", kind: "api-credential", fields: { config: JSON.stringify(cfg) } }, "cli");
  await m.run("vault.credential.tokens", { name: "clio-like", tokens: { access_token: fake("old"), refresh_token: fake("rt"), expires_in: 1, token_uri: "https://app.pm.test/oauth/token" } }, "module:connectors");
  m.tick(120_000); const bodies = []; m.net.script = r => { if (r.url.pathname === "/oauth/token") { bodies.push(String(r.body)); return json(200, { access_token: fake("new"), expires_in: 3600 }); } return json(200, { ok: true }); };
  const out = await m.run("vault.request", { credential: "clio-like", method: "GET", url: "https://app.pm.test/api/v4/matters" }); assert.equal(out.status, 200);
  assert.equal(bodies.length, 1); assert.ok(/grant_type=refresh_token/.test(bodies[0]) && /client_id=client-abc/.test(bodies[0])); assert.equal(/scope=/.test(bodies[0]), false, "no scope parameter");
});
