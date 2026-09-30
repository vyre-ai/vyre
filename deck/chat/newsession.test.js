// @ts-check
// The New session sheet and the folder browser rendered into the fake DOM (deck/test/fake-dom.js)
// with a fake vyred behind fetch: what each shows, what each calls with what input, the keyboard,
// and where a success goes. Only the sample world appears here.

import { test } from "node:test";
import assert from "node:assert/strict";
import { install, text, $, $$ } from "../test/fake-dom.js";

const doc = /** @type {any} */ (install());
/** Document-level key listeners, which the fake's document ignores: kept here to fire by hand. */
const keys = new Set();
doc.addEventListener = (type, fn) => { if (type === "keydown") keys.add(fn); };
doc.removeEventListener = (type, fn) => { if (type === "keydown") keys.delete(fn); };
doc.importNode = n => n;
Object.assign(globalThis, {
  DOMParser: class { parseFromString() { return { documentElement: new /** @type {any} */ (globalThis).Element("svg") }; } },
  CustomEvent: class extends /** @type {any} */ (globalThis).Event { constructor(t, o) { super(t); this.detail = o?.detail; } },
  dispatchEvent: () => true,
});
/** Where go() sent the page. */
const went = [];
/** Where the folder browser moved the address to without navigating. */
const replaced = [];
Object.defineProperty(globalThis, "history", { value: { state: null, pushState: (_s, _t, url) => went.push(url), replaceState: (_s, _t, url) => replaced.push(url) },
  configurable: true, writable: true });

/** A fake vyred: answers by tool name, records every call. */
function vyred(answers) {
  const calls = [];
  globalThis.fetch = /** @type {any} */ (async (url, o) => {
    const tool = decodeURIComponent(String(url).split("/v1/tools/")[1]);
    const input = JSON.parse(o.body);
    calls.push({ tool, input });
    const a = typeof answers[tool] === "function" ? answers[tool](input) : answers[tool];
    const body = a === undefined ? { error: { code: "no_such_tool", message: `no tool ${tool}` } } : a && a.$error ? { error: a.$error } : { data: a };
    return { status: body.error ? 404 : 200, statusText: "", json: async () => body };
  });
  return { calls, of: t => calls.filter(c => c.tool === t) };
}
const tick = () => new Promise(r => setTimeout(r, 0));
const press = (key, target = null, mods = {}) => {
  const e = /** @type {any} */ (new Event("keydown"));
  Object.assign(e, { key, target, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods });
  for (const fn of [...keys]) fn(e);
  return e;
};

const { startCall, openHref, mountNewSession } = await import("./newsession.js");
const { crumbs, moveSel, foldersHref, mountFolders } = await import("./folders.js");

const WORLD = {
  "projects.list": { projects: [{ slug: "harlow-legal", name: "Harlow Legal", home: "/work/harlow-legal" }, { slug: "northwind-bakery", name: "Northwind Bakery", home: "/work/northwind" }] },
  "files.recent": [{ path: "/work/northwind/site", last: Date.now() - 60_000, sessions: 3 }],
  "agents.list": [{ name: "juno", kind: "assistant" }, { name: "kit", kind: "agent" }],
  "files.dirs": i => i.q ? { path: null, parent: null, roots: [{ path: "/work", name: "work" }], dirs: [{ name: "site", path: "/work/northwind/site", git: false, mtime: "x" }] }
    : i.path === "/work/harlow-legal" ? { path: "/work/harlow-legal", parent: null, roots: [{ path: "/work", name: "work" }], dirs: [{ name: "briefs", path: "/work/harlow-legal/briefs", git: false, mtime: "x" }] }
    : { path: null, parent: null, roots: [{ path: "/work", name: "work" }], dirs: [
      { name: "harlow-legal", path: "/work/harlow-legal", git: true, project: "harlow-legal", mtime: "x" },
      { name: "northwind", path: "/work/northwind", git: false, project: "northwind-bakery", mtime: "x" }] },
  "threads.start": i => ({ id: "t-new", cwd: i.cwd || "/work/harlow-legal", project: i.project || null, status: "starting" }),
  "agents.ask": i => ({ agent: i.agent, thread: "t-kit", ok: true, sent: true, text: "" }),
};

