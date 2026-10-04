// @ts-check
// ghl capability: context parsing, tab reuse, sections that wait until they are loaded, flows that
// compile into ONE batch, saves that are verified, and the page module's robustness that the flows
// lean on (waits, spinners, popups, stale controls, traces and failure detail). All against the fake
// page model in test-support/fake-chrome.js: no Chrome, no network.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ghl, { parse, FLOWS, SECTIONS, actionOf, STEP_WAIT } from "./extension/caps/ghl.js";
import { dispatch, register  } from "./extension/caps/index.js";
import { createCtx } from "./extension/lib/ctx.js";
import { start } from "./extension/background.js";
import { err } from "./extension/lib/err.js";
import { matchControl, classifyBlocker, redactDom, scrub, wordsWithin } from "./extension/lib/ui.js";
import { resolve } from "./extension/caps/page.js";
import { createFakeChrome, createFakePage, createFakeFrames } from "./test-support/fake-chrome.js";
import { allSelectors, GHL_ROBUST } from "./bench/scenarios.mjs";
import { dispatchT, T } from "./test-support/trust.js";

const LOC = "MRKcUjapWpnOvQslF3Pc";
const HOME = `https://app.gohighlevel.com/v2/location/${LOC}/contacts`;
const WF = `https://app.gohighlevel.com/v2/location/${LOC}/automation/workflows`;
const sleep = (/** @type {number} */ ms) => new Promise(r => setTimeout(r, ms));

// ---------------------------------------------------------------- a small page world

let n = 0;
/** A control with a unique frame, so a click at its centre can be mapped back to it. */
const ctl = (/** @type {string} */ role, /** @type {string} */ name, /** @type {any} */ extra = {}) => {
  n++;
  return { path: `${role}[${n}]`, role, name, enabled: true, frame: { x: 10, y: 10 + n * 40, w: 120, h: 24 }, ...extra };
};
const centre = (/** @type {any} */ c) => ({ x: c.frame.x + c.frame.w / 2, y: c.frame.y + c.frame.h / 2 });

/**
 * One tab on a fake page. `page.onClick` can be set per test to make the model react.
 * @param {{ url?: string, controls?: any[], state?: any, tabs?: any[] }} [o]
 */
function world(o = {}) {
  const url = o.url || HOME;
  const chrome = createFakeChrome(o.tabs || [{ url, title: "GoHighLevel", active: true }]);
  const model = { url, title: "GoHighLevel", text: "", controls: o.controls || [], ...(o.state ? { state: o.state } : {}) };
  const fake = createFakePage(model);
  chrome._.cdp = (tabId, method, params) => fake.handler(tabId, method, params);
  const ctx = createCtx({ chrome });
  const clickOf = (/** @type {number} */ x, /** @type {number} */ y) => model.controls.find((/** @type {any} */ c) => { const p = centre(c); return p.x === x && p.y === y; });
  return { chrome, model, fake, ctx, clickOf, t0: Date.now() };
}
const act = (/** @type {any} */ ctx, /** @type {any} */ args) => dispatchT("page.act", { tabId: 1, ...args }, ctx);
const fillOp = (/** @type {any} */ ctx, /** @type {any} */ args) => dispatchT("page.fill", { tabId: 1, ...args }, ctx);
const quietState = (/** @type {any} */ extra = {}) => ({ busy: 0, domQuietMs: 5000, netPending: 0, netQuietMs: 5000, blockers: [], toasts: [], ...extra });

// ---------------------------------------------------------------- parse, flows, registry

test("parse reads host, location and section, and refuses other hosts", () => {
  const p = parse(`https://app.gohighlevel.com/v2/location/${LOC}/automation/workflows/abc`);
  assert.deepEqual([p.isGhl, p.locationId, p.section], [true, LOC, "workflows"]);
  assert.equal(parse("https://example.com/v2/location/" + LOC).isGhl, false);
  assert.equal(parse("nonsense").isGhl, false);
  assert.equal(parse("https://mail.google.com/").isGhl, false);
  assert.equal(parse("https://crm.harlow.example/v2/location/" + LOC + "/contacts", ["crm.harlow.example"]).section, "contacts");
});

const fakeCtx = (/** @type {any} */ o = {}) => {
  const calls = /** @type {any[]} */ ([]);
  return {
    calls,
    stopped: () => false,
    storage: { get: async () => o.hosts },
    tabs: { active: async () => o.active || { id: 1, url: "https://example.com/" }, get: async (/** @type {number} */ id) => (o.tabs || []).find((/** @type {any} */ t) => t.id === id), query: async () => o.tabs || [] },
    call: async (/** @type {string} */ op, /** @type {any} */ a) => { calls.push([op, a]); return o.result || { ok: true, done: (a.steps || []).length, results: [] }; },
    floorAllows: async () => ({ allow: true }),
  };
};

test("ghl.run compiles a flow into ONE batch call, labels every step, and reports its timing and trace", async () => {
  const ctx = fakeCtx({ result: { ok: true, done: 3, results: [{ ok: true, trace: { strategy: "identifier", fallback: false, waitedMs: 30, retries: 1, newTab: false } }, { ok: true, trace: { strategy: "text", fallback: true, waitedMs: 20, retries: 0, newTab: false } }] } });
  const r = await T(ghl.ops["ghl.run"])({ flow: "create-workflow", params: { name: "Welcome flow", trigger: "contact-created", actions: [{ type: "send-email", config: { subject: "Hi", messageBody: "Welcome" } }, { type: "wait", config: { duration: 15 } }] } }, ctx);
  assert.equal(ctx.calls.length, 1);
  assert.equal(ctx.calls[0][0], "batch.run");
  const steps = ctx.calls[0][1].steps;
  assert.equal(r.steps, steps.length);
  assert.ok(steps.every((/** @type {any} */ s) => typeof s.label === "string" && s.label));
  assert.equal(steps.filter((/** @type {any} */ s) => s.op === "ghl.save").length, 1);
  // the trigger has a search step and the action's config is filled by visible label, partially, with a report
  const fills = steps.filter((/** @type {any} */ s) => s.op === "page.fill" && s.args.partial);
  assert.ok(fills.some((/** @type {any} */ s) => s.args.fields.some((/** @type {any} */ f) => f.label === "Subject" && f.value === "Hi")));
  assert.ok(fills.some((/** @type {any} */ s) => s.args.fields.some((/** @type {any} */ f) => f.label === "Message Body" && f.value === "Welcome")));
  const name = steps.find((/** @type {any} */ s) => s.op === "page.fill" && s.args.fields[0].selector && s.args.fields[0].selector.identifier === "workflow-name");
  assert.equal(name.args.fields[0].value, "Welcome flow");
  assert.deepEqual(steps.find((/** @type {any} */ s) => s.op === "page.act").args.wait, STEP_WAIT);
  assert.equal(r.flow, "create-workflow");
  assert.ok(typeof r.ms === "number");
  assert.deepEqual([r.trace.strategy, r.trace.fallback, r.trace.waitedMs, r.trace.retries, r.trace.newTab], ["batch", true, 50, 1, false]);
});

