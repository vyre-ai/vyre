// @ts-check
// page.*: snapshot, act with holds, fill in one evaluate, eval redaction, wait, screenshot.
// The fake page (test-support/fake-chrome.js) answers the in-page scripts from a plain model.
import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { createCtx } from "./extension/lib/ctx.js";
import { dispatch } from "./extension/caps/index.js";
import page, { EXPRESSION, signatureOf, holdFor, resolve } from "./extension/caps/page.js";
import { createFakeChrome, createFakePage, samplePage } from "./test-support/fake-chrome.js";

const world = (model = samplePage()) => {
  const chrome = createFakeChrome([{ url: model.url, title: model.title, active: true }]);
  const fake = createFakePage(model);
  chrome._.cdp = (tabId, method, params) => fake.handler(tabId, method, params);
  return { chrome, fake, model, ctx: createCtx({ chrome }) };
};
const act = (ctx, args) => dispatch("page.act", { tabId: 1, ...args }, ctx);

test("every in-page script is valid JavaScript", async () => {
  new vm.Script(EXPRESSION);
  const { chrome, ctx } = world();
  const seen = [];
  chrome._.cdp = (t, m, p) => { if (m === "Runtime.evaluate") { new vm.Script(p.expression); seen.push(/^\/\*vyre:(\w+)/.exec(p.expression)[1]); } return createFakePage(samplePage()).handler(t, m, p); };
  await act(ctx, { selector: { role: "textbox", name: "Email" }, kind: "type", value: "a*/b" });
  await act(ctx, { selector: { name: "Cancel" }, kind: "click" });
  await dispatch("page.wait", { tabId: 1, idleMs: 5, timeoutMs: 500 }, ctx);
  await dispatch("page.wait", { tabId: 1, selector: "#done", timeoutMs: 200 }, ctx).catch(() => {});
  for (const k of ["snapshot", "apply", "locate", "quiet", "exists"]) assert.ok(seen.includes(k), k);
});

test("page.snapshot is one Runtime.evaluate and drops internals", async () => {
  const { chrome, ctx } = world();
  const s = await dispatch("page.snapshot", { tabId: 1 }, ctx);
  assert.equal(chrome._.commands.filter(c => c.method === "Runtime.evaluate").length, 1);
  assert.equal(s.controls.length, 7);
  assert.equal(s.named, 7);
  assert.ok(s.controls.every(c => !("fields" in c) && !("form" in c)));
  assert.ok(s.controls.some(c => c.submit));
});

test("page.snapshot defaults to the active tab and asks the floor", async () => {
  const { chrome, ctx } = world();
  assert.equal((await dispatch("page.snapshot", {}, ctx)).title, "New contact");
  chrome._.tabs[0].url = "https://my.1password.com/vaults";
  await assert.rejects(dispatch("page.snapshot", {}, ctx), { code: "blocked" });
  await assert.rejects(dispatch("page.snapshot", { tabId: 1 }, ctx), { code: "blocked" });
});

test("a safe click goes through Input.dispatchMouseEvent at the element centre after scrollIntoView", async () => {
  const { chrome, fake, ctx } = world();
  const r = await act(ctx, { selector: { role: "button", name: "Cancel" }, kind: "click" });
  assert.deepEqual([r.ok, r.did, r.control.name], [true, "click", "Cancel"]);
  assert.deepEqual(fake.clicks, [{ x: 60, y: 110 }]);
  const types = chrome._.commands.filter(c => c.method === "Input.dispatchMouseEvent").map(c => c.params.type);
  assert.deepEqual(types, ["mouseMoved", "mousePressed", "mouseReleased"]);
});

test("a click covered by another element is refused, not guessed", async () => {
  const { fake, ctx } = world();
  fake.covered = true;
  await assert.rejects(act(ctx, { selector: "Cancel", kind: "click" }), { code: "covered" });
  assert.equal(fake.clicks.length, 0);
});

test("selectors: not_found, tied, and a bare role is not enough", async () => {
  const { model, ctx } = world();
  await assert.rejects(act(ctx, { selector: { name: "Nope" }, kind: "click" }), { code: "not_found" });
  await assert.rejects(act(ctx, { selector: { role: "button" }, kind: "click" }), { code: "bad_request" });
  model.controls.push({ ...model.controls[3], path: "button[9]" });
  await assert.rejects(act(ctx, { selector: { name: "Cancel" }, kind: "click" }), { code: "tied" });
  assert.equal(resolve({ name: "Cancel", path: "button[9]" }, model.controls).control.path, "button[9]");
});

