import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { lookSeed, lookOf, SHAPES } from "./agent-look.js";
import { markSource } from "../marks/source.js";

test("a look is a shape and a colour, and reads back", () => {
  assert.equal(lookSeed(3, 5), "s3~c5");
  assert.deepEqual(lookOf("s3~c5"), { shape: 3, color: 5 });
  assert.equal(lookSeed(9, -1), "s1~c15");
  assert.equal(lookSeed(0, 11), "s0~c11");
  assert.equal(lookSeed(0, 16), "s0~c0");
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

import { PARTS, partsOf, baseOf, withParts, setPart } from "./agent-look.js";
import { agentV2 } from "../../../../lib/wink-code/agent2.js";

test("a look reads its parts in order, and an old look has none", () => {
  assert.deepEqual(partsOf("s3~c5~e2~m1~t4~b1~h0"), { e: 2, m: 1, t: 4, b: 1, h: 0 });
  assert.deepEqual(partsOf("s3~c5"), {});
  assert.deepEqual(partsOf("s3~c5~m4~h5"), { m: 4, h: 5 });
  assert.equal(baseOf("s3~c5~e2~m1~t4~b1~h0"), "s3~c5");
  assert.equal(baseOf("rex"), "rex");
  assert.deepEqual(lookOf("s3~c5~e2~m1~t4~b1~h0"), { shape: 3, color: 5 });
  assert.equal(lookOf("s3~c5~e9"), null);
  assert.deepEqual(lookOf("s3~c12"), { shape: 3, color: 12 });
  assert.deepEqual(lookOf("s3~c15~e2~m1~t4~b1~h0"), { shape: 3, color: 15 });
  assert.equal(lookOf("s3~c16"), null, "sixteen colours, c0 to c15");
});

test("a part a look leaves out is drawn from the agent's uid: always the same, and different agents differ", () => {
  const a = withParts("s1~c2", "agt_aaa"), b = withParts("s1~c2", "agt_aaa"), c = withParts("s1~c2", "agt_bbb");
  assert.equal(a, b, "the same uid, the same character");
  assert.match(a, /^s1~c2~e[0-5]~m[0-4]~t[0-6]~b[01]~h[0-5]$/);
  const seen = new Set(Array.from({ length: 40 }, (_, i) => withParts("s1~c2", `agt_${i}`)));
  assert.ok(seen.size > 20, "forty agents are not forty copies");
  assert.notEqual(withParts("s1~c2", "agt_aaa"), c, "two agents of one shape and colour differ");
  assert.equal(withParts("s1~c2~e4", "agt_aaa").slice(0, 10), "s1~c2~e4~m", "a part it names is kept");
  assert.equal(withParts("rex", "agt_aaa").startsWith("rex~e"), true, "a bare seed keeps its body and gains parts");
});

test("a tap changes one part and keeps the rest", () => {
  const before = withParts("s1~c2", "agt_aaa");
  const after = setPart("s1~c2", "agt_aaa", "t", 5);
  assert.deepEqual(partsOf(after), { ...partsOf(before), t: 5 });
  assert.equal(setPart(after, "agt_aaa", "e", 8).includes("~e2"), true, "out-of-range wraps (8 of 6 is 2)");
  assert.equal(PARTS.length, 5);
});

test("the renderer draws the parts: eyes, mouth, top, blush and charm change the picture, and a look without them is as before", () => {
  const plain = agentV2("s1~c2", 48, "dark");
  const full = agentV2("s1~c2~e4~m3~t5~b1~h2", 48, "dark");
  assert.notEqual(plain, full);
  assert.match(full, /#5B6B8C/, "the hat (top 5)");
  assert.match(full, /#E8857A/, "the heart (charm 2)");
  assert.doesNotMatch(plain, /#5B6B8C|#F3C970" stroke/, "no hat or charm without parts");
  const tops = new Set([0, 1, 2, 3, 4, 5, 6].map((t) => agentV2(`s1~c2~t${t}`, 48, "dark")));
  assert.equal(tops.size, 7, "seven tops are seven drawings");
  const charms = new Set([0, 1, 2, 3, 4, 5].map((h) => agentV2(`s1~c2~h${h}`, 48, "dark")));
  assert.equal(charms.size, 6);
  const eyes = new Set([0, 1, 2, 3, 4, 5].map((e) => agentV2(`s1~c2~e${e}`, 48, "dark")));
  assert.equal(eyes.size, 6);
  const mouths = new Set([0, 1, 2, 3, 4].map((m) => agentV2(`s1~c2~m${m}`, 48, "dark")));
  assert.equal(mouths.size, 5);
  assert.notEqual(agentV2("s1~c2~b0", 48, "dark"), agentV2("s1~c2~b1", 48, "dark"));
  // the body and colour still come from the shape and colour, whatever the parts say
  const body = (/** @type {string} */ seed) => /<path d="(M[^"]+)" fill="url/.exec(agentV2(seed, 48, "dark"))?.[1];
  assert.equal(body("s1~c2~e0"), body("s1~c2~e5~t3~h4"), "same body path");
});

test("the agent family has sixteen colours: the first eight are as shipped, the new eight draw and differ", async () => {
  const { AGENT_COLORS } = await import("../../../../lib/wink-code/agent2.js");
  assert.equal(AGENT_COLORS.length, 16);
  assert.deepEqual(AGENT_COLORS.slice(0, 8), ["#F2A58C", "#F3C970", "#86D0BB", "#E39A5B", "#E897C0", "#CDBF9B", "#EE9494", "#93D2B0"], "an agent made before c8 keeps its colour");
  assert.equal(new Set(AGENT_COLORS).size, 16);
  const drawn = new Set(Array.from({ length: 16 }, (_, c) => agentV2(`s1~c${c}`, 48, "dark")));
  assert.equal(drawn.size, 16, "each of the sixteen colours draws differently");
  assert.ok(agentV2("s1~c15~e1~m2~t3~b1~h4", 48, "dark").includes("<svg"), "a two-digit colour takes its parts after it");
  assert.equal(agentV2("s1~c12~e1", 48, "dark"), agentV2("s1~c12~e1", 48, "dark"));
});