test("ghl.run takes inline steps with {param} templates, gives them the flow's patience, and names a failed step", async () => {
  const ctx = fakeCtx({ result: { ok: false, done: 1, failedAt: 1, why: "nothing matches", results: [] } });
  const r = await T(ghl.ops["ghl.run"])({ steps: [{ op: "page.fill", args: { fields: [{ selector: { name: "Tag" }, value: "{tag}" }] } }, { op: "page.act", label: "press Go", args: { selector: "Go", wait: { timeoutMs: 1 } } }], params: { tag: "new-lead" } }, ctx);
  const sent = ctx.calls[0][1].steps;
  assert.equal(sent[0].args.fields[0].value, "new-lead");
  assert.deepEqual(sent[0].args.wait, STEP_WAIT, "no wait given: the flow's default is added");
  assert.deepEqual(sent[1].args.wait, { timeoutMs: 1 }, "a wait the caller set is kept");
  assert.deepEqual(r.failed, { step: 1, label: "press Go", op: "page.act" });
  await assert.rejects(() => T(ghl.ops["ghl.run"])({ flow: "nope" }, ctx), /no such flow/);
  assert.ok(Object.keys(FLOWS).length >= 7);
});

test("every flow the model is told about builds steps from its own params", () => {
  for (const [name, f] of Object.entries(FLOWS)) {
    const steps = f.steps({ name: "Intake", trigger: "tag-added", triggerConfig: { tag: "new" }, actions: [{ type: "add-tag", config: { tag: "new" } }], type: "webhook", config: { url: "https://example.test/hook" }, status: "draft", row: 2, rename: "Intake 2", listItem: "Intake", open: true, locationId: LOC });
    assert.ok(steps.length >= 1, name);
    for (const s of steps) assert.ok(s.op && s.label && s.args, `${name}: ${JSON.stringify(s)}`);
  }
  const ops = FLOWS["create-workflow"].steps({ name: "x", trigger: "contact-created", open: true, locationId: LOC }).map((/** @type {any} */ s) => s.op);
  assert.equal(ops[0], "ghl.section");
  const pub = FLOWS["publish-workflow"].steps({ status: "published" });
  assert.equal(pub[0].args.selector.name, "Publish");
  assert.deepEqual(pub[1].args.expect, { status: "published" });
});

test("action types accept plain names, and a config string keeps the old single-field form", () => {
  assert.deepEqual(actionOf("email"), { id: "send-email", label: "Send Email" });
  assert.deepEqual(actionOf("Update Contact Field"), { id: "update-contact-field", label: "Update Contact Field" });
  assert.deepEqual(actionOf("if/else"), { id: "if-else", label: "If/Else" });
  assert.deepEqual(actionOf("Custom Thing"), { id: "custom-thing", label: "Custom Thing" });
  const s = FLOWS["add-action"].steps({ type: "wait", config: "15" });
  assert.ok(s.some((/** @type {any} */ x) => x.op === "page.fill" && x.args.fields[0].selector && x.args.fields[0].selector.identifier === "action-config"));
  const pick = FLOWS["add-action"].steps({ type: "add-tag", config: { tag: { select: "VIP" } } });
  assert.ok(pick.some((/** @type {any} */ x) => x.op === "page.act" && x.args.fillable === true && x.args.selector.name === "Tag"));
});

test("the registry knows the ghl ops and treats a run and a save as acting", async () => {
  const stopped = { ...fakeCtx(), stopped: () => true };
  await assert.rejects(() => dispatchT("ghl.run", { flow: "open-contact", params: { row: 0 } }, stopped), e => /** @type {any} */ (e).code === "stopped");
  await assert.rejects(() => dispatchT("ghl.save", {}, stopped), e => /** @type {any} */ (e).code === "stopped");
  const r = await dispatchT("ghl.flows", {}, fakeCtx());
  assert.ok(r.flows.some((/** @type {any} */ f) => f.name === "create-workflow"));
  assert.ok(r.actions.some((/** @type {any} */ a) => a.id === "webhook"));
});

test("dispatch gives every capability both spellings of the tab", async () => {
  const seen = /** @type {any[]} */ ([]);
  register({ name: "spelltest", ops: { "spelltest.echo": async a => { seen.push(a); return {}; } } });
  await dispatchT("spelltest.echo", { tab: 5 }, fakeCtx());
  await dispatchT("spelltest.echo", { tabId: 6 }, fakeCtx());
  assert.deepEqual(seen.map(a => [a.tab, a.tabId]), [[5, 5], [6, 6]]);
});

// ---------------------------------------------------------------- matching: strict first, then fuzzy but safe

test("matchControl: identifier, role+name, name, then fuzzy stages that bind only when exactly one control fits", () => {
  const cs = [
    { path: "a", role: "button", name: "Save", identifier: "save-workflow", enabled: true },
    { path: "b", role: "textbox", name: "Subject line", enabled: true },
    { path: "c", role: "textbox", name: "Search", placeholder: "Search triggers", enabled: true },
    { path: "d", role: "textbox", name: "", near: "Message body", enabled: true },
    { path: "e", role: "button", name: "Add Contact Tag", enabled: true },
    { path: "f", role: "button", name: "Remove Contact Tag", enabled: true },
  ];
  const m = (/** @type {any} */ sel, /** @type {any} */ o) => matchControl(sel, cs, resolve, o);
  assert.deepEqual([m({ identifier: "save-workflow", name: "Whatever" }).strategy, m({ identifier: "save-workflow" }).fallback], ["identifier", false]);
  assert.deepEqual([m({ role: "button", name: "Save" }).strategy, m({ name: "Save" }).strategy], ["role+name", "name"]);
  // a fallback: the identifier is not on the page, the name is
  const fb = m({ identifier: "gone", name: "Save" });
  assert.deepEqual([fb.strategy, fb.fallback], ["name", true]);
  assert.equal(m({ name: "save" }).strategy, "name-ci");
  assert.equal(m({ name: "Search triggers" }).strategy, "aria");
  assert.deepEqual([m({ name: "Message body" }).strategy, m({ name: "Message body" }).control.path], ["nearby-label", "d"]);
  assert.equal(m({ name: "Add Tag" }).control.path, "e", "whole-word containment, one candidate");
  assert.equal(m({ name: "Tag" }).why, "tied", "two controls fit, so none is guessed");
  assert.equal(m({ name: "Subject" }).control.path, "b");
  assert.equal(m({ name: "Nope" }).why, "unbound");
  // containment stays modest: a long name does not bind a short want
  assert.equal(wordsWithin("Save", "Save as a reusable template for later"), false);
  assert.equal(wordsWithin("Save", "Save workflow"), true);
  // fillable filter: a label never binds a button
  assert.equal(m({ name: "Save" }, { fillable: true }).control, null);
});

