// @ts-check
// background: the only part of the extension that talks to vyred.
//
// Why it is built this way:
//   - One address. Every request goes to the vyred fill URL the person configured, and the
//     manifest's connect-src and host permissions allow nothing else, so a bug here cannot send
//     anything to a third party.
//   - The device token is long lived and reveals no value on its own, so it sits in
//     chrome.storage.local. The session token opens values, so it lives only in memory and in
//     chrome.storage.session (memory, cleared when the browser closes, closed to content
//     scripts). It never touches storage.local.
//   - The popup never sees a password. It asks for a fill by name; this worker fetches the login
//     and hands it straight to the content script in the active tab's top frame.
//   - Only the page's origin is sent to vyred, never its path, query or content.
//   - inline.js (opt-in, or once per keyboard fill) may ask for names, a fill, a code or a save
//     for its own page only; which page is the browser's word (sender), never the message's.

/* global chrome, browser */

// Chrome, Arc, Edge and Brave give `chrome`; Firefox gives `browser` (and a `chrome` alias). Every
// call below is on `ext` and every one of them exists in both with promises, so one source runs in
// both. Firefox has no storage.session.setAccessLevel (its session storage is closed to content
// scripts already), so that call is guarded.
const ext = /** @type {typeof chrome} */ (/** @type {any} */ (globalThis).browser ?? /** @type {any} */ (globalThis).chrome);

const DEFAULT_URL = "http://127.0.0.1:7788";
/** @type {{ session: string, expires: number } | null} */
let mem = null;

try {
  const set = ext.storage.session.setAccessLevel;
  if (typeof set === "function") Promise.resolve(set.call(ext.storage.session, { accessLevel: "TRUSTED_CONTEXTS" })).catch(() => {});
} catch { /* older Chrome: already the default; Firefox: has no such call */ }

/** The addresses the manifest's CSP lets this worker reach. Anything else is refused up front. */
function allowedUrl(u) {
  let x;
  try { x = new URL(String(u)); } catch { return null; }
  if (x.username || x.password || x.search || x.hash) return null;
  const local = x.protocol === "http:" && (x.hostname === "127.0.0.1" || x.hostname === "localhost");
  // A Vyre's own address (<you>.vyre.run) or its raw tailnet name; both resolve only inside the tailnet.
  const tailnet = x.protocol === "https:" && /\.(vyre\.run|ts\.net)$/.test(x.hostname);
  return local || tailnet ? x.origin : null;
}

async function settings() {
  const s = await ext.storage.local.get(["url", "device", "token", "deviceName"]);
  return { url: s.url || DEFAULT_URL, device: s.device || null, token: s.token || null, deviceName: s.deviceName || null };
}

async function getSession() {
  if (mem && mem.expires > Date.now()) return mem;
  const s = await ext.storage.session.get(["session", "expires"]);
  mem = s.session && s.expires > Date.now() ? { session: s.session, expires: s.expires } : null;
  return mem;
}

async function setSession(session, expires) {
  mem = session ? { session, expires } : null;
  if (session) await ext.storage.session.set({ session, expires });
  else await ext.storage.session.remove(["session", "expires"]);
}

/**
 * One call to the fill listener. Returns `{data}` or `{error:{code,message}}`, never throws.
 * @param {"GET"|"POST"} method @param {string} route @param {any} [body] @param {{ session?: boolean }} [o]
 */
async function api(method, route, body, { session = false } = {}) {
  const s = await settings();
  const base = allowedUrl(s.url);
  if (!base) return { error: { code: "bad_url", message: "the vyred address is not one this extension may reach" } };
  /** @type {Record<string,string>} */
  const headers = {};
  if (body) headers["content-type"] = "application/json";
  if (s.token && route !== "pair") headers.authorization = `Bearer ${s.token}`;
  if (session) { const x = await getSession(); if (x) headers["x-vyre-session"] = x.session; }
  let res;
  try {
    res = await fetch(`${base}/v1/fill/${route}`, { method, headers, body: body ? JSON.stringify(body) : undefined,
      credentials: "omit", redirect: "error", cache: "no-store", referrerPolicy: "no-referrer" });
  } catch {
    return { error: { code: "unreachable", message: `vyred did not answer at ${base}` } };
  }
  let out;
  try { out = await res.json(); } catch { return { error: { code: "bad_response", message: "vyred answered with something that is not JSON" } }; }
  if (out && out.error) {
    if (out.error.code === "session_expired" || out.error.code === "session_required") await setSession(null);
    if (out.error.code === "revoked" || out.error.code === "unauthorized") { await setSession(null); await ext.storage.local.remove(["device", "token", "deviceName"]); }
  }
  return out;
}

/** The active tab and its origin, which activeTab grants once the person clicks the action. */
async function activeTab() {
  const [tab] = await ext.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id || !tab.url) return null;
  let o = null;
  try { const u = new URL(tab.url); if (u.protocol === "https:" || u.protocol === "http:") o = u.origin; } catch { /* not a web page */ }
  return o ? { id: tab.id, origin: o } : null;
}