test("a real submit button is held, not clicked, with fields and a signature", async () => {
  const { fake, ctx } = world();
  const r = await act(ctx, { selector: { role: "button", name: "Save contact" }, kind: "click" });
  assert.deepEqual([r.ok, r.held], [false, true]);
  assert.match(r.why, /submit/);
  assert.equal(r.control.name, "Save contact");
  assert.deepEqual(r.fields, { name: "Alex Harlow", email: "alex@harlow.example", password: "[secret]" });
  assert.match(r.sig, /^[0-9a-f]{14}$/);
  assert.deepEqual(r.selector.name, "Save contact");
  assert.equal(fake.clicks.length, 0);
});

test("a control the consequence rules flag is held even when it is not a submit", async () => {
  const { fake, ctx } = world();
  const r = await act(ctx, { selector: { name: "Send message" }, kind: "click" });
  assert.equal(r.held, true);
  assert.match(r.why, /cannot be undone/);
  assert.equal(fake.clicks.length, 0);
  // and a nameless control cannot be judged, so it is held too
  const { model, ctx: c2, fake: f2 } = world();
  model.controls.push({ path: "button[7]", role: "button", nameless: true, identifier: "menu", enabled: true, frame: { x: 1, y: 1, w: 5, h: 5 } });
  assert.equal((await act(c2, { selector: { identifier: "menu" }, kind: "click" })).held, true);
  assert.equal(f2.clicks.length, 0);
});

test("release with an unchanged signature performs the held click", async () => {
  const { fake, ctx } = world();
  const held = await act(ctx, { selector: { name: "Save contact" }, kind: "click" });
  const r = await act(ctx, { selector: { name: "Save contact" }, kind: "click", release: { sig: held.sig } });
  assert.deepEqual([r.ok, r.did], [true, "click"]);
  assert.equal(fake.clicks.length, 1);
});

test("release after a field changed fails with code changed and clicks nothing", async () => {
  const { fake, model, ctx } = world();
  const held = await act(ctx, { selector: { name: "Save contact" }, kind: "click" });
  await dispatch("page.fill", { tabId: 1, fields: [{ selector: { name: "Email" }, value: "someone.else@harlow.example" }] }, ctx);
  await assert.rejects(act(ctx, { selector: { name: "Save contact" }, kind: "click", release: { sig: held.sig } }), { code: "changed" });
  assert.equal(fake.clicks.length, 0);
  // the new state signs differently, and a release with that new signature works
  const again = await act(ctx, { selector: { name: "Save contact" }, kind: "click" });
  assert.notEqual(again.sig, held.sig);
  assert.equal((await act(ctx, { selector: { name: "Save contact" }, kind: "click", release: { signature: again.sig } })).ok, true);
  void model;
});

test("release after the page moved to another url also fails", async () => {
  const { model, ctx, fake } = world();
  const held = await act(ctx, { selector: { name: "Save contact" }, kind: "click" });
  model.url = "https://app.northwind.example/contacts/other";
  await assert.rejects(act(ctx, { selector: { name: "Save contact" }, kind: "click", release: { sig: held.sig } }), { code: "changed" });
  assert.equal(fake.clicks.length, 0);
});

test("the signature ignores a hash fragment but tracks password length", () => {
  const { model } = world();
  const snap = m => ({ url: m.url, controls: m.controls });
  const btn = model.controls[4];
  const a = signatureOf(snap(model), btn);
  model.url = "https://app.northwind.example/contacts/new#other";
  assert.equal(signatureOf(snap(model), btn), a);
  model.controls[2].length = 9;
  assert.notEqual(signatureOf(snap(model), btn), a);
});

test("Enter inside a form is held on behalf of its submit button", async () => {
  const { fake, ctx } = world();
  const r = await act(ctx, { selector: { name: "Email" }, kind: "press", value: "Enter" });
  assert.equal(r.held, true);
  assert.equal(r.control.name, "Save contact");
  assert.equal(fake.keys.length, 0);
  const rel = await act(ctx, { selector: { name: "Email" }, kind: "press", value: "Enter", release: { sig: r.sig } });
  assert.equal(rel.ok, true);
  assert.deepEqual(fake.keys.map(k => k.type), ["keyDown", "keyUp"]);
  // Tab is not a submit
  assert.equal((await act(ctx, { selector: { name: "Email" }, kind: "press", value: "Tab" })).ok, true);
  assert.equal(holdFor({ controls: [] }, { role: "textbox", inForm: true }, "type", "x").held, false);
});

