// @ts-check
// presence: the tab group, the step badge, the pill and the way out, against a fake chrome.
import test from "node:test";
import assert from "node:assert/strict";
import { createPresence, pillScript, pillGone, cardScript, IDLE_MS, GROUP_TITLE } from "./extension/lib/presence.js";

function world(o = {}) {
  /** @type {any[]} */ const log = [];
  /** @type {Set<Function>} */ const listeners = new Set();
  let nextGroup = 50;
  const tabs = new Map([[1, { id: 1, windowId: 10, groupId: -1 }], [2, { id: 2, windowId: 10, groupId: -1 }], [3, { id: 3, windowId: 10, groupId: 7 }]]);
  const chrome = {
    action: { setBadgeText: async (/** @type {any} */ a) => { log.push(["badge", a.text]); }, setBadgeBackgroundColor: async (/** @type {any} */ a) => { log.push(["color", a.color]); }, setTitle: async (/** @type {any} */ a) => { log.push(["title", a.title]); }, setIcon: async (/** @type {any} */ a) => { log.push(["icon", a.path]); }, setBadgeTextColor: async (/** @type {any} */ a) => { log.push(["textcolor", a.color]); } },
    tabs: {
      get: async (/** @type {number} */ id) => tabs.get(id),
      group: async (/** @type {any} */ a) => { const gid = a.groupId ?? nextGroup++; for (const t of a.tabIds) tabs.get(t).groupId = gid; log.push(["group", a.tabIds, gid, a.createProperties ? "new" : "join"]); return gid; },
    },
    tabGroups: { get: async (/** @type {number} */ id) => ({ id, title: id === 7 ? "Work" : GROUP_TITLE }), query: async () => [], update: async (/** @type {number} */ id, /** @type {any} */ p) => { log.push(["groupUpdate", id, p]); } },
  };
  const cdp = { attached: () => [1, 2, 3], send: async (/** @type {number} */ tab, /** @type {string} */ method, /** @type {any} */ p) => { log.push(["cdp", tab, method, p && p.expression ? (p.expression === pillGone ? "gone" : "pill") : p && p.name]); return {}; }, on: (/** @type {Function} */ f) => { listeners.add(f); return () => listeners.delete(f); } };
  /** @type {Array<{ fn: Function, at: number, id: number }>} */ const timers = [];
  let t = 0, tid = 0;
  const setT = (/** @type {Function} */ fn, /** @type {number} */ ms) => { const x = { fn, at: t + ms, id: ++tid }; timers.push(x); return x.id; };
  const clearT = (/** @type {number} */ id) => { const i = timers.findIndex(x => x.id === id); if (i >= 0) timers.splice(i, 1); };
  const stops = /** @type {string[]} */ ([]);
  const finished = /** @type {any[]} */ ([]);
  const p = createPresence({ chrome, cdp, now: () => t, setT, clearT, setI: () => 0, clearI: () => {}, onStop: v => stops.push(v), onFinish: r => finished.push(r), ...o });
  const advance = async (/** @type {number} */ ms) => { t += ms; for (const x of timers.filter(x => x.at <= t)) { timers.splice(timers.indexOf(x), 1); x.fn(); } await new Promise(r => setImmediate(r)); };
  return { p, log, tabs, listeners, advance, stops, finished };
}

test("a run pills the tab with the step in plain words; the badge stays empty while Vyre works; only things a person could do by hand are steps", async () => {
  const w = world();
  await w.p.around("page.act", { tabId: 1, selector: { name: "Save" }, kind: "click" }, async () => ({ ok: true }));
  await w.p.around("page.fill", { tabId: 1, fields: [{}, {}] }, async () => ({ ok: true }));
  await w.p.around("caps", {}, async () => ({}));
  await w.p.around("frames.list", { tabId: 1 }, async () => ([]));
  assert.equal(w.p.active(), true);
  assert.match(w.p.label(), /^Step 3 \u00b7 Filling 2 fields \u00b7 Esc to stop$/);
  assert.ok(!w.log.some(l => l[0] === "badge" && l[1] !== ""), "no step count in the badge");
  assert.equal(w.log.filter(l => l[0] === "cdp" && l[2] === "Runtime.addBinding").length, 2, "stop and login bindings, once");
  assert.ok(w.log.some(l => l[0] === "cdp" && l[1] === 1 && l[3] === "pill"));
});

