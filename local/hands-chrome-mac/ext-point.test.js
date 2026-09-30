// @ts-check
// chrome_point: a point of a screenshot, mapped from the kept shot, classified by the text under it, and gated like chrome_act (and by a plan for what has no text).
import test from "node:test";
import assert from "node:assert/strict";
import point, { _resetRate } from "./extension/caps/point.js";
import { putShot, getShot, _clear, imageSize } from "./extension/lib/shots.js";
import { classifyText } from "./extension/caps/page.js";
import { T } from "./test-support/trust.js";

const op = T(point.ops["point.act"]);
const METRICS = { w: 800, h: 600, sx: 0, sy: 0, dpr: 1, vv: 1, vw: 800, url: "https://app.example/board", modals: 0 };

/**
 * A fake tab: what is under a point is whatever `under(x, y)` says, in the top frame (frames may add more).
 * @param {{ under?: (x: number, y: number, frame?: any) => any, focus?: any, now?: any, frames?: any[], floor?: any }} [o]
 */
function world(o = {}) {
  /** @type {any[]} */ const sent = [];
  const frames = o.frames || [{ index: 0, how: "top", frameId: "TOP", origin: "https://app.example", url: "https://app.example/board", readable: true }];
  const now = () => o.now || METRICS;
  const ctx = {
    cdp: {
      async send(/** @type {number} */ _t, /** @type {string} */ method, /** @type {any} */ params, /** @type {string|undefined} */ session) {
        sent.push({ method, params, session });
        if (method !== "Runtime.evaluate") return {};
        const e = String(params.expression);
        if (e.startsWith("/*vyre:metrics*/")) return { result: { value: now() } };
        if (e.startsWith("/*vyre:focus")) return { result: { value: o.focus || { none: true } } };
        const m = /^\/\*vyre:hit (\{.*?\})\*\//.exec(e);
        if (m) { const a = JSON.parse(m[1]); return { result: { value: (o.under || (() => ({ none: true })))(a.x, a.y) } }; }
        return { result: { value: undefined } };
      },
    },
    frames: { list: async () => frames, evalIn: async (/** @type {number} */ t, /** @type {any} */ f, /** @type {string} */ expr, /** @type {any} */ p) => ctx.cdp.send(t, "Runtime.evaluate", { expression: expr, ...p }, f.session) },
    floorUrl: async (/** @type {string} */ u) => (o.floor ? o.floor(u) : { allow: true, tier: "open" }),
    floorAllows: async () => ({ allow: true }),
    tabs: { active: async () => ({ id: 1 }) },
  };
  return { ctx, sent, mouse: () => sent.filter(s => s.method === "Input.dispatchMouseEvent").map(s => `${s.params.type}@${s.params.x},${s.params.y}`) };
}
const shotOf = (/** @type {number} */ scale = 1, m = METRICS) => { _clear(); _resetRate(); return putShot(1, scale, m); };
const el = (/** @type {any} */ o) => ({ tag: "div", kind: "element", text: "", textless: true, password: false, fillable: false, submit: false, modals: 0, path: "div@0,0,10,10", ...o });
const plan = (/** @type {any} */ p = {}) => ({ pointBudget: { click: 3, type: 2, drag: 1, tab: 1, origins: ["https://app.example"], ...p } });

test("classifyText: the same patterns chrome_act uses, for any text under a point", () => {
  for (const t of ["Send", "Send now | Send", "Delete account", "Publish", "Pay $20", "Sign out"]) assert.equal(classifyText(t).consequential, true, t);
  for (const t of ["Next", "Open the board", "Cancel", ""]) assert.equal(classifyText(t).consequential, false, t);
});

test("shots: an unguessable id, bound to its tab, expiring; a release may use it longer", () => {
  _clear();
  const id = putShot(1, 1, METRICS);
  assert.match(id, /^[0-9a-f]{24}$/);
  assert.ok(getShot(id, 1));
  assert.equal(getShot(id, 2), null, "another tab cannot use it");
  assert.equal(getShot(id, 1, { now: Date.now() + 61_000 }), null, "60 seconds");
  assert.ok(getShot(id, 1, { released: true, now: Date.now() + 120_000 }), "a release the person gave later");
  assert.equal(getShot("deadbeef", 1), null);
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
  assert.deepEqual(imageSize(png), { w: 1, h: 1 });
});

test("a click on a labelled, harmless control goes through, in the picture's scale", async () => {
  const w = world({ under: () => el({ tag: "button", text: "Open the board", textless: false }) });
  const id = shotOf(2);
  const r = await op({ tabId: 1, shot: id, x: 400, y: 200, action: "click" }, w.ctx);
  assert.equal(r.ok, true);
  assert.deepEqual(w.mouse().filter(s => /Pressed|Released/.test(s)), ["mousePressed@200,100", "mouseReleased@200,100"], "image pixels divided by the scale");
});

