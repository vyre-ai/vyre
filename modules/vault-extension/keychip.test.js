// @ts-check
// keychip tests: the worker half (background.js in a vm with a fake `chrome`, against a real fill
// listener over a real Vault) and the page half (keyfind.js and keychip.js over a fake DOM).
// They check that a chip is raised once per value, never for a password input, that the value
// goes to the worker only on a trusted Save tap, that a save is bound to the origin the chip was
// raised on, that Undo works for its own save only, and that registration follows pairing and the
// person's choice. No browser runs; every key is a fake built at run time.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { open, migrate } from "../../core/store/index.js";
import { Vault, MIGRATIONS } from "../../core/vault/vault.js";
import { Fill, serveFill } from "../../core/vault/fill.js";
import { SCRATCH } from "../../test/scratch.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = f => fs.readFileSync(path.join(HERE, f), "utf8");
const ID = "abcdefghijklmnopabcdefghijklmnop";
const ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
let seed = 0x4b657943; // "KeyC"
function fake(n) {
  let s = "";
  for (let i = 0; i < n; i++) { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; s += ALNUM[(seed >>> 8) % ALNUM.length]; }
  return s;
}
const anthropic = () => ["sk-", "ant-api03-", fake(48)].join("");
const plain = x => JSON.parse(JSON.stringify(x));

// ---- the worker ----------------------------------------------------------------------------

async function worker(t) {
  const tmp = fs.mkdtempSync(path.join(SCRATCH, "vyre-keychip-"));
  const db = open(path.join(tmp, "vyre.db"));
  migrate(db, "vault", MIGRATIONS);
  const vault = new Vault({ db, dir: path.join(tmp, "vault"), config: { vault: { keystore: "file" } }, emit: () => {} });
  const fill = new Fill({ vault });
  const srv = await serveFill({ host: "127.0.0.1", port: 0, fill });
  t.after(async () => { await srv.close(); db.close(); fs.rmSync(tmp, { recursive: true, force: true }); });
  const post = async (route, body, headers = {}) => (await fetch(`${srv.url}/v1/fill/${route}`, { method: "POST", headers: { "content-type": "application/json", origin: `chrome-extension://${ID}`, ...headers }, body: JSON.stringify(body) })).json();
  const paired = (await post("pair", { code: fill.code({ name: "vm browser" }).code })).data;
  await fill.setUnlockPassphrase({ passphrase: "a long unlock passphrase" });
  const session = (await post("unlock", { passphrase: "a long unlock passphrase" }, { authorization: `Bearer ${paired.token}` })).data;

  const local = { url: srv.url, device: paired.device, token: paired.token, deviceName: paired.name };
  const sess = { session: session.session, expires: session.expires };
  const registered = new Map();
  let listener = null;
  const store = obj => ({
    get: async keys => Object.fromEntries(keys.filter(k => k in obj).map(k => [k, obj[k]])),
    set: async v => { Object.assign(obj, v); }, remove: async keys => { for (const k of keys) delete obj[k]; },
    setAccessLevel: () => {},
  });
  const chrome = {
    runtime: { id: ID, getURL: p => `chrome-extension://${ID}/${p}`, onMessage: { addListener: fn => { listener = fn; } } },
    storage: { local: store(local), session: store(sess) },
    tabs: { query: async () => [{ id: 7, url: "https://console.example.com/keys" }], onRemoved: { addListener: () => {} }, sendMessage: async () => {} },
    commands: { onCommand: { addListener: () => {} } },
    scripting: {
      executeScript: async () => [],
      getRegisteredContentScripts: async ({ ids }) => ids.filter(id => registered.has(id)).map(id => registered.get(id)),
      registerContentScripts: async list => { for (const s of list) registered.set(s.id, s); },
      unregisterContentScripts: async ({ ids }) => { for (const id of ids) registered.delete(id); },
    },
    permissions: { contains: async () => true },
  };
  vm.runInNewContext(read("background.js"), { chrome, fetch, URL, Date, console, setTimeout });
  const send = (msg, sender) => new Promise(resolve => { listener(msg, sender, r => resolve(JSON.parse(JSON.stringify(r)))); });
  const page = (url, frameId = 0, tab = 7) => ({ id: ID, tab: { id: tab, url }, frameId, origin: new URL(url).origin, url });
  const popup = { id: ID, url: `chrome-extension://${ID}/popup.html` };
  await new Promise(r => setTimeout(r, 30));
  return { vault, send, page, popup, registered };
}

