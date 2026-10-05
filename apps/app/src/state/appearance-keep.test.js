import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { changedLooks, pack, unpack } from "./appearance-keep.js";

test("what the person and each space chose comes back the way it went in", () => {
  const raw = pack({ person: { theme: "paper", density: "compact", font: "serif", reducedMotion: true, largerText: true }, looks: { spc_a: { accent: "sky", tint: "rose", density: "comfortable", font: "system", corners: "round" }, mine: { accent: "custom", hex: "#7AA2F7" } } });
  const back = unpack(raw);
  assert.deepEqual(back.person, { density: "compact", font: "serif", reducedMotion: true, largerText: true });
  assert.deepEqual(back.looks.spc_a, { accent: "sky", tint: "rose", density: "comfortable", font: "system", corners: "round" });
  assert.deepEqual(back.looks.mine, { accent: "custom", hex: "#7AA2F7" });
});

test("the theme is not kept here (the box keeps it), and a setting that is off is not kept", () => {
  assert.equal(JSON.parse(pack({ person: { theme: "dark", reducedMotion: false }, looks: {} })).person.theme, undefined);
  assert.deepEqual(unpack(pack({ person: { reducedMotion: false, largerText: false }, looks: {} })).person, {});
});

test("anything unknown, from another version or not JSON is nothing", () => {
  assert.deepEqual(unpack(null), { person: {}, looks: {} });
  assert.deepEqual(unpack("{not json"), { person: {}, looks: {} });
  assert.deepEqual(unpack(JSON.stringify({ v: 2, person: { density: "compact" } })), { person: {}, looks: {} });
  const bad = unpack(JSON.stringify({ v: 1, person: { density: "huge", font: "comic", x: 1 }, looks: { "bad id!": { accent: "sky" }, ok: { accent: "neon", hex: "red", corners: "round" } } }));
  assert.deepEqual(bad, { person: {}, looks: { ok: { corners: "round" } } });
});

test("only a look the person changed is kept: the default one and the sample space are not", () => {
  const looks = { mine: { accent: "violet", tint: "accent", density: "default", font: "system", corners: "default" }, harlow: { accent: "amber", density: "compact" }, spc_a: { accent: "sky" } };
  assert.deepEqual(Object.keys(changedLooks(looks)), ["spc_a"]);
  assert.deepEqual(Object.keys(changedLooks({ mine: { accent: "rose", tint: "accent", density: "default", font: "system", corners: "default" } })), ["mine"]);
});
