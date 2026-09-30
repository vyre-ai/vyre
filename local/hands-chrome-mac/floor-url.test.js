// @ts-check
// The module's URL tier: what is blind, what is read-only, what is open, and that it gives the
// same answers as the extension's own lib/floor.js on a shared table.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { classify, originOf } from "./floor-url.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** [url, tier] on which the module and the extension must agree. */
const SHARED = /** @type {[string, "blind"|"hands"|"open"][]} */ ([
  ["https://harlow.example/intake", "open"],
  ["https://northwind.example/orders?id=7", "open"],
  ["http://localhost:3000/app", "open"],
  ["file:///Users/alex/notes.html", "open"],
  ["about:blank", "open"],
  ["https://chase.com/accounts", "blind"],
  ["https://secure.bankofamerica.com/login", "blind"],
  ["https://www.paypal.com/myaccount", "blind"],
  ["https://my.1password.com/vaults", "blind"],
  ["https://vault.bitwarden.com/#/vault", "blind"],
  ["https://accounts.google.com/signin", "blind"],
  ["https://chromewebstore.google.com/detail/x", "blind"],
  ["https://chrome.google.com/webstore/category/extensions", "blind"],
  ["https://vyre.run/setup", "blind"],
  ["http://localhost:7300/", "blind"],
  ["http://127.0.0.1:7788/deck", "blind"],
  ["chrome://settings", "blind"],
  ["chrome-extension://abcdefghijklmnopabcdefghijklmnop/page.html", "blind"],
  ["edge://settings", "blind"],
  ["devtools://devtools/bundled/inspector.html", "blind"],
  ["view-source:https://harlow.example/", "blind"],
  ["javascript:alert(1)", "blind"],
  ["ftp://files.example/x", "blind"],
  ["not a url", "blind"],
  ["", "blind"],
]);

test("classify: the built-in table", () => {
  for (const [url, tier] of SHARED) assert.equal(classify(url).tier, tier, url);
});

test("classify: blind refuses every op, open allows them, and the reason is given", () => {
  const b = classify("https://chase.com/", "page.snapshot");
  assert.deepEqual([b.tier, b.allow], ["blind", false]);
  assert.ok(b.why);
  assert.deepEqual(classify("https://harlow.example/", "page.act"), { tier: "open", allow: true, why: null });
});

test("classify: a read-only page can be read and not acted on", () => {
  const cfg = { hands: ["crm.example.com", "harlow.example/billing"] };
  assert.deepEqual(classify("https://app.crm.example.com/x", "page.snapshot", cfg).allow, true);
  for (const op of ["page.act", "page.fill", "page.eval", "batch.run", "tabs.navigate", "api.call", "net.on"]) {
    const c = classify("https://app.crm.example.com/x", op, cfg);
    assert.deepEqual([c.tier, c.allow], ["hands", false], op);
  }
  assert.equal(classify("https://harlow.example/billing/invoices", "page.act", cfg).tier, "hands");
  assert.equal(classify("https://harlow.example/intake", "page.act", cfg).tier, "open");
});

test("classify: the person's lists and the paired box add to it, and open lets one origin out", () => {
  assert.equal(classify("https://intranet.harlow.example/", "page.snapshot", { blind: ["intranet.harlow.example"] }).tier, "blind");
  assert.equal(classify("https://box.tailnet.example:8443/deck", "page.snapshot", { box: "https://box.tailnet.example:8443" }).tier, "blind");
  assert.equal(classify("https://box.tailnet.example:9000/", "page.snapshot", { box: "https://box.tailnet.example:8443" }).tier, "open");
  assert.equal(classify("https://online-banking.example/", "page.snapshot").tier, "blind", "a hostname that says bank");
  assert.equal(classify("https://online-banking.example/", "page.snapshot", { open: ["online-banking.example"] }).tier, "open");
});

test("originOf", () => {
  assert.equal(originOf("https://harlow.example:8443/a?b#c"), "https://harlow.example:8443");
  assert.equal(originOf("chrome://settings/x"), "chrome://settings");
  assert.equal(originOf("nope"), null);
  assert.equal(originOf(""), null);
});

test("classify agrees with the extension's lib/floor.js on the shared table", async t => {
  const file = path.join(HERE, "extension", "lib", "floor.js");
  if (!fs.existsSync(file)) return t.skip("extension/lib/floor.js is not in this checkout, so there is nothing to compare with");
  const ext = await import(file);
  if (typeof ext.tierOf !== "function" || typeof ext.decide !== "function") return t.skip("extension/lib/floor.js has no tierOf and decide to compare with");
  const cfg = { blind: ["intranet.harlow.example"], readonly: ["crm.example.com"] };
  const more = [...SHARED.map(([u]) => u), "https://intranet.harlow.example/", "https://crm.example.com/deals"];
  for (const url of more) {
    assert.equal(classify(url, undefined, cfg).tier, ext.tierOf(url, cfg).tier, `tier of ${url}`);
    for (const op of ["page.snapshot", "page.act", "page.fill", "batch.run", "tabs.list"]) {
      assert.equal(classify(url, op, cfg).allow, ext.decide(url, op, cfg).allow, `${op} on ${url}`);
    }
  }
});
