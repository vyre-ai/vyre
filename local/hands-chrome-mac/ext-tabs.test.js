// @ts-check
// tabs.*: reuse before open, focus only on request, blind tabs hidden, close only what Vyre opened.
import test from "node:test";
import assert from "node:assert/strict";
import { createCtx } from "./extension/lib/ctx.js";
import { dispatch } from "./extension/caps/index.js";
import { createFakeChrome } from "./test-support/fake-chrome.js";

const world = () => {
  const chrome = createFakeChrome([
    { url: "https://app.northwind.example/inbox", title: "Inbox", active: false },
    { url: "https://app.northwind.example/contacts/new", title: "New contact", active: true },
    { url: "https://app.northwind.example/contacts/7#notes", title: "Contact 7", active: false },
    { url: "https://harlow.example/", title: "Harlow Legal", active: false, windowId: 2 },
    { url: "chrome://settings", title: "Settings" },
    { url: "https://my.1password.com/vaults", title: "Vault of alex" },
  ]);
  return { chrome, ctx: createCtx({ chrome }) };
};

test("tabs.list floors blind tabs to url [blind] and empty title", async () => {
  const { ctx } = world();
  const { tabs } = await dispatch("tabs.list", {}, ctx);
  assert.equal(tabs.length, 6);
  const settings = tabs.find(t => t.id === 5);
  assert.deepEqual([settings.url, settings.title], ["[blind]", ""]);
  assert.deepEqual([tabs.find(t => t.id === 6).url, tabs.find(t => t.id === 6).title], ["[blind]", ""]);
  assert.equal(tabs.find(t => t.id === 1).title, "Inbox");
  assert.deepEqual(Object.keys(tabs[0]).sort(), ["active", "id", "opened", "title", "url", "windowId"]);
});

test("tabs.list redacts secrets in urls", async () => {
  const { chrome, ctx } = world();
  chrome._.tabs[0].url = "https://app.northwind.example/cb?access_token=abcdef123456&x=1";
  const { tabs } = await dispatch("tabs.list", {}, ctx);
  assert.ok(!tabs[0].url.includes("abcdef123456"));
  assert.ok(tabs[0].url.includes("x=1"));
});

test("tabs.use reuses an existing tab: exact url wins, no tab is created, nothing focused", async () => {
  const { chrome, ctx } = world();
  const r = await dispatch("tabs.use", { url: "https://app.northwind.example/inbox" }, ctx);
  assert.deepEqual([r.id, r.reused, r.matched], [1, true, "exact url"]);
  assert.equal(chrome._.counts.create, 0);
  assert.equal(chrome._.counts.update, 0);
});

test("tabs.use ignores the hash for an exact match, then falls to origin+path, then origin", async () => {
  const { chrome, ctx } = world();
  assert.equal((await dispatch("tabs.use", { url: "https://app.northwind.example/contacts/7" }, ctx)).id, 3);
  const p = await dispatch("tabs.use", { url: "https://app.northwind.example/contacts/9" }, ctx);
  // same origin, path prefix /contacts/9 matches nothing, so same origin: the active tab is preferred
  assert.deepEqual([p.id, p.matched], [2, "same origin"]);
  const q = await dispatch("tabs.use", { url: "https://app.northwind.example/contacts" }, ctx);
  assert.deepEqual([q.matched], ["same origin and path"]);
  assert.equal(q.id, 2, "the active tab beats the older one within the tier");
  assert.equal(chrome._.counts.create, 0);
});

test("tabs.use by origin or title never opens a tab and never focuses", async () => {
  const { chrome, ctx } = world();
  assert.equal((await dispatch("tabs.use", { match: { origin: "https://harlow.example" } }, ctx)).id, 4);
  assert.equal((await dispatch("tabs.use", { match: { title: "contact 7" } }, ctx)).id, 3);
  assert.equal(chrome._.counts.create + chrome._.counts.update, 0);
});

test("tabs.use focuses only with focus:true", async () => {
  const { chrome, ctx } = world();
  await dispatch("tabs.use", { url: "https://harlow.example/", focus: true }, ctx);
  assert.equal(chrome._.counts.update, 1);
  assert.equal(chrome._.tabs.find(t => t.id === 4).active, true);
});

test("tabs.use opens only when nothing matches, a url is given and openIfMissing is not false", async () => {
  const { chrome, ctx } = world();
  await assert.rejects(dispatch("tabs.use", { match: { origin: "https://nowhere.example" } }, ctx), { code: "no_tab" });
  await assert.rejects(dispatch("tabs.use", { url: "https://nowhere.example/", openIfMissing: false }, ctx), { code: "no_tab" });
  assert.equal(chrome._.counts.create, 0);
  const r = await dispatch("tabs.use", { url: "https://nowhere.example/" }, ctx);
  assert.deepEqual([r.opened, r.reused], [true, false]);
  assert.equal(chrome._.counts.create, 1);
  assert.equal(chrome._.created[0].active, false, "opened in the background");
  // and the second call reuses what the first opened
  const again = await dispatch("tabs.use", { url: "https://nowhere.example/" }, ctx);
  assert.deepEqual([again.id, again.reused], [r.id, true]);
  assert.equal(chrome._.counts.create, 1);
});

test("blind tabs never match, and a blind url is never opened", async () => {
  const { chrome, ctx } = world();
  await assert.rejects(dispatch("tabs.use", { match: { title: "vault" }, openIfMissing: false }, ctx), { code: "no_tab" });
  await assert.rejects(dispatch("tabs.use", { url: "https://my.1password.com/vaults", openIfMissing: false }, ctx), { code: "no_tab" });
  await assert.rejects(dispatch("tabs.open", { url: "https://vault.bitwarden.com/" }, ctx), { code: "blocked" });
  await assert.rejects(dispatch("tabs.use", { url: "https://accounts.google.com/signin" }, ctx), { code: "blocked" });
  assert.equal(chrome._.counts.create, 0);
});

test("tabs.close closes only tabs Vyre opened, and forgets them", async () => {
  const { chrome, ctx } = world();
  await assert.rejects(dispatch("tabs.close", { tabId: 1 }, ctx), { code: "blocked" });
  assert.equal(chrome._.counts.remove, 0);
  const o = await dispatch("tabs.open", { url: "https://harlow.example/new" }, ctx);
  assert.equal((await dispatch("tabs.list", {}, ctx)).tabs.find(t => t.id === o.id).opened, true);
  await dispatch("tabs.close", { tabId: o.id }, ctx);
  assert.equal(chrome._.counts.remove, 1);
  await assert.rejects(dispatch("tabs.close", { tabId: o.id }, ctx), { code: "no_tab" });
});

test("tabs.navigate and tabs.activate", async () => {
  const { chrome, ctx } = world();
  const r = await dispatch("tabs.navigate", { tabId: 1, url: "https://app.northwind.example/orders" }, ctx);
  assert.equal(r.id, 1);
  assert.equal(chrome._.tabs[0].url, "https://app.northwind.example/orders");
  await assert.rejects(dispatch("tabs.navigate", { tabId: 1, url: "https://chase.com/" }, ctx), { code: "blocked" });
  // navigating a blind tab is refused by dispatch's floor check (args.tabId)
  await assert.rejects(dispatch("tabs.navigate", { tabId: 5, url: "https://harlow.example/" }, ctx), { code: "blocked" });
  await dispatch("tabs.activate", { tabId: 3 }, ctx);
  assert.equal(chrome._.tabs.find(t => t.id === 3).active, true);
  await assert.rejects(dispatch("tabs.activate", { tabId: 5 }, ctx), { code: "blocked" });
});
