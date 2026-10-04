// @ts-check
import "../../scripts/test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { joinLink, joinTarget } from "./join-link.js";
import { cleanAddress, holdJoin, linkFromHash, takeJoin, withoutToken } from "./join-hold.js";

test("only an https join link of a space is passed on, encoded once or twice", () => {
  const good = "https://harlow.vyre.run/join/7Kq2-M9";
  assert.equal(joinLink(good), good);
  assert.equal(joinLink(encodeURIComponent(good)), good);
  assert.equal(joinTarget(good), "/u/install/join", "the token is not in the address");
  assert.equal(takeJoin(0), good);
  for (const bad of ["http://harlow.vyre.run/join/x", "https://harlow.vyre.run/other/x", "javascript:alert(1)", "", undefined, "https://h.vyre.run/join/"]) assert.equal(joinLink(bad), null);
  assert.equal(joinTarget("nope"), "/u/install/join");
});

test("a real invite token is payload.signature, so a dot is part of it", () => {
  const real = "https://harlowdev.vyre.run/join/eyJ2IjoxLCJpZCI6Imludl9TekE2TjN3eEU5eFpSWktKIn0.c2lnLTEyMy1hYmM";
  assert.equal(joinLink(real), real);
  assert.equal(joinLink(encodeURIComponent(real)), real);
  assert.equal(joinLink("https://h.vyre.run/join/../x"), null);
});

test("JL-1: the token is held in memory once, never in the address, and never shown or logged whole", () => {
  const tok = "https://h.vyre.run/join/eyJ2IjoxfQ.c2ln";
  assert.equal(takeJoin(), null);
  holdJoin(tok);
  const t0 = 1_000_000;
  assert.equal(takeJoin(t0), tok);
  assert.equal(takeJoin(t0 + 50), tok, "the development double-run of an initialiser reads the same link");
  assert.equal(takeJoin(t0 + 5000), null, "a later read is empty");
  assert.equal(withoutToken(tok), "https://h.vyre.run/join/…");
  assert.ok(!withoutToken(tok).includes("eyJ"));
  assert.equal(cleanAddress("https://app.vyre.run/app/join?link=https%3A%2F%2Fh.vyre.run%2Fjoin%2Fx.y#frag"), "/app/join");
  assert.equal(joinTarget("nope"), "/u/install/join");
  assert.equal(takeJoin(), null, "a bad link holds nothing");
});

test("JL-2: a vyre:// open is untrusted: only an https join path of a space goes on, whatever host", () => {
  for (const bad of ["vyre://join?link=x", "https://evil.example/join/..%2f", "file:///join/a.b", "https://h.vyre.run/join/a b"]) assert.equal(joinLink(bad), null, bad);
});

test("JL-1 leftovers: a fragment carries the link without a server ever seeing it, and the install route's own query is dropped", () => {
  const tok = "https://h.vyre.run/join/eyJ2IjoxfQ.c2ln";
  assert.equal(linkFromHash(`#link=${encodeURIComponent(tok)}`), tok);
  assert.equal(linkFromHash(`#x=1&link=${encodeURIComponent(tok)}`), tok);
  assert.equal(linkFromHash(""), null);
  assert.equal(linkFromHash("#other=1"), null);
  assert.equal(cleanAddress(`https://app.vyre.run/u/install/join?link=${encodeURIComponent(tok)}`), "/u/install/join");
  assert.equal(takeJoin(), null, "a link in the install route's query holds nothing: only holdJoin fills the hold");
});
