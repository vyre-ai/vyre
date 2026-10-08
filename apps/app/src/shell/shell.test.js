// @ts-check
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { shellCommand } from "./shell-model.js";

test("a menu command is a route of the app, back or forward, and nothing else", () => {
  assert.deepEqual(shellCommand("/u/now"), { kind: "route", route: "/u/now" });
  assert.deepEqual(shellCommand("/u/records/contact"), { kind: "route", route: "/u/records/contact" });
  assert.deepEqual(shellCommand("back"), { kind: "back" });
  assert.deepEqual(shellCommand("forward"), { kind: "forward" });
  for (const bad of ["https://evil.example", "/other", "/u/../x?y", "", null, 3]) assert.equal(shellCommand(bad).kind, "none");
});

test("a boxless window is the Mac app on a server Mac or the Windows app; a browser and a plain Mac window are not", async () => {
  const { isBoxless } = await import("./shell.ts");
  const set = (v) => { globalThis.window = v ? { __vyreShell: v } : {}; };
  try {
    set({ kind: "windows", boxless: true }); assert.equal(isBoxless(), true);
    set({ kind: "mac", boxless: true }); assert.equal(isBoxless(), true);
    set({ kind: "mac", boxless: false }); assert.equal(isBoxless(), false);
    set({ kind: "windows" }); assert.equal(isBoxless(), false);
    set(null); assert.equal(isBoxless(), false);
  } finally { delete globalThis.window; }
});
