import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { lookSeed, lookOf, SHAPES } from "./agent-look.js";
import { markSource } from "../marks/source.js";

test("a look is a shape and a colour, and reads back", () => {
  assert.equal(lookSeed(3, 5), "s3~c5");
  assert.deepEqual(lookOf("s3~c5"), { shape: 3, color: 5 });
  assert.equal(lookSeed(9, -1), "s1~c7");
  assert.equal(lookOf("kit"), null);
  assert.equal(SHAPES.length, 8);
});

test("the colour changes the drawing's colour and not its shape", () => {
  const a = markSource("agent", lookSeed(2, 0), "dark");
  const b = markSource("agent", lookSeed(2, 3), "dark");
  const path = (s) => /d="(M[^"]+)"/.exec(s)?.[1];
  assert.notEqual(a, b);
  assert.equal(path(a), path(b));
});

test("two looks of one shape in different colours do not share a gradient id", () => {
  const id = (s) => /<linearGradient id="([^"]+)"/.exec(s)?.[1];
  assert.notEqual(id(markSource("agent", lookSeed(2, 0), "dark")), id(markSource("agent", lookSeed(2, 3), "dark")));
});
