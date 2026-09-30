// @ts-check
// deck/js/platform.js: the shell is only what the host injected; glyphs follow the platform.

import test from "node:test";
import assert from "node:assert/strict";
import { shell, installed, kbd, mac } from "./platform.js";

const define = (/** @type {string} */ k, /** @type {any} */ v) => Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });

test("no injected shell: a browser tab, keys from the browser's platform", () => {
  define("__vyreShell", undefined);
  define("matchMedia", () => ({ matches: false }));
  define("navigator", { platform: "Win32", userAgent: "Windows" });
  assert.equal(shell(), null);
  assert.equal(installed(), false, "a tab: rail chords stay the browser's");
  assert.equal(kbd("K"), "Ctrl+K");
  assert.equal(kbd("Enter"), "Ctrl+Enter");
  define("navigator", { platform: "MacIntel", userAgent: "Macintosh" });
  assert.equal(kbd("K"), "⌘K");
  assert.equal(kbd("Enter"), "⌘⏎");
});

test("the injected shell wins, and a malformed one is ignored", () => {
  define("navigator", { platform: "MacIntel" });
  define("__vyreShell", { os: "windows", version: "0.2.0" });
  assert.deepEqual(shell(), { os: "windows", version: "0.2.0" });
  assert.equal(installed(), true);
  assert.equal(mac(), false);
  assert.equal(kbd("K"), "Ctrl+K");
  define("__vyreShell", "windows");
  assert.equal(shell(), null, "only an object the host set, never a string from somewhere");
  define("__vyreShell", undefined);
  define("matchMedia", (/** @type {string} */ q) => ({ matches: q === "(display-mode: standalone)" }));
  assert.equal(installed(), true, "an installed web app window counts too");
});
