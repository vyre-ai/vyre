// @ts-check
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { SETUP_STEPS, SKIPPABLE, setupList, setupLines } from "./setup-steps.js";

const ids = SETUP_STEPS.map(s => s.id);
const stat = l => Object.fromEntries(l.steps.map(s => [s.id, s.status]));

test("steps: the page's ten steps, in order, with their places and the optional ones", () => {
  assert.deepEqual(ids, ["install", "words", "address", "tailscale", "ai", "phone", "passkey", "assistant", "computers", "history"]);
  assert.deepEqual(SETUP_STEPS.filter(s => s.optional).map(s => s.id), ["phone", "computers", "history"]);
  assert.deepEqual(SETUP_STEPS.map(s => s.where), ["On your server", "On your server", "In your browser", "In your browser", "In your browser", "In your browser", "At your address", "At your address", "At your address", "At your address"]);
  assert.equal(SETUP_STEPS[4].title, "Sign in to your AI");
});

test("steps: done from what the box sees, the first step left is current, the rest todo, skipped ones stay listed", () => {
  const l = setupList({ install: true, words: true, address: true, tailscale: true }, { skipped: ["phone"] });
  assert.equal(l.current, "ai");
  assert.deepEqual(stat(l), { install: "done", words: "done", address: "done", tailscale: "done", ai: "current", phone: "skipped", passkey: "todo", assistant: "todo", computers: "todo", history: "todo" });
  assert.deepEqual(l.steps.map(s => s.n), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.equal(l.finished, false);
  assert.deepEqual(l.skipped, ["phone"]);
  // ai can be skipped too, and then the next step is current.
  const k = setupList({ install: true, words: true, address: true, tailscale: true }, { skipped: ["ai", "phone"] });
  assert.equal(k.current, "passkey");
  assert.equal(stat(k).ai, "skipped");
  // A step the box sees is done even if it was once skipped; only the skippable ones can be skipped; history is done once passed.
  const m = setupList({ install: true, ai: true }, { skipped: ["ai", "passkey", "nonsense"], passed: ["history"] });
  assert.equal(stat(m).ai, "done");
  assert.equal(stat(m).passkey, "todo", "passkey cannot be skipped");
  assert.equal(m.current, "words", "the first step the box does not see done");
  assert.equal(stat(m).history, "done");
  assert.deepEqual(SKIPPABLE, ["ai", "phone", "computers", "history"]);
});

test("steps: finished when nothing is left, with the skipped ones still named", () => {
  const all = Object.fromEntries(ids.map(i => [i, true]));
  const l = setupList({ ...all, phone: false, history: false }, { skipped: ["phone", "history"] });
  assert.equal(l.finished, true);
  assert.equal(l.current, null);
  assert.deepEqual(l.skipped, ["phone", "history"]);
});

test("steps: sudo vyre setup's words, while the page is open, after the passkey, and finished", () => {
  const early = setupList({ install: true, words: true, address: true, tailscale: true });
  const t = setupLines(early, { notes: { address: "alex.vyre.run" } });
  assert.equal(t[0], "Vyre setup: step 5 of 10, Sign in to your AI");
  assert.ok(t.includes("✓ Choose your address     alex.vyre.run"));
  assert.ok(t.includes("○ Sign in to your AI"));
  assert.ok(t.includes("○ Add your phone (optional)"));
  assert.ok(t.includes("run this for a link to carry on from this server:  sudo vyre setup --new-link"));
  const late = setupList({ install: true, words: true, address: true, tailscale: true, ai: true, phone: true, passkey: true });
  assert.deepEqual(setupLines(late, { address: "https://alex.vyre.run" }), ["Vyre setup: step 8 of 10, You and your assistant", "Steps 1 to 7 are done.", "", "Continue at https://alex.vyre.run"]);
  const done = setupList(Object.fromEntries(ids.map(i => [i, i !== "phone" && i !== "history"])), { skipped: ["phone", "history"] });
  assert.deepEqual(setupLines(done, { address: "https://alex.vyre.run" }), ["Setup is finished. Vyre is running at https://alex.vyre.run", "Skipped: Add your phone, Your history. Open Settings, Setup to do them."]);
});
