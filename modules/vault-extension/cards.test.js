// @ts-check
// cards tests: cards.js's field detection and value mapping as pure functions over field
// descriptors; background.js in a vm with a fake `chrome` against a real fill listener, checking
// that card and address fills go to the sender's page (never the message's say) and that a stale
// proof gets the reprompt answer; and inline.js over a fake DOM, acting only on trusted events.
// No browser runs.

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
const CARDS_JS = fs.readFileSync(path.join(HERE, "cards.js"), "utf8");
const INLINE_JS = fs.readFileSync(path.join(HERE, "inline.js"), "utf8");
const ID = "abcdefghijklmnopabcdefghijklmnop";
// Standard test numbers, put together at run time.
const VISA = ["4111", "1111", "1111", "1111"].join("");
const MC = ["5555", "5555", "5555", "4444"].join("");
const AMEX = ["3782", "822463", "10005"].join("");
const CVV = String(700 + 37);

/** cards.js's pure half, loaded into a bare context. */
function cardsApi() {
  const ctx = vm.createContext({});
  vm.runInContext(CARDS_JS, ctx);
  return /** @type {any} */ (vm.runInContext("globalThis.vyreCards", ctx));
}
const months = (/** @type {(n: number) => [string, string]} */ f) => [{ value: "", text: "Month" }, ...Array.from({ length: 12 }, (_, i) => { const [value, text] = f(i + 1); return { value, text }; })];
/** A value made in the vm's realm, as plain objects of this one. */
const plain = x => JSON.parse(JSON.stringify(x));
const NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

// ---- detection --------------------------------------------------------------------------

test("detection: autocomplete tokens first, then English words in name, id, label and placeholder", () => {
  const C = cardsApi();
  /** @type {[any, string|null][]} */
  const cases = [
    // autocomplete, with section and shipping/billing words around the field name
    [{ tag: "input", type: "text", autocomplete: "cc-number" }, "cc-number"],
    [{ tag: "input", type: "text", autocomplete: "section-pay billing cc-exp" }, "cc-exp"],
    [{ tag: "input", type: "text", autocomplete: "shipping address-line1" }, "address-line1"],
    [{ tag: "input", type: "text", autocomplete: "billing postal-code", name: "cardnumber" }, "postal-code"],
    [{ tag: "select", autocomplete: "country" }, "country"],
    [{ tag: "input", type: "tel", autocomplete: "work tel-national" }, "tel"],
    [{ tag: "input", type: "text", autocomplete: "username", name: "email" }, null],
    [{ tag: "input", type: "text", autocomplete: "one-time-code", name: "cvc" }, null],
    // card words
    [{ tag: "input", type: "text", name: "cardholder", label: "Name on card" }, "cc-name"],
    [{ tag: "input", type: "text", id: "cardNumber", placeholder: "1234 1234 1234 1234" }, "cc-number"],
    [{ tag: "input", type: "text", name: "ccnum" }, "cc-number"],
    [{ tag: "input", type: "text", name: "exp-date", autocomplete: "off" }, "cc-exp"],
    [{ tag: "input", type: "text", name: "x1", placeholder: "MM / YY" }, "cc-exp"],
    [{ tag: "input", type: "text", name: "expiry", placeholder: "MM/YYYY" }, "cc-exp"],
    [{ tag: "select", name: "exp_month" }, "cc-exp-month"],
    [{ tag: "select", id: "expYear" }, "cc-exp-year"],
    [{ tag: "select", name: "ccmonth" }, "cc-exp-month"],
    [{ tag: "select", name: "card_year", label: "Year" }, "cc-exp-year"],
    [{ tag: "input", type: "password", name: "cvv2" }, "cc-csc"],
    [{ tag: "input", type: "text", label: "Security code" }, "cc-csc"],
    [{ tag: "select", name: "creditCardType" }, "cc-type"],
    // address words
    [{ tag: "input", type: "text", name: "zip" }, "postal-code"],
    [{ tag: "input", type: "text", name: "postcode" }, "postal-code"],
    [{ tag: "input", type: "text", id: "city" }, "address-level2"],
    [{ tag: "select", name: "province" }, "address-level1"],
    [{ tag: "input", type: "text", name: "state" }, "address-level1"],
    [{ tag: "select", name: "country" }, "country"],
    [{ tag: "input", type: "text", name: "address2", label: "Apartment, suite" }, "address-line2"],
    [{ tag: "input", type: "text", name: "street", label: "Street address" }, "address-line1"],
    [{ tag: "textarea", name: "address" }, "address-line1"],
    [{ tag: "input", type: "text", name: "firstName" }, "given-name"],
    [{ tag: "input", type: "text", name: "last_name" }, "family-name"],
    [{ tag: "input", type: "text", name: "company" }, "organization"],
    [{ tag: "input", type: "text", name: "fullName" }, "name"],
    [{ tag: "input", type: "email", name: "contact" }, "email"],
    [{ tag: "input", type: "text", name: "phone" }, "tel"],
    // not ours
    [{ tag: "input", type: "password", name: "password" }, null],
    [{ tag: "input", type: "text", name: "username" }, null],
    [{ tag: "input", type: "text", name: "user_name" }, null],
    [{ tag: "input", type: "hidden", autocomplete: "cc-number" }, null],
    [{ tag: "input", type: "search", name: "q" }, null],
    [{ tag: "input", type: "checkbox", name: "save_card" }, null],
    [{ tag: "input", type: "text", name: "dob", placeholder: "MM/YY" }, null],
    [{ tag: "button", name: "card number" }, null],
  ];
  for (const [d, want] of cases) assert.equal(C.classify(d), want, JSON.stringify(d));
});