test("a Send or Delete drawn as a bare div holds, whatever the plan says; the person's release (its signature) lets that one act through", async () => {
  const w = world({ under: () => el({ text: "Send | Send", textless: false, path: "div@5,5,80,20" }) });
  const id = shotOf();
  const h = await op({ tabId: 1, shot: id, x: 50, y: 10, action: "click", ...plan() }, w.ctx);
  assert.equal(h.held, true);
  assert.match(h.why, /cannot be undone/);
  assert.ok(!w.mouse().length, "nothing was clicked");
  const ok = await op({ tabId: 1, shot: id, x: 50, y: 10, action: "click", release: { sig: h.sig }, asked: true }, w.ctx);
  assert.equal(ok.ok, true);
  await assert.rejects(op({ tabId: 1, shot: id, x: 50, y: 10, action: "click", release: { sig: "nope" }, asked: true }, w.ctx), /changed/);
  const d = world({ under: () => el({ text: "Delete account", textless: false }) });
  assert.equal((await op({ tabId: 1, shot: shotOf(), x: 5, y: 5, action: "click", ...plan() }, d.ctx)).held, true);
  const s = world({ under: () => el({ tag: "button", text: "Continue", textless: false, submit: true }) });
  assert.equal((await op({ tabId: 1, shot: shotOf(), x: 5, y: 5, action: "click", ...plan() }, s.ctx)).held, true, "a submit button sends its form");
});

test("a drawn surface (no text at all) waits for the person unless the plan covers this tab, origin and kind; hover and scroll need no plan", async () => {
  const w = world({ under: () => el({ tag: "canvas", kind: "canvas", path: "canvas@0,0,800,600" }) });
  const held = await op({ tabId: 1, shot: shotOf(), x: 100, y: 100, action: "click" }, w.ctx);
  assert.equal(held.held, true);
  assert.equal(held.control.role, "drawn surface");
  assert.ok(!w.mouse().length);
  const go = await op({ tabId: 1, shot: shotOf(), x: 100, y: 100, action: "click", ...plan() }, w.ctx);
  assert.equal(go.ok, true);
  assert.deepEqual(go.spent, { click: 1 });
  const dbl = await op({ tabId: 1, shot: shotOf(), x: 100, y: 100, action: "double", ...plan() }, w.ctx);
  assert.deepEqual(dbl.spent, { click: 2 }, "a double is two units");
  assert.equal((await op({ tabId: 1, shot: shotOf(), x: 100, y: 100, action: "click", ...plan({ click: 0 }) }, w.ctx)).held, true, "an empty budget holds");
  assert.equal((await op({ tabId: 1, shot: shotOf(), x: 100, y: 100, action: "click", ...plan({ origins: ["https://other.example"] }) }, w.ctx)).held, true, "a plan for another origin holds");
  assert.equal((await op({ tabId: 1, shot: shotOf(), x: 100, y: 100, action: "click", ...plan({ tab: 9 }) }, w.ctx)).held, true, "a plan for another tab holds");
  const h2 = world({ under: () => el({ tag: "canvas", kind: "canvas" }) });
  assert.equal((await op({ tabId: 1, shot: shotOf(), x: 10, y: 10, action: "hover" }, h2.ctx)).ok, true);
  assert.equal((await op({ tabId: 1, shot: shotOf(), x: 10, y: 10, action: "scroll", dy: 300 }, h2.ctx)).ok, true);
  assert.ok(h2.sent.some(s => s.params && s.params.type === "mouseWheel" && s.params.deltaY === 300));
});

test("type: no line breaks, tabs or control characters; credential fields refused; an unreadable focus waits for the plan", async () => {
  const w = world({ under: () => el({ tag: "input", text: "Notes", textless: false, fillable: true }), focus: { tag: "input", fillable: true, password: false } });
  for (const t of ["a\nb", "a\tb", "a\rb", "a\u0007b", "a b"]) await assert.rejects(op({ tabId: 1, shot: shotOf(), x: 5, y: 5, action: "type", text: t }, w.ctx), /control character|line break/, JSON.stringify(t));
  const ok = await op({ tabId: 1, shot: shotOf(), x: 5, y: 5, action: "type", text: "hello" }, w.ctx);
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.ok(w.sent.some(s => s.method === "Input.insertText" && s.params.text === "hello"));
  const pw = world({ under: () => el({ tag: "input", text: "Password", textless: false, fillable: true, password: true }) });
  await assert.rejects(op({ tabId: 1, shot: shotOf(), x: 5, y: 5, action: "type", text: "x" }, pw.ctx), /password/);
  const fp = world({ under: () => el({ tag: "div", text: "Name", textless: false }), focus: { tag: "input", fillable: true, password: true } });
  await assert.rejects(op({ tabId: 1, shot: shotOf(), x: 5, y: 5, action: "type", text: "x" }, fp.ctx), /password/, "focus moved into one");
  const nf = world({ under: () => el({ tag: "div", text: "Canvas board", textless: false }), focus: { none: true } });
  const r = await op({ tabId: 1, shot: shotOf(), x: 5, y: 5, action: "type", text: "x" }, nf.ctx);
  assert.equal(r.held, true, "nothing readable has focus, no plan");
});