// ---------------------------------------------------------------- page.act: trace, waiting, stale, spinners

test("page.act carries a trace: strategy, fallback, waitedMs, retries, newTab", async () => {
  const { ctx, model, fake } = world();
  model.controls.push(ctl("button", "Save", { identifier: "save-workflow" }), ctl("button", "Add Contact Tag"));
  const a = await act(ctx, { selector: { identifier: "save-workflow" }, kind: "click" });
  assert.deepEqual([a.ok, a.trace.strategy, a.trace.fallback, a.trace.retries, a.trace.newTab], [true, "identifier", false, 0, false]);
  assert.ok(typeof a.trace.waitedMs === "number");
  const b = await act(ctx, { selector: { identifier: "missing", name: "Save" }, kind: "click" });
  assert.deepEqual([b.trace.strategy, b.trace.fallback], ["name", true]);
  const c = await act(ctx, { selector: { name: "Add Tag" }, kind: "click" });
  assert.deepEqual([c.trace.strategy, c.trace.fallback], ["text", true]);
  assert.equal(fake.clicks.length, 3);
});

test("page.act waits for a control that appears late, and reports how long", async () => {
  const { ctx, model, fake } = world();
  const t0 = Date.now();
  fake.onSnapshot = () => { if (Date.now() - t0 > 250 && !model.controls.length) model.controls.push(ctl("button", "Add Action")); };
  const r = await act(ctx, { selector: { name: "Add Action" }, kind: "click", wait: { timeoutMs: 3000 } });
  assert.equal(r.ok, true);
  assert.ok(r.trace.waitedMs >= 200 && r.trace.waitedMs < 1500, String(r.trace.waitedMs));
  assert.equal(fake.clicks.length, 1);
  // without a wait the old behaviour holds: one look, not found
  fake.onSnapshot = undefined;
  model.controls.length = 0;
  await assert.rejects(act(ctx, { selector: { name: "Add Action" }, kind: "click" }), { code: "not_found" });
});

test("page.act waits for a disabled control to become enabled, and for a moving one to hold still", async () => {
  const { ctx, model, fake } = world();
  const save = ctl("button", "Save");
  save.enabled = false;
  model.controls.push(save);
  const t0 = Date.now();
  fake.onSnapshot = () => { if (Date.now() - t0 > 200) save.enabled = true; };
  const r = await act(ctx, { selector: "Save", kind: "click", wait: { timeoutMs: 3000 } });
  assert.equal(r.ok, true);
  assert.ok(r.trace.waitedMs >= 180);
  // a control whose position keeps changing (a drawer sliding in) is clicked only after it stops
  const drawer = ctl("button", "Continue");
  model.controls.length = 0;
  model.controls.push(drawer);
  let moves = 0;
  const t1 = Date.now();
  fake.onSnapshot = () => { if (Date.now() - t1 < 260) drawer.frame = { ...drawer.frame, x: drawer.frame.x + 3 + moves++ }; };
  const clicks = fake.clicks.length;
  const s = await act(ctx, { selector: "Continue", kind: "click", wait: { timeoutMs: 3000, stable: true } });
  assert.equal(s.ok, true);
  assert.ok(s.trace.waitedMs >= 250 + 100, `waited ${s.trace.waitedMs}`);
  assert.equal(fake.clicks.length, clicks + 1);
  assert.equal(fake.clicks.at(-1).x, centre(drawer).x, "clicked where it finally stopped");
});

test("spinners and skeletons are waited out; one that never goes away is given up on and reported", async () => {
  const { ctx, model, fake } = world({ state: quietState({ busy: 3, busySample: ["div.skeleton"] }) });
  model.controls.push(ctl("button", "Create Workflow"));
  const t0 = Date.now();
  fake.onSnapshot = () => { if (Date.now() - t0 > 300) model.state.busy = 0; };
  const r = await act(ctx, { selector: "Create Workflow", kind: "click", wait: { timeoutMs: 5000 } });
  assert.equal(r.ok, true);
  assert.ok(r.trace.waitedMs >= 280, `waited ${r.trace.waitedMs}`);
  assert.equal(r.trace.busyIgnored, undefined);
  fake.onSnapshot = undefined;
  model.state.busy = 2; // an animated widget that never stops
  const s = await act(ctx, { selector: "Create Workflow", kind: "click", wait: { timeoutMs: 2000, busyMs: 150 } });
  assert.equal(s.ok, true);
  assert.equal(s.trace.busyIgnored, true);
});

test("a control that goes stale between look and click is looked up again, with backoff, and capped", async () => {
  const { ctx, model, fake } = world();
  model.controls.push(ctl("button", "Add Action"));
  fake.locateFail = 2;
  const r = await act(ctx, { selector: "Add Action", kind: "click" });
  assert.equal(r.ok, true);
  assert.equal(r.trace.retries, 2);
  assert.equal(fake.clicks.length, 1);
  fake.locateFail = 10;
  await assert.rejects(act(ctx, { selector: "Add Action", kind: "click" }), e => {
    const x = /** @type {any} */ (e);
    assert.equal(x.code, "not_found");
    assert.equal(x.detail.trace.retries, 3);
    assert.ok(x.detail.dom && x.detail.tab);
    return true;
  });
  assert.equal(fake.clicks.length, 1, "nothing was clicked after the cap");
  // an optional step that finds nothing says so and does not fail
  const o = await act(ctx, { selector: "Start from Scratch", kind: "click", optional: true });
  assert.deepEqual([o.ok, o.skipped], [true, true]);
});

// ---------------------------------------------------------------- blocking dialogs

const dialogState = (/** @type {any} */ b) => quietState({ blockers: [{ i: 0, path: "div[0]", role: "dialog", modal: true, ...b }] });

test("a what's new popup in the way is dismissed by its own close control, and the act goes on", async () => {
  const close = ctl("button", "Close", { blk: 0 });
  const tour = ctl("button", "Take a tour", { blk: 0 });
  const nav = ctl("button", "Automation", { identifier: "nav-automation" });
  const { ctx, model, fake, clickOf } = world({ controls: [close, tour, nav], state: dialogState({ title: "What's new", text: "What's new in Harlow CRM. Try the new workflow templates." }) });
  fake.onClick = (x, y) => { const c = clickOf(x, y); if (c === close) { model.controls = model.controls.filter((/** @type {any} */ k) => k.blk !== 0); model.state.blockers = []; } };
  const r = await act(ctx, { selector: { identifier: "nav-automation" }, kind: "click", wait: { timeoutMs: 2000 } });
  assert.equal(r.ok, true);
  assert.deepEqual(r.trace.dismissed, [{ what: "What's new", control: "Close" }]);
  assert.equal(fake.clicks.length, 2, "one click on Close, one on the target");
  assert.deepEqual(fake.clicks[0], centre(close));
  assert.deepEqual(fake.clicks[1], centre(nav));
});