test("mapping: split expiry selects, single expiry inputs, country, brand and names", () => {
  const C = cardsApi();
  assert.equal(C.pickMonth(months(n => [String(n).padStart(2, "0"), String(n).padStart(2, "0")]), "07"), "07");
  assert.equal(C.pickMonth(months(n => [String(n), String(n)]), "07"), "7");
  assert.equal(C.pickMonth(months(n => [NAMES[n - 1].slice(0, 3).toUpperCase(), NAMES[n - 1]]), "07"), "JUL");
  assert.equal(C.pickMonth(months(n => [`m${n}`, NAMES[n - 1]]), "09"), "m9", "by the text when the value is opaque");
  assert.equal(C.pickMonth(months(n => [`opt${n}`, `${String(n).padStart(2, "0")} - ${NAMES[n - 1]}`]), "12"), "opt12");
  const years = long => [{ value: "", text: "Year" }, ...Array.from({ length: 10 }, (_, i) => { const y = String(2026 + i); return { value: long ? y : y.slice(2), text: y }; })];
  assert.equal(C.pickYear(years(true), "2029"), "2029");
  assert.equal(C.pickYear(years(false), "2029"), "29");
  assert.equal(C.pickYear(years(true), "2041"), null);

  const countries = [{ value: "", text: "Choose a country" }, { value: "US", text: "United States" }, { value: "GB", text: "United Kingdom" }, { value: "DE", text: "Germany" }];
  assert.equal(C.pickCountry(countries, "GB"), "GB");
  assert.equal(C.pickCountry(countries, "United Kingdom"), "GB");
  assert.equal(C.pickCountry(countries, "uk"), "GB");
  assert.equal(C.pickCountry(countries, "United States of America"), "US");
  assert.equal(C.pickCountry([{ value: "United Kingdom", text: "United Kingdom" }, { value: "Germany", text: "Germany" }], "GB"), "United Kingdom");
  assert.equal(C.pickCountry([{ value: "826", text: "United Kingdom" }], "GB"), "826", "by name when the value is a number");
  assert.equal(C.pickCountry(countries, "Narnia"), null);

  assert.equal(C.brandOf(VISA)[0], "Visa");
  assert.equal(C.brandOf(MC)[0], "Mastercard");
  assert.equal(C.brandOf(AMEX)[0], "American Express");
  assert.deepEqual([...C.splitName("Alex Harlow")], ["Alex", "Harlow"]);
  assert.deepEqual([...C.splitName("Juno")], ["Juno", ""]);

  const card = { holder: "Alex Harlow", number: `${VISA.slice(0, 4)} ${VISA.slice(4)}`, expiry: "07/29", exp_month: "07", exp_year: "2029", cvv: CVV };
  const form = [
    { tag: "input", type: "text", key: "cc-given-name" }, { tag: "input", type: "text", key: "cc-family-name" },
    { tag: "input", type: "text", key: "cc-number" },
    { tag: "select", key: "cc-exp-month", options: months(n => [String(n), NAMES[n - 1]]) },
    { tag: "select", key: "cc-exp-year", options: years(false) },
    { tag: "input", type: "password", key: "cc-csc" },
    { tag: "select", key: "cc-type", options: [{ value: "", text: "Card" }, { value: "vi", text: "Visa" }, { value: "mc", text: "Mastercard" }] },
    { tag: "input", type: "text", key: "cc-number" },
    { tag: "input", type: "text", key: "postal-code" },
  ];
  assert.deepEqual(plain(C.plan(form, "card", card).map(s => [s.i, s.key, s.value])), [
    [0, "cc-given-name", "Alex"], [1, "cc-family-name", "Harlow"], [2, "cc-number", VISA], [3, "cc-exp-month", "7"],
    [4, "cc-exp-year", "29"], [5, "cc-csc", CVV], [6, "cc-type", "vi"],
  ], "one field per kind, and a card never fills an address field");
  const exp = (/** @type {any} */ d) => C.plan([{ tag: "input", type: "text", key: "cc-exp", ...d }], "card", card)[0].value;
  assert.equal(exp({}), "07/29");
  assert.equal(exp({ placeholder: "MM / YYYY" }), "07/2029");
  assert.equal(exp({ maxLength: 7 }), "07/2029");
  assert.equal(exp({ maxLength: 4 }), "0729");
  assert.equal(C.plan([{ tag: "input", type: "text", key: "cc-exp-year", maxLength: 2 }], "card", card)[0].value, "29");
  assert.equal(C.plan([{ tag: "input", type: "text", key: "cc-exp-year", placeholder: "YY" }], "card", card)[0].value, "29");
  assert.equal(C.plan([{ tag: "input", type: "text", key: "cc-exp-year" }], "card", card)[0].value, "2029");
  assert.deepEqual(plain(C.plan([{ tag: "select", key: "cc-exp-month", options: [{ value: "x", text: "Soon" }] }], "card", card)), [], "no matching option: left alone");

  const addr = { name: "Juno Harlow", company: "Harlow Legal", line1: "12 Quay Street", line2: "Suite 4", city: "Harlow", region: "Essex", postal: "CM20 1AA", country: "United Kingdom", email: "juno@harlow.test" };
  const aform = [
    { tag: "input", type: "text", key: "given-name" }, { tag: "input", type: "text", key: "organization" },
    { tag: "textarea", key: "street-address" }, { tag: "input", type: "text", key: "address-level2" },
    { tag: "select", key: "address-level1", options: [{ value: "", text: "County" }, { value: "ESS", text: "Essex" }, { value: "KEN", text: "Kent" }] },
    { tag: "select", key: "country", options: countries }, { tag: "input", type: "text", key: "postal-code" },
    { tag: "input", type: "tel", key: "tel" }, { tag: "input", type: "text", key: "cc-number" },
  ];
  assert.deepEqual(plain(C.plan(aform, "address", addr).map(s => [s.key, s.value])), [
    ["given-name", "Juno"], ["organization", "Harlow Legal"], ["street-address", "12 Quay Street\nSuite 4"], ["address-level2", "Harlow"],
    ["address-level1", "ESS"], ["country", "GB"], ["postal-code", "CM20 1AA"],
  ], "no phone stored, no phone filled; an address never fills a card field");
});

