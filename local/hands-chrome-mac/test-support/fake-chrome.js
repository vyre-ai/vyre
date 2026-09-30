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
  const tabs = seed.map((t, i) => ({ id: i + 1, windowId: 1, active: false, title: "", status: "complete", ...t }));
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
        commands.push({ tabId: t.tabId, method, params, ...(t.sessionId ? { sessionId: t.sessionId } : {}) });
        return chrome._.cdp(t.tabId, method, params, t.sessionId);
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
        const t = { id: nextId++, windowId: 1, active: !!p.active, title: "", url: p.url, status: "complete" };
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
 * A control's place on the page is its `box` {x,y,w,h} (or the older name for it, `frame`, which tests still use).
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
        const bb = c.box || c.frame;
        return val({ found: true, x: bb.x + bb.w / 2, y: bb.y + bb.h / 2, hit: !page.covered, checked: !!c.checked });
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

/**
 * A tab whose page has frames, for the frame tests. Sets chrome._.cdp to a router that behaves like Chrome's protocol as the extension
 * uses it: Page.getFrameTree answers the tree; Runtime.evaluate goes to the page of the frame whose session or execution context it
 * names (the top page otherwise) and fails like Chrome when a session is gone; DOM.getFrameOwner and DOM.getBoxModel answer where each
 * iframe sits in its parent; Input goes to the top session and is handed to the frame under that point, in that frame's own coordinates,
 * which is what Chrome does. Each frame has its own fake page (createFakePage), so a control lives in one frame.
 *
 * spec: { top: pageModel, frames: [{ id, parent?: id (default "TOP"), origin, url, box: {x,y,w,h} (in the parent's viewport),
 *         via?: "session" (default) | "context" | "none" (attached later / never), model?: pageModel }] }
 * Call `await attach(ctx)` once the ctx exists: it attaches the debugger and announces each frame's session or execution context
 * the way Chrome would. Later: addFrame(f), navigate(id, { id?, url?, origin?, model? }), removeFrame(id).
 * @param {any} chrome @param {any} spec @param {{ tab?: number, userEval?: (frameId: string, expr: string) => any }} [o]
 */