test("worker: the key chip script is registered once paired, on every page, top frame only, and follows the person's choice", async t => {
  const { send, popup, registered } = await worker(t);
  const r = registered.get("vyre-keychip");
  assert.ok(r, "registered");
  assert.deepEqual(plain(r.js), ["keyfind.js", "keychip.js"], "keyfind.js first");
  assert.deepEqual(plain(r.matches), ["https://*/*", "http://*/*"]);
  assert.equal(r.allFrames, false);
  assert.deepEqual((await send({ type: "keychip-state" }, popup)).data, { keychip: true });
  assert.deepEqual((await send({ type: "keychip-disable" }, popup)).data, { keychip: false });
  assert.ok(!registered.has("vyre-keychip"));
  assert.deepEqual((await send({ type: "keychip-enable" }, popup)).data, { keychip: true });
  assert.ok(registered.has("vyre-keychip"));
  // Forgetting the pairing takes the script away with it.
  await send({ type: "forget" }, popup);
  assert.ok(!registered.has("vyre-keychip"));
});

test("worker: raise once per fingerprint, save for the sender's page, undo its own save", async t => {
  const { vault, send, page } = await worker(t);
  const value = anthropic();
  const p = page("https://console.example.com/settings/keys");

  assert.deepEqual((await send({ type: "key-raise", fp: "abc123", generic: false }, p)).data, { raise: true });
  assert.deepEqual((await send({ type: "key-raise", fp: "abc123", generic: false }, p)).data, { raise: false }, "the same value is never offered twice in a tab");
  assert.equal((await send({ type: "key-raise", fp: "bad fingerprint!" }, p)).data.raise, false);

  // The save goes for the sender's origin whatever the message says.
  const saved = await send({ type: "key-save", fp: "abc123", value, label: "API key", url: "https://evil.example.net", origin: "https://evil.example.net" }, p);
  assert.deepEqual(saved.data, { name: "console.example.com-api-key", created: true, connected: null }, JSON.stringify(saved));
  const row = vault.row("console.example.com-api-key");
  assert.equal(row.origin, "https://console.example.com");
  assert.equal((await vault.fields(row)).value, value);
  assert.equal((await send({ type: "key-save", fp: "abc123", value, label: "API key" }, p)).error.code, "expired", "an offer saves once");

  assert.equal((await send({ type: "key-undo", name: "example-mail" }, p)).error.code, "expired", "only its own save");
  assert.deepEqual((await send({ type: "key-undo", name: "console.example.com-api-key" }, p)).data, { removed: true });
  assert.equal(vault.row("console.example.com-api-key"), undefined);
  assert.equal((await send({ type: "key-undo", name: "console.example.com-api-key" }, p)).error.code, "expired");
});

test("worker: a save from another origin than the chip was raised on is refused by vyred", async t => {
  const { vault, send, page } = await worker(t);
  const a = page("https://console.example.com/keys"), b = page("https://app.northwind.example/home");
  await send({ type: "key-raise", fp: "k1" }, a);
  // The same tab has moved on to another site; the offer cannot follow it.
  const r = await send({ type: "key-save", fp: "k1", value: anthropic(), label: "API key" }, b);
  assert.equal(r.error?.code, "wrong_origin", JSON.stringify(r));
  assert.equal(vault.list().items.filter(i => i.kind === "api-key").length, 0);
  // Another tab has no offer at all.
  await send({ type: "key-raise", fp: "k2" }, a);
  assert.equal((await send({ type: "key-save", fp: "k2", value: anthropic(), label: "API key" }, page("https://console.example.com/keys", 0, 9))).error.code, "expired");
  assert.equal(vault.list().items.filter(i => i.kind === "api-key").length, 0);
});

test("worker: who may ask, and nothing while locked or for a value that is no key", async t => {
  const { vault, send, page, popup } = await worker(t);
  const p = page("https://console.example.com/keys");
  // Not from a subframe, not from another extension, not from the popup as a page request.
  assert.equal((await send({ type: "key-raise", fp: "f1" }, page("https://console.example.com/x", 3))).error.code, "refused");
  assert.equal((await send({ type: "key-raise", fp: "f1" }, { id: "someoneelse", tab: { id: 7, url: p.url }, frameId: 0, origin: p.origin, url: p.url })).error.code, "refused");
  assert.equal((await send({ type: "key-raise", fp: "f1" }, popup)).error.code, "bad_message");
  // A value the box does not call a key is refused, and nothing is stored.
  await send({ type: "key-raise", fp: "f2" }, p);
  assert.equal((await send({ type: "key-save", fp: "f2", value: "hunter2hunter2hunter2", label: "API key" }, p)).error.code, "not_a_key");
  assert.equal(vault.list().items.filter(i => i.kind !== "login").length, 0);
  // Locked: no chip.
  await send({ type: "lock" }, popup);
  assert.deepEqual((await send({ type: "key-raise", fp: "f3" }, p)).data, { raise: false });
});