test("stale: an unknown or expired shot, a moved page, a different zoom or a new dialog all refuse", async () => {
  const w = world({ under: () => el({ tag: "button", text: "Next", textless: false }) });
  await assert.rejects(op({ tabId: 1, shot: "nope", x: 1, y: 1, action: "click" }, w.ctx), { code: "stale" });
  for (const change of [{ sy: 40 }, { dpr: 2 }, { vv: 1.5 }, { w: 700 }, { url: "https://app.example/other" }, { modals: 1 }]) {
    const moved = world({ under: () => el({ tag: "button", text: "Next", textless: false }), now: { ...METRICS, ...change } });
    await assert.rejects(op({ tabId: 1, shot: shotOf(), x: 1, y: 1, action: "click" }, moved.ctx), { code: "stale" }, JSON.stringify(change));
  }
});

test("a dialog that appears between the picture and the click (seen right before dispatch) stops the click", async () => {
  let calls = 0;
  const w = world({ under: () => { calls++; return el({ tag: "button", text: "Next", textless: false, modals: calls > 1 ? 1 : 0 }); } });
  await assert.rejects(op({ tabId: 1, shot: shotOf(), x: 1, y: 1, action: "click" }, w.ctx), { code: "changed" });
  assert.ok(!w.mouse().length);
});

test("drag: the drop target is classified too (a drop on a Delete zone holds); a drop on a drawn surface follows the plan", async () => {
  const w = world({ under: (x) => (x < 300 ? el({ tag: "div", text: "Card", textless: false }) : el({ tag: "div", text: "Delete", textless: false })) });
  const h = await op({ tabId: 1, shot: shotOf(), x: 100, y: 100, action: "drag", to: { x: 500, y: 100 }, ...plan() }, w.ctx);
  assert.equal(h.held, true);
  const ok = world({ under: () => el({ tag: "div", text: "Card", textless: false }) });
  const r = await op({ tabId: 1, shot: shotOf(), x: 100, y: 100, action: "drag", to: { x: 200, y: 100 } }, ok.ctx);
  assert.equal(r.ok, true);
  assert.equal(ok.mouse().filter(m => m.startsWith("mouseReleased")).length, 1);
});

test("a point in a cross-origin iframe is dispatched on the frame's own session at frame coordinates, judged against that frame's origin, and held unless a plan names it", async () => {
  const frames = [
    { index: 0, how: "top", frameId: "TOP", origin: "https://app.example", url: "https://app.example/board", readable: true },
    { index: 1, how: "session", frameId: "KID", parentId: "TOP", origin: "https://widgets.example", url: "https://widgets.example/w", readable: true, session: "S-KID" },
  ];
  const w = world({ frames, under: (x, y) => (x === 120 && y === 130 ? { ...el({ tag: "iframe", kind: "iframe", src: "https://widgets.example/w" }), rect: { l: 100, t: 100, w: 300, h: 200 } } : el({ tag: "canvas", kind: "canvas", path: "canvas@0,0,300,200" })) });
  const held = await op({ tabId: 1, shot: shotOf(), x: 120, y: 130, action: "click", ...plan() }, w.ctx);
  assert.equal(held.held, true, "a tab-only plan does not cover the frame's origin");
  assert.equal(held.origin, "https://widgets.example");
  const go = await op({ tabId: 1, shot: shotOf(), x: 120, y: 130, action: "click", ...plan({ origins: ["https://app.example", "https://widgets.example"] }) }, w.ctx);
  assert.equal(go.ok, true);
  const press = w.sent.find(s => s.params && s.params.type === "mousePressed");
  assert.equal(press && press.session, "S-KID");
  assert.deepEqual([press.params.x, press.params.y], [20, 30], "frame coordinates");
  const blind = world({ frames, floor: (/** @type {string} */ u) => (/widgets/.test(u) ? { allow: false, tier: "blind", why: "a sign-in page" } : { allow: true }), under: () => ({ ...el({ tag: "iframe", kind: "iframe", src: "https://widgets.example/w" }), rect: { l: 0, t: 0, w: 800, h: 600 } }) });
  await assert.rejects(op({ tabId: 1, shot: shotOf(), x: 120, y: 130, action: "click", ...plan() }, blind.ctx), { code: "blocked" });
});

test("a runaway loop of point acts is rate limited", async () => {
  const w = world({ under: () => el({ tag: "button", text: "Next", textless: false }) });
  let limited = false;
  _resetRate(); _clear(); const id = putShot(1, 1, METRICS);
  for (let i = 0; i < 12 && !limited; i++) { try { await op({ tabId: 1, shot: id, x: 1, y: 1, action: "click" }, w.ctx); } catch (e) { limited = /** @type {any} */ (e).code === "rate_limited"; } }
  assert.equal(limited, true);
});
