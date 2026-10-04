// @ts-check
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { addDomain, verifyDomain, removeDomain, challengeOf, forCaddy, rebind, DEFAULT_LIMITS } from "./domains.js";
import { normalizeHost } from "./hostname.js";
import { SPACE } from "./test-kit.js";

const A = "dep_0123456789abcdef", B = "dep_fedcba9876543210";
const rnd = (/** @type {number} */ seed = 1) => (/** @type {number} */ n) => Uint8Array.from({ length: n }, (_, i) => (seed * 17 + i * 13) % 256);
const throwsCode = (/** @type {() => any} */ fn, /** @type {string} */ code) => assert.throws(fn, (/** @type {any} */ e) => e.code === code, code);
const add = (/** @type {string} */ host, existing = /** @type {any[]} */ ([]), extra = {}) => addDomain({ host, space: SPACE.id, deployment: A }, { existing, now: 1000, random: rnd(), ...extra });

test("hostname validation accepts plain public names and normalises case", () => {
  assert.equal(normalizeHost("Harlow-Bakery.COM").ascii, "harlow-bakery.com");
  assert.equal(normalizeHost("shop.harlow-bakery.com").labels.length, 3);
  assert.equal(normalizeHost("northwind.vyre.run").vyre_run, true);
  assert.equal(normalizeHost("bäckerei.de").ascii, "xn--bckerei-5wa.de");
  assert.equal(normalizeHost("xn--bckerei-5wa.de").unicode, "bäckerei.de");
});

test("hostname validation refuses wildcards, IPs, internal names, bad shapes and tricks", () => {
  const bad = [
    "*.example.com", "*", "example.*", "127.0.0.1", "10.0.0.1", "1.2.3.4", "0x7f.0.0.1", "2130706433", "[::1]", "::1", "localhost", "a.localhost", "printer.local", "db.internal", "nas.lan", "x.corp", "a.test", "a.example", "a.invalid", "x.onion",
    "singlelabel", "", " ", "a.com ", " a.com", "a b.com", "a.com.", "-a.com", "a-.com", "a..com", ".a.com", "a.c", "a_b.com", "a.com/x", "a.com\\x", "a.com?x=1", "a.com#x", "user@a.com", "a.com:443", "http://a.com", "a.com\n", "a.com\u0000", "a.com;b", "a.com'", "a.com|b", "a.com$x", "a.com%00", "a.com<b",
    "ab--cd.com", "a".repeat(64) + ".com", ("a".repeat(60) + ".").repeat(5) + "com", "vyre.run", "a.b.vyre.run", "www.vyre.run", "admin.vyre.run", "publish.vyre.run", "preview.vyre.run",
    "аpple.com", // a Cyrillic letter inside a Latin word
  ];
  const accepted = [];
  for (const h of bad) { try { accepted.push(h + " => " + normalizeHost(h).ascii); } catch (e) { assert.equal(/** @type {any} */ (e).code, "bad_domain", h); } }
  assert.deepEqual(accepted, []);
  throwsCode(() => normalizeHost(/** @type {any} */ (null)), "bad_domain");
  throwsCode(() => normalizeHost(/** @type {any} */ ({ toString: () => "a.com" })), "bad_domain");
});

