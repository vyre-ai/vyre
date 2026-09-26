// @ts-check
// egress on its own: the PAC script, run the way Chrome runs it (a function of url and host),
// the strict site check against inputs built to break out of it, and the env a computer gets.

import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { pac, pacUrl, checkSite, checkSites, chromeEnv, setting, proxy, probe, PROXY, MAX_SITES } from "./egress.js";

/** Run a PAC script in a fresh context with nothing in scope, and return its FindProxyForURL. */
function load(script) {
  const box = vm.createContext({});
  vm.runInContext(script, box);
  return (url, host) => box.FindProxyForURL(url, host);
}

test("egress: listed sites go through the sidecar with no DIRECT fallback, everything else DIRECT", () => {
  const find = load(pac(["bank.example.com", "*.harlow.example"]));
  const via = `SOCKS5 ${PROXY}`;
  assert.equal(find("https://bank.example.com/login", "bank.example.com"), via);
  assert.equal(find("https://x", "BANK.example.com"), via, "hosts are compared without case");
  assert.equal(find("https://x", "bank.example.com."), via, "a trailing dot is the same host, not a way past the list");
  assert.equal(find("https://x", "harlow.example"), via, "*. covers the name itself");
  assert.equal(find("https://x", "portal.harlow.example"), via);
  assert.equal(find("https://x", "a.b.harlow.example"), via);
  assert.equal(find("https://x", "evilharlow.example"), "DIRECT", "*.harlow.example is not a suffix match on the string");
  assert.equal(find("https://x", "www.bank.example.com"), "DIRECT", "an exact site does not cover its subdomains");
  assert.equal(find("https://x", "northwind.example"), "DIRECT");
  assert.doesNotMatch(via, /DIRECT/, "a listed site never falls back to DIRECT");
});

test("egress: an empty list routes nothing through the sidecar", () => {
  const find = load(pac([]));
  assert.equal(find("https://x", "bank.example.com"), "DIRECT");
});

test("egress: sites are refused, never cleaned up, when they could break out of the script", () => {
  const evil = [
    'bank.example.com"; return "DIRECT"; //', "bank.example.com'", "bank example.com", " bank.example.com", "bank.example.com\n",
    "bank.example.com ", "bank.example.com/", "https://bank.example.com", "bank.example.com:443", "bank.example.com.",
    "*.com", "localhost", "*", "*.", "**.example.com", "a.*.example.com", "-bank.example.com", "bank-.example.com",
    "bank..example.com", "bänk.example.com", "bank.example.com\\", "`x`.example.com", "${x}.example.com", "",
    `${"a".repeat(64)}.example.com`, `${"a.".repeat(130)}example`,
  ];
  for (const s of evil) assert.throws(() => checkSite(s), /is not a hostname/, `accepted ${JSON.stringify(s)}`);
  for (const s of [1, null, undefined, {}, ["bank.example.com"]]) assert.throws(() => checkSite(s), /must be a string/);
  assert.throws(() => pac(['bank.example.com"]; x = ["']), /is not a hostname/, "pac() checks the sites itself");
  assert.throws(() => checkSites("bank.example.com"), /must be a list/);
  assert.throws(() => checkSites(Array.from({ length: MAX_SITES + 1 }, (_, i) => `s${i}.example.com`)), /at most/);
});

test("egress: good sites are lowercased and de-duplicated; punycode and digits are hostnames", () => {
  assert.deepEqual(checkSites(["Bank.Example.com", "bank.example.com", "*.xn--bcher-kva.example", "1.2.example"]),
    ["bank.example.com", "*.xn--bcher-kva.example", "1.2.example"]);
});

test("egress: the proxy address is checked too, whatever sets it", t => {
  const prev = process.env.VYRE_EGRESS_PROXY;
  t.after(() => { if (prev === undefined) delete process.env.VYRE_EGRESS_PROXY; else process.env.VYRE_EGRESS_PROXY = prev; });
  delete process.env.VYRE_EGRESS_PROXY;
  assert.equal(proxy(), "egress:1055");
  process.env.VYRE_EGRESS_PROXY = 'egress:1055"; x';
  assert.throws(() => proxy(), /not a host:port/);
  process.env.VYRE_EGRESS_PROXY = "egress:70000";
  assert.throws(() => proxy(), /not a host:port/);
  assert.throws(() => pac(["bank.example.com"], "egress:1055 DIRECT"), /not a host:port/);
});

test("egress: a computer's env carries the PAC only when the setting is on and lists a site", () => {
  assert.deepEqual(chromeEnv(undefined), {}, "off by default");
  assert.deepEqual(chromeEnv({}), {});
  assert.deepEqual(chromeEnv({ enabled: false, sites: ["bank.example.com"] }), {});
  assert.deepEqual(chromeEnv({ enabled: "true", sites: ["bank.example.com"] }), {}, "only exactly true turns it on");
  assert.deepEqual(chromeEnv({ enabled: true, sites: [] }), {});
  const env = chromeEnv({ enabled: true, sites: ["bank.example.com"] });
  assert.deepEqual(Object.keys(env), ["VYRE_PROXY_PAC"]);
  assert.equal(env.VYRE_PROXY_PAC, pacUrl(["bank.example.com"]));
  // The shape entrypoint.sh checks before handing it to Chrome.
  assert.match(env.VYRE_PROXY_PAC, /^data:application\/x-ns-proxy-autoconfig;base64,[A-Za-z0-9+/]+=*$/);
  assert.throws(() => chromeEnv({ enabled: true, sites: ["bank example.com"] }), /is not a hostname/, "a bad list fails closed");
  assert.deepEqual(setting({ enabled: true }), { enabled: true, sites: [] });
});

test("egress: probe says no, quickly, when nothing answers", async () => {
  const net = await import("node:net");
  const srv = net.createServer();
  await new Promise(r => srv.listen(0, "127.0.0.1", () => r(undefined)));
  const port = /** @type {any} */ (srv.address()).port;
  await new Promise(r => srv.close(() => r(undefined)));
  const r = await probe(`127.0.0.1:${port}`, 500);
  assert.equal(r.answers, false);
  assert.ok(r.why);
});
