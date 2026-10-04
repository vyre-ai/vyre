// @ts-check
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { install, text, $, $$ } from "./fake-dom.js";

const doc = /** @type {any} */ (install());
doc.importNode = n => n;
Object.assign(globalThis, { dispatchEvent: () => true, DOMParser: class { parseFromString() { return { documentElement: doc.createElement("svg") }; } } });
const { drawAccounts, accountsOf, stateWord, safeUrl } = await import("../views/settings-accounts.js");

const ROWS = [
  { id: "c1", provider: "claude", label: "Claude", kind: "login", synthetic: true, is_default: true },
  { id: "x1", provider: "codex", label: "Work", kind: "login", signed_in_at: 1, identity: { email: "a@b.co", org: "Acme" }, is_default: true },
  { id: "x2", provider: "codex", label: "Home", kind: "login", signed_in_at: null },
  { id: "g1", provider: "grok", label: "xAI", kind: "login", signed_in_at: 1, privacy: true, privacy_label: "Privacy mode on: xAI does not keep this account's sessions; Grok cannot make video.", privacy_note: "Change it in Grok's /privacy settings; Vyre shows what you chose." },
  { id: "o1", provider: "openrouter", label: "Key", kind: "api-key", vault_item: "or-key" },
];
function mount(answers) {
  const calls = [];
  let alive = true;
  const attempt = async (tool, input = {}) => { calls.push({ tool, input }); const a = await (typeof answers[tool] === "function" ? answers[tool](input, calls) : answers[tool]); return a && a.$error ? { error: a.$error } : a === undefined ? { error: { missing: true } } : { data: a }; };
  const el = doc.createElement("div");
  return { el, calls, stop: () => { alive = false; }, run: () => drawAccounts(el, { alive: () => alive }, { attempt }) };
}
const ev = n => new /** @type {any} */ (globalThis).Event(n);
const settle = () => new Promise(r => setTimeout(r, 15));

test("each account says who it is and where it stands, in words; a key or token is never shown", () => {
  const rows = accountsOf(ROWS);
  assert.deepEqual(rows.map(stateWord), ["Signed in on this machine", "Signed in as a@b.co, Acme", "Not signed in yet", "Signed in", "API key"]);
  assert.equal(stateWord({ ...rows[1], needs: "sign-in" }), "Needs signing in again");
  assert.equal(stateWord({ ...rows[1], pending: true, needs: null }), "Waiting for you to finish it");
  assert.equal(safeUrl("https://auth.openai.com/codex/device"), true);
  assert.equal(safeUrl("javascript:alert(1)"), false);
  assert.equal(safeUrl("https://user:pw@evil.example/x"), false);
});

test("the list: default marked, Make default only where a provider has two, Remove asks first, Claude on this machine cannot be removed", async () => {
  const m = mount({ "sessions.accounts.list": ROWS, "sessions.accounts.bind": {}, "sessions.accounts.remove": {} });
  await m.run();
  assert.equal($$(m.el, "[data-account]").length, 5);
  assert.match(text($("[data-account=x1]" && m.el, "[data-account=x1]")), /Default/);
  assert.equal($(m.el, "[data-account=x2] [data-act=default]") !== null, true);
  assert.equal($(m.el, "[data-account=x1] [data-act=default]"), null);
  assert.equal($(m.el, "[data-account=g1] [data-act=default]"), null, "one Grok account: nothing to choose");
  assert.equal($(m.el, "[data-account=c1] [data-act=remove]"), null);
  $(m.el, "[data-account=x2] [data-act=default]").dispatchEvent(ev("click")); await settle();
  assert.deepEqual(m.calls.find(c => c.tool === "sessions.accounts.bind")?.input, { id: "x2", is_default: true });
  $(m.el, "[data-account=o1] [data-act=remove]").dispatchEvent(ev("click"));
  assert.equal(m.calls.filter(c => c.tool === "sessions.accounts.remove").length, 0, "asks first");
  $(m.el, "[data-account=o1] [data-act=remove-yes]").dispatchEvent(ev("click")); await settle();
  assert.deepEqual(m.calls.find(c => c.tool === "sessions.accounts.remove")?.input, { id: "o1" });
  m.stop();
});

test("Add: signing in shows the page and code, follows the flow, and reloads when it is done; Cancel stops following", async () => {
  let polls = 0;
  const m = mount({
    "sessions.accounts.list": ROWS,
    "sessions.accounts.signin": async i => {
      if (i.flow) { polls++; await new Promise(r => setTimeout(r, 40)); return polls < 2 ? { flow: "f1", step: "waiting" } : { flow: "f1", step: "done" }; }
      return { flow: "f1", step: "code", url: "https://auth.openai.com/codex/device", code: "ABCD-1234" };
    } });
  await m.run();
  $(m.el, "[data-act=add]").dispatchEvent(ev("click"));
  $(m.el, "[data-f=provider]").value = "codex"; $(m.el, "[data-f=label]").value = "Team";
  $(m.el, "[data-form=account]").dispatchEvent(ev("submit")); await settle();
  assert.deepEqual(m.calls.find(c => c.tool === "sessions.accounts.signin")?.input, { provider: "codex", label: "Team" });
  assert.match(text(m.el), /ABCD-1234/);
  assert.equal($(m.el, "[data-act=flow-open]").getAttribute("href"), "https://auth.openai.com/codex/device");
  await new Promise(r => setTimeout(r, 160));
  assert.equal(m.calls.filter(c => c.tool === "sessions.accounts.list").length, 2, "reloaded once done");
  assert.equal($(m.el, "[data-flow-code]"), null, "the panel is gone");
  m.stop();
});

test("a sign-in address that is not plain https is text, never a link; a failed sign-in says so; a box with no accounts says that", async () => {
  const m = mount({ "sessions.accounts.list": [], "sessions.accounts.signin": i => i.flow ? { flow: "f", step: "failed", message: "The code expired." } : { flow: "f", step: "code", url: "javascript:alert(1)", code: "X" } });
  await m.run();
  assert.match(text(m.el), /No AI accounts yet/);
  $(m.el, "[data-act=add]").dispatchEvent(ev("click"));
  $(m.el, "[data-form=account]").dispatchEvent(ev("submit")); await settle();
  assert.equal($(m.el, "[data-act=flow-open]"), null);
  await new Promise(r => setTimeout(r, 30));
  assert.match(text(m.el), /did not finish\. The code expired\./);
  m.stop();
  const none = mount({}); await none.run();
  assert.match(text(none.el), /no AI accounts/i);
});