test("startCall: a plain session in a project, a folder or no folder; an agent needs words", () => {
  assert.deepEqual(startCall({ kind: "project", slug: "harlow-legal" }, null, " hi ", "/work"),
    { tool: "threads.start", input: { surface: "deck", prompt: "hi", project: "harlow-legal" } });
  assert.deepEqual(startCall({ kind: "folder", path: "/work/northwind" }, null, "", "/work"),
    { tool: "threads.start", input: { surface: "deck", cwd: "/work/northwind" } });
  assert.deepEqual(startCall({ kind: "none" }, null, "hello", "/work"), { tool: "threads.start", input: { surface: "deck", prompt: "hello", cwd: "/work" } });
  assert.match(/** @type {any} */ (startCall({ kind: "none" }, null, "hello", null)).error, /no folder/);
  assert.deepEqual(startCall({ kind: "folder", path: "/work/x" }, "kit", "draft the hero copy", "/work"),
    { tool: "agents.ask", input: { agent: "kit", text: "draft the hero copy", surface: "deck", wait: false } });
  assert.match(/** @type {any} */ (startCall({ kind: "none" }, "kit", "  ", "/work")).error, /first message for kit/);
  assert.equal(openHref({ id: "t1", project: "harlow-legal" }, null), "/chat/harlow-legal/t1");
  assert.equal(openHref({ id: "t1", project: null }, null), "/chat/thread/t1");
  assert.equal(openHref({ agent: "kit", thread: "t2" }, null), "/chat/thread/t2");
  assert.equal(openHref({}, null), null);
});

test("new session: shows who and where, says where no folder starts, and starts in a project", async () => {
  const api = vyred(WORLD);
  went.length = 0;
  const box = /** @type {any} */ (document.createElement("div"));
  let done = 0;
  const stop = mountNewSession(box, { project: "harlow-legal", onDone: () => done++ });
  await tick(); await tick();
  const t = text(box);
  for (const s of ["Who", "Vyre", "juno", "kit", "Where", "Harlow Legal", "Northwind Bakery", "site", "Browse...", "No folder (starts in /work)", "First message"]) assert.ok(t.includes(s), s);
  assert.equal($(box, "button[aria-checked=true]") && text($$(box, "button[aria-checked=true]")[1]).includes("Harlow Legal"), true);
  $(box, "textarea").value = "Tidy the intake form";
  press("Enter", $(box, "textarea"), { metaKey: true });
  // Cmd+Enter on the textarea itself starts; the document listener only closes on Esc.
  $(box, "textarea").dispatchEvent(Object.assign(new Event("keydown"), { key: "Enter", metaKey: true }));
  await tick(); await tick();
  assert.deepEqual(api.of("threads.start").map(c => c.input), [{ surface: "deck", prompt: "Tidy the intake form", project: "harlow-legal" }]);
  assert.deepEqual(went, ["/chat/harlow-legal/t-new"]);
  press("Escape");
  assert.equal(done, 1);
  stop();
  press("Escape");
  assert.equal(done, 1, "the Esc listener is gone after cleanup");
});

test("new session: with no project given, it starts in context.now's project; an unknown slug or none leaves it on no folder", async () => {
  for (const [now, want] of [[{ project: "northwind-bakery" }, "Northwind Bakery"], [{ project: "gone-project" }, null], [{ project: null }, null]]) {
    const api = vyred({ ...WORLD, "context.now": now });
    const box = /** @type {any} */ (document.createElement("div"));
    const stop = mountNewSession(box, { onDone() {} });
    await tick(); await tick();
    assert.deepEqual(api.of("context.now").map(c => c.input), [{}], "the merged answer, no surface");
    const on = $$(box, "button[aria-checked=true]").map(text).join(" | ");
    if (want) assert.ok(on.includes(want), `${want} chosen: ${on}`);
    else assert.ok(!on.includes("Northwind Bakery") && !on.includes("Harlow Legal"), `no project chosen: ${on}`);
    stop();
  }
});