// ---- the page --------------------------------------------------------------------------------

class El {
  /** @param {string} tag @param {Record<string, any>} [o] */
  constructor(tag, o = {}) {
    this.tagName = tag.toUpperCase(); this.children = []; this.listeners = {}; this.style = {}; this.textContent = ""; this.className = "";
    this.connected = false; this.attrs = {}; this.previousElementSibling = null; this.parentElement = null; this.firstElementChild = null; this.labels = null;
    Object.assign(this, o);
  }
  get isConnected() { return this.connected; }
  attachShadow(o) { assert.equal(o.mode, "closed"); this.shadow = new El("#shadow"); return this.shadow; }
  append(...c) { this.children.push(...c); }
  replaceChildren(...c) { this.children = [...c]; }
  remove() { this.connected = false; }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  getAttribute(n) { return this.attrs[n] ?? null; }
  getClientRects() { return [1]; }
  closest() { return this.closestBtn ?? null; }
  querySelectorAll() { return this.inside || []; }
  all() { return this.children.flatMap(c => [c, ...c.all()]); }
  click(isTrusted) { for (const fn of this.listeners.click || []) fn({ isTrusted, preventDefault() {}, stopPropagation() {} }); }
}
class HTMLInputElement extends El {}
class HTMLTextAreaElement extends El {}
/** A shown value: a code element with a label element before it. */
function codeEl(text, label) {
  const parent = new El("div");
  const lab = new El("span", { textContent: label });
  const code = new El("code", { textContent: text, previousElementSibling: lab, parentElement: parent });
  return code;
}
const pwInput = value => new HTMLInputElement("input", { type: "password", value });

/** keyfind.js and keychip.js over a fake page. @param {El[]} fields @param {Record<string, (m: any) => any>} [answers] */
function pageWith(fields, answers = {}) {
  const sent = [];
  const delays = [];
  const docListeners = {};
  const hosts = [];
  const document = {
    createElement: tag => { const e = new El(tag); if (tag.startsWith("vyre-")) hosts.push(e); return e; },
    documentElement: { append: e => { e.connected = true; } },
    addEventListener: (type, fn) => { (docListeners[type] ||= []).push(fn); },
    querySelectorAll: sel => (/password/.test(sel) ? fields.filter(f => f.type === "password") : fields),
  };
  const replies = {
    "key-raise": () => ({ data: { raise: true } }),
    "key-save": () => ({ data: { name: "console.example.com-api-key", created: true, connected: null } }),
    "key-undo": () => ({ data: { removed: true } }),
    "key-dismiss": () => ({ data: { dismissed: true } }),
    ...answers,
  };
  const chrome = { runtime: { id: ID, lastError: undefined, sendMessage: (m, cb) => { sent.push(plain(m)); setTimeout(() => cb(replies[m.type](m)), 0); } } };
  class MutationObserver { observe() {} }
  const timers = (fn, ms) => { delays.push(ms); return ms >= 1000 ? 0 : setTimeout(fn, 0); };
  const win = { document, chrome, HTMLInputElement, HTMLTextAreaElement, Element: El, MutationObserver, getSelection: () => ({ toString: () => "", anchorNode: null }),
    setTimeout: timers, clearTimeout, Date, console };
  vm.createContext(win);
  const self = vm.runInContext("globalThis", win);
  win.window = self; win.top = self;
  vm.runInContext(read("keyfind.js"), win);
  vm.runInContext(read("keychip.js"), win);
  const shown = () => { const h = hosts.find(x => x.isConnected); return h ? h.shadow.all() : []; };
  const buttons = () => shown().filter(e => e.tagName === "BUTTON");
  return { sent, delays, shown, buttons, docListeners };
}
const tick = (ms = 20) => new Promise(r => setTimeout(r, ms));

test("page: a key-shaped value raises a chip; nothing but a fingerprint goes before the tap", async () => {
  const value = anthropic();
  const p = pageWith([codeEl(value, "New API key")]);
  await tick();
  const raise = p.sent.find(m => m.type === "key-raise");
  assert.ok(raise, "asked the worker");
  assert.deepEqual(Object.keys(raise).sort(), ["fp", "generic", "type"]);
  assert.ok(!JSON.stringify(p.sent).includes(value), "the value has not left the page");
  assert.deepEqual(p.shown().filter(e => e.className === "t").map(e => e.textContent), ["Save this Anthropic key to Vyre?"]);
  assert.ok(!p.shown().some(e => String(e.textContent).includes(value)), "the chip never shows the key");
  assert.deepEqual(p.buttons().map(b => b.textContent), ["Save", "Not now"]);
});

