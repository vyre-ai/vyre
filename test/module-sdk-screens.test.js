// A module's screens are held to the design language: the manifest check refuses a screen outside it, in the words an agent reads from the Design MCP.
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkManifest } from "../packages/module-sdk/manifest.js";

const base = () => ({
  vyre: "1", name: "bakery", version: "0.1.0", description: "Northwind Bakery's orders.", roles: ["box"], requires: [],
  does: { tools: [{ name: "bakery.orders", summary: "today's orders", reach: "anyone" }, { name: "bakery.count", summary: "counts", reach: "anyone" }] },
  watches: {}, needs: {}, teaches: {},
});
const screen = () => ({
  v: 2, layout: { col: [{ block: "k" }, { block: "o" }] },
  blocks: { k: { type: "stats", data: { tool: "bakery.count", map: { items: "totals", label: "name", value: "n" } } }, o: { type: "list", data: { tool: "bakery.orders", map: { rows: "orders", id: "id", title: "who" } } } },
});
const withScreen = (/** @type {any} */ s) => ({ ...base(), views: { today: { title: "Today", screen: s } } });
const problems = (/** @type {any} */ m, firstParty = false) => checkManifest(m, { firstParty }).filter(p => /screen/.test(String(p)));

test("module screens: a valid screen over the module's own tools passes", () => {
  assert.deepEqual(problems(withScreen(screen())), []);
  assert.deepEqual(checkManifest(withScreen(screen())), [], "the whole manifest is clean");
});

test("module screens: a block outside the catalogue, a style, a foreign tool and a mixed view are each refused with the fix", () => {
  const s = screen(); s.blocks.k.type = "sparkle";
  assert.match(problems(withScreen(s)).join("\n"), /views\.today\.screen: blocks\.k\.type "sparkle" is not a block/);
  const c = screen(); /** @type {any} */ (c.blocks.k).props = { color: "#f00" };
  assert.match(problems(withScreen(c)).join("\n"), /props\.color is not a prop of stats; use tone/);
  const t = screen(); t.blocks.o.data.tool = "vault.list";
  assert.match(problems(withScreen(t)).join("\n"), /"vault\.list" is not one of this module's tools/);
  const mixed = withScreen(screen()); /** @type {any} */ (mixed.views.today).list = { tool: "bakery.orders", map: {} };
  assert.match(problems(mixed).join("\n"), /a screen replaces list, board, summary and form/);
});

test("module screens: a view: entry in shows.capsule may carry a screen instead of a list", () => {
  const m = { ...base(), shows: { capsule: { "view:today": { title: "Today", screen: screen() } } } };
  assert.deepEqual(checkManifest(m), []);
  const bad = screen(); bad.layout = { col: [{ block: "zz" }] };
  assert.match(checkManifest({ ...base(), shows: { capsule: { "view:today": { title: "Today", screen: bad } } } }).join("\n"), /layout names block "zz"/);
});