test("an unsaved-changes dialog is never dismissed: the error describes it and nothing is clicked", async () => {
  const stay = ctl("button", "Stay", { blk: 0 });
  const discard = ctl("button", "Discard changes", { blk: 0 });
  const nav = ctl("button", "Contacts");
  const { ctx, fake } = world({ controls: [stay, discard, nav], state: dialogState({ role: "alertdialog", title: "Unsaved changes", text: "You have unsaved changes. If you leave, they will be lost." }) });
  await assert.rejects(act(ctx, { selector: "Contacts", kind: "click", wait: { timeoutMs: 800 } }), e => {
    const x = /** @type {any} */ (e);
    assert.equal(x.code, "modal");
    assert.match(x.message, /Unsaved changes/);
    assert.match(x.message, /not dismissed/);
    assert.equal(x.detail.blockers[0].kind, "unsafe");
    assert.deepEqual(x.detail.blockers[0].controls, ["Stay", "Discard changes"]);
    assert.deepEqual(x.detail.tab, { host: "app.gohighlevel.com", path: `/v2/location/${LOC}/contacts` });
    assert.ok(x.detail.dom.length <= 2048);
    return true;
  });
  assert.equal(fake.clicks.length, 0);
  // the model may act on the dialog's own controls: a held or plain click on Stay works
  const r = await act(ctx, { selector: "Stay", kind: "click" });
  assert.equal(r.ok, true);
  // ...and Discard is a consequential name, so it is held for the person
  const d = await act(ctx, { selector: "Discard changes", kind: "click" });
  assert.equal(d.held, true);
});

test("a dialog the policy does not know is surfaced after the wait, not clicked", async () => {
  const ok = ctl("button", "Continue", { blk: 0 });
  const nav = ctl("button", "Contacts");
  const { ctx, fake } = world({ controls: [ok, nav], state: dialogState({ title: "Session", text: "Please choose how to continue." }) });
  const t0 = Date.now();
  await assert.rejects(act(ctx, { selector: "Contacts", kind: "click", wait: { timeoutMs: 300 } }), { code: "modal" });
  assert.ok(Date.now() - t0 >= 250, "an unfamiliar dialog gets the wait first, in case it closes itself");
  assert.equal(fake.clicks.length, 0);
  assert.equal(classifyBlocker({ i: 0, title: "Cookies", text: "We use cookies" }, { controls: [{ blk: 0, name: "Accept all", enabled: true }, { blk: 0, name: "Reject all", enabled: true }] }).closer.name, "Reject all");
});

test("a control inside the dialog is not blocked by it", async () => {
  const save = ctl("button", "Save Action", { blk: 0 });
  const { ctx } = world({ controls: [save], state: dialogState({ title: "Add action", text: "Choose an action" }) });
  assert.equal((await act(ctx, { selector: "Save Action", kind: "click" })).ok, true);
});

// ---------------------------------------------------------------- page.fill by label

test("page.fill by label: reports which fields were set and which were not found, and never skips silently", async () => {
  const subject = ctl("textbox", "Subject");
  const body = ctl("textbox", "", { near: "Message body" });
  const { ctx, model, fake } = world({ controls: [subject, body] });
  const r = await fillOp(ctx, { fields: [{ label: "Subject", value: "Hi there" }, { label: "Message body", value: "Welcome" }, { label: "Reply to", value: "x" }], partial: true });
  assert.equal(r.ok, false);
  assert.equal(r.filled, 2);
  assert.deepEqual(r.notFound, ["Reply to"]);
  assert.match(r.why, /could not find: Reply to/);
  assert.deepEqual(r.fields.map((/** @type {any} */ f) => [f.name, f.ok, f.strategy]), [["Subject", true, "name"], ["Message body", true, "nearby-label"], ["Reply to", false, undefined]]);
  assert.deepEqual([subject.value, body.value], ["Hi there", "Welcome"]);
  assert.ok(!JSON.stringify(r).includes("Welcome"), "values are not echoed");
  assert.equal(fake.applies, 1);
  assert.ok(r.dom && r.tab && r.trace);
  // an optional field that is missing is listed but does not fail the step
  const o = await fillOp(ctx, { fields: [{ label: "Subject", value: "Again" }, { label: "Search", value: "x", optional: true }], partial: true });
  assert.deepEqual([o.ok, o.filled, o.skipped], [true, 1, ["Search"]]);
  // without partial, a missing label is an error before anything is set
  const before = fake.applies;
  await assert.rejects(fillOp(ctx, { fields: [{ label: "Subject", value: "z" }, { label: "Nope", value: "y" }] }), { code: "not_found" });
  assert.equal(fake.applies, before);
  // two controls that fit are a tie, not a guess
  model.controls.push(ctl("textbox", "Subject line"));
  const t = await fillOp(ctx, { fields: [{ label: "Subj", value: "z" }], partial: true });
  assert.equal(t.ok, false);
});

test("page.fill prefers the fields inside an open dialog or drawer", async () => {
  const outer = ctl("textbox", "Name");
  const inner = ctl("textbox", "Name", { blk: 0 });
  const { ctx } = world({ controls: [outer, inner], state: quietState({ blockers: [{ i: 0, path: "div[0]", role: "dialog", modal: false, title: "Add action", text: "" }] }) });
  const r = await fillOp(ctx, { fields: [{ label: "Name", value: "Drawer name" }], partial: true });
  assert.equal(r.ok, true);
  assert.deepEqual([inner.value, outer.value], ["Drawer name", undefined]);
  assert.equal(r.fields[0].fallback, undefined);
});

// ---------------------------------------------------------------- page.wait

test("page.wait settled: waits for the DOM and network to go quiet and reports soft flags; selector waits report waitedMs and a trace", async () => {
  const { ctx, model, fake } = world({ controls: [ctl("button", "Save")], state: quietState({ domQuietMs: 0, netPending: 1, netQuietMs: 0 }) });
  const t0 = Date.now();
  fake.onSnapshot = () => { const el = Date.now() - t0; model.state.domQuietMs = el > 250 ? 400 : 0; model.state.netPending = el > 250 ? 0 : 1; model.state.netQuietMs = el > 250 ? 400 : 0; };
  const r = await dispatchT("page.wait", { tabId: 1, settled: true, timeoutMs: 5000 }, ctx);
  assert.equal(r.ok, true);
  assert.ok(r.waitedMs >= 240, String(r.waitedMs));
  assert.equal(r.trace.strategy, "settled");
  // a page that never quiets is given up on after the grace period, with a flag
  fake.onSnapshot = undefined;
  model.state = quietState({ domQuietMs: 0 });
  const s = await dispatchT("page.wait", { tabId: 1, settled: true, timeoutMs: 400 }, ctx);
  assert.equal(s.trace.domNeverQuiet, true);
  const w = await dispatchT("page.wait", { tabId: 1, selector: { name: "Save" }, enabled: true, stable: true, timeoutMs: 2000 }, ctx);
  assert.deepEqual([w.ok, w.trace.strategy, typeof w.waitedMs], [true, "name", "number"]);
  const g = await dispatchT("page.wait", { tabId: 1, selector: { name: "Ghost" }, gone: true, timeoutMs: 300 }, ctx);
  assert.equal(g.trace.strategy, "absent");
  await assert.rejects(dispatchT("page.wait", { tabId: 1, selector: { name: "Ghost" }, timeoutMs: 150 }, ctx), e => /** @type {any} */ (e).code === "timeout" && /** @type {any} */ (e).detail.trace.strategy === "");
});

