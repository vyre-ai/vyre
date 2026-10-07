// @ts-check
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createDroplet, waitActive, destroy, estimateMonthly, cloudInit, firewallRules, redact, VpsError, INSTALL_COMMAND, PAIR_PROMPT } from "./vps.js";

const TOKEN = "dop_v1_fakefakefake0123456789abcdef";
const SP = "spc_harlow00001";

const res = (/** @type {number} */ status, /** @type {any} */ body = {}, /** @type {Record<string,string>} */ headers = {}) =>
  ({ status, headers: { get: (/** @type {string} */ k) => headers[k.toLowerCase()] ?? null }, json: async () => body, text: async () => JSON.stringify(body) });

/** A fake DigitalOcean: routes by "METHOD path". A route may be a response, a list of them, or a function. */
function fake(/** @type {Record<string, any>} */ routes) {
  /** @type {{ method: string, path: string, body: any, headers: any }[]} */ const calls = [];
  const counts = /** @type {Record<string, number>} */ ({});
  const f = async (/** @type {string} */ url, /** @type {any} */ init) => {
    const path = url.replace("https://api.digitalocean.com/v2", "");
    const key = `${init.method} ${path.replace(/\/\w+$/, m => (routes[`${init.method} ${path}`] ? m : "/:id"))}`;
    calls.push({ method: init.method, path, body: init.body ? JSON.parse(init.body) : undefined, headers: init.headers });
    let r = routes[key] ?? routes[`${init.method} ${path}`];
    if (Array.isArray(r)) { const n = counts[key] = (counts[key] ?? -1) + 1; r = r[Math.min(n, r.length - 1)]; }
    if (typeof r === "function") r = await r(init);
    if (!r) return res(500);
    return r;
  };
  return { fetch: f, calls };
}
const noSleep = async () => {};
const base = (/** @type {any} */ f, /** @type {any} */ extra = {}) => ({ fetch: f.fetch, sleep: noSleep, ...extra });

test("createDroplet makes a firewall then a server with user data, tag and only the needed ports", async () => {
  const f = fake({ "POST /firewalls": res(202, { firewall: { id: "fw1" } }), "POST /droplets": res(202, { droplet: { id: 77 } }) });
  const r = await createDroplet({ token: TOKEN, spaceId: SP, name: "harlow-home", region: "nyc3" }, base(f));
  assert.deepEqual(r, { dropletId: "77", firewallId: "fw1", tag: "vyre-spc-harlow00001", region: "nyc3", size: "s-2vcpu-4gb" });
  const [fw, dr] = f.calls;
  assert.equal(fw.path, "/firewalls");
  assert.deepEqual(fw.body.inbound_rules.map((/** @type {any} */ x) => `${x.protocol}/${x.ports}`), ["tcp/443", "udp/41641"]);
  assert.equal(dr.body.image, "ubuntu-24-04-x64");
  assert.deepEqual(dr.body.tags, ["vyre-spc-harlow00001"]);
  assert.match(dr.body.user_data, /vyre\.run\/i \| sh/);
  assert.ok(dr.body.user_data.includes(PAIR_PROMPT));
  assert.equal(dr.headers.Authorization, `Bearer ${TOKEN}`);
});

test("ssh is opened only when asked for", () => {
  assert.equal(firewallRules({ tag: "t" }).inbound_rules.some(r => r.ports === "22"), false);
  assert.equal(firewallRules({ tag: "t", allowSsh: true }).inbound_rules.some(r => r.ports === "22"), true);
});

test("the first-boot script runs the one command and holds no secret", () => {
  const c = cloudInit({ spaceId: SP });
  assert.ok(c.startsWith("#cloud-config"));
  assert.ok(c.includes(INSTALL_COMMAND));
  assert.ok(!/token|password|secret/i.test(c));
});

test("a failed server create removes the firewall again", async () => {
  const f = fake({ "POST /firewalls": res(202, { firewall: { id: "fw1" } }), "POST /droplets": res(422, { message: `bad ${TOKEN}` }), "DELETE /firewalls/:id": res(204) });
  await assert.rejects(createDroplet({ token: TOKEN, spaceId: SP }, base(f)), (/** @type {any} */ e) => e.code === "rejected" && !e.message.includes(TOKEN));
  assert.deepEqual(f.calls.map(c => `${c.method} ${c.path}`), ["POST /firewalls", "POST /droplets", "DELETE /firewalls/fw1"]);
});