export function createFakeFrames(chrome, spec, o = {}) {
  const TAB = o.tab || 1;
  /** @type {Map<string, any>} */ const pages = new Map();
  /** @type {any[]} */ const frames = [];
  let ctxSeq = 900;
  const pageFor = (/** @type {string} */ id, /** @type {any} */ model) => { const p = createFakePage(model || { url: "about:blank", title: "", text: "", controls: [] }); p.userEval = (/** @type {string} */ e) => (o.userEval ? o.userEval(id, e) : { result: { type: "undefined" } }); return p; };
  pages.set("TOP", pageFor("TOP", spec.top));
  const add = (/** @type {any} */ f) => {
    const fr = { id: f.id, parent: f.parent || "TOP", origin: f.origin, url: f.url || f.origin + "/", box: f.box || { x: 0, y: 0, w: 100, h: 100 }, via: f.via || "session", session: /** @type {string|null} */ (null), ctxId: /** @type {number|null} */ (null) };
    pages.set(fr.id, pageFor(fr.id, f.model));
    frames.push(fr);
    return fr;
  };
  for (const f of spec.frames || []) add(f);

  const kids = (/** @type {string} */ id) => frames.filter(f => f.parent === id);
  /** The session that hosts a frame's document: its own if it is a cross-process frame (via "session"), else the nearest ancestor's, else the top page. */
  const host = (/** @type {any} */ f) => { for (let cur = f, g = 0; cur && g < 20; g++) { if (cur.via === "session") return cur.id; cur = frames.find(k => k.id === cur.parent); } return "TOP"; };
  // Chrome's Page.getFrameTree lists only the frames of ONE process: the top session's tree leaves a cross-origin iframe out, and each child session's tree is rooted at its own frame.
  const node = (/** @type {string} */ id, /** @type {any} */ f, /** @type {string} */ hostId) => ({ frame: { id, ...(f ? { parentId: f.parent, url: f.url, securityOrigin: f.origin } : { url: spec.top.url, securityOrigin: new URL(spec.top.url).origin }) }, childFrames: kids(id).filter(k => k.via !== "none" && host(k) === hostId).map(k => node(k.id, k, hostId)) });
  const tree = (/** @type {string|undefined} */ sessionId) => { if (!sessionId) return node("TOP", null, "TOP"); const r = frames.find(f => f.session === sessionId); return r ? node(r.id, r, r.id) : null; };
  const absolute = (/** @type {any} */ f) => { let x = 0, y = 0, cur = f; for (let g = 0; cur && g < 20; g++) { x += cur.box.x; y += cur.box.y; cur = frames.find(k => k.id === cur.parent); } return { x, y, w: f.box.w, h: f.box.h }; };
  const bySession = (/** @type {string} */ s) => frames.find(f => f.session === s);
  const byCtx = (/** @type {number} */ c) => frames.find(f => f.ctxId === c);
  const owner = (/** @type {string} */ id) => frames.findIndex(f => f.id === id) + 1000;

  const fire = (/** @type {any} */ source, /** @type {string} */ m, /** @type {any} */ p) => chrome._.onEvent.fire(source, m, p);
  const announce = (/** @type {any} */ f) => {
    if (f.via === "session") {
      f.session = "S-" + f.id;
      const parent = frames.find(k => k.id === f.parent);
      fire(parent && parent.session ? { tabId: TAB, sessionId: parent.session } : { tabId: TAB }, "Target.attachedToTarget", { sessionId: f.session, targetInfo: { targetId: f.id, type: "iframe", url: f.url }, waitingForDebugger: false });
    } else if (f.via === "context") {
      f.ctxId = ++ctxSeq;
      const hs = host(f);
      fire(hs === "TOP" ? { tabId: TAB } : { tabId: TAB, sessionId: "S-" + hs }, "Runtime.executionContextCreated", { context: { id: f.ctxId, auxData: { isDefault: true, frameId: f.id } } });
    }
  };
  const retract = (/** @type {any} */ f) => {
    if (f.session) fire({ tabId: TAB }, "Target.detachedFromTarget", { sessionId: f.session });
    if (f.ctxId) fire({ tabId: TAB }, "Runtime.executionContextDestroyed", { executionContextId: f.ctxId });
    f.session = null; f.ctxId = null;
  };

  const raw = { clicks: /** @type {any[]} */ ([]), keys: /** @type {any[]} */ ([]), mouse: /** @type {any[]} */ ([]) };
  chrome._.cdp = (/** @type {number} */ tabId, /** @type {string} */ method, /** @type {any} */ params, /** @type {string|undefined} */ sessionId) => {
    if (method === "Page.getFrameTree") { const t = tree(sessionId); if (!t) throw new Error("Session with given id not found."); return { frameTree: t }; }
    if (method === "Runtime.evaluate" && String(params.expression).includes("querySelectorAll('iframe, frame')")) {
      let id = "TOP";
      if (sessionId) { const f = bySession(sessionId); if (!f) throw new Error("Session with given id not found."); id = f.id; }
      else if (params.contextId !== undefined) { const f = byCtx(params.contextId); if (!f) throw new Error("Cannot find context with specified id"); id = f.id; }
      return { result: { value: kids(id).map(k => ({ src: k.url, origin: k.origin, sandbox: !!k.sandbox, w: k.box.w, h: k.box.h })) } };
    }
    if (method === "DOM.getFrameOwner") return { backendNodeId: owner(params.frameId) };
    if (method === "DOM.getBoxModel") { const f = frames[params.backendNodeId - 1000]; if (!f) throw new Error("Could not find node with given id"); const b = f.box; return { model: { content: [b.x, b.y, b.x + b.w, b.y, b.x + b.w, b.y + b.h, b.x, b.y + b.h] } }; }
    if (method === "Input.dispatchMouseEvent") {
      raw.mouse.push({ type: params.type, x: params.x, y: params.y, sessionId });
      // Measured in real Chrome (macOS, Windows, Linux): an event on a frame's own session lands in that frame at frame coordinates.
      if (sessionId) {
        const own = bySession(sessionId);
        if (!own) throw new Error("Session with given id not found.");
        if (params.type === "mousePressed") raw.clicks.push({ x: params.x, y: params.y, frame: own.id, sessionId });
        return pages.get(own.id).handler(tabId, method, params);
      }
      // Sent on the top session over a cross-process frame, it reaches nothing; over a same-process frame Chrome hands it to the frame under the point, in that frame's coordinates.
      let hit = null;
      for (const f of frames) { const a = absolute(f); if (f.session || f.ctxId) if (params.x >= a.x && params.x < a.x + a.w && params.y >= a.y && params.y < a.y + a.h && (!hit || absolute(hit).w * absolute(hit).h >= a.w * a.h)) hit = f; }
      if (params.type === "mousePressed") raw.clicks.push({ x: params.x, y: params.y, frame: hit ? (hit.session ? "DROPPED" : hit.id) : "TOP", sessionId });
      if (hit && hit.session) return {};
      if (hit) { const a = absolute(hit); return pages.get(hit.id).handler(tabId, method, { ...params, x: params.x - a.x, y: params.y - a.y }); }
      return pages.get("TOP").handler(tabId, method, params);
    }
    if (method === "Input.dispatchKeyEvent") { raw.keys.push({ ...params, sessionId }); const own = sessionId ? bySession(sessionId) : null; return pages.get(own ? own.id : "TOP").handler(tabId, method, params); }
    if (method === "Runtime.evaluate") {
      let id = "TOP";
      if (sessionId) { const f = bySession(sessionId); if (!f) throw new Error("Session with given id not found."); id = f.id; }
      else if (params.contextId !== undefined) { const f = byCtx(params.contextId); if (!f) throw new Error("Cannot find context with specified id"); id = f.id; }
      return pages.get(id).handler(tabId, method, params);
    }
    return pages.get("TOP").handler(tabId, method, params);
  };

  return {
    raw, pages, frames,
    page: (/** @type {string} */ id) => pages.get(id),
    /** The debugger on, then every frame announced. */
    async attach(/** @type {any} */ ctx) { await ctx.cdp.attach(TAB); for (const f of frames) announce(f); },
    addFrame(/** @type {any} */ f) { const fr = add(f); if (fr.via !== "none") announce(fr); return fr; },
    /** A frame navigates: Chrome gives the new document a new frame id and session. */
    navigate(/** @type {string} */ id, /** @type {any} */ to = {}) {
      const f = frames.find(k => k.id === id); if (!f) throw new Error("no frame " + id);
      retract(f);
      if (to.id && to.id !== id) { pages.set(to.id, pages.get(id)); pages.delete(id); for (const k of kids(id)) k.parent = to.id; f.id = to.id; }
      if (to.url) f.url = to.url; if (to.origin) f.origin = to.origin;
      if (to.model) pages.set(f.id, pageFor(f.id, to.model));
      announce(f);
      return f;
    },
    removeFrame(/** @type {string} */ id) { const i = frames.findIndex(k => k.id === id); if (i < 0) return; retract(frames[i]); frames.splice(i, 1); pages.delete(id); },
    /** Make a frame that was "none" readable, as when Chrome finally hands over its session. */
    ready(/** @type {string} */ id, /** @type {"session"|"context"} */ via = "session") { const f = frames.find(k => k.id === id); if (!f) return; f.via = via; announce(f); },
  };
}
