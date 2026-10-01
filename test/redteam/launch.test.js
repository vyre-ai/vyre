// @ts-check
// Red-team refusals for launch's findings (0.2 PLAN row 12): each test ATTEMPTS the attack against the real code and
// asserts the refusal. Named "redteam <ID>: <attack> is refused". IDs: L-M1/L-1 (publish-release, release.json),
// M-S1 (staging overrides on the setup page), B4 (claim token), U (update request). Runs on runners and testbox:
// node --test "test/redteam/*.test.js". The update and publish-release attacks live in test/box-update.test.js
// (they need its fake docker box) and carry the same IDs in their names.
import { test } from "node:test";
import assert from "node:assert/strict";
import { setupOverrides } from "../../site/setup/config.js";
import { signClaim } from "../../site/setup/claim.js";

test("redteam M-S1: a /setup/config.json on the production origin changes nothing, whatever it says", () => {
  const evil = { relay: "wss://relay.vyre.run", installUrl: "https://vyre.run/evil.sh" };
  for (const host of ["vyre.run", "www.vyre.run", "VYRE.RUN", "Www.Vyre.Run"]) assert.deepEqual(setupOverrides(evil, host), {}, host);
});

test("redteam M-S1: lookalike, login-carrying, IP and plain-http overrides on a staging host are ignored", () => {
  const stage = "staging.vyre-site.pages.dev";
  const relays = ["ws://relay.vyre.run", "wss://relay.vyre.run.evil.example", "wss://evilvyre.run", "wss://relay.vyre.run@evil.example", "wss://evil.example/?x=.vyre.run",
    "ws://127.0.0.1.evil.example", "ws://localhost@evil.example", "wss://relay.vyre.run/path", "wss://1.2.3.4"];
  for (const relay of relays) assert.equal(setupOverrides({ relay }, stage).relay, undefined, relay);
  const urls = ["http://vyre.run/install.sh", "https://evil.example/install.sh", "https://vyre.run.evil.example/x", "https://user:pw@vyre.run/x", "https://vyre.run/x?a=1",
    "https://vyre.run/x#f", "https://1.2.3.4/x", "https://[::1]/x", "https://other.pages.dev/x", "http://localhost@evil.example/x", "http://127.0.0.1.evil.example/x", "javascript:alert(1)"];
  for (const installUrl of urls) assert.equal(setupOverrides({ installUrl }, stage).installUrl, undefined, installUrl);
  // And what is allowed still is.
  assert.equal(setupOverrides({ relay: "wss://relay.vyre.run" }, stage).relay, "wss://relay.vyre.run");
});

test("redteam B4: a claim token cannot be made for any host that is not one <name>.vyre.run, nor with a challenge of the wrong size", async () => {
  const { privateKey } = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const challenge = Buffer.alloc(32, 1).toString("base64url");
  const sign = (host, ch = challenge) => signClaim({ privateKey, route: "route-1", challenge: ch, host });
  assert.ok(await sign("harlow.vyre.run"));
  for (const host of ["vyre.run", "harlow.vyre.run.evil.example", "evil.example", "a.b.vyre.run", "HARLOW.vyre.run", "har_low.vyre.run", "-x.vyre.run", "x-.vyre.run",
    "harlow.vyre.run:8443", "user@harlow.vyre.run", "harlow.vyre.run/", "harlow.vyre.run\\nother.vyre.run", ""]) await assert.rejects(sign(host), /vyre\.run address/, JSON.stringify(host));
  for (const ch of [Buffer.alloc(31).toString("base64url"), Buffer.alloc(33).toString("base64url"), "", "not base64!"]) await assert.rejects(sign("harlow.vyre.run", ch), JSON.stringify(ch));
});

test("redteam B4: a token for one name does not verify for another, or for another route", async () => {
  const { privateKey, publicKey } = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const challenge = Buffer.alloc(32, 7);
  const token = Buffer.from(await signClaim({ privateKey, route: "route-1", challenge: challenge.toString("base64url"), host: "harlow.vyre.run" }), "base64url");
  assert.equal(token.length, 32 + 64);
  const msg = (route, host) => Buffer.concat([Buffer.from(`vyre-setup-claim\n${route}\n`), challenge, Buffer.from(`\n${host}`)]);
  const verify = (route, host) => crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, publicKey, token.subarray(32), msg(route, host));
  assert.equal(await verify("route-1", "harlow.vyre.run"), true);
  assert.equal(await verify("route-1", "other.vyre.run"), false);
  assert.equal(await verify("route-2", "harlow.vyre.run"), false);
});
