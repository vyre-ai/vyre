// @ts-check
// page tools across frames: a top page (the shell) with cross-origin, nested, same-origin, late, navigating and unreadable frames.
// Everything runs on the fakes in test-support/fake-chrome.js (createFakeFrames): no Chrome, no window, no network.
import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { createCtx } from "./extension/lib/ctx.js";
import { dispatch } from "./extension/caps/index.js";
import { EXPRESSION, allocate, mergeSnapshot, pinIndexes, isGhlBuilderFrame, builderTile, bindSelector } from "./extension/caps/page.js";
import { topBlocker } from "./extension/lib/ui.js";
import { passwordFieldScript } from "./extension/shared/guards.js";
import { guardInstall, guardCollect } from "./extension/shared/outbound.js";
import { createFakeChrome, createFakeFrames } from "./test-support/fake-chrome.js";

const SHELL = "https://crm.harlow.example";
const APP = "https://client-app-automation-workflows.leadconnectorhq.com";
const PAY = "https://pay.northwind.example";
const quiet = (/** @type {any} */ extra = {}) => ({ busy: 0, domQuietMs: 5000, netPending: 0, netQuietMs: 5000, blockers: [], toasts: [], ...extra });
let n = 0;
/** A control with a box of its own, so a click at its centre can be traced back to it. */
const ctl = (/** @type {string} */ role, /** @type {string} */ name, /** @type {any} */ extra = {}) => {
  n++;
  return { path: `${role}[${n}]`, role, name, enabled: true, box: { x: 10, y: 10 + (n % 9) * 30, w: 100, h: 20 }, ...extra };
};
const centre = (/** @type {any} */ c) => ({ x: c.box.x + c.box.w / 2, y: c.box.y + c.box.h / 2 });

/**
 * The shell (nav) at crm.harlow.example, with the builder in a cross-origin iframe placed at (200, 80) in the shell's viewport.
 * @param {{ frames?: any[], top?: any, userEval?: any }} [o]
 */
async function world(o = {}) {
  const url = `${SHELL}/v2/location/MRKcUjapWpnOvQslF3Pc/automation/workflows?tab=x`;
  const chrome = createFakeChrome([{ url, title: "Harlow CRM", active: true }]);
  const nav = ctl("link", "Automation");
  const contacts = ctl("link", "Contacts");
  const top = { url, title: "Harlow CRM", text: "Harlow Legal", controls: [nav, contacts], state: quiet(), ...(o.top || {}) };
  const create = ctl("button", "Create Workflow", { identifier: "create-workflow" });
  const name = ctl("textbox", "Workflow Name");
  const app = { url: `${APP}/builder?token=abc`, title: "Workflows", text: "Your workflows", controls: [create, name], state: quiet() };
  const fx = createFakeFrames(chrome, { top, frames: o.frames || [{ id: "APP", origin: APP, url: app.url, box: { x: 200, y: 80, w: 900, h: 600 }, model: app }] }, { userEval: o.userEval });
  const ctx = createCtx({ chrome });
  await fx.attach(ctx);
  return { chrome, ctx, fx, nav, contacts, create, name, top, app };
}
const snap = (/** @type {any} */ ctx, /** @type {any} */ args = {}) => dispatch("page.snapshot", { tabId: 1, ...args }, ctx);
const act = (/** @type {any} */ ctx, /** @type {any} */ args) => dispatch("page.act", { tabId: 1, ...args }, ctx);

test("the snapshot script (with frame extras) is still valid JavaScript", () => { new vm.Script(EXPRESSION); });

