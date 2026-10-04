import "../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { friendlyDeviceName, cleanLabel } from "./devicename.js";

test("devicename: what a device calls itself becomes a name a person reads, never .local or localhost", () => {
  const f = (raw, o) => friendlyDeviceName(raw, o);
  assert.equal(f("Alex's MacBook Pro"), "Alex's MacBook Pro", "a good name is kept as it is");
  assert.equal(f("alexs-macbook-pro.local"), "alexs macbook pro", "the suffix goes, the dashes read as spaces");
  assert.equal(f("Alexs-MacBook-Pro.lan"), "Alexs MacBook Pro");
  assert.equal(f("mac.local", { kind: "mac", owner: "Alex Smith" }), "Alex's Mac");
  assert.equal(f("localhost", { kind: "phone", owner: "Alex" }), "Alex's phone");
  assert.equal(f("localhost", { kind: "web" }), "Browser");
  assert.equal(f("", { kind: "device", owner: "" }), "Device");
  assert.equal(f("192.168.1.5"), "Device");
  assert.equal(f("alex-vyre"), "alex-vyre", "a dashed name that is not a kind of device is the person's own");
  assert.equal(f("x".repeat(100)).length, 64);
  assert.equal(f("a\u0000b\nc"), "a b c");
});

test("devicename: zero-width and bidi characters a device puts in its own name are stripped", () => {
  assert.equal(friendlyDeviceName("Al\u200bex\u202e's Mac\u2066"), "Alex's Mac");
  assert.equal(friendlyDeviceName("\u200b\u202e", { kind: "phone", owner: "Alex" }), "Alex's phone", "a name of only invisible characters is empty");
  assert.equal(cleanLabel("a\ufeffb\u061cc\u2029d"), "abc d");
});

test("devicename: emoji joiners stay inside an emoji sequence and nowhere else; astral tag characters go", () => {
  const family = "\u{1F468}\u200d\u{1F469}\u200d\u{1F467}", heart = "\u2764\ufe0f";
  assert.equal(cleanLabel(`Sam ${family}`), `Sam ${family}`, "a family emoji keeps its joiners");
  assert.equal(cleanLabel(`Sam ${heart}`), `Sam ${heart}`, "a presentation selector after an emoji stays");
  assert.equal(cleanLabel("Sa\u200dm\ufe0f"), "Sam", "a joiner or selector with no emoji beside it goes");
  assert.equal(cleanLabel("\u{1F468}\u200d x"), "\u{1F468} x", "a trailing joiner goes");
  assert.equal(cleanLabel("Alex\u{E0041}\u{E0042}\u{E007F}"), "Alex", "tag characters are hidden text and go");
  assert.equal(cleanLabel("a\ue000b\ue001c"), "a b c", "the private-use markers cannot be smuggled in");
});

test("devicename: a subdivision flag keeps its tag characters, a stray tag does not", () => {
  const tags = "gbeng", england = "\u{1F3F4}" + [...tags].map(c => String.fromCodePoint(0xE0000 + c.charCodeAt(0))).join("") + "\u{E007F}";
  assert.equal(cleanLabel(`Sam ${england}`), `Sam ${england}`, "the England flag is whole");
  assert.equal(cleanLabel(`${england}\u{E0041}x\u{E007F}`), `${england}x`, "a stray tag and a stray cancel tag beside it go");
  assert.equal(cleanLabel("\u{1F3F4}\u{E0067}"), "\u{1F3F4}", "a flag with no cancel tag loses its tags");
  assert.equal(cleanLabel("\u{E0067}\u{E0062}\u{E007F}"), "", "tags with no flag base go");
  assert.equal(cleanLabel("a\ue002b"), "a b", "the private-use marker cannot be smuggled in");
});