async function state() {
  const s = await settings();
  const tab = await activeTab();
  const base = { url: s.url, paired: Boolean(s.token), deviceName: s.deviceName, origin: tab ? tab.origin : null };
  if (!s.token) return { data: { ...base, unlocked: false } };
  const st = await api("GET", "status", null, { session: true });
  if (st.error) return { data: { ...base, paired: Boolean((await settings()).token), unlocked: false, problem: st.error.message } };
  // A session opened by Touch ID arrives here once; keep it the same way as a typed unlock.
  if (st.data.session) await setSession(st.data.session, st.data.expires);
  else if (!st.data.unlocked) await setSession(null);
  return { data: { ...base, unlocked: st.data.unlocked, expires: st.data.expires || null, canUnlock: st.data.canUnlock } };
}

/** Run fill.js in a tab's top frame and call one of its functions with `arg`. */
async function inject(tabId, fn, arg) {
  await ext.scripting.executeScript({ target: { tabId, frameIds: [0] }, files: ["fill.js"] });
  const [res] = await ext.scripting.executeScript({
    target: { tabId, frameIds: [0] },
    func: (f, c) => /** @type {any} */ (globalThis)[f](c),
    args: [fn, arg],
  });
  return res && res.result ? res.result : { filled: [] };
}

/** Fill a login into a tab whose origin the caller has already worked out (never from a page's say-so). */
async function fillInto(tab, name) {
  const r = await api("POST", "fill", { name, url: tab.origin }, { session: true });
  if (r.error) return r;
  /** @type {any} */
  let creds = { origin: tab.origin, username: r.data.username, password: r.data.password, totp: r.data.totp || "" };
  r.data = null;
  try {
    const out = await inject(tab.id, "vyreFill", creds);
    return { data: { filled: out.filled || [], why: out.why || null } };
  } catch {
    return { error: { code: "inject_failed", message: "could not fill this page" } };
  } finally {
    creds = null;
  }
}

async function otpInto(tab, name) {
  const r = await api("POST", "otp", { name, url: tab.origin }, { session: true });
  if (r.error) return r;
  try {
    const out = await inject(tab.id, "vyreFillOtp", { origin: tab.origin, code: r.data.code });
    return { data: { filled: out.filled || [], why: out.why || null } };
  } catch {
    return { error: { code: "inject_failed", message: "could not fill this page" } };
  }
}

async function fill(name) {
  const tab = await activeTab();
  if (!tab) return { error: { code: "no_page", message: "this tab is not a web page" } };
  return fillInto(tab, name);
}

// ---- in-page suggestions, one-time codes and save on submit (inline.js) -------------------

const INLINE_ID = "vyre-inline";
const PAGES = ["https://*/*", "http://*/*"];
const PENDING_MS = 2 * 60_000;
/** A login typed into a page, waiting for the person's Save. Memory only, per tab. @type {Map<number, any>} */
const pending = new Map();

async function inlineOn() {
  try { return (await ext.scripting.getRegisteredContentScripts({ ids: [INLINE_ID] })).length > 0; } catch { return false; }
}

async function setInline(on) {
  if (on) {
    if (!(await ext.permissions.contains({ origins: PAGES }))) return { error: { code: "no_permission", message: "the browser did not allow suggestions on pages" } };
    if (!(await inlineOn())) await ext.scripting.registerContentScripts([{ id: INLINE_ID, matches: PAGES, js: ["inline.js"], runAt: "document_idle", allFrames: false, persistAcrossSessions: true }]);
  } else if (await inlineOn()) {
    await ext.scripting.unregisterContentScripts({ ids: [INLINE_ID] });
  }
  return { data: { inline: await inlineOn() } };
}

/** The page a content script speaks for: its tab and its top frame's origin, from the browser, not from the message. */
function pageOf(sender) {
  if (!sender.tab || typeof sender.tab.id !== "number" || sender.frameId !== 0) return null;
  let o = null;
  try { const u = new URL(sender.origin || sender.url || ""); if (u.protocol === "https:" || u.protocol === "http:") o = u.origin; } catch { /* not a web page */ }
  return o ? { id: sender.tab.id, origin: o } : null;
}