// ---- the worker -------------------------------------------------------------------------

async function setup(t) {
  const tmp = fs.mkdtempSync(path.join(SCRATCH, "vyre-ext-cards-"));
  const db = open(path.join(tmp, "vyre.db"));
  migrate(db, "vault", MIGRATIONS);
  const vault = new Vault({ db, dir: path.join(tmp, "vault"), config: { vault: { keystore: "file" } }, emit: () => {} });
  await vault.put({ name: "northwind-bakery-visa", kind: "card", description: "Northwind Bakery Visa", fields: { holder: "Alex Harlow", number: VISA, expiry: "07/2029", cvv: CVV } }, "cli");
  await vault.put({ name: "harlow-legal-office", kind: "address", description: "Harlow Legal office", fields: { name: "Juno Harlow", line1: "12 Quay Street", city: "Harlow", postal: "CM20 1AA", country: "GB" } }, "cli");
  let skew = 0;
  const fill = new Fill({ vault, now: () => Date.now() + skew });
  const srv = await serveFill({ host: "127.0.0.1", port: 0, fill });
  t.after(async () => { await srv.close(); db.close(); fs.rmSync(tmp, { recursive: true, force: true }); });
  const paired = (await (await fetch(`${srv.url}/v1/fill/pair`, { method: "POST", headers: { "content-type": "application/json", origin: `chrome-extension://${ID}` },
    body: JSON.stringify({ code: fill.code({ name: "vm browser" }).code }) })).json()).data;
  // Touch ID through the Capsule; the worker collects the session on its next status call.
  fill.unlockDevice({ device: paired.device });
  const local = { url: srv.url, device: paired.device, token: paired.token, deviceName: paired.name };
  const sess = {};
  const injected = [];
  let listener = null;
  const store = obj => ({
    get: async keys => Object.fromEntries(keys.filter(k => k in obj).map(k => [k, obj[k]])),
    set: async v => { Object.assign(obj, v); }, remove: async keys => { for (const k of keys) delete obj[k]; }, setAccessLevel: () => {},
  });
  let files = [];
  const chrome = {
    runtime: { id: ID, getURL: p => `chrome-extension://${ID}/${p}`, onMessage: { addListener: fn => { listener = fn; } } },
    storage: { local: store(local), session: store(sess) },
    tabs: { query: async () => [{ id: 9, url: "https://shop.northwind.test/checkout" }], onRemoved: { addListener: () => {} }, sendMessage: async () => {} },
    commands: { onCommand: { addListener: () => {} } },
    scripting: {
      executeScript: async ({ target, func, args, files: f }) => {
        if (f) { files = f; return []; }
        injected.push({ target: JSON.parse(JSON.stringify(target)), files: [...files], fn: args[0], arg: JSON.parse(JSON.stringify(args[1])) });
        return [{ result: { filled: ["cc-number"] } }];
      },
      getRegisteredContentScripts: async () => [], registerContentScripts: async () => {}, unregisterContentScripts: async () => {},
    },
    permissions: { contains: async () => true },
  };
  vm.runInNewContext(fs.readFileSync(path.join(HERE, "background.js"), "utf8"), { chrome, fetch, URL, Date, console, setTimeout, JSON });
  const send = (msg, sender) => new Promise(resolve => { listener(msg, sender, r => resolve(JSON.parse(JSON.stringify(r)))); });
  const page = (url, frameId = 0, tab = 7) => ({ id: ID, tab: { id: tab, url }, frameId, origin: new URL(url).origin, url });
  const popup = { id: ID, url: `chrome-extension://${ID}/popup.html` };
  // The popup's first look collects the Touch ID session.
  assert.equal((await send({ type: "state" }, popup)).data.unlocked, true);
  return { db, send, page, popup, injected, advance: ms => { skew += ms; } };
}

