// @ts-check
// The floor tiers, judged from URLs alone (extension/lib/floor.js), and through ctx.floorAllows
// with the person's lists in chrome.storage.local.
import test from "node:test";
import assert from "node:assert/strict";
import { decide, tierOf } from "./extension/lib/floor.js";
import { createCtx } from "./extension/lib/ctx.js";
import { createFakeChrome } from "./test-support/fake-chrome.js";

const BLIND = [
  "chrome://settings", "chrome-extension://abc/page.html", "edge://flags", "about:config", "devtools://devtools/x",
  "https://chromewebstore.google.com/detail/x", "https://chrome.google.com/webstore/detail/x",
  "https://accounts.google.com/v3/signin", "https://vyre.run/setup", "https://alex.vyre.run/", "http://localhost:7300/", "http://localhost:7788/deck",
  "https://my.1password.com/vaults", "https://vault.bitwarden.com/#/vault", "https://lastpass.com/vault", "https://www.dashlane.com/",
  "https://keepersecurity.com/vault", "https://proton.me/pass/", "https://appleid.apple.com/", "https://icloud.com/passwords",
  "https://secure.chase.com/web/auth", "https://www.paypal.com/myaccount", "", undefined, "not a url",
];
const OPEN = ["https://harlow.example/intake", "about:blank", "http://localhost:3000/", "https://proton.me/mail", "https://vyre.run.evil.example/", "https://notchase.com/", "https://bitwarden.com/pricing"];

test("blind origins refuse reading and acting", () => {
  for (const u of BLIND) {
    for (const op of ["page.snapshot", "page.act", "tabs.list"]) {
      const v = decide(u, op);
      assert.equal(v.allow, false, `${u} ${op}`);
      assert.equal(v.tier, "blind");
    }
  }
});

test("ordinary pages, blank and look-alike hosts are open", () => {
  for (const u of OPEN) assert.deepEqual([decide(u, "page.act").allow, decide(u, "page.act").tier], [true, "open"], u);
});

test("hands tier: reading allowed, every acting op refused", () => {
  const cfg = { readonly: ["reports.harlow.example", "northwind.example/ledger"] };
  assert.equal(tierOf("https://reports.harlow.example/q3", cfg).tier, "hands");
  assert.equal(tierOf("https://a.reports.harlow.example/", cfg).tier, "hands");
  assert.equal(tierOf("https://northwind.example/ledger/2026", cfg).tier, "hands");
  assert.equal(tierOf("https://northwind.example/orders", cfg).tier, "open");
  assert.equal(decide("https://reports.harlow.example/q3", "page.snapshot", cfg).allow, true);
  for (const op of ["page.act", "page.fill", "page.eval", "tabs.navigate", "api.call", "batch.run"]) assert.equal(decide("https://reports.harlow.example/q3", op, cfg).allow, false, op);
});

test("a configured blind list adds hosts, paths, ports and scheme prefixes", () => {
  const cfg = { blind: ["hr.harlow.example", "*.secret.example", "northwind.example/payroll", "localhost:9000", "chrome://version"] };
  for (const u of ["https://hr.harlow.example/", "https://a.secret.example/", "https://northwind.example/payroll/run", "http://localhost:9000/x"]) assert.equal(tierOf(u, cfg).tier, "blind", u);
  assert.equal(tierOf("https://northwind.example/bakery", cfg).tier, "open");
  assert.equal(tierOf("http://localhost:9001/", cfg).tier, "open");
});

test("ctx.floorAllows reads the tab URL and the lists from storage", async () => {
  const chrome = createFakeChrome([
    { url: "https://harlow.example/a" }, { url: "https://reports.harlow.example/" }, { url: "https://hr.harlow.example/" }, { url: "chrome://settings" },
  ]);
  chrome._.store.local["floor.readonly"] = ["reports.harlow.example"];
  chrome._.store.local["floor.blind"] = ["hr.harlow.example"];
  const ctx = createCtx({ chrome });
  assert.equal((await ctx.floorAllows(1, "page.act")).allow, true);
  assert.equal((await ctx.floorAllows(2, "page.snapshot")).allow, true);
  assert.equal((await ctx.floorAllows(2, "page.act")).allow, false);
  assert.equal((await ctx.floorAllows(3, "page.snapshot")).tier, "blind");
  assert.equal((await ctx.floorAllows(4, "tabs.list")).allow, false);
  await assert.rejects(ctx.floorAllows(99, "page.act"), { code: "no_tab" });
});
