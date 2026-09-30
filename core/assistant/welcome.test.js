import { test } from "node:test";
import assert from "node:assert/strict";
import { welcomeOf } from "./welcome.js";

test("welcome: open steps become cards, done steps do not", () => {
  const w = welcomeOf({ person: "Alex", assistant: "Juno", detail: { claude: { signedIn: true, installed: true }, tailscale: { state: "done" }, history: { state: "todo" }, devices: { state: "todo" } } });
  assert.deepEqual(w.cards.map(c => c.id), ["history", "phone"]);
  assert.match(w.text, /Hi Alex\. I'm Juno/);
  assert.match(w.text, /2 things are left/);
});

test("welcome: nothing open, or status unreadable, still greets", () => {
  assert.equal(welcomeOf({ detail: {} }).cards.length, 0);
  const w = welcomeOf(null);
  assert.equal(w.cards.length, 0);
  assert.match(w.text, /assistant/);
});

test("welcome: running import shows progress, tailscale shows its link", () => {
  const w = welcomeOf({ detail: { history: { state: "working", running: true, indexed: 12 }, tailscale: { state: "working", loginUrl: "https://login.example/x" } } });
  assert.deepEqual(w.cards.map(c => c.id), ["tailscale", "import"]);
  assert.equal(w.cards[0].href, "https://login.example/x");
});

test("welcome: no card names a tool", () => {
  const w = welcomeOf({ detail: { claude: { installed: true }, history: { state: "todo" }, devices: { state: "todo" } } });
  assert.ok(w.cards.length >= 3);
  for (const c of w.cards) assert.ok(!("action" in c) && !("tool" in c));
});
