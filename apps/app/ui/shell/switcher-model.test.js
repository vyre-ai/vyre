import "../../../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { ACCOUNT_HREF, SWITCHER_HREF, THEME_CHOICES, accountHeader, spaceForKey, switcherActions, switcherRows } from "./switcher-model.js";

test("the switcher lists every Space in order with a check on the one showing and Cmd 1 to Cmd 9 on the right, and no All spaces", () => {
  const rows = switcherRows([{ id: "spc_a", name: "tess's Cloud" }, { id: "spc_b", name: "Northwind" }], "spc_b");
  assert.deepEqual(rows.map((r) => [r.name, r.on, r.shortcut]), [["tess's Cloud", false, "Cmd 1"], ["Northwind", true, "Cmd 2"]]);
  assert.equal(switcherRows(Array.from({ length: 10 }, (_, i) => ({ id: `s${i}`, name: `S${i}` })), "s0")[9].shortcut, "", "only nine have a key");
  assert.equal(spaceForKey([{ id: "a" }, { id: "b" }], "2"), "b");
  assert.equal(spaceForKey([{ id: "a" }], "5"), "");
  assert.equal(spaceForKey([{ id: "a" }], "0"), "");
});

test("Add a Space holds make and join; Space settings is always there; Invite people only for an owner or an admin of a Space with a server", () => {
  const own = (cur) => switcherActions(cur).own.map((a) => a.id);
  assert.deepEqual(switcherActions(undefined).add.map((a) => a.id), ["create", "join"]);
  assert.deepEqual(own({ id: "spc_a", sub: "Owner" }), ["settings", "invite"]);
  assert.deepEqual(own({ id: "spc_a", sub: "Admin" }), ["settings", "invite"]);
  assert.deepEqual(own({ id: "spc_a", sub: "Member" }), ["settings"]);
  assert.deepEqual(own({ id: "spc_h", sub: "Owner", basic: true }), ["settings"]);
  assert.deepEqual(own(undefined), []);
});

test("every action and account link opens a route that exists", () => {
  const app = new URL("../../app/", import.meta.url);
  const exists = (href) => { const p = href.split("?")[0].replace(/^\//, ""); return [`${p}.tsx`, `${p}/index.tsx`].some((f) => fs.existsSync(new URL(f, app))); };
  for (const href of [...Object.values(SWITCHER_HREF), ...Object.values(ACCOUNT_HREF)]) assert.ok(exists(href), href);
});

test("the theme choices are Light, Dark and Match this computer, with Appearance's own values", () => {
  assert.deepEqual(THEME_CHOICES.map(([v, l]) => `${v}:${l}`), ["paper:Light", "dark:Dark", "system:Match this computer"]);
});

test("a Space whose server is not answering carries the muted line and can be removed", () => {
  const rows = switcherRows([{ id: "spc_aaaaaaaaaaaa", name: "Cedar", quiet: true }, { id: "spc_bbbbbbbbbbbb", name: "Birch" }], "spc_bbbbbbbbbbbb");
  assert.equal(rows[0].note, "Not answering");
  assert.equal(rows[0].remove, true);
  assert.equal(rows[1].note, "");
  assert.equal(rows[1].remove, false);
  const shell = fs.readFileSync(new URL("./Shell.tsx", import.meta.url), "utf8");
  assert.match(shell, /r\.note/);
  assert.match(shell, /onRemoveSpace/);
  assert.match(shell, /onQuiet/);
  const menu = fs.readFileSync(new URL("../components/Menu.tsx", import.meta.url), "utf8");
  assert.match(menu, /i\.note/);
});

test("the account menu's top: the name, then the username", () => {
  assert.deepEqual(accountHeader({ name: "Tess", sub: "tess.vyre.run" }), { name: "Tess", handle: "@tess" });
  assert.deepEqual(accountHeader({ name: "", sub: "" }), { name: "You", handle: "" });
  assert.deepEqual(accountHeader({ name: "tess", sub: "tess" }), { name: "tess", handle: "" });
});
