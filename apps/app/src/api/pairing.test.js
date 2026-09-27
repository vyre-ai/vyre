// @ts-check
// The pairing link's parsing (pairing.ts): the offer out of `vyre://pair?offer=...` however it was
// encoded, a stored pairing checked on load, and the relay base a request's proof ignores.

import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePairUrl } from "../../../../relay/client/client.js";

const strip = Boolean(/** @type {any} */ (process.features).typescript);
const load = () => import("./pairing.ts");

const b64 = (/** @type {object} */ o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const OFFER = "https://vyre.run/pair#" + b64({ v: 1, r: "wss://relay.example.net", i: "abcdefghijklmnopqrstuvwxyz", s: "one-time-secret", k: Buffer.alloc(32, 7).toString("base64url"), n: "Harlow Legal" });

test("pairing: the offer comes out of vyre://pair?offer= encoded once", { skip: !strip }, async () => {
  const { offerFrom } = await load();
  const got = offerFrom(`vyre://pair?offer=${encodeURIComponent(OFFER)}`);
  assert.equal(got, OFFER);
  assert.equal(parsePairUrl(/** @type {string} */ (got))?.name, "Harlow Legal", "relay/client reads what we hand it");
});

test("pairing: the web route, a bare value, extra params and an unencoded # all give the same offer", { skip: !strip }, async () => {
  const { offerFrom } = await load();
  assert.equal(offerFrom(`https://harlow.example.ts.net/app/pair?offer=${encodeURIComponent(OFFER)}`), OFFER);
  assert.equal(offerFrom(`vyre://pair?from=cli&offer=${encodeURIComponent(OFFER)}&x=1`), OFFER);
  assert.equal(offerFrom(encodeURIComponent(OFFER)), OFFER, "the router's param, still encoded");
  assert.equal(offerFrom(OFFER), OFFER, "the router's param, already decoded");
  assert.equal(offerFrom(`vyre://pair?offer=${OFFER}`), OFFER, "the # was not encoded: query and fragment join");
});

test("pairing: anything that is not an offer is null", { skip: !strip }, async () => {
  const { offerFrom } = await load();
  for (const bad of [null, undefined, "", "vyre://pair", "vyre://pair?offer=", "vyre://pair?offer=%E0%A4%A",
    `vyre://pair?offer=${encodeURIComponent("https://evil.example/pair#abc")}`, "vyre://pair?offer=https%3A%2F%2Fvyre.run%2Fpair",
    `vyre://pair?code=${encodeURIComponent(OFFER)}`]) {
    assert.equal(offerFrom(bad), null, String(bad));
  }
});

test("pairing: a stored pairing is checked on load, and the relay base carries the route", { skip: !strip }, async () => {
  const { readPairing, relayBase } = await load();
  const p = { relay: "wss://relay.example.net", route: "abcdefghijklmnopqrstuvwxyz", box: "Bw", name: "Harlow Legal", device: "dev1", presence: null };
  assert.deepEqual(readPairing(JSON.stringify(p)), p);
  assert.equal(readPairing("{"), null);
  assert.equal(readPairing(JSON.stringify({ ...p, relay: "https://relay.example.net" })), null);
  assert.equal(readPairing(null), null);
  assert.equal(relayBase(p), "https://relay.example.net/abcdefghijklmnopqrstuvwxyz");
  assert.equal(relayBase({ relay: "ws://127.0.0.1:9/", route: "r" }), "http://127.0.0.1:9/r");
});