// ---------------------------------------------------------------- sections

const sectionWorld = (/** @type {any} */ o = {}) => {
  const nav = ctl("button", "Automation", { identifier: "nav-automation" });
  const w = world({ url: o.url || HOME, controls: o.noNav ? [ctl("button", "Add Contact", { identifier: "add-contact" })] : [nav, ctl("button", "Add Contact", { identifier: "add-contact" })], state: quietState(o.state) });
  const { model, fake, chrome, clickOf } = w;
  const route = () => { chrome._.tabs[0].url = WF; model.url = WF; model.controls = model.controls.filter((/** @type {any} */ c) => c.identifier !== "add-contact" && c !== nav); if (!o.noLandmark) model.controls.push(ctl("button", "Create Workflow", { identifier: "create-workflow" })); };
  fake.onClick = (x, y) => { if (clickOf(x, y) === nav) setTimeout(route, o.routeAfter ?? 0); };
  fake.onSnapshot = () => { model.url = chrome._.tabs.find((/** @type {any} */ t) => t.id === 1).url; };
  return { ...w, nav, route };
};

test("ghl.section clicks the left nav inside the app, waits until the section is really loaded, and never opens a tab", async () => {
  const { ctx, chrome, fake, nav } = sectionWorld();
  const r = await dispatchT("ghl.section", { section: "workflows" }, ctx);
  assert.deepEqual([r.ok, r.via, r.loaded, r.landmark], [true, "nav", true, true]);
  assert.deepEqual([r.trace.strategy, r.trace.fallback, r.trace.newTab], ["nav", false, false]);
  assert.equal(chrome._.counts.create, 0);
  assert.equal(chrome._.counts.update, 0, "no URL change: the single-page app routed itself");
  assert.deepEqual(fake.clicks, [centre(nav)]);
});

test("ghl.section waits through a slow route: skeleton on screen, landmark absent, then present", async () => {
  const { ctx, model, fake } = sectionWorld({ routeAfter: 50, state: { busy: 3 } });
  const t0 = Date.now();
  const prev = fake.onSnapshot;
  fake.onSnapshot = (/** @type {any} */ i, /** @type {any} */ m) => { prev(i, m); if (Date.now() - t0 > 450) { model.state.busy = 0; model.state.domQuietMs = 5000; } else model.state.domQuietMs = 0; };
  const r = await dispatchT("ghl.section", { section: "workflows", timeoutMs: 8000 }, ctx);
  assert.equal(r.loaded, true);
  assert.ok(Date.now() - t0 >= 440, "not returned while the skeleton was still on screen");
  assert.equal(r.trace.busyIgnored, undefined);
});

test("ghl.section falls back to a URL change on the same tab when the nav control is not there", async () => {
  const w = sectionWorld({ noNav: true, noLandmark: false });
  const { ctx, chrome, model } = w;
  const stop = setInterval(() => { if (chrome._.tabs[0].url === WF) { model.controls.push(ctl("button", "Create Workflow", { identifier: "create-workflow" })); clearInterval(stop); } }, 20);
  const r = await dispatchT("ghl.section", { section: "workflows" }, ctx);
  clearInterval(stop);
  assert.deepEqual([r.via, r.trace.fallback, r.trace.newTab], ["url", true, false]);
  assert.equal(chrome._.counts.create, 0);
  assert.equal(chrome._.tabs[0].url, WF);
});

test("ghl.section: a default landmark that never shows is a warning; a landmark the caller named is required", async () => {
  const { ctx } = sectionWorld({ noLandmark: true });
  const r = await dispatchT("ghl.section", { section: "workflows", timeoutMs: 3000 }, ctx);
  assert.equal(r.landmark, false);
  assert.match(r.warning, /landmark/);
  const w2 = sectionWorld({ noLandmark: true });
  await assert.rejects(dispatchT("ghl.section", { section: "workflows", landmark: "Workflow Templates", timeoutMs: 1500 }, w2.ctx), e => /** @type {any} */ (e).code === "timeout" && !!/** @type {any} */ (e).detail.tab);
});

test("ghl.section already there loads without a click; the tab is picked by location; a missing tab is opened only with a locationId", async () => {
  const OTHER = "ZZZZZZZZZZ1111111111";
  const ctxW = world({ url: WF, controls: [ctl("button", "Create Workflow", { identifier: "create-workflow" })], state: quietState(), tabs: [{ url: `https://app.gohighlevel.com/v2/location/${OTHER}/contacts`, title: "other", active: true }, { url: WF, title: "mine" }] });
  ctxW.fake.onSnapshot = () => { ctxW.model.url = ctxW.chrome._.tabs[1].url; };
  const r = await dispatchT("ghl.section", { section: "workflows", locationId: LOC, tabId: 2 }, ctxW.ctx);
  assert.deepEqual([r.via, r.tab], ["already", 2]);
  assert.equal(ctxW.fake.clicks.length, 0);
  // no GoHighLevel tab, no location: refuse
  const none = world({ url: "https://example.com/", tabs: [{ url: "https://example.com/", active: true }] });
  await assert.rejects(dispatchT("ghl.section", { section: "workflows" }, none.ctx), /no GoHighLevel tab is open/);
  await assert.rejects(dispatchT("ghl.section", { section: "nope" }, none.ctx), /unknown section/);
  // with a locationId one tab is opened (tabs.use), flagged in the trace, and a second call reuses it
  none.fake.onSnapshot = () => { none.model.url = none.chrome._.tabs.at(-1).url; };
  none.model.controls.push(ctl("button", "Create Workflow", { identifier: "create-workflow" }));
  none.model.state = quietState();
  const first = await dispatchT("ghl.section", { section: "workflows", locationId: LOC }, none.ctx);
  assert.equal(none.chrome._.counts.create, 1);
  assert.equal(first.trace.newTab, true);
  const again = await dispatchT("ghl.section", { section: "workflows", locationId: LOC }, none.ctx);
  assert.equal(none.chrome._.counts.create, 1, "the second call reuses the tab it opened");
  assert.equal(again.trace.newTab, false);
});

