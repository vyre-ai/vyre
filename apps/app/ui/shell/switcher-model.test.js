import "../../../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { ACCOUNT_HREF, SWITCHER_HREF, THEME_CHOICES, accountHeader, switcherActions, switcherRows } from "./switcher-model.js";

test("the switcher lists every Space with a check on the one showing, All spaces first", () => {
  const rows = switcherRows([{ id: "spc_a", name: "tess's Cloud" }, { id: "all", name: "All spaces" }, { id: "spc_b", name: "Northwind" }], "spc_b");
  assert.deepEqual(rows.map((r) => [r.name, r.on, r.all]), [["All spaces", false, true], ["tess's Cloud", false, false], ["Northwind", true, false]]);
  assert.ok(!rows.some((r) => /showing/.test(r.name)), "no (showing) suffix: the check says it");
});

test("the actions: make or join a Space always; invite and settings only for one Space, and no invite where no one else can join", () => {
  const ids = (cur) => switcherActions(cur).map((a) => a.id);
  assert.deepEqual(ids({ id: "spc_a" }), ["create", "join", "invite", "settings"]);
  assert.deepEqual(ids({ id: "all" }), ["create", "join"]);
  assert.deepEqual(ids({ id: "spc_h", basic: true }), ["create", "join", "settings"]);
  assert.deepEqual(ids(undefined), ["create", "join"]);
});

test("every action and account link opens a route that exists", () => {
  const app = new URL("../../app/", import.meta.url);
  const exists = (href) => { const p = href.split("?")[0].replace(/^\//, ""); return [`${p}.tsx`, `${p}/index.tsx`].some((f) => fs.existsSync(new URL(f, app))); };
  for (const href of [...Object.values(SWITCHER_HREF), ...Object.values(ACCOUNT_HREF)]) assert.ok(exists(href), href);
});

test("the theme choices are Light, Match this device and Dark, with Appearance's own values", () => {
  assert.deepEqual(THEME_CHOICES.map(([v, l]) => `${v}:${l}`), ["paper:Light", "system:Match this device", "dark:Dark"]);
});

test("the account menu's top: the name, then the username", () => {
  assert.deepEqual(accountHeader({ name: "Tess", sub: "tess.vyre.run" }), { name: "Tess", handle: "@tess" });
  assert.deepEqual(accountHeader({ name: "", sub: "" }), { name: "You", handle: "" });
  assert.deepEqual(accountHeader({ name: "tess", sub: "tess" }), { name: "tess", handle: "" });
});
