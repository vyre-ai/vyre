// @ts-check
// The relay client hands the chain-hello callback the device's PUBLIC key as the key store holds it (`publicKey`), not an undefined `pub`: rc2-people's real-daemon run found every dial died on that.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("the dial passes keys.publicKey to chainHello", () => {
  const src = fs.readFileSync(new URL("./client.js", import.meta.url), "utf8");
  assert.match(src, /this\.o\.chainHello\(keys\.publicKey \?\? keys\.pub\)/);
});

test("the dial offers the presence key beside the chain hello", () => {
  const src = fs.readFileSync(new URL("./client.js", import.meta.url), "utf8");
  assert.match(src, /\(hello\)\.presenceKey = typeof this\.o\.presenceKey === "function"/);
});