// ---------------------------------------------------------------- saving

const saveWorld = (/** @type {any} */ o = {}) => {
  const save = ctl("button", "Save", { identifier: "save-workflow" });
  const w = world({ url: WF, controls: [save, ...(o.extra || [])], state: quietState() });
  w.fake.onClick = (x, y) => { if (w.clickOf(x, y) === save) o.onSave && o.onSave(w, save); };
  return { ...w, save };
};

test("ghl.save verifies by a success toast and returns the evidence; the trace says how", async () => {
  const w = saveWorld({ onSave: (/** @type {any} */ x) => setTimeout(() => { x.model.state.toasts = [{ ageMs: 5, text: "Workflow saved successfully" }]; }, 60) });
  const r = await dispatchT("ghl.save", { tabId: 1 }, w.ctx);
  assert.deepEqual([r.ok, r.saved, r.evidence.kind], [true, true, "toast"]);
  assert.equal(r.evidence.text, "Workflow saved successfully");
  assert.equal(r.trace.evidence, "toast");
  assert.equal(w.fake.clicks.length, 1);
});

test("ghl.save: an error toast, a silent save and a disabled-then-nothing are all errors that name the step", async () => {
  const bad = saveWorld({ onSave: (/** @type {any} */ x) => { x.model.state.toasts = [{ ageMs: 1, text: "Could not save the workflow" }]; } });
  await assert.rejects(dispatchT("ghl.save", { tabId: 1 }, bad.ctx), e => { const x = /** @type {any} */ (e); assert.equal(x.code, "not_saved"); assert.match(x.message, /save step: the app reported a problem/); assert.equal(x.detail.toast, "Could not save the workflow"); return true; });
  const silent = saveWorld();
  await assert.rejects(dispatchT("ghl.save", { tabId: 1, timeoutMs: 600 }, silent.ctx), e => { const x = /** @type {any} */ (e); assert.equal(x.code, "not_saved"); assert.match(x.message, /save step: not confirmed after 600 ms/); assert.ok(x.detail.dom && x.detail.tab && x.detail.trace); return true; });
  // an old toast that was already on screen before the click is not evidence
  const stale = saveWorld();
  stale.model.state.toasts = [{ ageMs: null, text: "Workflow saved successfully" }];
  await assert.rejects(dispatchT("ghl.save", { tabId: 1, timeoutMs: 500 }, stale.ctx), { code: "not_saved" });
});

test("ghl.save accepts a disabled Save, a URL change or a list item as evidence", async () => {
  const dis = saveWorld({ onSave: (/** @type {any} */ x, /** @type {any} */ save) => { save.enabled = false; } });
  const d = await dispatchT("ghl.save", { tabId: 1 }, dis.ctx);
  assert.equal(d.evidence.kind, "save-disabled");
  const url = saveWorld({ onSave: (/** @type {any} */ x) => { x.model.url = WF + "/wf_123"; } });
  assert.equal((await dispatchT("ghl.save", { tabId: 1 }, url.ctx)).evidence.kind, "url");
  const list = saveWorld({ onSave: (/** @type {any} */ x) => { x.model.controls.push(ctl("button", "Welcome flow")); } });
  const l = await dispatchT("ghl.save", { tabId: 1, expect: { listItem: "Welcome flow" } }, list.ctx);
  assert.deepEqual([l.evidence.kind, l.evidence.text], ["list", "Welcome flow"]);
});

test("ghl.save: a confirm dialog after Save is surfaced, not dismissed; a held Save is passed up; status is verified", async () => {
  const conf = saveWorld({ onSave: (/** @type {any} */ x) => { x.model.state.blockers = [{ i: 0, path: "div[1]", role: "alertdialog", modal: true, title: "Confirm", text: "Are you sure you want to publish this workflow?" }]; } });
  await assert.rejects(dispatchT("ghl.save", { tabId: 1 }, conf.ctx), e => { const x = /** @type {any} */ (e); assert.equal(x.code, "modal"); assert.match(x.message, /saving opened a dialog/); assert.equal(x.detail.blockers[0].kind, "unsafe"); return true; });
  // a Save the page module holds for the person is passed up as held, not reported as a failed save
  const heldW = saveWorld();
  heldW.save.name = "Send workflow";
  const heldR = await dispatchT("ghl.save", { tabId: 1, name: "Send workflow" }, heldW.ctx);
  assert.equal(heldR.held, true);
  assert.equal(heldW.fake.clicks.length, 0);
  const toggle = ctl("switch", "Publish", { identifier: "publish-toggle", checked: false });
  const st = saveWorld({ extra: [toggle], onSave: (/** @type {any} */ x) => { x.model.state.toasts = [{ ageMs: 1, text: "Saved" }]; } });
  await assert.rejects(dispatchT("ghl.save", { tabId: 1, expect: { status: "published" } }, st.ctx), /workflow status is draft, not published/);
  toggle.checked = true;
  const ok = await dispatchT("ghl.save", { tabId: 1, expect: { status: "published" } }, saveWorld({ extra: [toggle], onSave: (/** @type {any} */ x) => { x.model.state.toasts = [{ ageMs: 1, text: "Saved" }]; } }).ctx);
  assert.equal(ok.status, "published");
});

test("publishing is a consequential click: the page module holds it for the person", async () => {
  const toggle = ctl("switch", "Publish", { identifier: "publish-toggle", checked: false });
  const { ctx, fake } = world({ url: WF, controls: [toggle], state: quietState() });
  const r = await act(ctx, { selector: { name: "Publish", identifier: "publish-toggle" }, kind: "click", wait: STEP_WAIT });
  assert.equal(r.held, true);
  assert.equal(fake.clicks.length, 0);
  assert.ok(r.trace);
  const asked = await act(ctx, { selector: { name: "Publish", identifier: "publish-toggle" }, kind: "click", asked: true });
  assert.equal(asked.ok, true);
});

// ---------------------------------------------------------------- failure detail