test("new session: an agent switches the folder off, asks without waiting, and opens its thread", async () => {
  const api = vyred(WORLD);
  went.length = 0;
  const box = /** @type {any} */ (document.createElement("div"));
  const stop = mountNewSession(box, { cwd: "/work/northwind", onDone: () => {} });
  await tick(); await tick();
  const kit = $$(box, "button[role=radio]").find(b => text(b).startsWith("kit"));
  kit.click();
  assert.match(text(box), /kit works in its own thread and its own projects, so the folder does not apply/);
  assert.ok($$(box, ".ns-where button[role=radio]").every(b => b.disabled));
  // No words: the sheet says so and calls nothing.
  $$(box, "button").find(b => text(b) === "Ask kit").click();
  await tick();
  assert.match(text(box), /Write the first message for kit/);
  assert.equal(api.of("agents.ask").length, 0);
  $(box, "textarea").value = "Draft the Northwind Bakery menu";
  $$(box, "button").find(b => text(b) === "Ask kit").click();
  await tick(); await tick();
  assert.deepEqual(api.of("agents.ask").map(c => c.input), [{ agent: "kit", text: "Draft the Northwind Bakery menu", surface: "deck", wait: false }]);
  assert.deepEqual(went, ["/chat/thread/t-kit"]);
  stop();
});

test("new session: a refusal is shown as the box said it, and nothing navigates", async () => {
  vyred({ ...WORLD, "threads.start": { $error: { code: "failed", message: "claude is not installed on this box" } } });
  went.length = 0;
  const box = /** @type {any} */ (document.createElement("div"));
  const stop = mountNewSession(box, { onDone: () => {} });
  await tick(); await tick();
  $$(box, "button").find(b => text(b) === "Start session").click();
  await tick(); await tick();
  assert.match(text($(box, ".ns-error")), /Could not start: claude is not installed on this box/);
  assert.deepEqual(went, []);
  stop();
});

test("folders: crumbs, selection and addresses", () => {
  const roots = [{ path: "/work", name: "work" }];
  assert.deepEqual(crumbs(null, roots), [{ name: "Folders", path: null }]);
  assert.deepEqual(crumbs("/work/northwind/site", roots).map(c => c.path), [null, "/work", "/work/northwind", "/work/northwind/site"]);
  assert.deepEqual(crumbs("/work", roots).map(c => c.name), ["Folders", "work"]);
  assert.equal(moveSel(-1, 3, 1), 0);
  assert.equal(moveSel(-1, 3, -1), 2);
  assert.equal(moveSel(2, 3, 1), 2);
  assert.equal(moveSel(0, 3, -1), 0);
  assert.equal(moveSel(0, 0, 1), -1);
  assert.equal(foldersHref("/work/harlow legal", true), "/chat?folders&at=%2Fwork%2Fharlow%20legal&pick");
});

test("folders: recent first, then the roots' folders with badges; keys open, start and open a terminal", async () => {
  const api = vyred(WORLD);
  went.length = 0;
  const box = /** @type {any} */ (document.createElement("div"));
  const started = [], terms = [];
  const stop = mountFolders(box, { onNewSession: p => started.push(p), onTerminal: async p => { terms.push(p); return "The terminal is not part of this Deck yet."; } });
  await tick(); await tick();
  const names = $$(box, ".fb-row .fb-name").map(text);
  assert.deepEqual(names, ["site", "harlow-legal", "northwind"]);
  const t = text(box);
  assert.ok(t.includes("git") && t.includes("northwind-bakery") && t.includes("Recent"), t);
  press("ArrowDown"); press("ArrowDown");
  assert.equal($$(box, ".fb-row")[1].getAttribute("aria-selected"), "true");
  press("s");
  assert.deepEqual(started, ["/work/harlow-legal"]);
  press("t");
  await tick();
  assert.deepEqual(terms, ["/work/harlow-legal"]);
  assert.match(text(box), /The terminal is not part of this Deck yet/);
  // A letter typed into the search box is typing, not a command.
  press("s", $(box, "input"));
  assert.equal(started.length, 1);
  press("Enter");
  await tick(); await tick();
  assert.deepEqual(api.of("files.dirs").at(-1)?.input, { path: "/work/harlow-legal" });
  assert.deepEqual(replaced.at(-1), "/chat?folders&at=%2Fwork%2Fharlow-legal");
  assert.deepEqual($$(box, ".fb-row .fb-name").map(text), ["briefs"]);
  assert.deepEqual($$(box, ".fb-crumb").map(text), ["Folders", "work", "harlow-legal"]);
  stop();
});

