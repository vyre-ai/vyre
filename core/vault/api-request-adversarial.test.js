// @ts-check
// Allowlist bypass, tried the ways an injected agent or a hostile server would try: userinfo and
// parser tricks in the url, open redirects and redirects that change host or scheme, dot-segment
// and encoded-slash path tricks against a classification table, a leading-"*." host match, DNS
// that answers differently the second time, IPv4-mapped and other IPv6 forms, and decimal, hex and
// octal address hosts. The pure checks are exercised directly; the redirect and rebinding cases run
// the whole request path with a fake lookup and a fake transport, so nothing reaches a network.
// Every host is a .test name and every address is documentation-range or reserved.

import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { open, migrate } from "../store/index.js";
import { Vault, MIGRATIONS } from "./vault.js";
import { ApiRequests } from "./request.js";
import { checkTarget, hostAllowed, addressBlocked, normalize, buildUrl, checkHeaders, checkQuery, classify, pinnedOptions } from "./api-request.js";
import { SCRATCH } from "../../test/scratch.mjs";

const PUBLIC = "93.184.216.10";
const HOSTS = ["api.harlow.test"];
const lookup = async () => [{ address: PUBLIC, family: 4 }];
const target = (u, hosts = HOSTS, l = lookup) => checkTarget(u, hosts, { lookup: l });