/** @param {any} msg @param {{ id: number, origin: string }} page */
async function inline(msg, page) {
  switch (msg.type) {
    case "inline-match": {
      if (!(await getSession())) return { error: { code: "locked", message: "Vyre is locked" } };
      const r = await api("POST", "match", { url: page.origin });
      return r.error ? r : { data: { logins: r.data.logins.map(l => ({ name: l.name })) } };
    }
    case "inline-fill": return fillInto(page, String(msg.name || ""));
    case "inline-otp": return otpInto(page, String(msg.name || ""));
    case "inline-offer-save": {
      if (typeof msg.password !== "string" || !msg.password || msg.password.length > 4096) return { data: { held: false } };
      pending.set(page.id, { origin: page.origin, username: typeof msg.username === "string" ? msg.username.slice(0, 1024) : "", password: msg.password, change: Boolean(msg.change), at: Date.now() });
      return { data: { held: true } };
    }
    case "inline-pending": {
      const p = pending.get(page.id);
      if (!p || Date.now() - p.at > PENDING_MS) { pending.delete(page.id); return { data: { pending: null } }; }
      // A login typed on one site is never offered on another the tab went to next.
      if (p.origin !== page.origin) return { data: { pending: null } };
      if (!(await getSession())) return { data: { pending: null } };
      return { data: { pending: { host: new URL(p.origin).host, username: p.username, change: p.change } } };
    }
    case "inline-save": {
      const p = pending.get(page.id);
      pending.delete(page.id);
      if (!p || p.origin !== page.origin || Date.now() - p.at > PENDING_MS) return { error: { code: "expired", message: "nothing to save any more" } };
      const r = await api("POST", "save", { url: p.origin, username: p.username, password: p.password }, { session: true });
      p.password = null;
      return r;
    }
    case "inline-dismiss": pending.delete(page.id); return { data: { dismissed: true } };
    default: return { error: { code: "bad_message", message: "unknown request" } };
  }
}

ext.tabs.onRemoved.addListener(id => { pending.delete(id); });

// The keyboard fill: one login fills at once; several open the chooser on the page.
ext.commands.onCommand.addListener(async command => {
  if (command !== "fill-login") return;
  const tab = await activeTab();
  if (!tab) return;
  const m = await api("POST", "match", { url: tab.origin });
  if (m.error || !m.data.logins.length) return;
  if (m.data.logins.length === 1) { await fillInto(tab, m.data.logins[0].name); return; }
  try {
    await ext.scripting.executeScript({ target: { tabId: tab.id, frameIds: [0] }, files: ["inline.js"] });
    await ext.tabs.sendMessage(tab.id, { type: "show-chooser" }, { frameId: 0 });
  } catch { /* a page the browser does not let extensions touch */ }
});

/** @param {any} msg */
async function route(msg) {
  switch (msg && msg.type) {
    case "state": return state();
    case "save-url": {
      const o = allowedUrl(msg.url);
      if (!o) return { error: { code: "bad_url", message: "use http://127.0.0.1:<port>, http://localhost:<port> or your https://<you>.vyre.run address" } };
      const old = await settings();
      await ext.storage.local.set({ url: o });
      if (old.url !== o) { await setSession(null); await ext.storage.local.remove(["device", "token", "deviceName"]); }
      return { data: { url: o } };
    }
    case "pair": {
      const r = await api("POST", "pair", { code: String(msg.code || ""), name: String(msg.name || "browser").slice(0, 64) });
      if (r.error) return r;
      await ext.storage.local.set({ device: r.data.device, token: r.data.token, deviceName: r.data.name });
      return { data: { device: r.data.device, name: r.data.name } };
    }
    case "unlock": {
      const r = await api("POST", "unlock", { passphrase: String(msg.passphrase || "") });
      if (r.error) return r;
      await setSession(r.data.session, r.data.expires);
      return { data: { expires: r.data.expires } };
    }
    case "lock": {
      const r = await api("POST", "lock", {});
      await setSession(null);
      return r.error ? r : { data: { locked: true } };
    }
    case "match": {
      const tab = await activeTab();
      if (!tab) return { data: { origin: null, logins: [] } };
      return api("POST", "match", { url: tab.origin });
    }
    case "fill": return fill(String(msg.name || ""));
    case "inline-state": return { data: { inline: await inlineOn() } };
    case "inline-enable": return setInline(true);
    case "inline-disable": return setInline(false);
    case "forget": {
      await setSession(null);
      await ext.storage.local.remove(["device", "token", "deviceName"]);
      return { data: { forgotten: true } };
    }
    default: return { error: { code: "bad_message", message: "unknown request" } };
  }
}

const INLINE_TYPES = ["inline-match", "inline-fill", "inline-otp", "inline-offer-save", "inline-pending", "inline-save", "inline-dismiss"];

ext.runtime.onMessage.addListener((msg, sender, reply) => {
  const failed = () => reply({ error: { code: "internal", message: "the extension failed" } });
  // The popup may ask for anything. Our own content script (inline.js, top frame only) may ask
  // for the inline requests, each for the page the browser says it is on. inline.js acts only
  // on trusted clicks, and a page's own scripts cannot reach chrome.runtime at all.
  const fromPopup = sender.id === ext.runtime.id && !sender.tab && typeof sender.url === "string" && sender.url.startsWith(ext.runtime.getURL("popup.html"));
  if (fromPopup) { route(msg).then(reply, failed); return true; }
  const page = sender.id === ext.runtime.id ? pageOf(sender) : null;
  if (page && msg && INLINE_TYPES.includes(msg.type)) { inline(msg, page).then(reply, failed); return true; }
  reply({ error: { code: "refused", message: "not from the popup" } });
  return false;
});
