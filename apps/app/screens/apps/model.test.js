import "../../../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { appTiles, titleOf, MAKE_AN_APP_HREF } from "./model.js";

test("an app is a module with screens: one tile each, opening its first screen, sorted by title", () => {
  const tiles = appTiles([
    { module: "pdf-converter", screens: [{ id: "convert", label: "Convert" }] },
    { module: "documents", label: "Documents", screens: [{ id: "drafting", label: "Drafting", icon: "file" }, { id: "signing", label: "Signing" }, { id: "templates", label: "Templates" }] },
    { module: "planner", screens: [] },
  ]);
  assert.deepEqual(tiles.map(t => t.title), ["Documents", "Pdf converter"], "a module with no screen is not an app; the rest are sorted");
  assert.equal(tiles[0].href, "/u/module/documents/drafting");
  assert.equal(tiles[0].sub, "Drafting, Signing, Templates");
  assert.equal(tiles[0].icon, "file");
  assert.equal(tiles[1].icon, "grid", "no icon of its own: the grid");
});

test("nothing installed is an empty list, titles are plain words, and Make an app goes to Engineer", () => {
  assert.deepEqual(appTiles([]), []);
  assert.deepEqual(appTiles(/** @type {any} */ (undefined)), []);
  assert.equal(titleOf("pdf-converter"), "Pdf converter");
  assert.equal(titleOf(""), "App");
  assert.equal(MAKE_AN_APP_HREF, "/u/engineer");
});