test("API errors are plain words, by status", async () => {
  const cases = /** @type {[number, string, RegExp][]} */ ([[401, "bad_token", /did not accept the token/], [403, "forbidden", /may not do that/], [500, "provider_down", /on its side/], [503, "provider_down", /on its side/]]);
  for (const [status, code, re] of cases) {
    const f = fake({ "POST /firewalls": res(status, { message: "x" }) });
    await assert.rejects(createDroplet({ token: TOKEN, spaceId: SP }, base(f)), (/** @type {any} */ e) => e instanceof VpsError && e.code === code && re.test(e.message) && e.status === status);
  }
});

test("rate limits are retried a limited number of times, then reported", async () => {
  const sleeps = /** @type {number[]} */ ([]);
  const f = fake({ "POST /firewalls": [res(429, {}, { "retry-after": "3" }), res(429), res(202, { firewall: { id: "fw1" } })], "POST /droplets": res(202, { droplet: { id: 1 } }) });
  const r = await createDroplet({ token: TOKEN, spaceId: SP }, base(f, { sleep: async (/** @type {number} */ ms) => { sleeps.push(ms); } }));
  assert.equal(r.dropletId, "1");
  assert.equal(sleeps[0], 3000);
  assert.equal(f.calls.filter(c => c.path === "/firewalls").length, 3);
  const g = fake({ "POST /firewalls": res(429) });
  await assert.rejects(createDroplet({ token: TOKEN, spaceId: SP }, base(g)), (/** @type {any} */ e) => e.code === "rate_limited" && e.retryable);
  assert.equal(g.calls.length, 3, "one try and two retries, no more");
});

