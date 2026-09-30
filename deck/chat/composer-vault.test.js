// @ts-check
// "#" in the composer: one universal tag (mentions.search: vault items, artifacts, files, repos, projects; names
// only, grouped by kind), a "#name" token in the draft, a chip under the box that carries {kind, id}, and
// "/remember" as the save-a-memory mode. Sample world only.

import { test } from "node:test";
import assert from "node:assert/strict";
import { install, $, $$, text } from "../test/fake-dom.js";
import { createSession } from "./core/session-state.js";
import { findVaultMention, applyVault, vaultTokens, vaultToken, draftKind, draftBody } from "./core/composer-state.js";

const doc = /** @type {any} */ (install());
doc.importNode = n => n;
doc.createDocumentFragment = () => new /** @type {any} */ (globalThis).Element("fragment");
Object.assign(globalThis, {
  DOMParser: class { parseFromString() { const E = /** @type {any} */ (globalThis).Element; const svg = new E("svg"); svg.append(new E("circle")); return { documentElement: svg }; } },
  CustomEvent: class extends /** @type {any} */ (globalThis).Event { constructor(t, o) { super(t); this.detail = o?.detail; } },
  dispatchEvent: () => true,
});
const calls = /** @type {any[]} */ ([]);
const RESULTS = [
  { kind: "github", id: "harlow/site#4", name: "site-pr-4", hint: "harlow/site", label: "GitHub" },
  { kind: "vault", id: "it-1", name: "GHLapikey", hint: "services.leadconnectorhq.com", label: "Vault" },
  { kind: "artifact", id: "a1", name: "Menu page", hint: "page", label: "Artifacts" },
  { kind: "vault", id: "it-2", name: "Stripe", hint: "api.stripe.com", label: "Vault" },
];
const NAMES = [{ name: "GHLapikey", kind: "api key", hosts: ["services.leadconnectorhq.com"] }, { name: "Gmail app password", kind: "password", hosts: ["smtp.gmail.com"] }, { name: "Stripe", kind: "api key", hosts: ["api.stripe.com"] }];
globalThis.fetch = /** @type {any} */ (async (url, o) => {
  const tool = decodeURIComponent(String(url).split("/v1/tools/")[1]);
  calls.push({ tool, input: JSON.parse(o.body) });
  if (tool === "mentions.search") {
    const q = String(JSON.parse(o.body).q || "").toLowerCase();
    const results = RESULTS.filter(r => r.name.toLowerCase().includes(q));
    return { status: 200, statusText: "", json: async () => ({ data: { results } }) };
  }
  return { status: 200, statusText: "", json: async () => ({ data: {} }) };
});
const { mountComposer } = await import("./composer.js");
const thread = () => "vault-test-" + Math.random().toString(36).slice(2);
const settle = () => new Promise(r => setTimeout(r, 200));
function type(c, value, caret = value.length) {
  c.input.value = value; c.input.setSelectionRange(caret, caret);
  c.input.dispatchEvent(new /** @type {any} */ (globalThis).Event("input"));
}

test("findVaultMention: a # at the start or after a space or bracket, never inside a word", () => {
  assert.deepEqual(findVaultMention("Use #GHL", 8), { start: 4, end: 8, query: "GHL" });
  assert.deepEqual(findVaultMention("Use (#", 6), { start: 5, end: 6, query: "" });
  assert.deepEqual(findVaultMention("#GHL", 4), { start: 0, end: 4, query: "GHL" }, "the first character opens it too");
  assert.equal(findVaultMention("issue#12", 8), null);
  assert.equal(findVaultMention("Use #GHL now", 12), null, "the caret is past the word");
});

test("/remember is the memory mode, # is no longer", () => {
  assert.equal(draftKind("/remember the lease ends in May"), "memory");
  assert.equal(draftBody("/remember the lease ends in May"), "the lease ends in May");
  assert.equal(draftKind("/remember"), "memory");
  assert.equal(draftKind("#GHLapikey"), "message");
  assert.equal(draftKind("/rewind"), "command");
});

