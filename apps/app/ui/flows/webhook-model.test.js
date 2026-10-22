import "../../../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { addressFacts, lastWords, curlSample, formSample, sizeWords } from "./webhook-model.js";

const URL1 = "https://team.example/hooks/orders-" + "a".repeat(64);
const hook = (o = {}) => ({ open: true, address: { path: "/hooks/orders-" + "a".repeat(64), url: URL1 }, why: null, last: null, check: null, ...o });

test("an open address reachable from the internet is the one address to copy", () => {
  assert.deepEqual(addressFacts(hook()), { state: "live", address: URL1, line: "" });
});

test("an address the internet cannot reach yet says why in one plain line, and the path is what you copy", () => {
  const f = addressFacts(hook({ address: { path: "/hooks/orders-x", url: null }, why: "The public address is not up yet. Senders on the internet reach it once the server has its public address." }));
  assert.equal(f.state, "here");
  assert.equal(f.address, "/hooks/orders-x");
  assert.match(f.line, /not up yet/);
  assert.equal(addressFacts(hook({ open: false, address: null, why: null })).state, "off");
  assert.match(addressFacts(hook({ open: false, address: null, why: null })).line, /Turn the Flow on/);
  assert.equal(addressFacts(null).state, "none");
});

test("the last delivery is when, OK or refused and why, and its size; never more", () => {
  assert.equal(lastWords(null), "Nothing has arrived yet.");
  assert.equal(lastWords({ when: "Today 10:05", ok: true, bytes: 2048 }), "Today 10:05: OK. 2.0 KB.");
  assert.equal(lastWords({ when: "Today 10:06", ok: false, why: "the token does not match", bytes: 210 }), "Today 10:06: refused, the token does not match. 210 bytes.");
  assert.equal(lastWords({ ok: true, test: true, bytes: 70 }), "the test from Vyre, OK. 70 bytes.");
  assert.equal(sizeWords(300 * 1024), "300 KB");
});

test("the samples post JSON or a form to the address, and need nothing else", () => {
  assert.match(curlSample(URL1), /^curl -X POST 'https:\/\/team\.example\/hooks\/orders-a+' -H 'content-type: application\/json'/);
  assert.match(formSample(URL1), /<form method="post" action="https:\/\/team\.example\/hooks\/orders-a+">/);
});

test("the trigger editor offers one address, Copy, Send a test, the last delivery and the signature check under Advanced", async () => {
  const fs = await import("node:fs");
  const src = fs.readFileSync(new URL("./WebhookFields.tsx", import.meta.url), "utf8");
  for (const words of ["Send a test", "Get a new address", "Advanced, verify a signature", "Last delivery", "CodeBlock"]) assert.ok(src.includes(words), words);
  assert.match(src, /f\.address \?/, "the address is shown with Copy whenever there is one, including a path with no public url");
  assert.doesNotMatch(src, /Open the route|Turn the listener on/, "no separate steps to open a route or turn the listener on");
});