test("folders: the search waits 250 ms after the last key and asks files.dirs for q", async () => {
  const api = vyred(WORLD);
  const box = /** @type {any} */ (document.createElement("div"));
  const stop = mountFolders(box, { onNewSession: () => {}, onTerminal: () => {} });
  await tick(); await tick();
  const input = $(box, "input");
  input.value = "si";
  input.dispatchEvent(new Event("input"));
  input.value = "site";
  input.dispatchEvent(new Event("input"));
  await tick();
  assert.equal(api.of("files.dirs").filter(c => c.input.q).length, 0);
  await new Promise(r => setTimeout(r, 300));
  await tick();
  assert.deepEqual(api.of("files.dirs").filter(c => c.input.q).map(c => c.input), [{ q: "site" }]);
  assert.deepEqual($$(box, ".fb-row .fb-name").map(text), ["site"]);
  stop();
});

test("folders: pick mode chooses a folder instead of starting one, and offers no terminal", async () => {
  vyred(WORLD);
  const box = /** @type {any} */ (document.createElement("div"));
  const picked = [];
  const stop = mountFolders(box, { pick: p => picked.push(p), onNewSession: () => assert.fail("not in pick mode"), onTerminal: () => assert.fail("no terminal in pick mode") });
  await tick(); await tick();
  assert.match(text(box), /Choose a folder/);
  assert.ok(!text(box).includes("Open in terminal"));
  press("ArrowDown"); press("t"); press("s");
  assert.deepEqual(picked, ["/work/northwind/site"]);
  stop();
});

test("folders: a refusal from the box reads plainly", async () => {
  vyred({ ...WORLD, "files.dirs": { $error: { code: "not_available", message: "not available" } } });
  const box = /** @type {any} */ (document.createElement("div"));
  const stop = mountFolders(box, { at: "/etc", onNewSession: () => {}, onTerminal: () => {} });
  await tick(); await tick();
  assert.match(text(box), /The folders could not be read\.\s*not available/);
  stop();
});

test("a hidden kept page ignores keys: the sheet's Esc and the browser's letters act only while shown", async () => {
  vyred(WORLD);
  let on = false, done = 0;
  const sheet = /** @type {any} */ (document.createElement("div"));
  const stopSheet = mountNewSession(sheet, { onDone: () => done++, shown: () => on });
  const box = /** @type {any} */ (document.createElement("div"));
  const started = [];
  const stopBox = mountFolders(box, { shown: () => on, onNewSession: p => started.push(p), onTerminal: () => {} });
  await tick(); await tick();
  press("Escape"); press("ArrowDown"); press("s");
  assert.equal(done, 0);
  assert.deepEqual(started, []);
  on = true;
  press("ArrowDown"); press("s");
  assert.deepEqual(started, ["/work/northwind/site"]);
  press("Escape");
  assert.equal(done, 1);
  stopSheet(); stopBox();
});

test("new session: a success clears the message, so a revisit of the kept sheet starts fresh", async () => {
  vyred(WORLD);
  went.length = 0;
  const box = /** @type {any} */ (document.createElement("div"));
  const stop = mountNewSession(box, { onDone: () => {} });
  await tick(); await tick();
  $(box, "textarea").value = "Plan the Harlow Legal launch";
  $$(box, "button").find(b => text(b) === "Start session").click();
  await tick(); await tick();
  assert.deepEqual(went, ["/chat/thread/t-new"]);
  assert.equal($(box, "textarea").value, "");
  stop();
});