test("worker: cards and addresses listed and filled for the sender's page, never the message's", async t => {
  const { db, send, page, popup, injected } = await setup(t);
  const shop = page("https://shop.northwind.test/checkout");
  const list = await send({ type: "inline-cards" }, shop);
  assert.deepEqual(list.data, { cards: [{ name: "northwind-bakery-visa", description: "Northwind Bakery Visa" }], addresses: [{ name: "harlow-legal-office", description: "Harlow Legal office" }] });

  // The message names another origin; the worker ignores it and fills the sender's top frame.
  const f = await send({ type: "inline-card-fill", name: "northwind-bakery-visa", url: "https://evil.northwind.test", origin: "https://evil.northwind.test" }, shop);
  assert.deepEqual(f.data.filled, ["cc-number"]);
  assert.equal(injected.length, 1);
  assert.equal(injected[0].fn, "vyreFillCard");
  assert.deepEqual(injected[0].files, ["cards.js"]);
  assert.deepEqual(injected[0].target, { tabId: 7, frameIds: [0] });
  assert.deepEqual(injected[0].arg, { holder: "Alex Harlow", number: VISA, expiry: "07/29", exp_month: "07", exp_year: "2029", cvv: CVV, origin: "https://shop.northwind.test" });
  const audited = /** @type {any} */ (db.prepare("SELECT why FROM vault_audit WHERE action = 'fill-card' AND ok = 1").get());
  assert.equal(audited.why, "https://shop.northwind.test");

  const a = await send({ type: "inline-address-fill", name: "harlow-legal-office" }, page("https://order.harlow.test/ship", 0, 8));
  assert.equal(a.data.filled.length, 1);
  assert.equal(injected[1].fn, "vyreFillAddress");
  assert.equal(injected[1].arg.origin, "https://order.harlow.test");
  assert.equal(injected[1].arg.postal, "CM20 1AA");
  assert.deepEqual(injected[1].target, { tabId: 8, frameIds: [0] });

  // The popup fills the active tab.
  assert.equal((await send({ type: "cards" }, popup)).data.cards[0].name, "northwind-bakery-visa");
  await send({ type: "card-fill", name: "northwind-bakery-visa" }, popup);
  assert.equal(injected[2].arg.origin, "https://shop.northwind.test");
  assert.deepEqual(injected[2].target, { tabId: 9, frameIds: [0] });

  // A frame, another extension and a popup-only request from a page are refused, and fill nothing.
  for (const [msg, sender] of [
    [{ type: "inline-card-fill", name: "northwind-bakery-visa" }, page("https://shop.northwind.test/", 4)],
    [{ type: "inline-cards" }, { ...shop, id: "another-extension" }],
    [{ type: "card-fill", name: "northwind-bakery-visa" }, shop],
    [{ type: "address-fill", name: "harlow-legal-office" }, shop],
  ]) assert.equal((await send(msg, sender)).error.code, "refused", JSON.stringify(msg));
  assert.equal(injected.length, 3);
});

