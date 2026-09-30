// @ts-check
// fake-chrome: just enough of chrome.* and a fake page for the extension's tests, with no Chrome.
//
// createFakeChrome({tabs}) gives chrome.debugger / tabs / windows / storage / runtime / alarms with
// call counters (chrome.tabs.create is the one the reuse tests count). createFakePage(model)
// answers the CDP calls page.js makes: it recognises each in-page script by the /*vyre:kind {json}*/
// tag in front of it and applies it to a plain-object model, so the whole path from op to CDP
// runs, everything except the browser's own DOM.

/** @param {any[]} [seed] */
export function createFakeChrome(seed = []) {
  /** @type {any[]} */
  const tabs = seed.map((t, i) => ({ id: i + 1, windowId: 1, active: false, title: "", ...t }));
  let nextId = 100;
  const listeners = () => { const fns = new Set(); return { fns, addListener: (/** @type {any} */ f) => fns.add(f), removeListener: (/** @type {any} */ f) => fns.delete(f), fire: (/** @type {any[]} */ ...a) => { for (const f of [...fns]) f(...a); } }; };
  const counts = { create: 0, update: 0, remove: 0, attach: 0, detach: 0, sendCommand: 0, connectNative: 0 };
  /** @type {any[]} */ const commands = [];
  /** @type {any[]} */ const created = [];
  const attached = new Set();
  const store = { local: /** @type {Record<string, any>} */ ({}), session: /** @type {Record<string, any>} */ ({}) };
  /** @type {any[]} */ const ports = [];
  const onEvent = listeners(), onDetach = listeners(), onAlarm = listeners();

  /** @param {"local"|"session"} area */
  const area = a => ({
    async get(/** @type {any} */ keys) {
      if (keys == null) return { ...store[a] };
      const list = typeof keys === "string" ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
      return Object.fromEntries(list.filter(k => k in store[a]).map(k => [k, structuredClone(store[a][k])]));
    },
    async set(/** @type {any} */ o) { Object.assign(store[a], structuredClone(o)); },
  });

  const chrome = {
    _: { tabs, counts, commands, created, ports, store, attached, onEvent, onDetach, onAlarm, cdp: /** @type {(tabId: number, method: string, params: any) => any} */ (() => ({})) },
    debugger: {
      onEvent, onDetach,
      async attach(/** @type {any} */ t) {
        counts.attach++;
        if (attached.has(t.tabId)) throw new Error("Another debugger is already attached to the tab with id: " + t.tabId);
        attached.add(t.tabId);
      },
      async detach(/** @type {any} */ t) { counts.detach++; attached.delete(t.tabId); },
      async sendCommand(/** @type {any} */ t, /** @type {string} */ method, /** @type {any} */ params) {
        counts.sendCommand++;
        commands.push({ tabId: t.tabId, method, params });
        return chrome._.cdp(t.tabId, method, params);
      },
    },
    tabs: {
      async query(/** @type {any} */ q = {}) {
        return tabs.filter(t => (q.active === undefined || t.active === q.active) && (q.windowId === undefined || t.windowId === q.windowId)).map(t => ({ ...t }));
      },
      async get(/** @type {number} */ id) { const t = tabs.find(x => x.id === id); if (!t) throw new Error("No tab with id: " + id); return { ...t }; },
      async update(/** @type {number} */ id, /** @type {any} */ p) {
        counts.update++;
        const t = tabs.find(x => x.id === id);
        if (!t) throw new Error("No tab with id: " + id);
        if (p.active) for (const o of tabs) if (o.windowId === t.windowId) o.active = o.id === id;
        if (p.url) t.url = p.url;
        return { ...t };
      },
      async create(/** @type {any} */ p) {
        counts.create++;
        created.push(p);
        const t = { id: nextId++, windowId: 1, active: !!p.active, title: "", url: p.url };
        tabs.push(t);
        return { ...t };
      },
      async remove(/** @type {any} */ ids) { counts.remove++; for (const id of [].concat(ids)) { const i = tabs.findIndex(t => t.id === id); if (i >= 0) tabs.splice(i, 1); } },
    },
    windows: { async update() {} },
    storage: { local: area("local"), session: area("session") },
    alarms: { created: /** @type {any[]} */ ([]), create(/** @type {string} */ n, /** @type {any} */ i) { chrome.alarms.created.push({ n, i }); }, onAlarm },
    runtime: {
      id: undefined, lastError: undefined,
      getManifest: () => ({ version: "0.2.0" }),
      connectNative(/** @type {string} */ name) {
        counts.connectNative++;
        const onMessage = listeners(), onDisconnect = listeners();
        /** @type {any[]} */ const sent = [];
        let closed = false;
        const port = {
          name, sent, onMessage, onDisconnect,
          postMessage(/** @type {any} */ m) { if (closed) throw new Error("disconnected"); sent.push(structuredClone(m)); },
          disconnect() { closed = true; },
          /** the module sends this */ deliver(/** @type {any} */ m) { onMessage.fire(structuredClone(m)); },
          /** the host went away */ hostClose() { closed = true; onDisconnect.fire(); },
        };
        ports.push(port);
        return port;
      },
    },
  };
  return chrome;
}