test("the plan length comes from the server: 'Step 12 of 20'", async () => {
  const w = world();
  await w.p.state({ of: 20 });
  for (let i = 0; i < 11; i++) await w.p.around("page.act", { tabId: 1 }, async () => ({ ok: true }));
  assert.match(w.p.label(), /^Step 12 of 20/);
});

test("background API work still shows the run and counts", async () => {
  const w = world();
  await w.p.around("api.call", { tabId: 1 }, async () => ({ ok: true }));
  assert.equal(w.p.active(), true);
  assert.match(w.p.label(), /^Step 2 \u00b7 Calling the app's own API/);
});

test("a batch counts its completed steps", async () => {
  const w = world();
  await w.p.around("batch.run", { tabId: 1, steps: [1, 2, 3, 4, 5] }, async () => ({ ok: true, done: 5 }));
  assert.match(w.p.label(), /^Step 6 /);
});

test("the toolbar icon animates through 12 frames while working and holds still otherwise", async () => {
  const icons = /** @type {any[]} */ ([]);
  /** @type {Function[]} */ const ticks = [];
  const w = world({ setI: (/** @type {Function} */ f) => { ticks.push(f); return ticks.length; }, clearI: () => { ticks.length = 0; } });
  void icons;
  await w.p.around("page.act", { tabId: 1 }, async () => ({ ok: true }));
  assert.equal(ticks.length >= 1, true, "an animation timer is running");
  for (let i = 0; i < 13; i++) for (const f of ticks.slice()) f();
  await new Promise(r => setImmediate(r));
  const paths = w.log.filter(l => l[0] === "icon").map(l => l[1]);
  assert.ok(paths.some(p => p && p[16] === "frames/working-01.png"));
  assert.ok(paths.some(p => p && p[16] === "frames/working-11.png"));
  await w.p.state({ waiting: "sign in", login: { site: "Acme" } });
  assert.deepEqual(w.log.filter(l => l[0] === "icon").pop()[1], { 16: "icons/icon-16.png", 32: "icons/icon-32.png" }, "waiting for the person: the icon holds still");
});

test("a tab Vyre opens joins one grey group titled Vyre; the next joins it; a tab in the person's own group is left", async () => {
  const w = world();
  await w.p.around("tabs.open", {}, async () => ({ id: 1, reused: false }));
  await w.p.around("tabs.open", {}, async () => ({ id: 2, reused: false }));
  await w.p.around("tabs.use", { tabId: 3 }, async () => ({ id: 3, reused: false }));
  const g = w.log.filter(l => l[0] === "group");
  assert.equal(g.length, 2, "tab 3 is in the person's group and stays there");
  assert.equal(g[0][3], "new");
  assert.equal(g[1][3], "join");
  assert.equal(g[0][2], g[1][2]);
  assert.ok(w.log.some(l => l[0] === "groupUpdate" && l[2].title === "Vyre" && l[2].color === "grey"));
  assert.equal(w.tabs.get(3).groupId, 7);
});

test("the group says whose turn it is: Vyre, Vyre your turn, Vyre done; the badge is 1 in Bone on ink for the person's turn only", async () => {
  const w = world();
  await w.p.around("tabs.open", {}, async () => ({ id: 1, reused: false }));
  await w.p.state({ waiting: "sign in to Acme", login: { site: "Acme" } });
  assert.ok(w.log.some(l => l[0] === "groupUpdate" && l[2].title === "Vyre, your turn"));
  assert.deepEqual(w.log.filter(l => l[0] === "badge").pop(), ["badge", "1"]);
  assert.ok(w.log.some(l => l[0] === "color" && l[1] === "#EDE8DC"));
  assert.ok(w.log.some(l => l[0] === "textcolor" && l[1] === "#171513"));
  await w.p.state({ waiting: null });
  assert.deepEqual(w.log.filter(l => l[0] === "badge").pop(), ["badge", ""]);
  assert.ok(w.log.filter(l => l[0] === "groupUpdate").pop()[2].title === "Vyre", "back to plain Vyre");
  await w.p.state({ done: true });
  assert.ok(w.log.filter(l => l[0] === "groupUpdate").pop()[2].title === "Vyre, done");
});

test("a tab that was already open is not moved into the group (only tabs Vyre opened)", async () => {
  const w = world();
  await w.p.around("tabs.use", { tabId: 1 }, async () => ({ id: 1, reused: true }));
  assert.equal(w.log.filter(l => l[0] === "group").length, 0);
});

test("the pill's Stop or Esc stops the run", async () => {
  const w = world();
  await w.p.around("page.act", { tabId: 1 }, async () => ({ ok: true }));
  for (const f of w.listeners) f(1, "Runtime.bindingCalled", { name: "vyreStop", payload: "esc" });
  assert.deepEqual(w.stops, ["esc"]);
  for (const f of w.listeners) f(1, "Runtime.bindingCalled", { name: "someoneElses", payload: "x" });
  assert.equal(w.stops.length, 1);
});

test("quiet for a while: the badge clears, the pill goes, the group is titled Vyre, done (never closed), and the record goes to the finish card", async () => {
  const w = world();
  await w.p.around("tabs.open", {}, async () => ({ id: 1, reused: false }));
  await w.p.around("page.act", { tabId: 1 }, async () => ({ ok: true }));
  w.p.change({ what: "created draft workflow", url: "https://x/y" });
  await w.advance(IDLE_MS + 10);
  assert.equal(w.p.active(), false);
  assert.deepEqual(w.log.filter(l => l[0] === "badge").pop(), ["badge", ""]);
  assert.ok(w.log.some(l => l[0] === "cdp" && l[3] === "gone"));
  assert.ok(w.log.some(l => l[0] === "groupUpdate" && l[2].title === "Vyre, done"));
  assert.ok(!w.log.some(l => l[0] === "groupUpdate" && l[2].collapsed === true), "nothing is collapsed or closed for the person");
  assert.equal(w.finished.length, 1);
  assert.equal(w.finished[0].steps, 2);
  assert.equal(w.finished[0].changes[0].what, "created draft workflow");
});

test("waiting for the person: badge 1, the pill says Your turn, and it does not time out", async () => {
  const w = world();
  await w.p.around("page.act", { tabId: 1 }, async () => ({ ok: true }));
  await w.p.state({ waiting: "sign in to GoHighLevel" });
  assert.match(w.p.label(), /^Your turn: sign in/);
  assert.deepEqual(w.log.filter(l => l[0] === "badge").pop(), ["badge", "1"]);
  await w.advance(IDLE_MS * 5);
  assert.equal(w.p.active(), true, "still waiting");
  await w.p.state({ waiting: null });
  await w.advance(IDLE_MS + 10);
  assert.equal(w.p.active(), false);
});

test("the connection diagnosis owns the badge while it is failing", async () => {
  const w = world();
  w.p.badgeOwnedBy(() => true);
  await w.p.around("page.act", { tabId: 1 }, async () => ({ ok: true }));
  assert.equal(w.log.filter(l => l[0] === "badge").length, 0);
});

test("a failing op never breaks because a browser call did, and an error is rethrown", async () => {
  const w = world({ chrome: { action: {}, tabs: {}, tabGroups: {} } });
  assert.deepEqual(await w.p.around("page.act", { tabId: 1 }, async () => ({ ok: true })), { ok: true });
  await assert.rejects(w.p.around("page.act", { tabId: 1 }, async () => { throw new Error("boom"); }), /boom/);
});

test("the pill script is a closed shadow root on an element the snapshot skips, takes no pointer events, and carries the words", () => {
  const s = pillScript({ mode: "working", step: 2, of: 20, text: "Clicking \"Save\"" });
  assert.match(s, /attachShadow\(\{ mode: "closed" \}\)/);
  assert.match(s, /pointer-events:none/);
  assert.match(s, /createElement\("vyre-pill"\)/);
  assert.match(s, /vyreStop/);
  assert.match(s, /Esc to stop/);
  assert.match(s, /prefers-reduced-motion/);
  assert.match(s, /rgba\(23,21,19,\.88\)/, "dark glass, Bone on ink");
  assert.match(s, /elementFromPoint/, "it checks what is under it and moves out of the way of the page's controls");
  assert.match(s, /can't see what you type/);
  assert.ok(!/vyreApprove|vyreResume|approve|resume/i.test(s.replace(/\bapprove\b[^;]*?from[^;]*/i, "")), "no binding in the page can approve or resume anything");
});

test("an approval waiting raises a notification at once and again after two minutes, and never answers for the person", async () => {
  const notes = /** @type {any[]} */ ([]);
  const w = world();
  const chromeN = /** @type {any} */ ({ notifications: { create: async (/** @type {string} */ id, /** @type {any} */ o) => { notes.push(o); } }, runtime: { getURL: (/** @type {string} */ p) => "chrome-extension://x/" + p } });
  const w2 = world({ chrome: { ...chromeN, action: {}, tabs: {}, tabGroups: {} } });
  await w2.p.state({ waiting: "approve: Plan: 8 drafts", notify: { title: "Vyre needs you to approve a plan", message: "Plan: 8 drafts (https://app.example)" } });
  assert.equal(notes.length, 1);
  assert.equal(notes[0].requireInteraction, true);
  assert.match(notes[0].iconUrl, /icons\/icon-128\.png$/);
  await w2.advance(120_000 + 10);
  assert.equal(notes.length, 2, "reminded");
  assert.match(notes[1].title, /Still waiting/);
  assert.equal(w2.p.active(), true, "still open, not timed out");
  void w;
  await w2.p.state({ waiting: null });
  await w2.advance(120_000 + 10);
  assert.equal(notes.length, 2, "no reminder once answered");
});

test("the run's changes come back as a card in the last tab: counts, an Open link per item, and how to undo; the snapshot skips it", async () => {
  const w = world();
  const evals = /** @type {string[]} */ ([]);
  const cdp2 = { attached: () => [1], send: async (/** @type {number} */ _t, /** @type {string} */ m, /** @type {any} */ p) => { if (m === "Runtime.evaluate") evals.push(String(p.expression)); return {}; }, on: () => () => {} };
  const w2 = world({ cdp: cdp2 });
  await w2.p.around("page.act", { tabId: 1 }, async () => ({ ok: true }));
  await w2.p.state({ change: { kind: "create", what: "create /workflow (wf_1)", url: "https://app.example/v2/location/L/automation/workflows" } });
  await w2.p.state({ change: { kind: "create", what: "create /workflow (wf_2)" } });
  await w2.p.state({ done: true });
  const card = evals.find(e => e.includes("vyre-card"));
  assert.ok(card, "a card was put in the tab");
  assert.match(card, /"create":2/);
  assert.match(card, /automation\/workflows/);
  assert.match(card, /attachShadow\(\{ mode: "closed" \}\)/);
  assert.match(card, /undo what you created/);
  assert.match(card, /Dismiss/);
  void w;
});

test("the card takes only http links, so a page cannot be told to run code through it", () => {
  const s = cardScript({ counts: { create: 1 }, items: [{ what: "x", url: "javascript:alert(1)" }], steps: 1 });
  assert.match(s, /"url":""/);
});
