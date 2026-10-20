import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { toastLine } from "./toast-model.js";

// The owner saw toasts that started lowercase and ran on ("no computer of yours is set up to run this Space's chats yet: turn on ..."). Every toast is one short sentence with a capital.

test("a toast starts with a capital", () => {
  assert.equal(toastLine("that did not go through."), "That did not go through.");
  assert.equal(toastLine("  Renamed.  "), "Renamed.");
  assert.equal(toastLine(""), "");
});

test("a long toast keeps its first sentence, or the part before a colon", () => {
  const long = "no computer of yours is set up to run this Space's chats yet: turn on Run on this computer on the Mac, then move the chat, and then try once more from the chat itself";
  assert.equal(toastLine(long), "No computer of yours is set up to run this Space's chats yet.");
  const two = "The copy is made and kept in your chats. It could not move because the computer it was meant for has not checked in for a while, so it stays on the server for now.";
  assert.equal(toastLine(two), "The copy is made and kept in your chats.");
  for (const s of [long, two, "x".repeat(400)]) assert.ok(toastLine(s).length <= 120, s);
});

test("showToast applies the rule, so no screen can skip it", () => {
  const src = fs.readFileSync(new URL("./Toast.tsx", import.meta.url), "utf8");
  assert.match(src, /useToasts\.getState\(\)\.set\(toastLine\(line\), undo\)/);
});
