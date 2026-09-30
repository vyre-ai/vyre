// @ts-check
// frames: child sessions (cross-origin iframes, nested) are kept, listed honestly, addressed and placed.
import test from "node:test";
import assert from "node:assert/strict";
import { createCtx } from "./extension/lib/ctx.js";
import { dispatch } from "./extension/caps/index.js";
import { createFakeChrome } from "./test-support/fake-chrome.js";
import { realisticFrameTree } from "./devtools-kit.js";

/** A tab whose page has a shell, a cross-origin app (own session), a nested cross-origin frame (own session) and a same-process frame. */
function world() {
  const chrome = createFakeChrome([{ url: "https://shell.harlow.example/", title: "Shell", active: true }]);
  const tree = {
    frame: { id: "TOP", url: "https://shell.harlow.example/", securityOrigin: "https://shell.harlow.example" },
    childFrames: [
      { frame: { id: "APP", parentId: "TOP", url: "https://app.harlow.example/workflows?token=abc", securityOrigin: "https://app.harlow.example" }, childFrames: [
        { frame: { id: "INNER", parentId: "APP", url: "https://pay.harlow.example/", securityOrigin: "https://pay.harlow.example" } },
      ] },
      { frame: { id: "SAME", parentId: "TOP", url: "https://shell.harlow.example/widget", securityOrigin: "https://shell.harlow.example" } },
    ],
  };
  const calls = /** @type {any[]} */ ([]);
  chrome._.cdp = (/** @type {number} */ tab, /** @type {string} */ method, /** @type {any} */ p, /** @type {string|undefined} */ session) => {
    calls.push({ method, session, p });
    // Chrome lists only one process's frames per session: the cross-origin APP and INNER are in their own sessions' trees, not the top's.
    if (method === "Page.getFrameTree") return realisticFrameTree(tree, [{ sessionId: "S-APP", targetId: "APP" }, { sessionId: "S-INNER", targetId: "INNER" }])(p, tab, session);
    // An iframe the page holds that Chrome has given no frame or session for (a cross-origin frame still attaching).
    if (method === "Runtime.evaluate" && String(p.expression).includes("querySelectorAll('iframe, frame')") && !session && p.contextId === undefined) return { result: { value: [{ src: "https://late.harlow.example/", origin: "https://late.harlow.example", sandbox: false, w: 300, h: 200 }, { src: "https://app.harlow.example/workflows", origin: "https://app.harlow.example", sandbox: false, w: 800, h: 500 }] } };
    if (method === "Runtime.evaluate" && String(p.expression).includes("querySelectorAll('iframe, frame')")) return { result: { value: [] } };
    if (method === "Runtime.evaluate") return { result: { value: { session: session || "top", ctx: p.contextId ?? null, expr: p.expression } } };
    if (method === "DOM.getFrameOwner") return { backendNodeId: p.frameId === "APP" ? 11 : 22 };
    if (method === "DOM.getBoxModel") return { model: { content: p.backendNodeId === 11 ? [100, 60, 900, 60, 900, 560, 100, 560] : [10, 20, 410, 20, 410, 220, 10, 220] } };
    return {};
  };
  const ctx = createCtx({ chrome });
  const ev = (/** @type {any} */ source, /** @type {string} */ m, /** @type {any} */ params) => chrome._.onEvent.fire(source, m, params);
  return { chrome, ctx, calls, ev, tree };
}

test("frames: the debugger layer keeps child sessions as they attach, nested ones too, and forgets them when they go", async () => {
  const { ctx, chrome, ev, calls } = world();
  await ctx.cdp.attach(1);
  assert.ok(calls.some(c => c.method === "Target.setAutoAttach") || chrome._.commands.some((/** @type {any} */ c) => c.method === "Target.setAutoAttach"), "asks Chrome for child sessions");
  ev({ tabId: 1 }, "Target.attachedToTarget", { sessionId: "S-APP", targetInfo: { targetId: "APP", type: "iframe", url: "https://app.harlow.example/" }, waitingForDebugger: false });
  ev({ tabId: 1, sessionId: "S-APP" }, "Target.attachedToTarget", { sessionId: "S-INNER", targetInfo: { targetId: "INNER", type: "iframe", url: "https://pay.harlow.example/" }, waitingForDebugger: false });
  assert.deepEqual(ctx.cdp.children(1).map((/** @type {any} */ c) => c.targetId).sort(), ["APP", "INNER"]);
  assert.ok(chrome._.commands.some((/** @type {any} */ c) => c.method === "Target.setAutoAttach" && c.sessionId === "S-APP"), "a child is asked to auto-attach its own children");
  ev({ tabId: 1 }, "Target.detachedFromTarget", { sessionId: "S-INNER" });
  assert.deepEqual(ctx.cdp.children(1).map((/** @type {any} */ c) => c.targetId), ["APP"]);
});

