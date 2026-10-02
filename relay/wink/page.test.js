// @ts-check
// The camera page, with a fake camera, relay and navigation. Platform's ruling on iOS is a real test here: from an iPhone in
// Safari the seed is never read, stored or sent; from the installed app, Android or a desktop, a first scan hands off to the app.
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { install, text as allText } from "../../deck/test/fake-dom.js";

install();
const { mountWink } = await import("./page.js");
const flow = await import("./flow.js");

const IOS = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148";
const ANDROID = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Mobile";
const sha256 = async (/** @type {Uint8Array} */ b) => new Uint8Array(crypto.createHash("sha256").update(b).digest());

/** A page with every outside call counted. */
function world(/** @type {{ userAgent: string, standalone?: boolean, record?: any, resolveError?: any }} */ o) {
  const log = /** @type {string[]} */ ([]), haptics = /** @type {string[]} */ ([]), timers = /** @type {(() => void)[]} */ ([]);
  /** @type {{ onFound: (t: Uint8Array) => void, onError: (e: Error) => void } | null} */ let cam = null;
  const root = document.createElement("div");
  const wink = mountWink(root, {
    nav: { userAgent: o.userAgent, platform: "", maxTouchPoints: 5, standalone: o.standalone }, standalone: false, relay: "wss://relay.test", crypto: {},
    startScan: opts => { log.push("scan"); cam = opts; return { stop() { log.push("scan-stop"); } }; },
    resolveTicket: async () => { log.push("resolve"); if (o.resolveError) throw o.resolveError; return o.record || { name: "Alex's Mac", fingerprint: "AB12 CD34" }; },
    sha256, haptic: k => { haptics.push(k); }, navigate: u => { log.push("navigate " + u); }, later: fn => { timers.push(fn); },
    registerWorker: () => { log.push("register-sw"); },
  });
  const tick = () => new Promise(r => setTimeout(r, 0));
  const run = async () => { for (let i = 0; i < 4; i++) { await tick(); while (timers.length) timers.shift()?.(); } await tick(); };
  return { root, wink, log, haptics, run, cam: () => /** @type {NonNullable<typeof cam>} */ (cam) };
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

test("the installed app on iOS, Android and a desktop scan; a first pairing hands the ticket to app.vyre.run and does nothing else with it", async () => {
  for (const o of [{ userAgent: IOS, standalone: true }, { userAgent: ANDROID }, { userAgent: "Mozilla/5.0 (Windows NT 10.0)" }]) {
    const w = world(o);
    assert.equal(w.wink.state().kind, "search");
    assert.deepEqual(w.log, ["register-sw", "scan"], "the worker is registered where the page runs");
    w.cam().onFound(TICKET);
    await w.run();
    assert.equal(w.wink.state().kind, "card");
    assert.ok(w.log.includes("resolve") && w.log.includes("scan-stop"), "looked up, then the camera is off while the card is up");
    assert.deepEqual(w.haptics.slice(0, 2), ["tick", "success"], "a tick on a ring, a firm tap on the lock");
    const text = allText(w.root);
    assert.ok(text.includes("Alex's Mac") && text.includes("AB12 CD34") && text.includes("Single use"));
    const main = /** @type {any} */ ([...w.root.querySelectorAll?.("button") || []].find((/** @type {any} */ b) => b.className.includes("main")));
    main.dispatchEvent(Object.assign(new Event("click"), { button: 0 }));
    await w.run();
    assert.equal(w.wink.state().kind, "handoff");
    const nav = w.log.filter(l => l.startsWith("navigate "));
    assert.equal(nav.length, 1);
    assert.equal(nav[0], "navigate " + flow.handoffUrl(TICKET));
    assert.match(nav[0], /^navigate https:\/\/app\.vyre\.run\/#pair=[A-Za-z0-9_-]{11}$/);
    assert.equal(w.log.filter(l => l === "resolve").length, 1, "this page never redeems: the app origin does");
  }
});

test("Not now drops the ticket and returns to the camera; a second tap on Pair after the hand-off does nothing", async () => {
  const w = world({ userAgent: ANDROID });
  w.cam().onFound(TICKET); await w.run();
  const btns = () => /** @type {any[]} */ ([...w.root.querySelectorAll("button")]);
  btns().find(b => b.textContent === "Not now").dispatchEvent(new Event("click"));
  assert.equal(w.wink.state().kind, "search");
  assert.equal(w.log.filter(l => l === "scan").length, 2, "the camera restarts");
  w.cam().onFound(TICKET); await w.run();
  const pair = btns().find(b => b.textContent === "Pair");
  pair.dispatchEvent(new Event("click")); pair.dispatchEvent(new Event("click")); await w.run();
  assert.equal(w.log.filter(l => l.startsWith("navigate ")).length, 1, "one hand-off, however many taps");
});

test("a refused ticket, a lookup that fails and a denied camera show a plain line with Scan again, and never hand off", async () => {
  const gone = Object.assign(new Error("gone"), { code: "ticket_gone" });
  const w = world({ userAgent: ANDROID, resolveError: gone });
  w.cam().onFound(TICKET); await w.run();
  assert.equal(w.wink.state().kind, "error");
  assert.match(allText(w.root), /expired or was already used/);
  assert.ok(!w.log.some(l => l.startsWith("navigate ")));
  assert.equal(w.haptics.at(-1), "warning");
  const w2 = world({ userAgent: ANDROID });
  w2.cam().onError(Object.assign(new Error("denied"), { name: "NotAllowedError" })); await w2.run();
  assert.match(allText(w2.root), /Camera access is off/);
});

test("text from the record is text: a name made of markup is shown as characters and builds no element", async () => {
  const w = world({ userAgent: ANDROID, record: { name: "<img src=x onerror=alert(1)>‮evil", fingerprint: "AB12" } });
  w.cam().onFound(TICKET); await w.run();
  assert.ok(allText(w.root).includes("<img src=x onerror=alert(1)> evil"), "shown as characters, bidi override gone");
  assert.equal(w.root.querySelectorAll("img").length, 0);
});

test("the page source: innerHTML only for the constant icon drawings, no storage, no fetch of its own, no inline handlers", () => {
  const src = fs.readFileSync(path.join(import.meta.dirname, "page.js"), "utf8");
  assert.equal((src.match(/innerHTML/g) || []).length, 1);
  assert.doesNotMatch(src, /localStorage|sessionStorage|indexedDB|document\.cookie|fetch\(|eval\(|new Function/);
  const entry = fs.readFileSync(path.join(import.meta.dirname, "wink.js"), "utf8");
  assert.doesNotMatch(entry, /localStorage|sessionStorage|indexedDB|document\.cookie|fetch\(/);
});

test("no host from the ring or the server is ever navigated to: whatever the record says, the hand-off is app.vyre.run and the card names the address as display text", async () => {
  const hostile = { name: "Alex's Mac", fingerprint: "AB12 CD34", handle: "evil.example", rpId: "evil.example", enroll: { grant: "x".repeat(43), rpId: "evil.example" },
    url: "https://evil.example/", redirect: "https://evil.example/", address: "evil.example", host: "evil.example" };
  for (const record of [hostile, { ...hostile, handle: "10.0.0.1" }, { ...hostile, handle: "alex" }]) {
    const w = world({ userAgent: ANDROID, record });
    w.cam().onFound(TICKET); await w.run();
    const text = allText(w.root);
    if (record.handle === "alex") assert.ok(text.includes("Says it is alex.vyre.run") && text.includes("AB12 CD34"), "the address is a claim on its own line, beside the fingerprint a server cannot choose");
    else assert.ok(!text.includes("evil.example") && !text.includes("10.0.0.1"), "an invalid handle is not shown as an address");
    const main = /** @type {any} */ ([...w.root.querySelectorAll("button")].find((/** @type {any} */ b) => b.className.includes("main")));
    main.dispatchEvent(Object.assign(new Event("click"), { button: 0 })); await w.run();
    const navs = w.log.filter(l => l.startsWith("navigate "));
    assert.equal(navs.length, 1);
    assert.ok(navs[0].startsWith("navigate https://app.vyre.run/#pair="), navs[0]);
    assert.ok(!navs[0].includes("evil") && !navs[0].includes("10.0.0.1"), "nothing the record said is in the URL");
  }
});

test("inside the hosted app (redeem given): the ticket goes to the app's own pairing, never into a URL or a navigation", async () => {
  /** @type {Uint8Array[]} */ const got = [];
  const log = /** @type {string[]} */ ([]);
  const timers = /** @type {(() => void)[]} */ ([]);
  /** @type {any} */ let cam = null;
  const root = document.createElement("div");
  const wink = mountWink(root, { nav: { userAgent: ANDROID }, relay: "wss://relay.test", crypto: {}, startScan: o => { cam = o; return { stop() {} }; },
    resolveTicket: async () => ({ name: "Alex's Mac", fingerprint: "AB12" }), sha256, haptic: () => {}, navigate: u => log.push("navigate " + u),
    redeem: async t => { got.push(t); }, later: fn => { timers.push(fn); } });
  cam.onFound(TICKET);
  for (let i = 0; i < 4; i++) { await new Promise(r => setTimeout(r, 0)); while (timers.length) timers.shift()?.(); }
  const main = /** @type {any} */ ([...root.querySelectorAll("button")].find((/** @type {any} */ b) => b.className.includes("main")));
  main.dispatchEvent(Object.assign(new Event("click"), { button: 0 }));
  for (let i = 0; i < 3; i++) { await new Promise(r => setTimeout(r, 0)); while (timers.length) timers.shift()?.(); }
  assert.deepEqual(got.map(t => [...t]), [[...TICKET]]);
  assert.deepEqual(log, [], "no navigation");
  assert.equal(wink.state().kind, "handoff");
});