test("a failure's error detail carries the tab's host and path (no query) and a masked page snippet of at most 2 KB", async () => {
  const noisy = ctl("textbox", "Email", { value: "alex.sample@example.com" });
  const w = world({ url: `${WF}?token=abc123abc123abc123&x=1#frag`, controls: [noisy, ctl("button", "Save")] });
  w.chrome._.tabs[0].url = `${WF}?token=abc123abc123abc123&x=1#frag`;
  w.model.dom = `<form><input data-testid="email" value="alex.sample@example.com"><p>Call 916 555 0100 or +1 (916) 555-0100</p><p>${"lorem ".repeat(600)}</p><input value="Bearer abcdefghijklmnop1234567890"></form>`;
  await assert.rejects(act(w.ctx, { selector: { name: "Nope" }, kind: "click" }), e => {
    const x = /** @type {any} */ (e);
    assert.equal(x.code, "not_found");
    assert.deepEqual(x.detail.tab, { host: "app.gohighlevel.com", path: `/v2/location/${LOC}/automation/workflows` });
    assert.ok(!JSON.stringify(x.detail).includes("abc123abc123"), "the query is gone");
    assert.ok(x.detail.dom.length <= 2048 && x.detail.dom.length > 200);
    assert.ok(!/alex\.sample@example\.com|916 555 0100|555-0100|abcdefghijklmnop1234567890/.test(x.detail.dom));
    assert.match(x.detail.dom, /redacted:email/);
    assert.match(x.detail.dom, /redacted:phone/);
    assert.equal(x.detail.trace.newTab, false);
    assert.ok(x.detail.candidates.some((/** @type {any} */ c) => c.name === "Save"));
    return true;
  });
  assert.match(scrub("mail a@b.co or call 5551234567 with " + "sk" + "-abcdefghijklmnopqrstuvwx"), /redacted:email.*redacted:phone.*redacted:key/);
  assert.ok(redactDom("x".repeat(5000)).length <= 2048);
});

test("the detail survives batch.run (thrown steps carry it), the shell's error frame, and gets redacted on the way out", async () => {
  register({ name: "ghldetail", ops: { "ghldetail.fail": async () => { throw err("modal", "a dialog is blocking", { blockers: [{ text: "mail alex@example.com" }], dom: "<b>hi</b>" }); } } });
  const w = world({ controls: [ctl("button", "Go")], state: quietState() });
  const b = await dispatchT("batch.run", { steps: [{ op: "ghldetail.fail", args: {} }] }, w.ctx);
  assert.equal(b.ok, false);
  assert.equal(b.code, "modal");
  assert.equal(b.detail.dom, "<b>hi</b>");
  assert.equal(b.results[0].error.detail.blockers[0].text, "mail alex@example.com", "batch keeps the detail as it is; the shell masks it");
  // through the shell
  const chrome = createFakeChrome([{ url: HOME, active: true }]);
  const timers = { now: () => 0, setTimeout: (/** @type {any} */ fn) => fn && 0, clearTimeout: () => {} };
  start(chrome, /** @type {any} */ (timers));
  const port = chrome._.ports.at(-1);
  port.deliver({ id: 9, op: "ghldetail.fail", args: {} });
  for (let i = 0; i < 50 && !port.sent.find((/** @type {any} */ m) => m.id === 9); i++) await new Promise(r => setImmediate(r));
  const frame = port.sent.find((/** @type {any} */ m) => m.id === 9);
  assert.equal(frame.ok, false);
  assert.equal(frame.error.code, "modal");
  assert.equal(frame.error.detail.dom, "<b>hi</b>");
  assert.match(frame.error.detail.blockers[0].text, /mail alex@example\.com|redacted/);
});

test("every in-page script the new code sends is valid JavaScript", async () => {
  const w = world({ controls: [ctl("button", "Go")], state: quietState() });
  const seen = /** @type {string[]} */ ([]);
  const orig = w.chrome._.cdp;
  w.chrome._.cdp = (/** @type {number} */ t, /** @type {string} */ m, /** @type {any} */ p) => { if (m === "Runtime.evaluate") { new vm.Script(p.expression); seen.push(/^\/\*vyre:(\w+)/.exec(p.expression)?.[1] || ""); } return orig(t, m, p); };
  await act(w.ctx, { selector: "Nope", kind: "click" }).catch(() => {});
  assert.ok(seen.includes("snapshot") && seen.includes("dom"), seen.join());
});

// ---------------------------------------------------------------- fixture and scenario

test("the fixture has the awkward behaviours, and the bench scenario only names selectors that exist in it", () => {
  const html = fs.readFileSync(new URL("./bench/fixtures/ghl.html", import.meta.url), "utf8");
  for (const needle of ['id="skeleton"', "aria-busy", 'id="whatsnew"', 'role="alertdialog"', 'id="toasts"', "renderToolbar", 'data-testid="trigger-search"', 'data-testid="action-search"', 'id="f-subject"', "Unsaved changes", "FX.slow", "FX.stale", "FX.guard", "FX.whatsnew"]) assert.ok(html.includes(needle), needle);
  const ids = new Set([...html.matchAll(/data-testid="([^"]+)"/g)].map(m => m[1]));
  for (const s of allSelectors()) {
    const m = /^\[data-testid="([^"]+)"\]$/.exec(s);
    if (m && !/-\d+$/.test(m[1])) assert.ok(ids.has(m[1]), `${s} is in the fixture`); // contact rows are made by script
  }
  assert.ok(GHL_ROBUST.path.includes("slow=") && GHL_ROBUST.path.includes("whatsnew=1") && GHL_ROBUST.path.includes("guard=1"));
  assert.equal(GHL_ROBUST.flow, "create-workflow");
  for (const s of GHL_ROBUST.expect.identifiers) assert.ok(ids.has(s), `${s} is in the fixture`);
  const steps = FLOWS[GHL_ROBUST.flow].steps(GHL_ROBUST.params);
  assert.ok(steps.length > 10);
  assert.ok(Object.keys(SECTIONS).length > 5);
});

test("popups: a dialog that asks for agreement is never closed with OK, Got it, Accept or Allow", () => {
  const snap = { controls: [{ blk: 0, name: "Got it", enabled: true }, { blk: 0, name: "OK", enabled: true }, { blk: 0, name: "Accept all", enabled: true }] };
  const agree = classifyBlocker({ i: 0, title: "Welcome", text: "By continuing you agree to our terms and privacy policy" }, snap);
  assert.notEqual(agree.kind, "safe");
  const tour = classifyBlocker({ i: 0, title: "Welcome tour", text: "Take a tour of the new builder" }, snap);
  assert.equal(tour.kind, "safe");
  assert.equal(classifyBlocker({ i: 0, title: "Consent", text: "consent to marketing" }, snap).kind, "unknown", "bare consent is no longer a safe popup");
});

// ---------------------------------------------------------------- the builder in a cross-origin iframe (real-use finding)

const SHELL = "https://crm.harlow.example";
const BUILDER = "https://client-app-automation-workflows.leadconnectorhq.com";
let fn = 0;
/** A control with a box inside a 600 x 400 iframe. */
const fctl = (/** @type {string} */ role, /** @type {string} */ name, /** @type {any} */ extra = {}) => { fn++; return { path: `${role}[${fn}]`, role, name, enabled: true, box: { x: 10, y: 10 + (fn % 9) * 30, w: 120, h: 24 }, ...extra }; };

/**
 * A white-label shell (its host is the person's own) whose Workflows UI is the builder iframe, as on a real account: the shell holds
 * the left nav, the iframe holds every control of the builder.
 * @param {{ url?: string, builder?: any[], builderState?: any }} [o]
 */
