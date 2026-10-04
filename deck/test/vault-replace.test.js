// @ts-check
// An API credential is never read back, so the Deck offers "Replace the key" for it and never Edit;
// replacing sends only the new key through vault.put, which keeps the credential's hosts and readers.

import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";

async function load() {
  const dom = await import("./fake-dom.js");
  dom.install();
  /** @type {any} */ (globalThis).DOMParser = class { parseFromString() { const s = document.createElement("svg"); s.append(document.createElement("circle")); return { documentElement: s }; } };
  /** @type {any} */ (document).importNode = (/** @type {any} */ n) => n;
  /** @type {any} */ (document).createElementNS = (/** @type {string} */ _ns, /** @type {string} */ tag) => document.createElement(tag);
  const item = await import("../views/vault-item.js");
  const edit = await import("../views/vault-edit.js");
  return { ...dom, ...item, ...edit };
}

function appWith(/** @type {any[]} */ items, /** @type {any[]} */ calls = []) {
  const opened = /** @type {any[]} */ ([]);
  const app = {
    host: "your server",
    st: { items, caps: {}, fav: new Set(), places: [], uses: {}, passes: [], pending: { grants: [], passes: [] }, health: null },
    vc: { has: () => false, call: async (/** @type {string} */ tool, /** @type {any} */ input) => { calls.push({ tool, input }); return { data: {} }; } },
    ctx: { cleanup() {}, alive: () => true },
    onPane() {}, open: (/** @type {any} */ p) => opened.push(p), close() {}, load: async () => {}, favorite() {}, share() {}, copy() {},
  };
  return { app, opened };
}

const credential = { name: "ms-graph", kind: "api-credential", kindLabel: "API credential", fields: ["config"], hosts: ["graph.example.test"], description: "", grants: [], holders: [], updated: 0 };
const apiKey = { name: "billing-key", kind: "api-key", kindLabel: "API key", fields: ["value"], hosts: [], description: "", grants: [], holders: [], updated: 0 };

test("the item pane offers Replace the key for an API credential and Edit for everything else", async () => {
  const lib = await load();
  for (const [it, want, not] of [[credential, "Replace the key", "Edit"], [apiKey, "Edit", "Replace the key"]]) {
    const panel = document.createElement("div");
    const { app, opened } = appWith([it]);
    try { lib.itemPane(app, panel, it.name, false); } catch (e) { assert.fail(`itemPane threw: ${/** @type {Error} */ (e).message}`); }
    const buttons = lib.$$(panel, "button").map((/** @type {any} */ b) => lib.text(b).trim());
    assert.ok(buttons.includes(want), `${it.kind}: ${JSON.stringify(buttons)}`);
    assert.ok(!buttons.includes(not), `${it.kind} has no ${not}`);
    const b = lib.$$(panel, "button").find((/** @type {any} */ x) => lib.text(x).trim() === want);
    b.click();
    assert.deepEqual(opened.at(-1), { mode: it === credential ? "replace" : "edit", name: it.name });
  }
});

test("replacing the key sends only the new key through vault.put", async () => {
  const lib = await load();
  const panel = document.createElement("div");
  const calls = /** @type {any[]} */ ([]);
  const { app, opened } = appWith([credential], calls);
  lib.replaceKeyPane(app, panel, "ms-graph", false);
  assert.match(lib.text(panel), /Replace the key for ms-graph/);
  const input = lib.$(panel, "input");
  input.value = "fixture-new-key-000000";
  const form = lib.$(panel, "form");
  await Promise.all(form.dispatchEvent({ type: "submit", preventDefault() {} }));
  assert.deepEqual(calls, [{ tool: "vault.put", input: { name: "ms-graph", kind: "api-credential", fields: { secret: "fixture-new-key-000000" } } }]);
  assert.equal(input.value, "", "your server is cleared at once");
  assert.deepEqual(opened.at(-1), { mode: "item", name: "ms-graph" });
});