test("frames.list: every frame, in tree order, with origin, how it is reached, and an iframe Chrome gave no frame for is NOT readable and says why", async () => {
  const { ctx, ev } = world();
  await ctx.cdp.attach(1);
  ev({ tabId: 1 }, "Target.attachedToTarget", { sessionId: "S-APP", targetInfo: { targetId: "APP", type: "iframe", url: "https://app.harlow.example/" } });
  ev({ tabId: 1, sessionId: "S-APP" }, "Target.attachedToTarget", { sessionId: "S-INNER", targetInfo: { targetId: "INNER", type: "iframe", url: "https://pay.harlow.example/" } });
  // A same-process frame has an execution context on the top session.
  ev({ tabId: 1 }, "Runtime.executionContextCreated", { context: { id: 77, auxData: { isDefault: true, frameId: "SAME" } } });
  const r = await dispatch("frames.list", { tabId: 1 }, ctx);
  assert.equal(r.count, 5);
  assert.deepEqual(r.frames.map((/** @type {any} */ f) => [f.index, f.depth, f.origin, f.readable, f.via]), [
    [0, 0, "https://shell.harlow.example", true, "top"],
    [1, 1, "https://shell.harlow.example", true, "context"],
    [2, 1, "https://app.harlow.example", true, "session"],
    [3, 2, "https://pay.harlow.example", true, "session"],
    [4, 1, "https://late.harlow.example", false, "none"],
  ]);
  assert.deepEqual(r.notReadable, [{ index: 4, origin: "https://late.harlow.example" }], "a frame Vyre cannot read is said, never left out");
  assert.match(r.frames[4].why, /on the page but Chrome has given no frame or session for it/);
  assert.ok(!JSON.stringify(r).includes("token=abc"), "the query string never comes back");
});

test("frames: a script runs in the frame it is meant for: its own session, or its own execution context, or the top page", async () => {
  const { ctx, ev } = world();
  await ctx.cdp.attach(1);
  ev({ tabId: 1 }, "Target.attachedToTarget", { sessionId: "S-APP", targetInfo: { targetId: "APP", type: "iframe", url: "" } });
  ev({ tabId: 1 }, "Runtime.executionContextCreated", { context: { id: 77, auxData: { isDefault: true, frameId: "SAME" } } });
  const fr = await ctx.frames.list(1);
  const val = async (/** @type {any} */ f) => (await ctx.frames.evalIn(1, f, "1+1", { returnByValue: true })).result.value;
  assert.deepEqual([(await val(fr[0])).session, (await val(fr[2])).session, (await val(fr[1])).ctx], ["top", "S-APP", 77]);
  const last = fr[fr.length - 1];
  assert.equal(last.readable, false);
  await assert.rejects(ctx.frames.evalIn(1, last, "1"), /is not readable/);
});

test("frames.pick: by index, by frame id, or by a piece of the origin or URL", async () => {
  const { ctx, ev } = world();
  await ctx.cdp.attach(1);
  ev({ tabId: 1 }, "Target.attachedToTarget", { sessionId: "S-APP", targetInfo: { targetId: "APP", type: "iframe", url: "" } });
  ev({ tabId: 1, sessionId: "S-APP" }, "Target.attachedToTarget", { sessionId: "S-INNER", targetInfo: { targetId: "INNER", type: "iframe", url: "" } });
  const fr = await ctx.frames.list(1);
  const p = (/** @type {any} */ r) => ctx.frames.pickFrom(fr, r)?.frameId;
  assert.deepEqual([p(0), p("top"), p(2), p("3"), p("APP"), p("pay.harlow"), p(undefined)], ["TOP", "TOP", "APP", "INNER", "APP", "INNER", "TOP"]);
  assert.match(String(p("late")), /^element:/, "an iframe with no frame is still addressable, so an error can name it");
  assert.equal(p("nothing-like-it"), undefined);
});

test("frames.offset: a frame's viewport starts at the sum of its iframe elements' boxes up the chain, so a click found inside lands in the right place", async () => {
  const { ctx, ev } = world();
  await ctx.cdp.attach(1);
  ev({ tabId: 1 }, "Target.attachedToTarget", { sessionId: "S-APP", targetInfo: { targetId: "APP", type: "iframe", url: "" } });
  ev({ tabId: 1, sessionId: "S-APP" }, "Target.attachedToTarget", { sessionId: "S-INNER", targetInfo: { targetId: "INNER", type: "iframe", url: "" } });
  const fr = await ctx.frames.list(1);
  assert.deepEqual(await ctx.frames.offset(1, fr[0], fr), { dx: 0, dy: 0 });
  assert.deepEqual(await ctx.frames.offset(1, fr[2], fr), { dx: 100, dy: 60 });
  // INNER sits at (10,20) inside APP, which sits at (100,60) in the top page.
  assert.deepEqual(await ctx.frames.offset(1, fr[3], fr), { dx: 110, dy: 80 });
});

test("frames.reveal scrolls each iframe owner into view, outermost first, best effort", async () => {
  const { ctx, ev, calls } = world();
  await ctx.cdp.attach(1);
  ev({ tabId: 1 }, "Target.attachedToTarget", { sessionId: "S-APP", targetInfo: { targetId: "APP", type: "iframe", url: "" } });
  ev({ tabId: 1, sessionId: "S-APP" }, "Target.attachedToTarget", { sessionId: "S-INNER", targetInfo: { targetId: "INNER", type: "iframe", url: "" } });
  const fr = await ctx.frames.list(1);
  await ctx.frames.reveal(1, fr[3], fr);
  const scrolls = calls.filter(c => c.method === "DOM.scrollIntoViewIfNeeded");
  assert.equal(scrolls.length, 2);
  assert.deepEqual(scrolls.map(c => c.session), [undefined, "S-APP"], "the app's owner in the top page first, then the inner frame's owner inside the app");
});