test("page: only a trusted tap saves; Undo shows for ten seconds and removes what was saved", async () => {
  const value = anthropic();
  const p = pageWith([codeEl(value, "API key")]);
  await tick();
  const [save] = p.buttons();
  save.click(false);
  await tick();
  assert.ok(!p.sent.some(m => m.type === "key-save"), "a script's click saves nothing");
  save.click(true);
  await tick();
  const asked = p.sent.find(m => m.type === "key-save");
  assert.equal(asked.value, value, "the value goes on the tap");
  assert.equal(asked.label, "api key");
  assert.equal(asked.generic, false);
  assert.ok(p.shown().some(e => /^Saved as console\.example\.com-api-key/.test(e.textContent)));
  assert.ok(p.delays.includes(10_000), "Undo shows for ten seconds");
  const undo = p.buttons().find(b => b.textContent === "Undo");
  assert.ok(undo, "the same chip carries Undo");
  assert.ok(!p.buttons().some(b => /review|edit|draft/i.test(b.textContent)), "no review step");
  undo.click(true);
  await tick();
  assert.deepEqual(p.sent.find(m => m.type === "key-undo"), { type: "key-undo", name: "console.example.com-api-key" });
  assert.ok(p.shown().some(e => e.textContent === "Removed."));
});

test("page: Not now tells the worker and hides the chip", async () => {
  const p = pageWith([codeEl(anthropic(), "API key")]);
  await tick();
  p.buttons()[1].click(true);
  await tick();
  assert.ok(p.sent.some(m => m.type === "key-dismiss"));
  assert.equal(p.shown().length, 0);
});

test("page: a password input, a UUID, a placeholder and an unlabelled random string raise nothing", async () => {
  const value = anthropic();
  const p = pageWith([
    pwInput(value),
    codeEl("0b1f6c5e-3c1a-4d55-9d47-0e3f9a6f2b11", "API key"),
    codeEl("sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx", "API key"),
    codeEl("YOUR_API_KEY_HERE_0123456789", "API key"),
    codeEl(fake(44), "Order reference"),
    codeEl(fake(44), ""),
  ]);
  await tick();
  assert.equal(p.sent.length, 0);
  assert.equal(p.shown().length, 0);
});

test("page: a password input holding a key-shaped value hides the same value shown elsewhere", async () => {
  const value = anthropic();
  const p = pageWith([pwInput(value), codeEl(value, "API key")]);
  await tick();
  assert.equal(p.sent.length, 0, "a login form's value is login save's");
});

test("page: a generic string counts under a secret label, once, even when shown twice", async () => {
  const v = fake(44);
  const p = pageWith([codeEl(v, "Secret key"), codeEl(v, "Secret key")]);
  await tick();
  const raises = p.sent.filter(m => m.type === "key-raise");
  assert.equal(raises.length, 1, "once per value");
  assert.equal(raises[0].generic, true);
  assert.ok(p.shown().some(e => e.textContent === "Save this key to Vyre?"));
});

test("page: nothing is shown when the worker says no (locked, or offered before in this tab)", async () => {
  const p = pageWith([codeEl(anthropic(), "API key")], { "key-raise": () => ({ data: { raise: false } }) });
  await tick();
  assert.ok(p.sent.some(m => m.type === "key-raise"));
  assert.equal(p.shown().length, 0);
});

test("page: a trusted click on a Copy button finds the key in the box beside it", async () => {
  const value = anthropic();
  const container = new El("div", { inside: [codeEl(value, "API key")] });
  const button = new El("button", { textContent: "Copy", parentElement: container });
  button.closestBtn = button;
  const p = pageWith([]);
  await tick();
  assert.equal(p.sent.length, 0, "the page shows nothing yet");
  const click = isTrusted => { for (const fn of p.docListeners.click || []) fn({ isTrusted, target: button }); };
  click(false);
  await tick();
  assert.equal(p.sent.length, 0, "a synthetic click does nothing");
  click(true);
  await tick();
  assert.equal(p.sent.filter(m => m.type === "key-raise").length, 1);
  assert.ok(p.shown().some(e => e.textContent === "Save this Anthropic key to Vyre?"));
  // A Copy button beside nothing key-shaped raises nothing.
  const bare = new El("button", { textContent: "Copy", parentElement: new El("div", { inside: [codeEl("hello world", "Name")] }) });
  bare.closestBtn = bare;
  const before = p.sent.length;
  for (const fn of p.docListeners.click || []) fn({ isTrusted: true, target: bare });
  await tick();
  assert.equal(p.sent.length, before);
});