test("type uses the apply script; check clicks only when the state differs", async () => {
  const { fake, model, ctx } = world();
  model.controls.push({ path: "input[5]", role: "checkbox", name: "Newsletter", enabled: true, frame: { x: 1, y: 300, w: 10, h: 10 } });
  const r = await act(ctx, { selector: { name: "Full name" }, kind: "type", value: "Alex" });
  assert.equal(r.ok, true);
  assert.equal(model.controls[0].value, "Alex");
  assert.equal((await act(ctx, { selector: { name: "Newsletter" }, kind: "check" })).ok, true);
  assert.equal(fake.clicks.length, 1, "an unchecked box needs one real click");
  assert.equal((await act(ctx, { selector: { name: "Newsletter" }, kind: "check", value: false })).ok, true);
  assert.equal(fake.clicks.length, 1, "already unchecked in the model? locate reports checked:false so no second click");
  await assert.rejects(act(ctx, { selector: { name: "Full name" }, kind: "type" }), { code: "bad_request" });
});

test("a disabled control is reported, not clicked", async () => {
  const { model, fake, ctx } = world();
  model.controls[3].enabled = false;
  const r = await act(ctx, { selector: { name: "Cancel" }, kind: "click" });
  assert.equal(r.ok, false);
  assert.match(r.why, /disabled/);
  assert.equal(fake.clicks.length, 0);
});

test("page.fill sets every field in ONE evaluate, all-or-nothing on resolution", async () => {
  const { chrome, model, fake, ctx } = world();
  const before = chrome._.commands.filter(c => c.method === "Runtime.evaluate").length;
  const r = await dispatch("page.fill", { tabId: 1, fields: [{ selector: { name: "Full name" }, value: "Alex Harlow" }, { selector: { name: "Email" }, value: "alex@harlow.example" }] }, ctx);
  assert.deepEqual([r.ok, r.filled], [true, 2]);
  assert.equal(fake.applies, 1);
  // one snapshot + one apply
  assert.equal(chrome._.commands.filter(c => c.method === "Runtime.evaluate").length - before, 2);
  assert.deepEqual([model.controls[0].value, model.controls[1].value], ["Alex Harlow", "alex@harlow.example"]);
  assert.ok(!JSON.stringify(r).includes("alex@harlow.example"), "values are not echoed");
  await assert.rejects(dispatch("page.fill", { tabId: 1, fields: [{ selector: { name: "Full name" }, value: "X" }, { selector: { name: "Missing" }, value: "Y" }] }, ctx), { code: "not_found" });
  assert.equal(fake.applies, 1, "nothing was applied by the failed fill");
  assert.equal(model.controls[0].value, "Alex Harlow");
});

test("page.fill with submit holds the form's submit button; release then clicks it", async () => {
  const { fake, ctx } = world();
  const r = await dispatch("page.fill", { tabId: 1, submit: true, fields: [{ selector: { name: "Email" }, value: "alex@harlow.example" }] }, ctx);
  assert.deepEqual([r.ok, r.held, r.filled], [false, true, 1]);
  assert.equal(r.fields.email, "alex@harlow.example");
  assert.equal(fake.clicks.length, 0);
  const rel = await act(ctx, { selector: r.selector, kind: "click", release: { sig: r.sig } });
  assert.equal(rel.ok, true);
  assert.equal(fake.clicks.length, 1);
});

test("page.eval returns a redacted value and reports a throw as text", async () => {
  const { fake, ctx } = world();
  fake.userEval = () => ({ result: { type: "object", value: { user: "alex", access_token: "abcdef0123456789abcdef", note: "Bearer abcdefghijklmnop1234" } } });
  const r = await dispatch("page.eval", { tabId: 1, expression: "({})" }, ctx);
  assert.equal(r.ok, true);
  assert.equal(r.value.user, "alex");
  assert.ok(!JSON.stringify(r).includes("abcdef0123456789abcdef"));
  assert.ok(!JSON.stringify(r).includes("abcdefghijklmnop1234"));
  fake.userEval = () => ({ exceptionDetails: { text: "Uncaught", exception: { description: "ReferenceError: nope" } } });
  const t = await dispatch("page.eval", { tabId: 1, expression: "nope" }, ctx);
  assert.deepEqual([t.ok, t.error], [false, "ReferenceError: nope"]);
  await assert.rejects(dispatch("page.eval", { tabId: 1 }, ctx), { code: "bad_request" });
});