test("new session: every session busy says so, with Try again, which starts it once one frees up", async () => {
  let busy = true;
  const api = vyred({ ...WORLD, "threads.start": i => (busy ? { $error: { code: "busy", message: "no free session" } } : { id: "t-free", cwd: "/work/harlow-legal", project: i.project || null, status: "starting" }) });
  went.length = 0;
  const box = /** @type {any} */ (document.createElement("div"));
  const stop = mountNewSession(box, { onDone: () => {} });
  await tick(); await tick();
  $(box, "textarea").value = "Tidy the Harlow Legal intake";
  $$(box, "button").find(b => text(b) === "Start session").click();
  await tick(); await tick();
  assert.match(text($(box, ".ns-error")), /^All sessions are busy; one will free up shortly\./);
  assert.deepEqual(went, []);
  busy = false;
  $(box, ".ns-retry").click();
  await tick(); await tick();
  assert.equal(api.of("threads.start").length, 2);
  assert.equal(went.length, 1);
  stop();
});

test("startCall: pasted spans of the first message go to threads.start, only the ones still in it", () => {
  const r = /** @type {any} */ (startCall({ kind: "project", slug: "harlow-legal" }, null, "Read this: Wire it with #Stripe. Thanks", "/work", ["Wire it with #Stripe.", "gone"]));
  assert.deepEqual(r.input.pasted, ["Wire it with #Stripe."]);
  assert.equal("pasted" in /** @type {any} */ (startCall({ kind: "project", slug: "harlow-legal" }, null, "hi", "/work", [])).input, false);
});

test("startCall: pasted spans go to agents.ask too, and only when there are some", () => {
  const r = /** @type {any} */ (startCall({ kind: "none" }, "kit", "Check this: use #Stripe for it. Thanks", null, ["use #Stripe for it."]));
  assert.equal(r.tool, "agents.ask");
  assert.deepEqual(r.input.pasted, ["use #Stripe for it."]);
  assert.equal("pasted" in /** @type {any} */ (startCall({ kind: "none" }, "kit", "hi", null, [])).input, false);
});

test("new session: # opens the same tag picker, a pick becomes a chip, and Start sends mentions and pasted on threads.start", async () => {
  const api = vyred({ ...WORLD, "mentions.search": { results: [{ kind: "vault", id: "it-1", name: "Stripe", hint: "api.stripe.com", label: "Vault" }, { kind: "artifact", id: "a1", name: "Menu page", hint: "page", label: "Artifacts" }] } });
  went.length = 0;
  const box = /** @type {any} */ (document.createElement("div"));
  const stop = mountNewSession(box, { project: "harlow-legal", onDone() {} });
  await tick(); await tick();
  const ta = $(box, "textarea");
  const input = (v, inputType) => { ta.value = v; ta.setSelectionRange(v.length, v.length); ta.dispatchEvent(Object.assign(new Event("input"), { inputType })); };
  input("Check #", "insertText");
  await new Promise(r => setTimeout(r, 200));
  assert.deepEqual($$(box, "[role=option]").map(o => o.getAttribute("data-key")), ["vault:it-1", "artifact:a1"]);
  $$(box, "[role=option]")[0].dispatchEvent(new Event("click"));
  assert.equal(ta.value, "Check #Stripe ");
  assert.equal($(box, "[data-vault]").getAttribute("data-kind"), "vault");
  input("Check #Stripe Wire it: pay #Menu now", "insertFromPaste");
  $(box, "textarea").dispatchEvent(Object.assign(new Event("keydown"), { key: "Enter", metaKey: true }));
  await tick(); await tick();
  const sent = api.of("threads.start")[0].input;
  assert.deepEqual(sent.mentions, [{ kind: "vault", id: "it-1", name: "Stripe" }]);
  assert.deepEqual(sent.pasted, ["Wire it: pay #Menu now"]);
  assert.equal(sent.prompt, "Check #Stripe Wire it: pay #Menu now");
  stop();
});

test("startCall: mentions go to agents.ask too", () => {
  const m = [{ kind: "github", id: "harlow/site#4", name: "site-pr-4" }];
  assert.deepEqual(/** @type {any} */ (startCall({ kind: "none" }, "kit", "Review #site-pr-4", null, [], m)).input.mentions, m);
  assert.equal("mentions" in /** @type {any} */ (startCall({ kind: "none" }, "kit", "hi", null, [], [])).input, false);
});
