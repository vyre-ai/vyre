// @ts-check
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setWorldSpace, subscribeWorldSpace, worldSpace } from "./world-space.js";

const here = path.dirname(fileURLToPath(import.meta.url));

test("the records world follows the Space showing: a switch tells every screen once, the same Space tells nobody", () => {
  let told = 0;
  const off = subscribeWorldSpace(() => { told++; });
  setWorldSpace("spc_aaaaaaaaaaaa");
  assert.equal(worldSpace(), "spc_aaaaaaaaaaaa");
  setWorldSpace("spc_aaaaaaaaaaaa");
  setWorldSpace("spc_bbbbbbbbbbbb");
  assert.equal(told, 2);
  off();
  setWorldSpace("spc_aaaaaaaaaaaa");
  assert.equal(told, 2, "a screen that left hears nothing");
});

test("the shared records world is kept per Space, and the shell feeds it the Space showing", () => {
  const data = fs.readFileSync(path.join(here, "data.ts"), "utf8");
  assert.match(data, /const key = `\$\{space\}\|\$\{filtersKey\(filters\)\}`/, "the world's key names the Space");
  const shell = fs.readFileSync(path.join(here, "../../screens/shell/state.ts"), "utf8");
  assert.match(shell, /useSpaces\.subscribe\(\(s\) => setWorldSpace\(s\.space\)\)/);
});