test("addDomain returns a TXT challenge at _vyre-publish.<domain>, bound to space, deployment and host", () => {
  const { record, challenge } = add("harlow-bakery.com");
  assert.equal(challenge.type, "TXT");
  assert.equal(/** @type {any} */ (challenge).name, "_vyre-publish.harlow-bakery.com");
  assert.match(/** @type {any} */ (challenge).value, /^vyre-publish=[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{32}$/);
  assert.equal(record.status, "pending");
  assert.equal(record.method, "dns");
  assert.equal(record.expires_at, 1000 + DEFAULT_LIMITS.tokenTtlMs);
  const other = (/** @type {any} */ over) => /** @type {any} */ (challengeOf({ ...record, ...over })).value;
  const v = /** @type {any} */ (challenge).value;
  assert.notEqual(other({ space: "spc_zzzzzzzzzzzz" }), v);
  assert.notEqual(other({ bound_to: B }), v);
  assert.notEqual(other({ host: "other.com" }), v);
  assert.equal(other({}), v);
});

test("verifyDomain: no record, mismatch, match (chunked TXT), expiry; another deployment's token does not verify", async () => {
  const { record, challenge } = add("harlow-bakery.com");
  const value = /** @type {any} */ (challenge).value, name = /** @type {any} */ (challenge).name;
  const dnsOf = (/** @type {any} */ answers) => ({ resolveTxt: async (/** @type {string} */ n) => { assert.equal(n, name); if (answers === "err") throw new Error("ENOTFOUND"); return answers; } });
  assert.deepEqual((await verifyDomain(record, { dns: dnsOf("err"), now: 2000 })).reason, "no_record");
  assert.deepEqual((await verifyDomain(record, { dns: dnsOf([]), now: 2000 })).reason, "no_record");
  assert.deepEqual((await verifyDomain(record, { dns: dnsOf([["something else"]]), now: 2000 })).reason, "mismatch");
  const foreign = /** @type {any} */ (challengeOf({ ...record, bound_to: B })).value;
  assert.deepEqual((await verifyDomain(record, { dns: dnsOf([[foreign]]), now: 2000 })).reason, "mismatch");
  const ok = await verifyDomain(record, { dns: dnsOf([["x"], [value.slice(0, 10), value.slice(10)]]), now: 2000 });
  assert.equal(ok.verified, true);
  assert.equal(ok.record.status, "verified");
  assert.equal(ok.record.verified_at, 2000);
  assert.equal((await verifyDomain(record, { dns: dnsOf([[value]]), now: /** @type {number} */ (record.expires_at) + 1 })).reason, "expired");
  assert.equal((await verifyDomain(ok.record, { dns: dnsOf("err"), now: 9 })).verified, true);
  assert.equal(record.status, "pending");
});

test("a vyre.run label verifies through the names directory, not DNS", async () => {
  const { record, challenge } = add("northwind.vyre.run");
  assert.deepEqual(challenge, { type: "names", host: "northwind.vyre.run" });
  const dns = { resolveTxt: async () => { throw new Error("never"); } };
  assert.equal((await verifyDomain(record, { dns, now: 1, names: { owns: async () => false } })).reason, "not_owner");
  assert.equal((await verifyDomain(record, { dns, now: 1 })).reason, "not_owner");
  assert.equal((await verifyDomain(record, { dns, now: 1, names: { owns: async (h, s) => h === "northwind.vyre.run" && s === SPACE.id } })).verified, true);
});

test("per-space limits and duplicates", () => {
  const list = [];
  for (let i = 0; i < DEFAULT_LIMITS.perSpace; i++) list.push({ ...add(`site${i}.example.com`).record, status: /** @type {const} */ ("verified") });
  throwsCode(() => add("one-more.example.com", list), "domain_limit");
  throwsCode(() => add("site0.example.com", list.slice(0, 3)), "domain_taken");
  const pending = [];
  for (let i = 0; i < DEFAULT_LIMITS.pendingPerSpace; i++) pending.push(add(`p${i}.example.com`).record);
  throwsCode(() => add("p9.example.com", pending), "domain_limit");
  throwsCode(() => add("example.com", [add("www.example.com").record]), "domain_taken");
  throwsCode(() => add("www.example.com", [add("example.com").record]), "domain_taken");
  assert.equal(add("a.example.com", list.slice(0, 2), { limits: { perSpace: 3 } }).record.host, "a.example.com");
  throwsCode(() => add("a.example.com", list.slice(0, 3), { limits: { perSpace: 3 } }), "domain_limit");
  throwsCode(() => addDomain({ host: "a.com", space: "bad", deployment: A }, { existing: [], now: 1, random: rnd() }), "bad_input");
});

test("removal, rebinding to a newer version, and only verified domains reach the Caddyfile", () => {
  const a = { ...add("harlow-bakery.com").record, status: /** @type {const} */ ("verified") }, b = add("pending.example.com").record;
  const left = removeDomain([a, b], "HARLOW-bakery.com");
  assert.deepEqual(left.map(r => r.host), ["pending.example.com"]);
  throwsCode(() => removeDomain([a], "nope.example.com"), "not_found");
  assert.deepEqual(forCaddy([a, b]), [{ host: "harlow-bakery.com", verified: true, deployment: A, canonical: null }]);
  const moved = rebind(a, B);
  assert.equal(moved.deployment, B);
  assert.equal(moved.bound_to, A);
  assert.equal(/** @type {any} */ (challengeOf(moved)).value, /** @type {any} */ (challengeOf(a)).value);
  throwsCode(() => rebind(a, "x"), "bad_input");
});