test("a request that hangs times out in plain words", async () => {
  /** @type {any} */ let sig;
  const hang = { fetch: (/** @type {string} */ _u, /** @type {any} */ init) => new Promise((_, rej) => { sig = init.signal; if (sig.aborted) return rej(Object.assign(new Error("aborted"), { name: "AbortError" })); sig.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" }))); }) };
  await assert.rejects(createDroplet({ token: TOKEN, spaceId: SP }, { ...hang, sleep: noSleep, setTimer: (/** @type {() => void} */ fn) => { fn(); return 1; }, clearTimer: () => {} }),
    (/** @type {any} */ e) => e.code === "timeout" && /too long/.test(e.message));
});

test("a network failure is plain words and carries no token", async () => {
  const deps = { fetch: async () => { throw new Error(`ECONNRESET talking to https://x with Bearer ${TOKEN}`); }, sleep: noSleep };
  await assert.rejects(createDroplet({ token: TOKEN, spaceId: SP }, deps), (/** @type {any} */ e) => e.code === "unreachable" && !e.message.includes(TOKEN) && !JSON.stringify(e).includes(TOKEN));
});

test("an unknown size or region is refused before any call", async () => {
  const f = fake({});
  await assert.rejects(createDroplet({ token: TOKEN, spaceId: SP, size: "huge" }, base(f)), /size is not offered/);
  await assert.rejects(createDroplet({ token: TOKEN, spaceId: SP, region: "mars1" }, base(f)), /region is not offered/);
  assert.equal(f.calls.length, 0);
});

test("a missing token is asked for", async () => {
  await assert.rejects(createDroplet({ token: "", spaceId: SP }, base(fake({}))), /Paste your DigitalOcean token/);
});

test("waitActive polls until active and returns the public address", async () => {
  const f = fake({ "GET /droplets/:id": [res(200, { droplet: { status: "new" } }), res(200, { droplet: { status: "new" } }),
    res(200, { droplet: { status: "active", networks: { v4: [{ type: "private", ip_address: "10.0.0.2" }, { type: "public", ip_address: "203.0.113.9" }] } } })] });
  const r = await waitActive(TOKEN, "77", base(f), { intervalMs: 1000 });
  assert.deepEqual(r, { dropletId: "77", address: "203.0.113.9" });
  assert.equal(f.calls.length, 3);
});

test("waitActive has a hard cap on polling", async () => {
  const f = fake({ "GET /droplets/:id": res(200, { droplet: { status: "new" } }) });
  await assert.rejects(waitActive(TOKEN, "77", base(f), { maxPolls: 100000 }), (/** @type {any} */ e) => e.code === "slow_start" && /too long/.test(e.message));
  assert.equal(f.calls.length, 120);
  const g = fake({ "GET /droplets/:id": res(200, { droplet: { status: "new" } }) });
  await assert.rejects(waitActive(TOKEN, "77", base(g), { maxPolls: 3 }), /taking too long/);
  assert.equal(g.calls.length, 3);
});

test("waitActive fails fast when the server stops, and on an API error", async () => {
  await assert.rejects(waitActive(TOKEN, "77", base(fake({ "GET /droplets/:id": res(200, { droplet: { status: "off" } }) }))), (/** @type {any} */ e) => e.code === "not_active");
  await assert.rejects(waitActive(TOKEN, "77", base(fake({ "GET /droplets/:id": res(401) }))), (/** @type {any} */ e) => e.code === "bad_token");
});

test("cancel: destroy removes the server it created and its firewall", async () => {
  const f = fake({ "POST /firewalls": res(202, { firewall: { id: "fw1" } }), "POST /droplets": res(202, { droplet: { id: 77 } }), "DELETE /droplets/:id": res(204), "DELETE /firewalls/:id": res(204) });
  const made = await createDroplet({ token: TOKEN, spaceId: SP }, base(f));
  const r = await destroy(TOKEN, made, base(f));
  assert.deepEqual(r, { removed: ["server", "firewall"] });
  assert.deepEqual(f.calls.slice(-2).map(c => `${c.method} ${c.path}`), ["DELETE /droplets/77", "DELETE /firewalls/fw1"]);
});

test("destroy treats already gone as removed and says plainly what it could not remove", async () => {
  const gone = fake({ "DELETE /droplets/:id": res(404), "DELETE /firewalls/:id": res(204) });
  assert.deepEqual(await destroy(TOKEN, { dropletId: "1", firewallId: "f" }, base(gone)), { removed: ["server", "firewall"] });
  const bad = fake({ "DELETE /droplets/:id": res(500), "DELETE /firewalls/:id": res(204) });
  await assert.rejects(destroy(TOKEN, { dropletId: "1", firewallId: "f" }, base(bad)), (/** @type {any} */ e) =>
    e.code === "destroy_failed" && /Remove it in your DigitalOcean account/.test(e.message) && e.removed[0] === "firewall" && e.failed[0].what === "server");
});

test("the token is redacted in every error, event and thrown value", async () => {
  const events = /** @type {any[]} */ ([]);
  const f = fake({ "POST /firewalls": res(202, { firewall: { id: "fw1" } }), "POST /droplets": res(202, { droplet: { id: 5 } }), "DELETE /droplets/:id": res(500, { message: TOKEN }), "DELETE /firewalls/:id": res(204) });
  const deps = base(f, { emit: (/** @type {string} */ type, /** @type {any} */ payload) => events.push({ type, payload }) });
  const made = await createDroplet({ token: TOKEN, spaceId: SP }, deps);
  /** @type {any} */ let err;
  await destroy(TOKEN, made, deps).catch(e => { err = e; });
  assert.ok(err);
  assert.ok(!JSON.stringify([events, err.message, err.failed, err.removed, err.code]).includes(TOKEN));
  assert.ok(events.length >= 1);
  assert.equal(redact(`x ${TOKEN} y`, [TOKEN]), "x [redacted] y");
  assert.ok(!redact("Authorization: Bearer abc.def").includes("abc.def"));
});

test("estimateMonthly prices the sizes on offer", () => {
  assert.equal(estimateMonthly("s-2vcpu-4gb", "nyc3").usdPerMonth, 24);
  assert.equal(estimateMonthly().size, "s-2vcpu-4gb");
  assert.throws(() => estimateMonthly("nope", "nyc3"), /not offered/);
});
