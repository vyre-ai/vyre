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
  const w = welcomeOf({ detail: { history: { state: "working", running: true, indexed: 12 }, tailscale: { state: "working", loginUrl: "https://login.tailscale.com/a/abc123" } } });
  assert.deepEqual(w.cards.map(c => c.id), ["tailscale", "import"]);
  assert.equal(w.cards[0].href, "https://login.tailscale.com/a/abc123");
});

test("welcome: no card names a tool", () => {
  const w = welcomeOf({ detail: { claude: { installed: true }, history: { state: "todo" }, devices: { state: "todo" } } });
  assert.ok(w.cards.length >= 3);
  for (const c of w.cards) assert.ok(!("action" in c) && !("tool" in c));
});

test("welcome: the Tailscale link is kept only for https on tailscale.com", () => {
  const card = u => welcomeOf({ detail: { tailscale: { state: "working", loginUrl: u } } }).cards[0];
  assert.equal(card("https://login.tailscale.com/a/x").href, "https://login.tailscale.com/a/x");
  assert.equal(card("https://tailscale.com/a/x").href, "https://tailscale.com/a/x");
  for (const bad of ["http://login.tailscale.com/a/x", "https://evil.example/a", "https://tailscale.com.evil.example/a", "https://eviltailscale.com/a", "https://login.tailscale.com@evil.example/a", "https://u:p@login.tailscale.com/a", "javascript:alert(1)", "not a url"]) {
    const c = card(bad);
    assert.equal(c.id, "tailscale", bad);
    assert.ok(!("href" in c), bad);
  }
});
