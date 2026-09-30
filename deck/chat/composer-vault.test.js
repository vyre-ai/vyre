// @ts-check
// "#" in the composer: a vault picker by item name (never a value), a "#name" token in the draft, a chip
// under the box, and the very first character still the save-a-memory mode. Sample world only.

import { test } from "node:test";
import assert from "node:assert/strict";
import { install, $, $$, text } from "../test/fake-dom.js";
import { findVaultMention, applyVault, vaultTokens, rankVault, vaultToken, draftKind } from "./core/composer-state.js";

const doc = /** @type {any} */ (install());
doc.importNode = n => n;
doc.createDocumentFragment = () => new /** @type {any} */ (globalThis).Element("fragment");
Object.assign(globalThis, {
  DOMParser: class { parseFromString() { const E = /** @type {any} */ (globalThis).Element; const svg = new E("svg"); svg.append(new E("circle")); return { documentElement: svg }; } },
  CustomEvent: class extends /** @type {any} */ (globalThis).Event { constructor(t, o) { super(t); this.detail = o?.detail; } },
  dispatchEvent: () => true,
});
const calls = /** @type {any[]} */ ([]);
const NAMES = [{ name: "GHLapikey", kind: "api key", hosts: ["services.leadconnectorhq.com"] }, { name: "Gmail app password", kind: "password", hosts: ["smtp.gmail.com"] }, { name: "Stripe", kind: "api key", hosts: ["api.stripe.com"] }];
globalThis.fetch = /** @type {any} */ (async (url, o) => {
  const tool = decodeURIComponent(String(url).split("/v1/tools/")[1]);
  calls.push({ tool, input: JSON.parse(o.body) });
  if (tool === "vault.items.names") return { status: 200, statusText: "", json: async () => ({ data: { names: NAMES } }) };
  return { status: 200, statusText: "", json: async () => ({ data: {} }) };
});
const { mountComposer } = await import("./composer.js");
const thread = () => "vault-test-" + Math.random().toString(36).slice(2);
const settle = () => new Promise(r => setTimeout(r, 15));
function type(c, value, caret = value.length) {
  c.input.value = value; c.input.setSelectionRange(caret, caret);
  c.input.dispatchEvent(new /** @type {any} */ (globalThis).Event("input"));
}

test("findVaultMention: a # after a space or bracket, never the first character, never inside a word", () => {
  assert.deepEqual(findVaultMention("Use #GHL", 8), { start: 4, end: 8, query: "GHL" });
  assert.deepEqual(findVaultMention("Use (#", 6), { start: 5, end: 6, query: "" });
  assert.equal(findVaultMention("#GHL", 4), null, "the first character is the memory mode");
  assert.equal(findVaultMention("issue#12", 8), null);
  assert.equal(findVaultMention("Use #GHL now", 12), null, "the caret is past the word");
  assert.equal(draftKind("#note"), "memory");
});

test("applyVault and vaultToken: a plain name as it is, a name with spaces quoted", () => {
  assert.equal(vaultToken("GHLapikey"), "#GHLapikey");
  assert.equal(vaultToken("Gmail app password"), '#"Gmail app password"');
  assert.deepEqual(applyVault("Use #GH to inventory", { start: 4, end: 7, query: "GH" }, "GHLapikey"), { text: "Use #GHLapikey to inventory", caret: 15 });
});

test("vaultTokens: only real items, quoted or not, never a # at the start", () => {
  const names = new Set(["GHLapikey", "Gmail app password"]);
  assert.deepEqual(vaultTokens('Use #GHLapikey and #"Gmail app password" and #123 and #Other', names).map(t => t.name), ["GHLapikey", "Gmail app password"]);
  assert.deepEqual(vaultTokens("#GHLapikey note", names), []);
});

test("rankVault: names that start with the query first, then containing it", () => {
  assert.deepEqual(rankVault(NAMES, "g").map(i => i.name), ["GHLapikey", "Gmail app password"]);
  assert.deepEqual(rankVault(NAMES, "app").map(i => i.name), ["Gmail app password"], "containing, not only starting");
  assert.deepEqual(rankVault([{ name: "Zapier" }, { name: "App" }], "ap").map(i => i.name), ["App", "Zapier"], "starting first");
  assert.equal(rankVault(NAMES, "zzz").length, 0);
});

test("typing # after a word opens the picker with names, kind and hosts; only names are asked for", async () => {
  calls.length = 0;
  const c = mountComposer({ thread: thread() });
  type(c, "Use #");
  await settle();
  const rows = $$(c.el, "[role=option]");
  assert.equal(rows.length, 3);
  assert.match(text(rows[0]), /#GHLapikey.*services\.leadconnectorhq\.com.*api key/);
  assert.equal(calls.filter(x => x.tool === "vault.items.names").length, 1);
  type(c, "Use #st");
  await settle();
  assert.deepEqual($$(c.el, "[role=option]").map(r => r.getAttribute("data-key")), ["Stripe"]);
  assert.equal(calls.filter(x => x.tool === "vault.items.names").length, 1, "one read per open, filtered here");
  c.stop();
});

test("picking inserts the token, closes the picker and shows a chip that removes it", async () => {
  const c = mountComposer({ thread: thread(), session: /** @type {any} */ ({ mode: "default", model: "sonnet", thinking: null, state: "idle" }) });
  type(c, "Use #gm");
  await settle();
  $$(c.el, "[role=option]")[0].dispatchEvent(new /** @type {any} */ (globalThis).Event("click"));
  assert.equal(c.value(), 'Use #"Gmail app password" ');
  assert.equal($$(c.el, "[role=option]").length, 0);
  const chip = $(c.el, "[data-vault]");
  assert.equal(chip.getAttribute("data-vault"), "Gmail app password");
  $(chip, "button").dispatchEvent(new /** @type {any} */ (globalThis).Event("click"));
  assert.equal(c.value().trim(), "Use");
  assert.equal($(c.el, "[data-vault]"), null);
  c.stop();
});

test("a # first character stays the memory mode: no picker, no vault read", async () => {
  calls.length = 0;
  const c = mountComposer({ thread: thread() });
  type(c, "#remember this");
  await settle();
  assert.equal($$(c.el, "[role=option]").length, 0);
  assert.equal(calls.filter(x => x.tool === "vault.items.names").length, 0);
  c.stop();
});
