// @ts-check
// The camera page, with a fake camera, relay and navigation. Platform's ruling on iOS is a real test here: from an iPhone in
// Safari the seed is never read, stored or sent; from the installed app, Android or a desktop, a first scan hands off to the app.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { install, text as allText } from "../../deck/test/fake-dom.js";

install();
const { mountWink } = await import("./page.js");
const flow = await import("./flow.js");

const IOS = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148";
const ANDROID = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Mobile";

/** A page with every outside call counted. */
function world(/** @type {{ userAgent: string, standalone?: boolean, onTicket?: boolean }} */ o) {
  const log = /** @type {string[]} */ ([]), haptics = /** @type {string[]} */ ([]), timers = /** @type {(() => void)[]} */ ([]);
  /** @type {Uint8Array[]} */ const handed = [];
  /** @type {{ onFound: (t: Uint8Array) => void, onError: (e: Error) => void } | null} */ let cam = null;
  const root = document.createElement("div");
  const wink = mountWink(root, {
    nav: { userAgent: o.userAgent, platform: "", maxTouchPoints: 5, standalone: o.standalone }, standalone: false,
    startScan: opts => { log.push("scan"); cam = opts; return { stop() { log.push("scan-stop"); } }; },
    haptic: k => { haptics.push(k); }, navigate: u => { log.push("navigate " + u); }, later: fn => { timers.push(fn); },
    registerWorker: () => { log.push("register-sw"); },
    ...(o.onTicket ? { onTicket: t => { handed.push(t); } } : {}),
  });
  const tick = () => new Promise(r => setTimeout(r, 0));
  const run = async () => { for (let i = 0; i < 4; i++) { await tick(); while (timers.length) timers.shift()?.(); } await tick(); };
  return { root, wink, log, haptics, handed, run, cam: () => /** @type {NonNullable<typeof cam>} */ (cam) };
}

const TICKET = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);

test("iOS in Safari (platform's test): nothing starts. No camera, no lookup, no hand-off, no storage, and the install steps show", async () => {
  /** @type {string[]} */ const touched = [];
  const store = new Map();
  Object.defineProperty(globalThis, "localStorage", { value: { getItem: () => { touched.push("get"); return null; }, setItem: () => { touched.push("set"); }, removeItem: () => { touched.push("rm"); } }, configurable: true });
  Object.defineProperty(globalThis, "sessionStorage", { value: { getItem: () => { touched.push("sget"); return null; }, setItem: () => { touched.push("sset"); } }, configurable: true });
  void store;
  const w = world({ userAgent: IOS });
  await w.run();
  assert.equal(w.wink.state().kind, "install");
  assert.deepEqual(w.log, [], "no scan, no resolve, no navigate, and no service worker: an iPhone tab keeps no cache");
  assert.deepEqual(touched, [], "no storage read or written");
  assert.match(allText(w.root), /Add Vyre to your Home Screen/);
  for (const step of ["Share", "Add to Home Screen", "Open Vyre"]) assert.ok(allText(w.root).includes(step), step);
  assert.match(allText(w.root), /scan the code again, inside the app/i);
});

test("a ring on Android, a desktop and the installed iOS app: the lock haptic, no lookup and no card, then the hand-off to app.vyre.run", async () => {
  for (const o of [{ userAgent: IOS, standalone: true }, { userAgent: ANDROID }, { userAgent: "Mozilla/5.0 (Windows NT 10.0)" }]) {
    const w = world(o);
    assert.equal(w.wink.state().kind, "search");
    assert.deepEqual(w.log, ["register-sw", "scan"], "the worker is registered where the page runs");
    w.cam().onFound(TICKET);
    w.cam().onFound(TICKET); // a second frame decodes the same ring: still one hand-off
    await w.run();
    assert.equal(w.wink.state().kind, "handoff");
    assert.ok(w.log.includes("scan-stop"), "the camera is off once a ring is read");
    assert.deepEqual(w.haptics, ["success"], "the lock haptic");
    const text = allText(w.root);
    assert.match(text, /Opening Vyre/);
    assert.equal(w.root.querySelectorAll("button").filter((/** @type {any} */ b) => /Pair|Not now/.test(b.textContent)).length, 0, "no card, no Pair button on this page");
    const nav = w.log.filter(l => l.startsWith("navigate "));
    assert.equal(nav.length, 1);
    assert.equal(nav[0], "navigate " + flow.handoffUrl(TICKET));
    assert.match(nav[0], /^navigate https:\/\/app\.vyre\.run\/#pair=[A-Za-z0-9_-]{11}$/);
  }
});

test("a denied camera shows a plain line with Scan again, and never hands off", async () => {
  const w2 = world({ userAgent: ANDROID });
  w2.cam().onError(Object.assign(new Error("denied"), { name: "NotAllowedError" })); await w2.run();
  assert.match(allText(w2.root), /Camera access is off/);
  assert.ok(!w2.log.some(l => l.startsWith("navigate ")));
  assert.equal(w2.haptics.at(-1), "warning");
});

test("the page source: innerHTML only for the constant icon drawings, no storage, no fetch of its own, no lookup, no inline handlers", () => {
  const src = fs.readFileSync(path.join(import.meta.dirname, "page.js"), "utf8");
  assert.equal((src.match(/innerHTML/g) || []).length, 1);
  assert.doesNotMatch(src, /localStorage|sessionStorage|indexedDB|document\.cookie|fetch\(|eval\(|new Function|resolveTicket|WebSocket/);
  const entry = fs.readFileSync(path.join(import.meta.dirname, "wink.js"), "utf8");
  assert.doesNotMatch(entry, /localStorage|sessionStorage|indexedDB|document\.cookie|fetch\(|resolveTicket|WebSocket/);
});

test("the hand-off is app.vyre.run and nothing the ring says is in it", async () => {
  const w = world({ userAgent: ANDROID });
  w.cam().onFound(new Uint8Array([9, 9, 9, 9, 9, 9, 9, 9, 9, 9])); await w.run();
  const navs = w.log.filter(l => l.startsWith("navigate "));
  assert.equal(navs.length, 1);
  assert.ok(navs[0].startsWith("navigate https://app.vyre.run/#pair="), navs[0]);
});

test("inside the hosted app (onTicket given): the decoded ticket goes back to the loader, never into a URL or a navigation", async () => {
  const w = world({ userAgent: ANDROID, onTicket: true });
  w.cam().onFound(TICKET); await w.run();
  assert.deepEqual(w.handed.map(t => [...t]), [[...TICKET]]);
  assert.ok(!w.log.some(l => l.startsWith("navigate ")), "no navigation");
  assert.equal(w.wink.state().kind, "handoff");
});
