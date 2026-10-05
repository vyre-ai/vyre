import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { markSource, markKey, seedOf, sizeBand, slug, deviceTypeOf, scopeIds, KINDS } from "./source.js";

test("seed: own seed, then id, then the name's slug", () => {
  assert.equal(seedOf({ id: "u1", name: "Alex Rivera", seed: "alex-rivera" }), "alex-rivera");
  assert.equal(seedOf({ id: "c7", name: "Jane Doe" }), "c7");
  assert.equal(seedOf({ name: "Doe estate plan" }), "doe-estate-plan");
  assert.equal(slug("Harlow Legal"), "harlow-legal");
});

test("every kind draws a mark with a viewBox and no fixed size or letter", () => {
  for (const kind of KINDS) {
    const s = markSource(kind, kind === "teammate" ? "research-harlow" : "alex-rivera", "dark", { size: 32 });
    assert.match(s, /^<svg [^>]*viewBox=/, kind);
    assert.doesNotMatch(/^<svg[^>]*>/.exec(s)[0], /\swidth="\d+"/, kind);
    assert.doesNotMatch(s, /<text/, kind);
  }
});

test("same seed, same mark; another seed, another mark; dark and paper differ for themed families", () => {
  assert.equal(markSource("person", "alex-rivera", "dark"), markSource("person", "alex-rivera", "dark"));
  assert.notEqual(markSource("person", "alex-rivera", "dark"), markSource("person", "chris-park", "dark"));
  assert.notEqual(markSource("project", "doe-estate-plan", "dark"), markSource("project", "roe-succession-plan", "dark"));
  assert.notEqual(markSource("project", "doe-estate-plan", "dark"), markSource("project", "doe-estate-plan", "paper"));
});

test("project and space use the same emblem for the same seed", () => {
  assert.equal(markSource("project", "harlow-legal", "dark"), markSource("space", "harlow-legal", "dark"));
});

test("ids are scoped per mark, so two marks never share a clipPath", () => {
  const a = markSource("project", "doe-estate-plan", "dark"), b = markSource("project", "roe-succession-plan", "dark");
  const idA = /id="([^"]+)"/.exec(a)[1], idB = /id="([^"]+)"/.exec(b)[1];
  assert.notEqual(idA, idB);
  assert.match(a, new RegExp(`url\\(#${idA}\\)`));
  assert.equal(scopeIds('<svg><clipPath id="x"/><g clip-path="url(#x)"/></svg>', "t"), '<svg><clipPath id="x-t"/><g clip-path="url(#x-t)"/></svg>');
});

test("cache key: one parse per kind, seed, size band and scheme", () => {
  assert.equal(markKey("person", "a", 24, "dark"), markKey("person", "a", 56, "dark"));
  assert.notEqual(markKey("person", "a", 24, "dark"), markKey("person", "a", 24, "paper"));
  assert.notEqual(markKey("teammate", "a", 24, "dark"), markKey("teammate", "a", 40, "dark"));
  assert.equal(sizeBand("teammate", 28), "s");
  assert.equal(sizeBand("teammate", 32), "l");
  assert.equal(sizeBand("assistant", 56), "");
});

test("device type follows the name", () => {
  assert.equal(deviceTypeOf("Alex's iPhone"), "phone");
  assert.equal(deviceTypeOf("nova"), "server");
  assert.equal(deviceTypeOf("Harlow archive"), "storage");
  assert.equal(deviceTypeOf("Alex's Mac"), "computer");
});
