import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { openHow, screenUrl, withTicket } from "./module-screen.js";

const MODS = [{ module: "docuseal", origin: "https://docuseal.harlow.vyre.run", screens: [{ id: "documents", label: "Documents", path: "documents" }, { id: "templates", label: "Templates" }] }, { module: "noorigin", screens: [{ id: "a", label: "A" }] }];

test("a module screen is on the module's own origin, not under the app's address", () => {
  assert.equal(screenUrl(MODS, "docuseal", "documents"), "https://docuseal.harlow.vyre.run/documents");
  assert.equal(screenUrl(MODS, "docuseal", "templates"), "https://docuseal.harlow.vyre.run/templates", "no path: the screen id");
  assert.equal(screenUrl([{ module: "x", origin: "https://x.harlow.vyre.run/", screens: [{ id: "i", label: "I", path: "/a/b" }] }], "x", "i"), "https://x.harlow.vyre.run/a/b");
});

test("no origin, an unknown screen, a plain-http origin or a path that climbs gives no address", () => {
  assert.equal(screenUrl(MODS, "noorigin", "a"), null);
  assert.equal(screenUrl(MODS, "docuseal", "nope"), null);
  assert.equal(screenUrl(MODS, "nobody", "a"), null);
  assert.equal(screenUrl([{ module: "x", origin: "http://x.local", screens: [{ id: "i", label: "I" }] }], "x", "i"), null);
  assert.equal(screenUrl([{ module: "x", origin: "https://x.harlow.vyre.run", screens: [{ id: "i", label: "I", path: "../etc" }] }], "x", "i"), null);
});

test("it opens in the main pane where the page can be embedded and in a new window elsewhere", () => {
  assert.equal(openHow("web"), "pane");
  assert.equal(openHow("ios"), "window");
  assert.equal(openHow("android"), "window");
});

test("the one-time ticket's address is used only on the module's own origin", () => {
  const plain = "https://docuseal.harlow.vyre.run/documents";
  assert.equal(withTicket(plain, { url: "https://docuseal.harlow.vyre.run/documents?ticket=abc" }), "https://docuseal.harlow.vyre.run/documents?ticket=abc");
  assert.equal(withTicket(plain, { url: "https://evil.example/documents?ticket=abc" }), plain, "another origin is ignored");
  assert.equal(withTicket(plain, null), plain);
  assert.equal(withTicket(plain, { url: "javascript:alert(1)" }), plain);
});