test("worker: a card past 60 seconds of its proof answers reprompt; an address still fills", async t => {
  const { send, page, injected, advance } = await setup(t);
  advance(61_000);
  const r = await send({ type: "inline-card-fill", name: "northwind-bakery-visa" }, page("https://shop.northwind.test/pay"));
  assert.deepEqual(r.error, { code: "reprompt", message: "This card asks every time. Unlock again from the toolbar button." });
  assert.equal(injected.length, 0);
  assert.equal((await send({ type: "inline-address-fill", name: "harlow-legal-office" }, page("https://shop.northwind.test/pay"))).data.filled.length, 1);
});

// ---- inline.js over a fake DOM -----------------------------------------------------------

class El {
  /** @param {string} tag */
  constructor(tag) { this.tagName = tag.toUpperCase(); this.children = []; this.listeners = {}; this.style = {}; this.textContent = ""; this.className = ""; this.connected = false; this.attrs = {}; }
  get isConnected() { return this.connected; }
  attachShadow(o) { assert.equal(o.mode, "closed"); this.shadow = new El("#shadow"); return this.shadow; }
  append(...c) { this.children.push(...c); }
  replaceChildren(...c) { this.children = [...c]; }
  remove() { this.connected = false; }
  addEventListener(t, fn) { (this.listeners[t] ||= []).push(fn); }
  getAttribute(n) { return this.attrs[n] ?? null; }
  getBoundingClientRect() { return { left: 10, bottom: 20, width: 100 }; }
  all() { return this.children.flatMap(c => [c, ...c.all()]); }
  click(isTrusted) { for (const fn of this.listeners.click || []) fn({ isTrusted, preventDefault() {}, stopPropagation() {} }); }
}
class HTMLInputElement extends El {
  constructor(attrs) { super("input"); Object.assign(this.attrs, attrs); this.type = attrs.type || "text"; this.name = attrs.name || ""; this.id = attrs.id || ""; this.autocomplete = attrs.autocomplete || ""; this.disabled = false; this.readOnly = false; this.maxLength = -1; this.labels = []; this.form = null; }
}
class HTMLSelectElement extends El {}
class HTMLTextAreaElement extends El {}
class HTMLFormElement extends El {}