test("snapshot: runs in every readable frame and merges, each control carrying its frame, origin and its own path", async () => {
  const w = await world();
  const s = await snap(w.ctx);
  assert.deepEqual(s.controls.map((/** @type {any} */ c) => [c.name, c.frame, c.frameOrigin]), [["Automation", 0, SHELL], ["Contacts", 0, SHELL], ["Create Workflow", 1, APP], ["Workflow Name", 1, APP]]);
  assert.deepEqual(s.frames.map((/** @type {any} */ f) => [f.index, f.depth, f.origin, f.readable, f.controls]), [[0, 0, SHELL, true, 2], [1, 1, APP, true, 2]]);
  assert.equal(s.frames[1].url, `${APP}/builder`, "the url comes without its query");
  assert.ok(!JSON.stringify(s).includes("token=abc"));
  assert.equal(s.notReadable, undefined);
  assert.match(s.text, /Harlow Legal/);
  assert.match(s.text, /\[frame 1 https:\/\/client-app-automation-workflows/);
  assert.match(s.text, /Your workflows/, "the text inside the iframe is on the page too");
  assert.equal(s.named, 4);
});

test("snapshot: a page with only its top frame keeps its shape (no frame on controls) and lists the one frame", async () => {
  const w = await world({ frames: [] });
  const s = await snap(w.ctx);
  assert.ok(s.controls.every((/** @type {any} */ c) => !("frame" in c) && !("frameOrigin" in c) && c.box));
  assert.deepEqual(s.frames.map((/** @type {any} */ f) => [f.index, f.readable]), [[0, true]]);
});

test("a control's selector in the snapshot carries its frame, and pins it", async () => {
  const w = await world();
  const s = await snap(w.ctx);
  const c = s.controls.find((/** @type {any} */ x) => x.name === "Workflow Name");
  const r = await dispatch("page.fill", { tabId: 1, fields: [{ selector: { name: c.name, path: c.path, frame: c.frame }, value: "Welcome" }] }, w.ctx);
  assert.equal(r.ok, true);
  assert.equal(r.trace.frame, 1);
  assert.equal(r.trace.frameOrigin, APP);
  assert.equal(w.name.value, "Welcome");
});

test("snapshot: a frame that is not readable is said, in the fields and in the text, and one that fills the page says so explicitly", async () => {
  const w = await world({ top: { state: quiet({ vw: 1200, vh: 800, iframes: [{ src: `${PAY}/embed`, x: 0, y: 80, w: 1100, h: 700 }] }) }, frames: [
    { id: "APP", origin: APP, url: `${APP}/builder`, box: { x: 0, y: 0, w: 10, h: 10 }, model: { url: `${APP}/builder`, title: "W", text: "", controls: [ctl("button", "Save")] } },
    { id: "PAY", origin: PAY, url: `${PAY}/embed`, box: { x: 0, y: 80, w: 1100, h: 700 }, via: "none" },
  ] });
  const s = await snap(w.ctx);
  assert.equal(s.notReadable.length, 1);
  assert.deepEqual([s.notReadable[0].index, s.notReadable[0].origin], [2, PAY]);
  assert.match(s.notReadable[0].why, /on the page but Chrome has given no frame or session for it/);
  assert.equal(s.notReadable[0].coversViewport, 80);
  assert.match(s.text, /^1 frame not readable: https:\/\/pay\.northwind\.example\./);
  assert.match(s.text, /Frame 2 \(https:\/\/pay\.northwind\.example\) covers about 80% of the viewport and is not readable/);
  assert.deepEqual(s.frames.map((/** @type {any} */ f) => f.readable), [true, true, false]);
  // it is never the shell alone passing for the whole page
  assert.ok(s.controls.some((/** @type {any} */ c) => c.frame === 1));
});

test("snapshot: nested and same-process frames are read too, in tree order", async () => {
  const mk = (/** @type {string} */ name) => ({ url: "x", title: name, text: name + " text", controls: [ctl("button", name)] });
  const w = await world({ frames: [
    { id: "APP", origin: APP, url: `${APP}/b`, box: { x: 200, y: 80, w: 900, h: 600 }, model: mk("Inner save") },
    { id: "INNER", parent: "APP", origin: PAY, url: `${PAY}/`, box: { x: 10, y: 20, w: 300, h: 200 }, model: mk("Pay") },
    { id: "SAME", origin: SHELL, url: `${SHELL}/widget`, box: { x: 0, y: 700, w: 300, h: 50 }, via: "context", model: mk("Widget") },
  ] });
  const s = await snap(w.ctx);
  // Frames in the top process come first (Chrome lists one process per tree), then each cross-origin subtree under its owner.
  assert.deepEqual(s.frames.map((/** @type {any} */ f) => [f.index, f.depth, f.parent, f.origin]), [[0, 0, undefined, SHELL], [1, 1, 0, SHELL], [2, 1, 0, APP], [3, 2, 2, PAY]]);
  assert.deepEqual(s.controls.filter((/** @type {any} */ c) => c.frame > 0).map((/** @type {any} */ c) => [c.name, c.frame]), [["Widget", 1], ["Inner save", 2], ["Pay", 3]]);
});

test("budget: each frame gets its own share of the limit with a floor, and main content and dialogs beat navigation chrome", async () => {
  assert.deepEqual(allocate([100, 100], 40), [20, 20]);
  assert.deepEqual(allocate([3, 100], 40), [3, 37], "a small frame leaves its share to the big one");
  assert.deepEqual(allocate([100, 100, 100], 60), [20, 20, 20]);
  assert.deepEqual(allocate([100, 5], 10), [5, 5]);
  assert.deepEqual(allocate([10, 10], undefined), [10, 10]);
  const chrome = /** @type {any[]} */ ([]);
  for (let i = 0; i < 6; i++) chrome.push({ path: `nav[${i}]`, role: "link", name: "nav " + i, enabled: true, pri: 2, box: { x: 0, y: i, w: 1, h: 1 } });
  for (let i = 0; i < 6; i++) chrome.push({ path: `main[${i}]`, role: "button", name: "main " + i, enabled: true, pri: 0, box: { x: 0, y: 50 + i, w: 1, h: 1 } });
  const m = mergeSnapshot([{ index: 0, frameId: "T", parentId: null, depth: 0, url: "https://a.example/", origin: "https://a.example", how: "top", readable: true }], [{ raw: { title: "t", url: "https://a.example/", text: "", controls: chrome } }], { limit: 6 });
  assert.deepEqual(m.controls.map((/** @type {any} */ c) => c.name), ["main 0", "main 1", "main 2", "main 3", "main 4", "main 5"]);
  assert.deepEqual(m.truncated, { total: 12, returned: 6 });
  assert.equal(m.frames[0].total, 12);
  assert.ok(m.controls.every((/** @type {any} */ c) => !("pri" in c)));
  const w = await world();
  const two = await snap(w.ctx, { limit: 3 });
  assert.equal(two.controls.length, 4, "both frames keep at least their floor (4 controls fit under it)");
});

test("selectors: two frames matching is tied, and the error says which frames; a frame pin (index, id, origin piece) resolves it", async () => {
  const shellSave = ctl("button", "Save");
  const appSave = ctl("button", "Save");
  const w = await world({ top: { controls: [shellSave] }, frames: [{ id: "APP", origin: APP, url: `${APP}/b`, box: { x: 200, y: 80, w: 900, h: 600 }, model: { url: "x", title: "", text: "", controls: [appSave] } }] });
  await assert.rejects(act(w.ctx, { selector: { name: "Save" }, kind: "click", asked: true }), (/** @type {any} */ e) => {
    assert.equal(e.code, "tied");
    assert.match(e.message, /in frames 0 and 1/);
    assert.equal(e.detail.candidates.length, 2);
    assert.match(e.detail.candidates[1], /Save \[frame 1 https:\/\/client-app-automation/);
    assert.deepEqual(e.detail.tiedFrames, [0, 1]);
    return true;
  });
  for (const pin of [1, "1", "APP", "leadconnectorhq", APP]) {
    w.fx.raw.clicks.length = 0;
    const r = await act(w.ctx, { selector: { name: "Save", frame: pin }, kind: "click", asked: true });
    assert.equal(r.ok, true, `pin ${pin}`);
    assert.equal(r.control.frame, 1);
    assert.equal(w.fx.raw.clicks[0].frame, "APP");
  }
  const top = await act(w.ctx, { selector: { name: "Save", frame: "top" }, kind: "click", asked: true });
  assert.equal(top.control.frame, 0);
  await assert.rejects(act(w.ctx, { selector: { name: "Save", frame: 9 }, kind: "click", asked: true }), (/** @type {any} */ e) => e.code === "not_found" && /no frame matches 9/.test(e.detail.candidates[0]));
});

test("selectors: a control inside an open dialog wins a tie between frames", async () => {
  const dlgSave = ctl("button", "Save", { blk: 0 });
  const plain = ctl("button", "Save");
  const w = await world({ top: { controls: [plain] }, frames: [{ id: "APP", origin: APP, url: `${APP}/b`, box: { x: 0, y: 0, w: 500, h: 500 }, model: { url: "x", title: "", text: "", controls: [dlgSave], state: quiet({ blockers: [] }) } }] });
  // no modal in the way, the dialog marker alone: the one in the dialog is the one meant
  w.fx.page("APP").model.state.blockers = [{ i: 0, path: "div[0]", role: "dialog", title: "Edit step", text: "Edit step", modal: false }];
  const r = await act(w.ctx, { selector: { name: "Save" }, kind: "click", asked: true });
  assert.equal(r.control.frame, 1);
});

test("act: the click is found in the frame, moved by the frame's offset, and sent to the TOP session", async () => {
  const w = await world();
  const r = await act(w.ctx, { selector: { name: "Create Workflow" }, kind: "click", asked: true });
  assert.equal(r.ok, true);
  const c = centre(w.create);
  assert.deepEqual(w.fx.raw.mouse.map((/** @type {any} */ m) => [m.type, m.x, m.y, m.sessionId]), [["mouseMoved", c.x + 200, c.y + 80, undefined], ["mousePressed", c.x + 200, c.y + 80, undefined], ["mouseReleased", c.x + 200, c.y + 80, undefined]]);
  assert.deepEqual(w.fx.page("APP").clicks, [{ x: c.x, y: c.y }], "and inside the frame it lands where the control is");
  assert.equal(w.fx.page("TOP").clicks.length, 0);
});

test("act: a nested frame's click adds up every offset on the way; the hit test stays inside the frame", async () => {
  const pay = ctl("button", "Pay now");
  const w = await world({ frames: [
    { id: "APP", origin: APP, url: `${APP}/b`, box: { x: 200, y: 80, w: 900, h: 600 }, model: { url: "x", title: "", text: "", controls: [] } },
    { id: "INNER", parent: "APP", origin: PAY, url: `${PAY}/`, box: { x: 10, y: 20, w: 400, h: 400 }, model: { url: "x", title: "", text: "", controls: [pay] } },
  ] });
  const c = centre(pay);
  const r = await act(w.ctx, { selector: { name: "Pay now" }, kind: "check", value: true });
  assert.equal(r.ok, true);
  assert.deepEqual(w.fx.raw.clicks.map((/** @type {any} */ k) => [k.x, k.y, k.frame]), [[c.x + 210, c.y + 100, "INNER"]]);
  // covered inside the frame: nothing is clicked
  w.fx.raw.clicks.length = 0;
  w.fx.page("INNER").covered = true;
  await assert.rejects(act(w.ctx, { selector: { name: "Pay now" }, kind: "click", asked: true }), { code: "covered" });
  assert.equal(w.fx.raw.clicks.length, 0);
});

test("act: keys focus the element inside its frame and go out on the top session", async () => {
  const w = await world();
  const r = await act(w.ctx, { selector: { name: "Workflow Name" }, kind: "press", value: "Tab", asked: true });
  assert.equal(r.ok, true);
  assert.equal(r.control.frame, 1);
  assert.deepEqual(w.fx.raw.keys.map((/** @type {any} */ k) => [k.type, k.key, k.sessionId]), [["rawKeyDown", "Tab", undefined], ["keyUp", "Tab", undefined]]);
});

test("held: a real Send in a frame is still held, and its selector carries the frame so a release lands in the same place", async () => {
  const send = ctl("button", "Send message");
  const w = await world({ frames: [{ id: "APP", origin: APP, url: `${APP}/b`, box: { x: 200, y: 80, w: 900, h: 600 }, model: { url: "x", title: "", text: "", controls: [send] } }] });
  const h = await act(w.ctx, { selector: { name: "Send message" }, kind: "click" });
  assert.deepEqual([h.ok, h.held, h.control.frame, h.selector.frame], [false, true, 1, 1]);
  assert.equal(w.fx.raw.clicks.length, 0);
  const rel = await act(w.ctx, { selector: h.selector, kind: "click", release: { sig: h.sig } });
  assert.equal(rel.ok, true);
  assert.equal(w.fx.raw.clicks[0].frame, "APP");
});

test("fill: fields are grouped by frame, one script per frame; values never come back", async () => {
  const shellEmail = ctl("textbox", "Search");
  const a = ctl("textbox", "Subject");
  const b = ctl("textbox", "Body");
  const w = await world({ top: { controls: [shellEmail] }, frames: [{ id: "APP", origin: APP, url: `${APP}/b`, box: { x: 200, y: 80, w: 900, h: 600 }, model: { url: "x", title: "", text: "", controls: [a, b] } }] });
  const r = await dispatch("page.fill", { tabId: 1, fields: [{ label: "Subject", value: "Hello kit" }, { label: "Search", value: "juno" }, { label: "Body", value: "Northwind Bakery news" }] }, w.ctx);
  assert.deepEqual([r.ok, r.filled], [true, 3]);
  assert.deepEqual([w.fx.page("APP").applies, w.fx.page("TOP").applies], [1, 1], "one apply per frame");
  assert.deepEqual([a.value, b.value, shellEmail.value], ["Hello kit", "Northwind Bakery news", "juno"]);
  assert.ok(!JSON.stringify(r).includes("Northwind Bakery news") && !JSON.stringify(r).includes("Hello kit"));
  assert.ok(r.trace.frames === undefined || Array.isArray(r.trace.frames));
  // a label pinned to a frame
  await assert.rejects(dispatch("page.fill", { tabId: 1, fields: [{ label: "Search", frame: 1, value: "x" }] }, w.ctx), { code: "not_found" });
});

test("wait: a selector is found in any frame; one that appears late in a child frame is picked up", async () => {
  const w = await world();
  const later = ctl("button", "Add Action");
  setTimeout(() => w.fx.page("APP").model.controls.push(later), 120);
  const t0 = Date.now();
  const r = await dispatch("page.wait", { tabId: 1, selector: { name: "Add Action" }, timeoutMs: 3000 }, w.ctx);
  assert.equal(r.ok, true);
  assert.ok(Date.now() - t0 >= 100);
  assert.equal(r.trace.frame, 1);
  // gone, across frames
  setTimeout(() => { w.fx.page("APP").model.controls.length = 0; }, 100);
  assert.equal((await dispatch("page.wait", { tabId: 1, selector: { name: "Add Action" }, gone: true, timeoutMs: 3000 }, w.ctx)).ok, true);
  // a CSS selector, in any frame, or in the one `frame` names
  w.fx.page("APP").model.css = "#builder";
  const css = await dispatch("page.wait", { tabId: 1, selector: "#builder", timeoutMs: 500 }, w.ctx);
  assert.equal(css.trace.frame, 1);
  await assert.rejects(dispatch("page.wait", { tabId: 1, selector: "#builder", frame: "top", timeoutMs: 150 }, w.ctx), (/** @type {any} */ e) => e.code === "timeout" && /frame "top"/.test(e.message) && e.detail.frame === 0);
});

test("wait: a frame that appears late is picked up (a new frame, and the same one after it navigates and gets a new id)", async () => {
  const w = await world({ frames: [] });
  const target = ctl("button", "Next step");
  setTimeout(() => w.fx.addFrame({ id: "LATE", origin: APP, url: `${APP}/late`, box: { x: 0, y: 0, w: 300, h: 300 }, model: { url: "x", title: "", text: "", controls: [] } }), 60);
  setTimeout(() => { w.fx.navigate("LATE", { id: "LATE2", url: `${APP}/late2` }); w.fx.page("LATE2").model.controls.push(target); }, 160);
  const r = await dispatch("page.wait", { tabId: 1, selector: { name: "Next step" }, timeoutMs: 3000 }, w.ctx);
  assert.equal(r.ok, true);
  assert.equal(r.trace.frame, 1);
  const c = await act(w.ctx, { selector: { name: "Next step" }, kind: "click", asked: true });
  assert.equal(c.ok, true);
  assert.equal(w.fx.raw.clicks[0].frame, "LATE2");
});

test("wait settled: looks in every readable frame, so a spinner in the iframe holds it", async () => {
  const w = await world();
  const app = w.fx.page("APP");
  app.model.state = quiet({ busy: 2, busySample: ["div.spinner"] });
  const t0 = Date.now();
  app.onSnapshot = () => { if (Date.now() - t0 > 300) app.model.state.busy = 0; };
  const r = await dispatch("page.wait", { tabId: 1, settled: true, timeoutMs: 5000 }, w.ctx);
  assert.equal(r.ok, true);
  assert.ok(Date.now() - t0 >= 290, "not settled while the iframe's skeleton was on screen");
  assert.equal(r.trace.busyIgnored, undefined);
  // and a network request pending in a frame counts
  app.model.state = quiet({ netPending: 1, netQuietMs: 0 });
  const t1 = Date.now();
  app.onSnapshot = () => { if (Date.now() - t1 > 200) { app.model.state.netPending = 0; app.model.state.netQuietMs = 300; } };
  const r2 = await dispatch("page.wait", { tabId: 1, settled: true, timeoutMs: 5000 }, w.ctx);
  assert.equal(r2.ok, true);
  assert.ok(Date.now() - t1 >= 190);
});

test("wait url and idle look across frames", async () => {
  const w = await world();
  const r = await dispatch("page.wait", { tabId: 1, url: "/builder", timeoutMs: 500 }, w.ctx);
  assert.deepEqual([r.ok, r.trace.frame], [true, 1]);
  await assert.rejects(dispatch("page.wait", { tabId: 1, url: "/builder", frame: "top", timeoutMs: 150 }, w.ctx), { code: "timeout" });
  w.fx.page("APP").quietMs = 0;
  await assert.rejects(dispatch("page.wait", { tabId: 1, idleMs: 200, timeoutMs: 150 }, w.ctx), { code: "timeout" });
  w.fx.page("APP").quietMs = 10_000;
  assert.equal((await dispatch("page.wait", { tabId: 1, idleMs: 200, timeoutMs: 500 }, w.ctx)).ok, true);
});

test("a step that runs while its frame navigates re-resolves the frame and retries within the retry budget", async () => {
  const w = await world();
  let tripped = false;
  const inner = w.chrome._.cdp;
  w.chrome._.cdp = (/** @type {any} */ tab, /** @type {string} */ method, /** @type {any} */ p, /** @type {any} */ session) => {
    // the first locate inside the iframe finds the frame navigating: it gets a new id and session, and the old session is gone
    if (!tripped && method === "Runtime.evaluate" && session === "S-APP" && String(p.expression).startsWith("/*vyre:locate")) {
      tripped = true;
      w.fx.navigate("APP", { id: "APP2", url: `${APP}/builder2` });
      throw new Error("Session with given id not found.");
    }
    return inner(tab, method, p, session);
  };
  const r = await dispatch("batch.run", { steps: [{ op: "page.act", args: { tabId: 1, selector: { name: "Create Workflow" }, kind: "click", asked: true } }, { op: "page.fill", args: { tabId: 1, fields: [{ label: "Workflow Name", value: "Welcome" }] } }] }, w.ctx);
  assert.equal(r.ok, true, JSON.stringify(r.detail || r.why));
  assert.equal(r.results[0].trace.retries, 1);
  assert.equal(r.results[0].trace.frame, 1);
  assert.equal(w.fx.raw.clicks[0].frame, "APP2");
  assert.equal(w.name.value, "Welcome");
});

test("a control whose frame is really gone fails as stale, and says which frame", async () => {
  const w = await world();
  const s = await snap(w.ctx);
  const c = s.controls.find((/** @type {any} */ x) => x.name === "Create Workflow");
  w.fx.removeFrame("APP");
  await assert.rejects(act(w.ctx, { selector: { name: "Create Workflow", frame: c.frame }, kind: "click", asked: true }), (/** @type {any} */ e) => e.code === "not_found" && /no frame matches 1/.test(e.detail.candidates[0]));
});

test("blockers are per frame: a dialog in the iframe blocks the iframe, not the shell; a dialog in the shell blocks the iframe too", async () => {
  const confirm = ctl("button", "Discard changes", { blk: 0 });
  const inside = ctl("button", "Add Action");
  const w = await world({ frames: [{ id: "APP", origin: APP, url: `${APP}/b`, box: { x: 200, y: 80, w: 900, h: 600 }, model: { url: "x", title: "", text: "", controls: [inside, confirm], state: quiet({ blockers: [{ i: 0, path: "div[0]", role: "dialog", title: "Unsaved changes", text: "You have unsaved changes", modal: true }] }) } }] });
  await assert.rejects(act(w.ctx, { selector: { name: "Add Action" }, kind: "click", asked: true }), (/** @type {any} */ e) => {
    assert.equal(e.code, "modal");
    assert.match(e.message, /in frame 1/);
    assert.equal(e.detail.frame, 1);
    assert.equal(e.detail.blockers[0].frame, 1);
    return true;
  });
  const shellOk = await act(w.ctx, { selector: { name: "Contacts" }, kind: "click", asked: true });
  assert.equal(shellOk.ok, true, "the shell is not behind the iframe's dialog");
  // a modal in the shell is in front of the iframe
  w.fx.page("APP").model.state.blockers = [];
  w.fx.page("TOP").model.state = quiet({ blockers: [{ i: 0, path: "div[0]", role: "dialog", title: "Session expiring", text: "Confirm you are still here", modal: true }] });
  await assert.rejects(act(w.ctx, { selector: { name: "Add Action" }, kind: "click", asked: true }), { code: "modal" });
  // the unit rule
  const s = mergeSnapshot([{ index: 0, frameId: "T", parentId: null, depth: 0, url: "", origin: "a", how: "top", readable: true }, { index: 1, frameId: "A", parentId: "T", depth: 1, url: "", origin: "b", how: "session", readable: true }, { index: 2, frameId: "B", parentId: "T", depth: 1, url: "", origin: "c", how: "session", readable: true }],
    [{ raw: { controls: [], state: quiet() } }, { raw: { controls: [{ path: "x", role: "button", name: "in A", enabled: true }], state: quiet({ blockers: [{ i: 0, modal: true, role: "dialog" }] }) } }, { raw: { controls: [{ path: "y", role: "button", name: "in B", enabled: true }], state: quiet() } }]);
  assert.equal(topBlocker(s, s.controls[0]).frame, 1, "a dialog in frame 1 is in front of frame 1's controls");
  assert.equal(topBlocker(s, { frame: 2, path: "y" }), null, "but not of a sibling frame");
  assert.equal(topBlocker(s, { frame: 0, path: "z" }), null, "nor of the shell");
});

test("failures say which frame they looked in, the page snippet comes from that frame, and traces carry frame and frameOrigin", async () => {
  const w = await world();
  w.fx.page("APP").model.dom = "<button>Create Workflow</button>";
  w.fx.page("TOP").model.dom = "<a>Automation</a>";
  const e = await act(w.ctx, { selector: { name: "Nope" }, kind: "click" }).catch((/** @type {any} */ x) => x);
  assert.equal(e.code, "not_found");
  assert.equal(e.detail.searched, "all readable frames");
  assert.deepEqual(e.detail.frames.map((/** @type {any} */ f) => f.index), [0, 1]);
  const pinned = await act(w.ctx, { selector: { name: "Nope", frame: 1 }, kind: "click" }).catch((/** @type {any} */ x) => x);
  assert.equal(pinned.detail.frame, 1);
  assert.equal(pinned.detail.frameOrigin, APP);
  assert.equal(pinned.detail.searched, "frame 1 (pinned)");
  assert.match(pinned.detail.dom, /Create Workflow/, "the snippet is from the frame it was expected in");
  const ok = await act(w.ctx, { selector: { name: "Contacts" }, kind: "click", asked: true });
  assert.deepEqual([ok.trace.frame, ok.trace.frameOrigin], [0, SHELL]);
  // a disabled control names its frame too
  w.create.enabled = false;
  const dis = await act(w.ctx, { selector: { name: "Create Workflow" }, kind: "click", asked: true });
  assert.equal(dis.ok, false);
  assert.equal(dis.control.frame, 1);
});

test("eval: `frame` picks where the script runs (index, id or a piece of the origin); the guard shim goes in and comes out of that same frame", async () => {
  /** @type {any[]} */ const seen = [];
  const w = await world({ userEval: (/** @type {string} */ id, /** @type {string} */ expr) => {
    seen.push([id, expr === passwordFieldScript ? "password" : expr === guardInstall ? "install" : expr === guardCollect ? "collect" : expr]);
    if (expr === passwordFieldScript) return { result: { type: "boolean", value: false } };
    if (expr === guardInstall) return { result: { type: "boolean", value: true } };
    if (expr === guardCollect) return { result: { type: "object", value: [] } };
    return { result: { type: "string", value: "ran in " + id } };
  } });
  const r = await dispatch("page.eval", { tabId: 1, expression: "document.title", frame: "leadconnectorhq" }, w.ctx);
  assert.deepEqual([r.ok, r.value, r.frame, r.frameOrigin], [true, "ran in APP", 1, APP]);
  const mine = seen.filter(x => x[1] === "install" || x[1] === "collect" || x[1] === "document.title");
  assert.deepEqual(mine, [["APP", "install"], ["APP", "document.title"], ["APP", "collect"]], "install, run and collect all happen in the frame the script runs in");
  // default is the top page, and the shape is unchanged
  seen.length = 0;
  const t = await dispatch("page.eval", { tabId: 1, expression: "document.title" }, w.ctx);
  assert.equal(t.value, "ran in TOP");
  assert.deepEqual(seen.filter(x => x[1] === "install" || x[1] === "collect").map(x => x[0]), ["TOP", "TOP"]);
  // by index and by id
  assert.equal((await dispatch("page.eval", { tabId: 1, expression: "1", frame: 1, asked: true }, w.ctx)).value, "ran in APP");
  assert.equal((await dispatch("page.eval", { tabId: 1, expression: "1", frame: "APP", asked: true }, w.ctx)).frame, 1);
  await assert.rejects(dispatch("page.eval", { tabId: 1, expression: "1", frame: "nowhere" }, w.ctx), { code: "not_found" });
});

test("eval: a password field in ANY readable frame makes the script refuse, wherever it would have run", async () => {
  const w = await world({ frames: [
    { id: "APP", origin: APP, url: `${APP}/b`, box: { x: 200, y: 80, w: 900, h: 600 }, model: { url: "x", title: "", text: "", controls: [] } },
    { id: "LOGIN", origin: PAY, url: `${PAY}/signin`, box: { x: 0, y: 0, w: 100, h: 100 }, model: { url: "x", title: "", text: "", controls: [] } },
    { id: "HIDDEN", origin: "https://ads.northwind.example", url: "https://ads.northwind.example/", box: { x: 0, y: 0, w: 1, h: 1 }, via: "none" },
  ], userEval: (/** @type {string} */ id, /** @type {string} */ expr) => (expr === passwordFieldScript ? { result: { type: "boolean", value: id === "LOGIN" } } : { result: { type: "string", value: "ran in " + id } }) });
  for (const frame of [undefined, 1, "LOGIN"]) {
    await assert.rejects(dispatch("page.eval", { tabId: 1, expression: "1", asked: true, ...(frame !== undefined ? { frame } : {}) }, w.ctx), (/** @type {any} */ e) => e.code === "blocked" && /frame 2 \(https:\/\/pay\.northwind\.example\) has a password field/.test(e.message), `frame ${frame}`);
  }
  // without the login form: it runs, and says a frame it could not read was not scanned
  w.fx.removeFrame("LOGIN");
  const ok = await dispatch("page.eval", { tabId: 1, expression: "1", asked: true }, w.ctx);
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.notScanned, [{ index: 2, origin: "https://ads.northwind.example" }]);
});

test("GoHighLevel: a builder iframe on a leadconnectorhq.com automation host makes its tiles builder tiles, even in a white-label shell", async () => {
  assert.equal(isGhlBuilderFrame({ depth: 1, url: `${APP}/x`, origin: APP }), true);
  assert.equal(isGhlBuilderFrame({ depth: 1, url: "https://app.leadconnectorhq.com/automation/workflows/abc", origin: "https://app.leadconnectorhq.com" }), true);
  assert.equal(isGhlBuilderFrame({ depth: 0, url: `${APP}/x`, origin: APP }), false, "the top page is not a child frame");
  assert.equal(isGhlBuilderFrame({ depth: 1, url: "https://automation.northwind.example/", origin: "https://automation.northwind.example" }), false, "an automation host that is not GoHighLevel's");
  assert.equal(isGhlBuilderFrame({ depth: 1, url: "https://services.leadconnectorhq.com/x", origin: "https://services.leadconnectorhq.com" }), false);
  const tile = ctl("button", "Send Email", { container: "Add action" });
  const realSend = ctl("button", "Send", { container: "Add action" });
  const w = await world({ top: { url: `${SHELL}/dashboard`, controls: [] }, frames: [{ id: "APP", origin: APP, url: `${APP}/builder`, box: { x: 200, y: 80, w: 900, h: 600 }, model: { url: "x", title: "", text: "", controls: [tile, realSend] } }] });
  const s = await snap(w.ctx);
  assert.deepEqual([s.state.ghlFrame, s.ghlFrames], [true, [1]]);
  const r = await act(w.ctx, { selector: { name: "Send Email" }, kind: "click" });
  assert.equal(r.ok, true, "a builder tile is not held");
  const h = await act(w.ctx, { selector: { name: "Send" }, kind: "click" });
  assert.equal(h.held, true, "a real Send still is");
  // the same tile in a frame that is not GoHighLevel's is held
  const other = await world({ top: { url: `${SHELL}/dashboard`, controls: [] }, frames: [{ id: "X", origin: PAY, url: `${PAY}/workflows`, box: { x: 0, y: 0, w: 500, h: 500 }, model: { url: "x", title: "", text: "", controls: [ctl("button", "Send Email", { container: "Add action" })] } }] });
  assert.equal((await act(other.ctx, { selector: { name: "Send Email" }, kind: "click" })).held, true);
  // a page cannot claim it: a page-supplied flag is dropped by the merge
  const forged = mergeSnapshot([{ index: 0, frameId: "T", parentId: null, depth: 0, url: `${SHELL}/dashboard`, origin: SHELL, how: "top", readable: true }], [{ raw: { controls: [], state: { ghlFrame: true } } }]);
  assert.equal(forged.state.ghlFrame, undefined);
  assert.equal(builderTile({ url: `${SHELL}/dashboard`, state: { ghlFrame: true }, ghlFrames: [] }, { role: "button", name: "Send Email", container: "Add action", frame: 1 }), false);
});

test("pinIndexes and bindSelector on plain objects", () => {
  const frames = [{ index: 0, origin: "https://a.example", url: "https://a.example/" }, { index: 1, id: "F1", origin: "https://b.example", url: "https://b.example/x/y" }];
  assert.deepEqual([pinIndexes(frames, undefined), pinIndexes(frames, "top"), pinIndexes(frames, 1), pinIndexes(frames, "F1"), pinIndexes(frames, "b.example"), pinIndexes(frames, "/x/y"), pinIndexes(frames, "zzz"), pinIndexes(frames, 7)], [null, [0], [1], [1], [1], [1], [], []]);
  const controls = [{ role: "button", name: "Save", frame: 0, enabled: true, path: "a" }, { role: "button", name: "Save", frame: 1, enabled: true, path: "a" }];
  assert.equal(bindSelector({ name: "Save" }, { controls, frames }).why, "tied");
  assert.equal(bindSelector({ name: "Save", frame: 1 }, { controls, frames }).control.frame, 1);
});
