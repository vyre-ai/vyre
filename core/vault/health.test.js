// @ts-check
// Watchtower's rules and the breach check, without vyred. The breach check never reaches the
// network here: fetch is injected, and the test checks what would have been sent.

import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { judge, estimateBits, registrable, breachCheck, twofaDomains, passkeyDomains, WEAK_BITS, BREACH_URL } from "./health.js";

const NOW = Date.parse("2026-09-26T12:00:00Z");
const DAY = 86400_000;
const strong = () => crypto.randomBytes(18).toString("base64url");

test("health: the estimate calls common, short and patterned passwords weak and generated ones strong", () => {
  for (const pw of ["password1", "Summer2024!", "qwerty123", "aaaaaaaaaaaa", "abcdefgh", "P@ssw0rd!", "letmein", "12345678"]) {
    assert.ok(estimateBits(pw) < WEAK_BITS, `${pw.length}-char sample should be weak`);
  }
  for (let i = 0; i < 20; i++) assert.ok(estimateBits(strong()) >= WEAK_BITS, "a generated 24-char value is strong");
  assert.ok(estimateBits("vakemo-tirupa-sodega-lunefi-bazoku") >= WEAK_BITS, "a five-word passphrase is strong");
  assert.equal(estimateBits(""), 0);
});

test("health: registrable domains", () => {
  assert.equal(registrable("api.github.com"), "github.com");
  assert.equal(registrable("mail.example.co.uk"), "example.co.uk");
  assert.equal(registrable("example.com"), "example.com");
  assert.ok(twofaDomains().has("github.com"), "the bundled list loads");
  assert.ok(passkeyDomains().has("github.com"), "the bundled passkey list loads");
});

test("health: each rule, names and codes only", () => {
  const shared = strong();
  const canary = "canary-" + strong();
  const items = [
    { name: "weak-login", kind: "login", fields: { username: "alex", password: "Summer2024!" }, hosts: ["https://forum.acme.test"], updated: NOW - DAY },
    { name: "reuse-a", kind: "login", fields: { password: shared }, hosts: [], updated: NOW - DAY },
    { name: "reuse-b", kind: "secret", fields: { value: shared }, updated: NOW - DAY },
    { name: "old-key", kind: "api-key", fields: { value: strong() }, updated: NOW - 400 * DAY },
    { name: "marked", kind: "secret", fields: { value: strong() }, updated: NOW - DAY, rotate: "sealed to dana by p_1" },
    { name: "gh", kind: "login", fields: { password: canary }, hosts: ["https://github.com"], updated: NOW - DAY },
    { name: "gh-with-code", kind: "login", fields: { password: strong(), totp: "JBSWY3DPEHPK3PXP" }, url: "https://github.com/login", updated: NOW - DAY },
    { name: "agents-note", kind: "note", fields: { text: "fictional" }, updated: NOW - DAY, class: "agents" },
    { name: "fine", kind: "login", fields: { password: strong() }, updated: NOW - DAY },
  ];
  const out = judge(items, { now: NOW, classes: true });
  const by = Object.fromEntries(out.items.map(i => [i.name, i]));
  assert.deepEqual(by["weak-login"].reasons, ["weak"]);
  assert.deepEqual(by["reuse-a"].reasons, ["reused"]);
  assert.deepEqual(by["reuse-b"].reasons, ["reused"]);
  assert.equal(by["reuse-a"].group, by["reuse-b"].group);
  assert.match(by["reuse-a"].group, /^g\d+$/);
  assert.deepEqual(by["old-key"].reasons, ["old"]);
  assert.deepEqual(by["marked"].reasons, ["rotate"]);
  assert.deepEqual(by["gh"].reasons, ["2fa-available", "passkey-available"]);
  assert.deepEqual(by["gh-with-code"].reasons, ["passkey-available"], "a seed clears 2FA, but a passkey drops the password too");
  assert.deepEqual(by["agents-note"].reasons, ["unprotected"]);
  assert.equal(by["fine"], undefined);
  assert.equal(out.checked, items.length);
  assert.deepEqual(out.counts, { weak: 1, reused: 2, old: 1, rotate: 1, "2fa-available": 1, "passkey-available": 2, unprotected: 1, expired: 0, expiring: 0 });
  // Nothing but names, kinds, codes and group ids.
  const text = JSON.stringify(out);
  for (const it of items) for (const v of Object.values(it.fields)) assert.ok(!text.includes(v), "no value in the result");
  assert.ok(!text.includes("sealed to dana"), "the rotate reason text stays in vyre.db");
  assert.deepEqual(Object.keys(out.items[0]).sort(), ["kind", "name", "reasons"]);
  // Without classes, unprotected is never judged.
  assert.ok(!judge(items, { now: NOW }).items.some(i => i.reasons.includes("unprotected")));
});

test("health: reuse group ids change every run", () => {
  const v = strong();
  const items = [{ name: "a", kind: "secret", fields: { value: v }, updated: NOW }, { name: "b", kind: "secret", fields: { value: v }, updated: NOW }];
  assert.equal(judge(items, { now: NOW }).items[0].group, "g1", "ids are sequence numbers, not hashes");
});

test("breach: only 5-char prefixes leave, with padding, and matching is local", async () => {
  const canary = "canary-" + strong();
  const pw = "hunter2-fictional";
  const sha = s => crypto.createHash("sha1").update(s).digest("hex").toUpperCase();
  const calls = [];
  const fakeFetch = async (url, init) => {
    calls.push({ url: String(url), headers: init.headers });
    const prefix = String(url).slice(BREACH_URL.length);
    // The breached one's suffix, a padding row with count 0 for the canary, and noise.
    const rows = ["0000000000000000000000000000000000A:3"];
    if (prefix === sha(pw).slice(0, 5)) rows.push(sha(pw).slice(5) + ":42");
    if (prefix === sha(canary).slice(0, 5)) rows.push(sha(canary).slice(5) + ":0");
    return new Response(rows.join("\r\n"));
  };
  const out = await breachCheck([{ name: "old-forum", password: pw }, { name: "gh", password: canary }, { name: "empty", password: "" }], { fetch: /** @type {any} */ (fakeFetch) });
  assert.deepEqual(out.breached, ["old-forum"]);
  assert.equal(out.checked, 2);
  for (const c of calls) {
    assert.match(c.url, /^https:\/\/api\.pwnedpasswords\.com\/range\/[0-9A-F]{5}$/);
    assert.equal(c.headers["Add-Padding"], "true");
    assert.ok(!c.url.includes(sha(canary).slice(5)) && !c.url.includes(canary));
  }
  await assert.rejects(breachCheck([{ name: "x", password: "y" }], { fetch: /** @type {any} */ (async () => { throw new Error("offline"); }) }), /did not answer/);
});