test("applyVault and vaultToken: a plain name as it is, a name with spaces quoted", () => {
  assert.equal(vaultToken("GHLapikey"), "#GHLapikey");
  assert.equal(vaultToken("Menu page"), '#"Menu page"');
  assert.deepEqual(applyVault("Use #GH to inventory", { start: 4, end: 7, query: "GH" }, "GHLapikey"), { text: "Use #GHLapikey to inventory", caret: 15 });
});

test("vaultTokens: only picked names, quoted or not, at the start too", () => {
  const names = new Set(["GHLapikey", "Menu page"]);
  assert.deepEqual(vaultTokens('Use #GHLapikey and #"Menu page" and #123 and #Other', names).map(t => t.name), ["GHLapikey", "Menu page"]);
  assert.deepEqual(vaultTokens("#GHLapikey first", names).map(t => t.name), ["GHLapikey"]);
});

test("typing # opens one picker over every kind, grouped, names and hints only; # first works", async () => {
  calls.length = 0;
  const c = mountComposer({ thread: thread() });
  type(c, "#");
  await settle();
  const rows = $$(c.el, "[role=option]");
  assert.deepEqual(rows.map(r => r.getAttribute("data-key")), ["vault:it-1", "vault:it-2", "artifact:a1", "github:harlow/site#4"].sort((a, b) => order(a) - order(b) || 0));
  assert.deepEqual($$(c.el, ".cv-menu-group").map(g => text(g)), ["Vault", "Artifacts", "GitHub"]);
  assert.match(text(rows[0]), /#GHLapikey.*services\.leadconnectorhq\.com/);
  assert.deepEqual(calls.filter(x => x.tool === "mentions.search")[0].input, { q: "", limit: 30 });
  type(c, "Use #st");
  await settle();
  assert.deepEqual($$(c.el, "[role=option]").map(r => r.getAttribute("data-key")), ["vault:it-2"]);
  c.stop();
});
const order = k => ["vault", "artifact", "drive", "github"].indexOf(k.split(":")[0]);

test("picking inserts the token and a chip that carries {kind, id}; the turn goes out with mentions", async () => {
  calls.length = 0;
  const th = thread();
  const c = mountComposer({ thread: th, session: createSession(th) });
  type(c, "Read #men");
  await settle();
  $$(c.el, "[role=option]")[0].dispatchEvent(new /** @type {any} */ (globalThis).Event("click"));
  assert.equal(c.value(), 'Read #"Menu page" ');
  const chip = $(c.el, "[data-vault]");
  assert.equal(chip.getAttribute("data-vault"), "Menu page");
  assert.equal(chip.getAttribute("data-kind"), "artifact");
  type(c, c.value() + "and summarise it");
  c.input.dispatchEvent(Object.assign(new /** @type {any} */ (globalThis).Event("keydown"), { key: "Enter", target: c.input }));
  await settle();
  const sent = calls.find(x => x.tool === "threads.send");
  assert.ok(sent, "sent");
  assert.deepEqual(sent.input.mentions, [{ kind: "artifact", id: "a1", name: "Menu page" }]);
  assert.match(sent.input.text, /#"Menu page"/);
  c.stop();
});

test("the chip's x takes the token out of the words and the tag with it", async () => {
  const c = mountComposer({ thread: thread(), session: /** @type {any} */ ({ mode: "default", model: "sonnet", thinking: null, state: "idle" }) });
  type(c, "Use #gh");
  await settle();
  $$(c.el, "[role=option]")[0].dispatchEvent(new /** @type {any} */ (globalThis).Event("click"));
  $(c.el, "[data-vault] button").dispatchEvent(new /** @type {any} */ (globalThis).Event("click"));
  assert.equal(c.value().trim(), "Use");
  assert.equal($(c.el, "[data-vault]"), null);
  c.stop();
});

test("no mentions provider on the box: no picker, nothing offered", async () => {
  const keep = globalThis.fetch;
  globalThis.fetch = /** @type {any} */ (async () => ({ status: 404, statusText: "", json: async () => ({ error: { code: "no_such_tool", message: "no such tool: mentions.search" } }) }));
  const c = mountComposer({ thread: thread() });
  type(c, "Use #");
  await settle();
  assert.equal($$(c.el, "[role=option]").length, 0);
  globalThis.fetch = keep;
  c.stop();
});