async function iframeWorld(o = {}) {
  const url = o.url || `${SHELL}/v2/location/${LOC}/contacts`;
  const chrome = createFakeChrome([{ url, title: "Harlow CRM", active: true }]);
  chrome._.store.local["ghl.hosts"] = ["crm.harlow.example"];
  const nav = fctl("link", "Automation", { identifier: "nav-automation" });
  const top = { url, title: "Harlow CRM", text: "Harlow Legal", controls: [nav], state: quietState() };
  const builder = { url: `${BUILDER}/builder?token=abc`, title: "Workflows", text: "Workflows", controls: o.builder || [], state: o.builderState || quietState() };
  const fx = createFakeFrames(chrome, { top, frames: [{ id: "APP", origin: BUILDER, url: builder.url, box: { x: 300, y: 60, w: 600, h: 400 }, model: builder }] });
  const ctx = createCtx({ chrome });
  await fx.attach(ctx);
  const topPage = fx.page("TOP");
  topPage.onSnapshot = () => { top.url = chrome._.tabs[0].url; };
  return { chrome, ctx, fx, top, builder, nav, topPage, app: fx.page("APP") };
}

test("ghl.section in a white-label shell: the nav is clicked in the top frame, the landmark is waited for in the iframe, and the result says which frame", async () => {
  const create = fctl("button", "Create Workflow", { identifier: "create-workflow" });
  const w = await iframeWorld({ builderState: quietState({ netPending: 3, netQuietMs: 0 }) });
  w.topPage.onClick = () => setTimeout(() => { w.chrome._.tabs[0].url = `${SHELL}/v2/location/${LOC}/automation/workflows`; w.builder.controls.push(create); }, 30);
  const t0 = Date.now();
  const r = await dispatchT("ghl.section", { section: "workflows" }, w.ctx);
  const took = Date.now() - t0;
  assert.deepEqual([r.ok, r.via, r.landmark], [true, "nav", true]);
  assert.deepEqual(r.landmarkFrame, { frame: 1, frameOrigin: BUILDER });
  assert.deepEqual([r.trace.frame, r.trace.frameOrigin], [1, BUILDER]);
  assert.equal(w.fx.raw.clicks[0].frame, "TOP", "the shell's nav is in the top frame");
  assert.ok(took < 1500, `with the landmark in hand a busy network is not waited for (took ${took} ms; the old settle step alone soft-waited 2500 ms)`);
  assert.equal(r.trace.netIgnored, true, "and it says the network was not quiet");
});

test("ghl.section still waits for the iframe's own spinner to clear before it says loaded", async () => {
  const create = fctl("button", "Create Workflow", { identifier: "create-workflow" });
  const w = await iframeWorld({ url: `${SHELL}/v2/location/${LOC}/automation/workflows`, builder: [create], builderState: quietState({ busy: 2 }) });
  const t0 = Date.now();
  w.app.onSnapshot = () => { if (Date.now() - t0 > 350) w.builder.state.busy = 0; };
  const r = await dispatchT("ghl.section", { section: "workflows", timeoutMs: 8000 }, w.ctx);
  assert.equal(r.loaded, true);
  assert.ok(Date.now() - t0 >= 340);
  assert.equal(r.trace.busyIgnored, undefined);
});

test("ghl.section with a landmark that never shows in any frame: a default one is a warning after a short grace", async () => {
  const w = await iframeWorld({ url: `${SHELL}/v2/location/${LOC}/automation/workflows`, builder: [fctl("button", "Something else")] });
  const t0 = Date.now();
  const r = await dispatchT("ghl.section", { section: "workflows", timeoutMs: 6000 }, w.ctx);
  assert.equal(r.landmark, false);
  assert.match(r.warning, /landmark/);
  assert.ok(Date.now() - t0 < 2500);
});

test("create-workflow runs when the builder controls live in the iframe: every step in frame 1, and the result lists them", async () => {
  const name = fctl("textbox", "Workflow Name", { identifier: "workflow-name" });
  const create = fctl("button", "Create Workflow", { identifier: "create-workflow" });
  const scratch = fctl("button", "Start from Scratch");
  const w = await iframeWorld({ url: `${SHELL}/v2/location/${LOC}/automation/workflows`, builder: [create, scratch, name] });
  const r = await dispatchT("ghl.run", { flow: "create-workflow", params: { name: "Welcome flow", save: false } }, w.ctx);
  assert.equal(r.ok, true, JSON.stringify(r.detail || r.why));
  assert.equal(name.value, "Welcome flow");
  assert.deepEqual(r.stepFrames.map((/** @type {any} */ x) => [x.frame, x.frameOrigin]), [[1, BUILDER], [1, BUILDER], [1, BUILDER]]);
  assert.equal(w.fx.raw.clicks.every((/** @type {any} */ c) => c.frame === "APP"), true);
  assert.equal(r.failed, undefined);
});

test("a builder tile in the iframe runs without a hold inside a white-label shell, and a real Send in it is still held", async () => {
  const tile = fctl("button", "Send Email", { container: "Add Action drawer" });
  const send = fctl("button", "Send", { container: "Add Action drawer" });
  const w = await iframeWorld({ url: `${SHELL}/v2/location/${LOC}/automation/workflows`, builder: [tile, send] });
  const ok = await act(w.ctx, { selector: { name: "Send Email" }, kind: "click" });
  assert.equal(ok.ok, true);
  const held = await act(w.ctx, { selector: { name: "Send" }, kind: "click" });
  assert.equal(held.held, true);
  const r = await dispatchT("ghl.context", { tabId: 1 }, w.ctx);
  assert.deepEqual([r.builderFrame.index, r.builderFrame.origin, r.builderFrame.readable], [1, BUILDER, true]);
  assert.equal(r.isGhl, true);
});

test("ghl.save: a toast inside the iframe is the evidence, and the builder navigating inside its frame counts as a URL change", async () => {
  const save = fctl("button", "Save", { identifier: "save-workflow" });
  const w = await iframeWorld({ url: `${SHELL}/v2/location/${LOC}/automation/workflows`, builder: [save] });
  w.app.onClick = () => setTimeout(() => { w.builder.state.toasts = [{ ageMs: 5, text: "Workflow saved successfully" }]; }, 40);
  const r = await dispatchT("ghl.save", { tabId: 1 }, w.ctx);
  assert.deepEqual([r.ok, r.evidence.kind, r.trace.frame], [true, "toast", 1]);
  // the same, but the iframe moves to the saved workflow's own address
  const save2 = fctl("button", "Save", { identifier: "save-workflow" });
  const w2 = await iframeWorld({ url: `${SHELL}/v2/location/${LOC}/automation/workflows`, builder: [save2] });
  w2.app.onClick = () => setTimeout(() => w2.fx.navigate("APP", { id: "APP2", url: `${BUILDER}/builder/wf_123` }), 40);
  const u = await dispatchT("ghl.save", { tabId: 1 }, w2.ctx);
  assert.equal(u.evidence.kind, "url");
});