/**
 * A fake page. model: {url, title, text, controls: [{path, role, name, enabled, value?, submit?, form?, inForm?, fields?, ...}]}
 * Mouse clicks are recorded in page.clicks; "apply" scripts set control values in the model.
 * @param {any} model
 */
export function createFakePage(model) {
  const page = {
    model, locateFail: 0, clicks: /** @type {any[]} */ ([]), keys: /** @type {any[]} */ ([]), applies: 0, evaluates: 0, covered: false,
    /** @param {number} tabId @param {string} method @param {any} params */
    handler(tabId, method, params) {
      if (method === "Input.dispatchMouseEvent") { if (params.type === "mousePressed") { page.clicks.push({ x: params.x, y: params.y }); if (page.onClick) page.onClick(params.x, params.y, model); } return {}; }
      if (method === "Input.dispatchKeyEvent") { page.keys.push(params); return {}; }
      if (method === "Page.captureScreenshot") return { data: Buffer.from("pixels-" + (params.format || "png")).toString("base64") };
      if (method !== "Runtime.evaluate") return {};
      page.evaluates++;
      const expr = String(params.expression);
      const m = /^\/\*vyre:(\w+) (.*?)\*\/\(\(\)/s.exec(expr);
      if (!m) return page.userEval ? page.userEval(expr) : { result: { type: "undefined" } };
      const kind = m[1];
      const args = JSON.parse(m[2]);
      const byPath = (/** @type {string} */ p) => model.controls.find((/** @type {any} */ c) => c.path === p);
      const val = (/** @type {any} */ v) => ({ result: { type: typeof v, value: v } });
      if (kind === "snapshot") {
        page.snapshots = (page.snapshots || 0) + 1;
        if (page.onSnapshot) page.onSnapshot(page.snapshots, model);
        return val(structuredClone({ title: model.title, url: model.url, text: model.text || "", controls: model.controls, ...(model.state ? { state: model.state } : {}) }));
      }
      if (kind === "dom") return val({ html: model.dom !== undefined ? model.dom : model.controls.map((/** @type {any} */ c) => `<${c.role}${c.identifier ? ` data-testid="${c.identifier}"` : ""}>${c.name || ""}</${c.role}>`).join("") });
      if (kind === "locate") {
        const c = byPath(args.path);
        if (page.locateFail > 0) { page.locateFail--; return val({ found: false }); }
        if (!c) return val({ found: false });
        return val({ found: true, x: c.frame.x + c.frame.w / 2, y: c.frame.y + c.frame.h / 2, hit: !page.covered, checked: !!c.checked });
      }
      if (kind === "apply") {
        page.applies++;
        return val(args.items.map((/** @type {any} */ it) => {
          const c = byPath(it.path);
          if (!c) return { ok: false, why: "the control is gone" };
          if (c.role === "checkbox") { c.checked = !(it.value === false || it.value === "false"); return { ok: true, checked: c.checked }; }
          c.value = String(it.value);
          if (c.formField) for (const o of model.controls) if (o.fields && o.form === c.form) o.fields[c.formField] = c.value;
          return { ok: true };
        }));
      }
      if (kind === "exists") return val(!!model.css && model.css.includes(args.css));
      if (kind === "href") return val(model.url);
      if (kind === "quiet") return val(page.quietMs ?? 10_000);
      return val(null);
    },
    /** @type {any} */ userEval: null,
    /** @type {number|undefined} */ quietMs: undefined,
  };
  return page;
}

/** A small GoHighLevel-shaped page: a contact form with a Save (safe) and a Send (submit) button. */
export function samplePage() {
  const frame = (/** @type {number} */ y) => ({ x: 10, y, w: 100, h: 20 });
  return {
    url: "https://app.northwind.example/contacts/new#top", title: "New contact", text: "Northwind Bakery contacts",
    controls: [
      { path: "input[0]", role: "textbox", name: "Full name", enabled: true, frame: frame(10), container: "contact", inForm: true, form: "contact", formField: "name" },
      { path: "input[1]", role: "textbox", name: "Email", enabled: true, frame: frame(40), container: "contact", inForm: true, form: "contact", formField: "email" },
      { path: "input[2]", role: "textbox", name: "Password", enabled: true, frame: frame(70), container: "contact", inForm: true, form: "contact", length: 8 },
      { path: "button[0]", role: "button", name: "Cancel", enabled: true, frame: frame(100) },
      { path: "button[1]", role: "button", name: "Save contact", enabled: true, frame: frame(130), container: "contact", inForm: true, form: "contact", submit: true, fields: { name: "Alex Harlow", email: "alex@harlow.example", password: "[secret]" } },
      { path: "button[2]", role: "button", name: "Send message", enabled: true, frame: frame(190) },
      { path: "a[0]", role: "link", name: "Back to list", enabled: true, frame: frame(160) },
    ],
  };
}