test("page.wait: selector, url, idle and timeout", async () => {
  const { model, fake, ctx } = world();
  assert.equal((await dispatch("page.wait", { tabId: 1, selector: { name: "Cancel" }, timeoutMs: 300 }, ctx)).ok, true);
  await assert.rejects(dispatch("page.wait", { tabId: 1, selector: { name: "Ghost" }, timeoutMs: 150 }, ctx), { code: "timeout" });
  assert.equal((await dispatch("page.wait", { tabId: 1, url: "/contacts/new", timeoutMs: 300 }, ctx)).ok, true);
  await assert.rejects(dispatch("page.wait", { tabId: 1, url: "/orders", timeoutMs: 150 }, ctx), { code: "timeout" });
  assert.equal((await dispatch("page.wait", { tabId: 1, idleMs: 200, timeoutMs: 300 }, ctx)).ok, true);
  fake.quietMs = 0;
  await assert.rejects(dispatch("page.wait", { tabId: 1, idleMs: 200, timeoutMs: 150 }, ctx), { code: "timeout" });
  model.css = "#done";
  assert.equal((await dispatch("page.wait", { tabId: 1, selector: "#done", timeoutMs: 300 }, ctx)).ok, true);
  await assert.rejects(dispatch("page.wait", { tabId: 1 }, ctx), { code: "bad_request" });
});

test("page.wait halts when the person presses stop", async () => {
  const { ctx } = world();
  const p = dispatch("page.wait", { tabId: 1, url: "/never", timeoutMs: 5000 }, ctx);
  setTimeout(() => ctx.setStopped(true), 30);
  await assert.rejects(p, { code: "stopped" });
});

test("page.screenshot returns an image and refuses an oversized frame", async () => {
  const { chrome, ctx } = world();
  const r = await dispatch("page.screenshot", { tabId: 1, format: "png" }, ctx);
  assert.equal(r.image.mime, "image/png");
  assert.equal(Buffer.from(r.image.data, "base64").toString(), "pixels-png");
  chrome._.cdp = () => ({ data: "A".repeat(1_000_000) });
  await assert.rejects(dispatch("page.screenshot", { tabId: 1 }, ctx), { code: "bad_request" });
});

test("acting ops on a read-only page are refused, reading ops are not", async () => {
  const { chrome, ctx } = world();
  chrome._.store.local["floor.readonly"] = ["app.northwind.example"];
  assert.equal((await dispatch("page.snapshot", { tabId: 1 }, ctx)).title, "New contact");
  for (const op of ["page.act", "page.fill", "page.eval"]) await assert.rejects(dispatch(op, { tabId: 1, selector: "Cancel", fields: [], expression: "1" }, ctx), { code: "blocked" });
});

test("the page capability's op names are valid protocol ops", () => {
  assert.deepEqual(Object.keys(page.ops).sort(), ["page.act", "page.eval", "page.fill", "page.screenshot", "page.snapshot", "page.wait"]);
});

test("holdFor: a workflow builder's action tiles (Send Email, Remove Tag) are not held, a real Send or Delete still is", async () => {
  const { holdFor } = await import("./extension/caps/page.js");
  const snap = (/** @type {string} */ url) => ({ url, controls: [] });
  const tile = (/** @type {string} */ name, extra = {}) => ({ role: "button", name, container: "Pick an action", ...extra });
  const url = "https://app.gohighlevel.com/v2/location/abcdefghij12/automation/workflows/wf1";
  assert.equal(holdFor(snap(url), tile("Send Email"), "click", undefined).held, false);
  assert.equal(holdFor(snap(url), tile("Remove Tag"), "click", undefined).held, false);
  assert.equal(holdFor(snap("http://127.0.0.1:1/ghl"), tile("Send SMS"), "click", undefined).held, false);
  assert.equal(holdFor(snap(url), tile("Send Email", { submit: true }), "click", undefined).held, true, "a submit is a send");
  assert.equal(holdFor(snap(url), { role: "button", name: "Send Email" }, "click", undefined).held, true, "not inside a dialog or drawer");
  assert.equal(holdFor(snap(url), tile("Delete workflow"), "click", undefined).held, true);
  assert.equal(holdFor(snap(url), tile("Publish"), "click", undefined).held, true);
  assert.equal(holdFor(snap("https://mail.example.com/compose"), tile("Send Email"), "click", undefined).held, true, "not a workflow page");
});
