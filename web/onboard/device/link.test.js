// @ts-check
// The pure parts of /onboard/device (ADR 0018 section 3): reading the app's link, refusing any
// return but vyre://, and the exact presence.enroll input the proof is bound to.

import "../../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { parseLink, enrollInput, returnUrl } from "./link.js";

const KEY = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" }).publicKey.export({ format: "der", type: "spki" }).toString("base64url");
const hash = params => "#" + new URLSearchParams(params).toString();

test("device link: the hash gives the key, the device name and the vyre return", () => {
  assert.deepEqual(parseLink(hash({ k: KEY, n: "alex-phone", r: "vyre" })), { ok: true, publicKey: KEY, name: "alex-phone" });
  assert.deepEqual(parseLink(hash({ k: KEY, n: "Alex's iPhone 16", r: "vyre" })).name, "Alex's iPhone 16");
  assert.equal(parseLink(hash({ k: KEY, n: "a\u0000b‮c  d", r: "vyre" })).name, "a b c d", "control and bidi characters go");
  assert.equal(parseLink(hash({ k: KEY, n: "x".repeat(200), r: "vyre" })).name.length, 80);
  assert.equal(parseLink(hash({ k: KEY, r: "vyre" })).name, "This phone", "no name, a plain one");
});

test("device link: any return but exactly vyre is refused, and so is a missing or odd key", () => {
  for (const r of [undefined, "", "VYRE", "vyre:", "vyre://", "https", "javascript", "vyre-evil", " vyre", "vyres"]) {
    const out = parseLink(hash({ k: KEY, n: "alex-phone", ...(r === undefined ? {} : { r }) }));
    assert.equal(out.ok, false, String(r));
    assert.equal(out.reason, "return", String(r));
  }
  for (const k of [undefined, "", "not base64url!", "a".repeat(20), "a".repeat(2000)]) {
    const out = parseLink(hash({ ...(k === undefined ? {} : { k }), n: "alex-phone", r: "vyre" }));
    assert.equal(out.ok, false, String(k));
    assert.equal(out.reason, "key", String(k));
  }
  assert.equal(parseLink("").ok, false);
  assert.equal(parseLink("#").ok, false);
});

test("device link: the enroll input is exactly what the proof is bound to", () => {
  assert.deepEqual(enrollInput({ publicKey: KEY, name: "alex-phone" }), { kind: "device", name: "alex-phone", public_key: KEY, alg: -7 });
  assert.deepEqual(Object.keys(enrollInput({ publicKey: KEY, name: "alex-phone" })), ["kind", "name", "public_key", "alg"]);
});

test("device link: the way back is always vyre://enrolled", () => {
  assert.equal(returnUrl({ id: "AbC-_1234567890123456789" }), "vyre://enrolled?id=AbC-_1234567890123456789");
  assert.equal(returnUrl({ error: "cancelled" }), "vyre://enrolled?error=cancelled");
  assert.equal(returnUrl({ id: "a&b=c" }), "vyre://enrolled?id=a%26b%3Dc");
});

test("device link: the page is its own index.html, with no inline script (CSP default-src self)", async () => {
  const fs = await import("node:fs");
  const html = fs.readFileSync(new URL("./index.html", import.meta.url), "utf8");
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];
  assert.ok(scripts.length >= 1);
  for (const [, attrs, body] of scripts) { assert.match(attrs, /src="\/onboard\/device\/device\.js"/); assert.equal(body.trim(), ""); }
  assert.doesNotMatch(html, /\son[a-z]+=/i, "no inline handlers");
});