function page(fields) {
  const sent = [];
  /** @type {Record<string, (m: any) => any>} */
  const answers = {
    "inline-pending": () => ({ data: { pending: null } }),
    "inline-cards": () => ({ data: { cards: [{ name: "northwind-bakery-visa", description: "Northwind Bakery Visa" }], addresses: [{ name: "harlow-legal-office", description: "Harlow Legal office" }] } }),
    "inline-card-fill": () => ({ error: { code: "reprompt", message: "This card asks every time. Unlock again from the toolbar button." } }),
    "inline-address-fill": () => ({ data: { filled: ["postal-code"] } }),
  };
  const docListeners = {};
  const hosts = [];
  const document = {
    createElement: t => { const e = new El(t); if (t.startsWith("vyre-")) hosts.push(e); return e; },
    documentElement: { append: e => { e.connected = true; } },
    addEventListener: (t, fn) => { (docListeners[t] ||= []).push(fn); },
    querySelector: () => null,
    querySelectorAll: () => fields,
    getElementById: () => null,
    activeElement: null,
  };
  const chrome = { runtime: { id: ID, lastError: undefined, onMessage: { addListener: () => {} },
    sendMessage: (m, cb) => { sent.push(m); const a = answers[m.type]; setTimeout(() => cb(a ? a(m) : { error: { code: "bad_message" } }), 0); } } };
  const win = { document, chrome, HTMLInputElement, HTMLSelectElement, HTMLTextAreaElement, HTMLFormElement, Element: El, scrollX: 0, scrollY: 0, setTimeout, Date, console };
  vm.createContext(win);
  const self = vm.runInContext("globalThis", win);
  win.window = self; win.top = self;
  vm.runInContext(CARDS_JS, win);
  vm.runInContext(INLINE_JS, win);
  const focus = (el, isTrusted) => { for (const fn of docListeners.focusin || []) fn({ isTrusted, target: el }); };
  const shown = () => { const h = hosts.find(x => x.isConnected); return h ? h.shadow.all() : []; };
  return { sent, focus, shown, self };
}
const tick = () => new Promise(r => setTimeout(r, 10));

test("inline: a payment field offers cards, an address form offers addresses, and only trusted events act", async () => {
  const number = new HTMLInputElement({ autocomplete: "cc-number", name: "cardnumber" });
  const zip = new HTMLInputElement({ name: "postcode" });
  const email = new HTMLInputElement({ type: "email", name: "newsletter" });
  const p = page([number, zip, email]);
  await tick();

  p.focus(number, false);
  await tick();
  assert.ok(!p.sent.some(m => m.type === "inline-cards"), "a script's focus does nothing");

  p.focus(number, true);
  await tick();
  const buttons = p.shown().filter(e => e.tagName === "BUTTON");
  assert.deepEqual(buttons.map(b => b.textContent), ["Fill card: Northwind Bakery Visa", "Close"]);
  buttons[0].click(false);
  await tick();
  assert.ok(!p.sent.some(m => m.type === "inline-card-fill"), "a synthetic click fills nothing");
  buttons[0].click(true);
  await tick();
  const asked = p.sent.find(m => m.type === "inline-card-fill");
  assert.deepEqual(JSON.parse(JSON.stringify(asked)), { type: "inline-card-fill", name: "northwind-bakery-visa" }, "a name only: no origin, no url");
  assert.ok(p.shown().some(e => e.textContent === "This card asks every time. Unlock again from the toolbar button."));

  p.focus(zip, true);
  await tick();
  const addr = p.shown().filter(e => e.tagName === "BUTTON");
  assert.equal(addr[0].textContent, "Fill address: Harlow Legal office");
  addr[0].click(true);
  await tick();
  assert.deepEqual(JSON.parse(JSON.stringify(p.sent.find(m => m.type === "inline-address-fill"))), { type: "inline-address-fill", name: "harlow-legal-office" });
  assert.equal(p.self.vyreCardAnchor, zip, "cards.js fills the form the person was in");

  // An email box on a page with no address form offers nothing.
  const lone = page([email]);
  await tick();
  lone.focus(email, true);
  await tick();
  assert.ok(!lone.sent.some(m => m.type === "inline-cards"));
});