test("userinfo and parser tricks: the host is what the url parser says it is, and userinfo is refused", async () => {
  // Userinfo, however it is spelled, is refused outright.
  for (const u of ["https://api.harlow.test@evil.test/", "https://api.harlow.test:pass@evil.test/", "https://user@api.harlow.test/", "https://:x@api.harlow.test/", "https://api.harlow.test%40evil.test@evil.test/"])
    await assert.rejects(target(u), /user or password/, u);
  // Everything that only looks like the host but parses to another one is not allowed.
  for (const u of [
    "https://evil.test\\@api.harlow.test/", "https://evil.test#@api.harlow.test/", "https://evil.test?@api.harlow.test/", "https://evil.test/@api.harlow.test/",
    "https://api.harlow.test.evil.test/", "https://evilapi.harlow.test/", "https://api.harlow.test./", "https://api.harlow.test%2eevil.test/",
    "https://api.harlow.test。evil.test/", "https://аpi.harlow.test/", "https://api.harlow.test\t.evil.test/", "https://api.harlow.test\n.evil.test/",
    "https://evil.test:443@api.harlow.test.evil.test/", "https://api-harlow.test/", "https://xapi.harlow.test/", "https://harlow.test/",
  ]) await assert.rejects(target(u), /not on this credential's allowed hosts|user or password|valid address/, JSON.stringify(u));
  // The same host in another spelling is the same host, and is allowed.
  for (const u of ["https://API.HARLOW.TEST/v1", "HTTPS://api.harlow.test/v1", "https://api.harlow.test:443/v1", "https://api.harlow.test/v1?x=https://evil.test", "https://api.harlow.test/v1#https://evil.test"])
    assert.equal((await target(u)).url.hostname, "api.harlow.test", u);
  // Scheme tricks.
  for (const u of ["http://api.harlow.test/", "//api.harlow.test/x", "api.harlow.test/x", "javascript:alert(1)", "file:///etc/passwd", "ftp://api.harlow.test/", "wss://api.harlow.test/", "data:text/plain,x", ""])
    await assert.rejects(target(u), /https|valid address/, JSON.stringify(u));
  // Ports: only the https port.
  for (const u of ["https://api.harlow.test:8443/", "https://api.harlow.test:80/", "https://api.harlow.test:0/", "https://api.harlow.test:65535/"]) await assert.rejects(target(u), /https port/, u);
});

test("path tricks: a url is classified by the path the server will see, and an encoded slash is refused", async () => {
  // Dot segments, plain or percent-encoded, are resolved before anything is classified.
  assert.equal((await target("https://api.harlow.test/v1/search/../delete")).url.pathname, "/v1/delete");
  assert.equal((await target("https://api.harlow.test/v1/search/%2e%2e/delete")).url.pathname, "/v1/delete");
  assert.equal((await target("https://api.harlow.test/v1/search/%2E%2E/delete")).url.pathname, "/v1/delete");
  assert.equal((await target("https://api.harlow.test/v1/search/.%2e/delete")).url.pathname, "/v1/delete");
  assert.equal((await target("https://api.harlow.test/v1/search/..\\delete")).url.pathname, "/v1/delete", "a backslash is a slash to the parser");
  // What a parser leaves encoded, a server may decode: refused, not classified.
  for (const u of ["https://api.harlow.test/v1/search/..%2fdelete", "https://api.harlow.test/v1/search/..%2Fdelete", "https://api.harlow.test/v1%2fsearch/x", "https://api.harlow.test/v1/search%5cdelete", "https://api.harlow.test/v1/x%00y"])
    await assert.rejects(target(u), /encoded slash, a backslash or a null/, u);

  // A table that calls one search path a read cannot be walked out of with dots.
  const endpoints = [{ method: "POST", path: "/v1/search/*", kind: "read" }];
  const kind = async (method, u) => { const t = await target(u); return classify(method, t.url.pathname + t.url.search, endpoints).kind; };
  assert.equal(await kind("POST", "https://api.harlow.test/v1/search/people"), "read");
  assert.equal(await kind("POST", "https://api.harlow.test/v1/search/../delete"), "send");
  assert.equal(await kind("POST", "https://api.harlow.test/v1/search/x/../../admin/users"), "send");
  assert.equal(await kind("POST", "https://api.harlow.test/v1/search/%2e%2e/%2e%2e/admin"), "send");
  assert.equal(await kind("POST", "https://api.harlow.test/V1/search/people"), "send", "paths are case-sensitive; an unlisted spelling is outward");
  assert.equal(await kind("DELETE", "https://api.harlow.test/v1/search/people"), "send", "the method is part of the match");
  // A preset write is not hidden by dots, a query or a case change.
  assert.equal(await kind("POST", "https://api.harlow.test/v1.0/me/x/../sendMail"), "send");
  assert.equal(classify("POST", "/v1.0/me/sendMail?x=/../", []).kind, "send");
  assert.equal(classify("POST", "/v1.0/me/SENDMAIL", []).kind, "send", "default for a non-read is outward");
  assert.equal(classify("PUT", "/gmail/v1/users/me/messages/send", []).kind, "send");
  assert.equal(classify("PATCH", "/v1/charges", []).kind, "send");

  // A read cannot be turned into a write by naming another method.
  for (const h of ["X-HTTP-Method-Override", "x-http-method", "X-Method-Override"]) assert.throws(() => checkHeaders({ [h]: "DELETE" }), /set by the credential or the connection/, h);
  for (const q of ["_method=DELETE", "_METHOD=PUT", "x-http-method-override=DELETE", "$httpMethod=DELETE", "_httpMethod=PATCH"])
    assert.throws(() => checkQuery(new URL(`https://api.harlow.test/v1/x?${q}`)), /another method/, q);
  assert.throws(() => checkQuery(new URL(buildUrl("https://api.harlow.test/v1/x", { _method: "DELETE" }))), /another method/);
  checkQuery(new URL("https://api.harlow.test/v1/x?method=get&q=_method"));
});

test("a leading *. matches exactly one real label, never the bare domain, a deeper name, a lookalike or a literal star", () => {
  const W = ["*.harlow.test"];
  for (const h of ["files.harlow.test", "a1.harlow.test", "xn--fiels-jua.harlow.test", "a-b.harlow.test", "FILES.HARLOW.TEST"]) assert.ok(hostAllowed(h, W), h);
  for (const h of ["harlow.test", ".harlow.test", "a.b.harlow.test", "xharlow.test", "files-harlow.test", "files.harlow.test.evil.test", "harlow.test.evil.test",
    "*.harlow.test", "_x.harlow.test", "a b.harlow.test", "-a.harlow.test", "a-.harlow.test", "a_b.harlow.test", "files.harlow.test.", "evil.test"]) assert.ok(!hostAllowed(h, W), h);
  // An exact entry is exact.
  assert.ok(hostAllowed("api.harlow.test", ["api.harlow.test"]));
  for (const h of ["x.api.harlow.test", "api.harlow.test.", "API2.harlow.test", "api.harlow.test.evil.test"]) assert.ok(!hostAllowed(h, ["api.harlow.test"]), h);
  // The stored allowlist is bounded: a wildcard on a shared domain, a bare star, two stars, a middle star, a port or a scheme are not entries.
  for (const h of ["*.googleapis.com", "*", "**.harlow.test", "*.*.harlow.test", "files.*.harlow.test", "*harlow.test", "api.harlow.test:443", "https://api.harlow.test", "api.harlow.test/", "*.com", "a", ""])
    assert.throws(() => normalize({ auth: { type: "bearer" }, hosts: [h] }), /is not a host|wildcard on a domain/, JSON.stringify(h));
  // ...and an address is never an entry, whatever it is written as.
  for (const h of ["127.0.0.1", "0177.0.0.1", "0x7f.0.0.1", "127.1", "2130706433", "169.254.169.254", "100.100.100.200", "[::1]", "::1", "[::ffff:127.0.0.1]"])
    assert.throws(() => normalize({ auth: { type: "bearer" }, hosts: [h] }), /is not a host/, h);
});

test("IPv4-mapped and other IPv6 forms cannot carry a blocked IPv4 address past the check", () => {
  const blocked = [
    // mapped, dotted and hex, any case, with and without zeros written out
    "::ffff:127.0.0.1", "::FFFF:127.0.0.1", "::ffff:7f00:1", "::ffff:7f00:0001", "0:0:0:0:0:ffff:127.0.0.1", "0:0:0:0:0:ffff:7f00:1", "0000:0000:0000:0000:0000:ffff:7f00:0001",
    "::ffff:169.254.169.254", "::ffff:a9fe:a9fe", "::ffff:10.0.0.1", "::ffff:a00:1", "::ffff:192.168.1.1", "::ffff:c0a8:101", "::ffff:100.64.0.1", "::ffff:6440:1", "::ffff:0.0.0.0",
    // compatible, NAT64 and 6to4 forms of a blocked address
    "::127.0.0.1", "::7f00:1", "64:ff9b::7f00:1", "64:ff9b::127.0.0.1", "64:ff9b::a9fe:a9fe", "2002:7f00:1::", "2002:7f00:0001::1", "2002:a9fe:a9fe::1", "2002:a00:1::",
    // the native ranges
    "::", "::1", "0:0:0:0:0:0:0:1", "fe80::1", "fe80::1%eth0", "febf::1", "fec0::1", "fc00::1", "fd00::1", "fd00:ec2::254", "ff02::1", "2001::1", "2001:0:4136:e378::1", "2001:db8::1", "100::1",
    // not addresses at all
    "::gggg", ":::", "1:2:3:4:5:6:7:8:9", "1::2::3", "", "not-an-ip", "12345::1",
  ];
  for (const ip of blocked) assert.ok(addressBlocked(ip), `${JSON.stringify(ip)} must be blocked`);
  const fine = ["::ffff:8.8.8.8", "::ffff:808:808", "64:ff9b::808:808", "2002:808:808::1", "2606:4700:4700::1111", "2a00:1450:4001:81b::200e", "8.8.8.8", "142.250.80.46", "93.184.216.10"];
  for (const ip of fine) assert.ok(!addressBlocked(ip), `${ip} is a public address`);
  // The parser itself.
});

test("decimal, hex and octal address hosts are not the credential's host, and a resolver answering in those forms is refused", async () => {
  for (const u of ["https://2130706433/", "https://0x7f000001/", "https://0x7f.1/", "https://0177.0.0.1/", "https://127.1/", "https://127.0.0.1/", "https://[::1]/", "https://[::ffff:127.0.0.1]/",
    "https://[::ffff:7f00:1]/", "https://169.254.169.254/latest/meta-data/", "https://0xa9fea9fe/", "https://2852039166/", "https://100.100.100.200/", "https://[fd00:ec2::254]/", "https://0/", "https://0.0.0.0/"])
    await assert.rejects(target(u), /not on this credential's allowed hosts/, u);
  // The address check stands on its own: even a host entry that named an address is refused once it resolves to one.
  await assert.rejects(target("https://127.0.0.1/", ["127.0.0.1"], async () => [{ address: "127.0.0.1", family: 4 }]), /may never reach/);
  await assert.rejects(target("https://[::1]/", ["[::1]"], async () => [{ address: "::1", family: 6 }]), /may never reach/);
  // A lookup that answers with something that is not a clean address is refused too.
  for (const address of ["2130706433", "0x7f000001", "0177.0.0.1", "127.1", "0", "1.2.3", "1.2.3.4.5", "256.1.1.1", "localhost", "", "::ffff:7f00:1"])
    await assert.rejects(target("https://api.harlow.test/", HOSTS, async () => [{ address, family: 4 }]), /may never reach/, JSON.stringify(address));
  // No answer, an error, and one bad answer among good ones.
  await assert.rejects(target("https://api.harlow.test/", HOSTS, async () => []), /resolved to no address/);
  await assert.rejects(target("https://api.harlow.test/", HOSTS, async () => { throw new Error("SERVFAIL"); }), /could not be resolved/);
  await assert.rejects(target("https://api.harlow.test/", HOSTS, async () => [{ address: PUBLIC, family: 4 }, { address: "::ffff:169.254.169.254", family: 6 }]), /may never reach/);
});

test("the connection is pinned to the validated address, with the url's own name for Host and TLS", () => {
  const url = new URL("https://api.harlow.test/v1/x?a=1");
  const o = pinnedOptions(url, PUBLIC, { method: "POST", headers: { "x-a": "1" } });
  assert.equal(o.hostname, "api.harlow.test");
  assert.equal(o.servername, "api.harlow.test", "the certificate is checked for the name the credential allows");
  assert.equal(o.headers.host, "api.harlow.test");
  assert.equal(o.port, 443);
  assert.equal(o.path, "/v1/x?a=1");
  assert.equal(o.agent, false, "no pooled connection to somewhere else");
  // Whatever the socket layer asks the lookup, in either shape, it gets the validated address.
  let got;
  o.lookup("api.harlow.test", {}, (...a) => { got = a; });
  assert.deepEqual(got, [null, PUBLIC, 4]);
  o.lookup("rebound.evil.test", { all: true }, (...a) => { got = a; });
  assert.deepEqual(got, [null, [{ address: PUBLIC, family: 4 }]], "even a different name gets the validated address, never a new lookup");
  o.lookup("x", { all: false, family: 6 }, (...a) => { got = a; });
  assert.equal(got[1], PUBLIC);
  let v6;
  pinnedOptions(url, "2606:4700:4700::1111").lookup("x", {}, (...a) => { v6 = a; });
  assert.deepEqual(v6, [null, "2606:4700:4700::1111", 6]);
});

// ---- the whole path, with a fake lookup and transport ----

async function mk(t, config = { auth: { type: "bearer" }, hosts: ["api.harlow.test", "cdn.harlow.test"] }) {
  const home = fs.mkdtempSync(path.join(SCRATCH, "vyre-adv-"));
  const db = open(path.join(home, "vyre.db"));
  migrate(db, "vault", MIGRATIONS);
  const v = new Vault({ db, dir: path.join(home, "vault"), config: { name: "harlow-box", vault: { keystore: "file" } }, emit: () => {}, log: () => {} });
  t.after(() => { db.close(); fs.rmSync(home, { recursive: true, force: true }); });
  await v.put({ name: "harlow-api", kind: "api-credential", fields: { config: JSON.stringify(config), secret: "fixture-secret-adversarial-0001" } }, "cli");
  const net = { calls: /** @type {any[]} */ ([]), lookups: /** @type {string[]} */ ([]), script: /** @type {(r: any) => any} */ (() => ({ status: 200, headers: { "content-type": "text/plain" }, body: Buffer.from("ok") })) };
  const state = { answer: /** @type {(host: string, n: number) => string} */ (() => PUBLIC), multi: /** @type {string[]|null} */ (null) };
  const api = new ApiRequests(v, {
    lookup: async host => {
      net.lookups.push(host);
      return (state.multi || [state.answer(host, net.lookups.length)]).map(address => ({ address, family: address.includes(":") ? 6 : 4 }));
    },
    transport: async r => { net.calls.push({ host: r.url.hostname, path: r.url.pathname, address: r.address, headers: r.headers }); return net.script(r); },
  });
  const get = (u, extra = {}) => api.request({ credential: "harlow-api", method: "GET", url: u, ...extra }, { caller: "cli" });
  return { v, api, net, state, get };
}
const redirect = (location, status = 302) => ({ status, headers: { location }, body: Buffer.alloc(0) });

test("open redirects: the response of an allowed host cannot send the credential anywhere else", async t => {
  const { net, get } = await mk(t);
  const cases = [
    "https://evil.test/steal", "//evil.test/steal", "/\\evil.test/steal", "https://api.harlow.test.evil.test/", "https://api.harlow.test@evil.test/", "https://cdn.harlow.test/x",
    "http://169.254.169.254/latest/meta-data/", "https://[::1]/", "https://2130706433/", "https://evil.test:443/", "//cdn.harlow.test/x", "\\\\evil.test\\x",
  ];
  for (const location of cases) {
    net.calls.length = 0;
    net.script = () => redirect(location);
    await assert.rejects(get("https://api.harlow.test/go?url=" + encodeURIComponent(location)), /redirected to another host|not an address/, location);
    assert.deepEqual(net.calls.map(c => c.host), ["api.harlow.test"], `nothing was sent to ${location}`);
  }
  // A downgrade or another port on the same host is refused at the hop, before anything is sent.
  for (const location of ["http://api.harlow.test/x", "https://api.harlow.test:8443/x", "ftp://api.harlow.test/x"]) {
    net.calls.length = 0;
    net.script = () => redirect(location);
    await assert.rejects(get("https://api.harlow.test/go"), /https|redirected|valid/, location);
    assert.equal(net.calls.length, 1, `only the first hop went out for ${location}`);
  }
  // A redirect with no usable Location is just a response.
  net.script = () => ({ status: 302, headers: {}, body: Buffer.from("moved") });
  assert.equal((await get("https://api.harlow.test/go")).status, 302);
});

test("redirect then recheck: every hop is checked as the first was, and a chain stops", async t => {
  const { net, state, get } = await mk(t);
  // Hop by hop on the same host, each re-resolved and re-validated.
  net.script = r => (r.url.pathname === "/a" ? redirect("/b") : r.url.pathname === "/b" ? redirect("/c") : { status: 200, headers: { "content-type": "text/plain" }, body: Buffer.from("done") });
  assert.equal((await get("https://api.harlow.test/a")).body, "done");
  assert.deepEqual(net.calls.map(c => c.path), ["/a", "/b", "/c"]);
  assert.ok(net.lookups.length >= 4, "planned once, then checked at connect time for each of three hops");
  // The name turns private on the second hop: refused there, and the third hop never happens.
  net.calls.length = 0; net.lookups.length = 0;
  state.answer = (_h, n) => (n <= 2 ? PUBLIC : "10.1.2.3");
  await assert.rejects(get("https://api.harlow.test/a"), /may never reach/);
  assert.deepEqual(net.calls.map(c => c.path), ["/a"]);
  // A chain that never ends.
  state.answer = () => PUBLIC;
  net.script = () => redirect("/again");
  await assert.rejects(get("https://api.harlow.test/x"), /more than five times/);
});

test("rebinding: an address is validated and then used, never looked up a second time between the two", async t => {
  const { net, state, get } = await mk(t);
  // The plan check sees a public address; the connect-time check sees a private one. Refused, and nothing connects.
  state.answer = (_h, n) => (n === 1 ? PUBLIC : "127.0.0.1");
  await assert.rejects(get("https://api.harlow.test/v1"), /may never reach/);
  assert.equal(net.calls.length, 0);
  // Both public but different: the transport gets exactly the address the connect-time check validated.
  net.lookups.length = 0;
  state.answer = (_h, n) => (n === 1 ? "93.184.216.1" : "93.184.216.2");
  await get("https://api.harlow.test/v1");
  assert.deepEqual(net.calls.map(c => c.address), ["93.184.216.2"]);
  assert.equal(net.lookups.length, 2, "one lookup to plan, one to connect; none after the address was chosen");
  // A round-robin answer with a private address anywhere in it is refused, whichever turn it takes.
  for (const set of [["93.184.216.1", "10.0.0.9"], ["10.0.0.9", "93.184.216.1"], ["::ffff:10.0.0.9", "93.184.216.1"], ["93.184.216.1", "93.184.216.2", "169.254.169.254"]]) {
    net.calls.length = 0;
    state.multi = set;
    await assert.rejects(get("https://api.harlow.test/v1"), /may never reach/, set.join(" "));
    assert.equal(net.calls.length, 0);
  }
  state.multi = null;
});

test("the credential never travels: no request to another host carries it, and a caller cannot bring its own authentication", async t => {
  const { net, get } = await mk(t);
  net.script = () => redirect("https://cdn.harlow.test/x");
  await assert.rejects(get("https://api.harlow.test/x"), /redirected to another host/);
  assert.ok(net.calls.every(c => c.host === "api.harlow.test"));
  // A caller cannot bring its own authentication to a host the credential names.
  for (const h of ["Authorization", "authorization", "AUTHORIZATION", "Proxy-Authorization", "Cookie", "Host", "host"]) await assert.rejects(get("https://api.harlow.test/x", { headers: { [h]: "x" } }), /set by the credential or the connection/, h);
});
