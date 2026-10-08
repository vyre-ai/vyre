import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { moduleHost, originFor, rewriteLocation, keepCookies, cookieHeader, createTickets, ENTER } from "./proxy.js";

test("a host under an app's name splits into the app and the host Vyre is served at; anything else is not an app's", () => {
  assert.deepEqual(moduleHost("docuseal.acme.vyre.run"), { name: "docuseal", base: "acme.vyre.run" });
  assert.deepEqual(moduleHost("DocuSeal.localhost:8080"), { name: "docuseal", base: "localhost:8080" });
  for (const h of ["localhost:8080", "127.0.0.1:80", "", "x.y", "1abc.example.com", "docu_seal.example.com"]) assert.equal(moduleHost(h), null, h);
  assert.deepEqual(moduleHost("acme.vyre.run"), { name: "acme", base: "vyre.run" }, "any host with a first label looks like one; whether an app of that name is installed decides");
});

test("the app's origin is https on a real host and http on localhost", () => {
  assert.equal(originFor("docuseal", "acme.vyre.run"), "https://docuseal.acme.vyre.run");
  assert.equal(originFor("docuseal", "localhost:8080"), "http://docuseal.localhost:8080");
  assert.equal(originFor("docuseal", "https://acme.vyre.run"), "https://docuseal.acme.vyre.run");
});

test("a redirect to the app's own address is put back on the origin the person is on; another host is left alone", () => {
  const o = ["http://127.0.0.1:4000", "http://localhost:3000"], here = "https://docuseal.acme.vyre.run";
  assert.equal(rewriteLocation("http://127.0.0.1:4000/templates/1?a=1", o, here), "https://docuseal.acme.vyre.run/templates/1?a=1");
  assert.equal(rewriteLocation("http://localhost:3000", o, here), here);
  assert.equal(rewriteLocation("/dashboard", o, here), "/dashboard");
  assert.equal(rewriteLocation("https://elsewhere.example/x", o, here), "https://elsewhere.example/x");
  assert.equal(rewriteLocation("http://localhost:30001/x", o, here), "http://localhost:30001/x", "a different port is a different origin");
});

test("the app's cookies are kept in a jar and removed when it expires them", () => {
  const jar = new Map();
  keepCookies(jar, ["_s=abc; path=/; HttpOnly", "other=1; Max-Age=3600"]);
  assert.equal(cookieHeader(jar), "_s=abc; other=1");
  keepCookies(jar, ["other=; Max-Age=0; path=/"]);
  keepCookies(jar, ["_s=zzz; Expires=Wed, 21 Oct 2015 07:28:00 GMT"]);
  assert.equal(cookieHeader(jar), "");
});

test("a ticket is good once, for a minute, only at the host it was made for; its session only for that app at that host", () => {
  let t = 1000;
  const k = createTickets({ now: () => t });
  const a = k.issue("docuseal", "docuseal.acme.vyre.run", "/templates");
  assert.equal(k.trade(a, "docuseal.other.example"), null, "another host cannot spend it");
  assert.equal(k.trade(a, "docuseal.acme.vyre.run"), null, "and a spent or wrong-host ticket is gone");
  const b = k.issue("docuseal", "docuseal.acme.vyre.run", "/templates");
  const got = k.trade(b, "docuseal.acme.vyre.run");
  assert.equal(got.next, "/templates");
  assert.equal(k.trade(b, "docuseal.acme.vyre.run"), null, "once");
  assert.equal(k.valid(got.sid, "docuseal", "docuseal.acme.vyre.run"), true);
  assert.equal(k.valid(got.sid, "other", "docuseal.acme.vyre.run"), false);
  assert.equal(k.valid(got.sid, "docuseal", "docuseal.evil.example"), false);
  assert.equal(k.valid(undefined, "docuseal", "docuseal.acme.vyre.run"), false);
  const c = k.issue("docuseal", "h.x", "/"); t += 61_000;
  assert.equal(k.trade(c, "h.x"), null, "a minute is all it gets");
  t += 9 * 3_600_000;
  assert.equal(k.valid(got.sid, "docuseal", "docuseal.acme.vyre.run"), false, "a session ends");
  const d = k.issue("docuseal", "h.x", "/"); const s = k.trade(d, "h.x"); k.drop("docuseal");
  assert.equal(k.valid(s.sid, "docuseal", "h.x"), false, "removing the app ends its sessions");
  assert.equal(ENTER, "/__vyre/enter");
});
