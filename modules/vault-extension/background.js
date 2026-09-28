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
//   - Cards and addresses are not tied to a site: inline.js and the popup may list them anywhere
//     and fill one into their own page's top frame (cards.js), again for the sender's origin.
//   - passkey-bridge.js (on by default once paired and allowed on pages) may ask for this site's
//     passkey names, a new passkey or a sign-in, from any frame. The origin vyred signs for is
//     the frame's, from the sender; a framed request says so (crossOrigin, topOrigin from the
//     tab). When vyred cannot take it (not paired, not reachable), the answer is { fallback }
//     and the browser's own authenticator does the job.

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
    if (out.error.code === "revoked" || out.error.code === "unauthorized") { await setSession(null); await ext.storage.local.remove(["device", "token", "deviceName"]); await syncPasskeys(); }
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

/** Run fill.js (or cards.js) in a tab's top frame and call one of its functions with `arg`. */
async function inject(tabId, fn, arg, file = "fill.js") {
  await ext.scripting.executeScript({ target: { tabId, frameIds: [0] }, files: [file] });
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

/** The words a person sees when a card asks for a fresh proof. */
const REPROMPT = "This card asks every time. Unlock again from the toolbar button.";

/**
 * Fill a card or an address into a tab's top frame, for the origin the caller worked out (the
 * sender's or the active tab's). The values go from vyred to cards.js and are dropped here.
 * @param {{ id: number, origin: string }} tab @param {"card"|"address"} kind @param {string} name
 */
async function cardInto(tab, kind, name) {
  const r = await api("POST", kind === "card" ? "card.fill" : "address.fill", { name, url: tab.origin }, { session: true });
  if (r.error) return r.error.code === "reprompt" ? { error: { code: "reprompt", message: REPROMPT } } : r;
  /** @type {any} */
  let values = { ...r.data, origin: tab.origin };
  r.data = null;
  try {
    const out = await inject(tab.id, kind === "card" ? "vyreFillCard" : "vyreFillAddress", values, "cards.js");
    return { data: { filled: out.filled || [], why: out.why || null } };
  } catch {
    return { error: { code: "inject_failed", message: "could not fill this page" } };
  } finally {
    values = null;
  }
}

/** Cards and addresses, names and descriptions only; the same list on every page. @param {string|null} origin */
async function cardList(origin) {
  const r = await api("POST", "cards", { url: origin || "" });
  if (r.error) return r;
  const pick = (/** @type {any} */ x) => (Array.isArray(x) ? x : []).map(c => ({ name: String(c.name), description: String(c.description || "") }));
  return { data: { cards: pick(r.data.cards), addresses: pick(r.data.addresses) } };
}

async function fill(name) {
  const tab = await activeTab();
  if (!tab) return { error: { code: "no_page", message: "this tab is not a web page" } };
  return fillInto(tab, name);
}

// ---- in-page suggestions, one-time codes and save on submit (inline.js) -------------------

const INLINE_ID = "vyre-inline";
/** What the suggestions script is: cards.js first, so inline.js can tell a card field from a login field. */
const INLINE_JS = ["cards.js", "inline.js"];
const PAGES = ["https://*/*", "http://*/*"];
const PENDING_MS = 2 * 60_000;
/** A login typed into a page, waiting for the person's Save. Memory only, per tab. @type {Map<number, any>} */
const pending = new Map();

async function inlineOn() {
  try { return (await ext.scripting.getRegisteredContentScripts({ ids: [INLINE_ID] })).length > 0; } catch { return false; }
}

/** A registration from before cards.js existed is replaced by the current one. */
async function inlineCurrent() {
  try {
    const [r] = await ext.scripting.getRegisteredContentScripts({ ids: [INLINE_ID] });
    if (!r || JSON.stringify(r.js || []) === JSON.stringify(INLINE_JS)) return;
    await ext.scripting.unregisterContentScripts({ ids: [INLINE_ID] });
    await ext.scripting.registerContentScripts([{ id: INLINE_ID, matches: PAGES, js: INLINE_JS, runAt: "document_idle", allFrames: false, persistAcrossSessions: true }]);
  } catch { /* the old one keeps offering logins */ }
}

async function setInline(on) {
  if (on) {
    if (!(await ext.permissions.contains({ origins: PAGES }))) return { error: { code: "no_permission", message: "the browser did not allow suggestions on pages" } };
    if (!(await inlineOn())) await ext.scripting.registerContentScripts([{ id: INLINE_ID, matches: PAGES, js: INLINE_JS, runAt: "document_idle", allFrames: false, persistAcrossSessions: true }]);
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

// ---- passkeys (passkey-page.js in the page's world, passkey-bridge.js beside it) ----------

const PASSKEY_IDS = ["vyre-passkey-page", "vyre-passkey-bridge"];
const PASSKEY_TYPES = ["passkey-list", "passkey-create", "passkey-get"];
/** Answers that mean vyred cannot take a passkey request, so the browser's own authenticator should. */
const FALLBACK_CODES = ["unreachable", "bad_url", "bad_response", "not_found", "revoked", "unauthorized"];

/** Which of the two passkey scripts are registered now. @returns {Promise<string[]>} */
async function passkeyIds() {
  try { return (await ext.scripting.getRegisteredContentScripts({ ids: PASSKEY_IDS })).map(x => x.id).filter(id => PASSKEY_IDS.includes(id)); } catch { return []; }
}
const passkeysOn = async () => (await passkeyIds()).length === PASSKEY_IDS.length;

/** The person's choice; on unless they turned it off. */
async function passkeysWanted() { return (await ext.storage.local.get(["passkeys"])).passkeys !== false; }

/** Firefox runs a registered script in the page's world from 128 on; before that, no passkeys. */
async function mainWorldOk() {
  const info = /** @type {any} */ (ext.runtime).getBrowserInfo;
  if (typeof info !== "function") return true;
  try { const b = await info.call(ext.runtime); return b.name !== "Firefox" || parseInt(String(b.version), 10) >= 128; } catch { return false; }
}

const passkeyScripts = (/** @type {boolean} */ fallbackKey) => [
  // The page's world, every frame, before the page's own scripts. matchOriginAsFallback false:
  // about:blank and data: frames are left to the browser.
  { id: PASSKEY_IDS[0], matches: PAGES, js: ["passkey-page.js"], runAt: "document_start", allFrames: true, persistAcrossSessions: true,
    world: "MAIN", ...(fallbackKey ? { matchOriginAsFallback: false } : {}) },
  { id: PASSKEY_IDS[1], matches: PAGES, js: ["passkey-bridge.js"], runAt: "document_start", allFrames: true, persistAcrossSessions: true },
];

/**
 * Register the passkey scripts when they should run (paired, wanted, allowed on pages, a browser
 * that can run a script in the page's world) and unregister them otherwise. Never throws.
 * @returns {Promise<{ passkeys: boolean, wanted: boolean, supported: boolean }>}
 */
async function syncPasskeys() {
  const wanted = await passkeysWanted();
  const supported = await mainWorldOk();
  try {
    const s = await settings();
    const want = Boolean(s.token) && wanted && supported && (await ext.permissions.contains({ origins: PAGES }));
    const present = await passkeyIds();
    // Both or neither: a half-registered pair (a failed register) is cleared first.
    if (present.length && (!want || present.length < PASSKEY_IDS.length)) await ext.scripting.unregisterContentScripts({ ids: present });
    if (want && present.length < PASSKEY_IDS.length) {
      // Chrome before 119 has no matchOriginAsFallback on registered scripts: try once without it.
      try { await ext.scripting.registerContentScripts(passkeyScripts(true)); }
      catch { await ext.scripting.registerContentScripts(passkeyScripts(false)); }
    }
  } catch { /* a browser that will not register them: passkeys stay the browser's own */ }
  return { passkeys: await passkeysOn(), wanted, supported };
}

/** @param {unknown} u */
function webOrigin(u) {
  try { const x = new URL(String(u || "")); return x.protocol === "https:" || x.protocol === "http:" ? x.origin : null; } catch { return null; }
}

/**
 * The frame a passkey request comes from, in the browser's words: its tab, its own origin (the
 * one vyred signs for) and the tab's top origin. Any frame, unlike pageOf.
 */
function frameOf(sender) {
  if (!sender.tab || typeof sender.tab.id !== "number" || typeof sender.frameId !== "number") return null;
  const origin = webOrigin(sender.origin || sender.url);
  if (!origin) return null;
  const top = sender.frameId === 0 ? origin : webOrigin(sender.tab.url);
  if (!top) return null;
  return { id: sender.tab.id, origin, top, frameId: sender.frameId };
}

const b64uList = (/** @type {any} */ x) => (Array.isArray(x) ? x : []).map(c => c && c.id).filter(id => typeof id === "string");

/** @param {any} msg @param {{ id: number, origin: string, top: string, frameId: number }} frame */
async function passkey(msg, frame) {
  const s = await settings();
  if (!s.token || !(await passkeysWanted())) return { fallback: true };
  const o = msg.options && typeof msg.options === "object" ? msg.options : {};
  const create = msg.type === "passkey-create";
  const rp = create ? o.rp && o.rp.id : o.rpId;
  /** @type {Record<string, any>} */
  const body = { url: frame.origin, ...(typeof rp === "string" && rp ? { rpId: rp } : {}) };
  if (msg.type === "passkey-list") {
    const r = await api("POST", "passkeys", body);
    if (r.error) return FALLBACK_CODES.includes(r.error.code) ? { fallback: true } : r;
    const allow = b64uList(o.allowCredentials);
    const keys = (r.data.passkeys || []).filter(p => !allow.length || allow.includes(p.id));
    return { data: { passkeys: keys.map(p => ({ id: p.id, name: p.name, description: p.description })) } };
  }
  // Framed by another origin: the clientData says so, and names the top.
  const crossOrigin = frame.frameId !== 0 && frame.origin !== frame.top;
  Object.assign(body, { challenge: o.challenge, crossOrigin, ...(crossOrigin ? { topOrigin: frame.top } : {}) });
  if (create) {
    const u = o.user && typeof o.user === "object" ? o.user : {};
    Object.assign(body, {
      user: { id: u.id, name: u.name, displayName: u.displayName },
      algs: (Array.isArray(o.pubKeyCredParams) ? o.pubKeyCredParams : []).map(p => p && p.alg).filter(Number.isInteger),
      exclude: b64uList(o.excludeCredentials),
    });
  } else {
    Object.assign(body, { allow: b64uList(o.allowCredentials), ...(typeof msg.id === "string" ? { id: msg.id } : {}) });
  }
  const r = await api("POST", create ? "passkey.create" : "passkey.get", body, { session: true });
  if (r.error && FALLBACK_CODES.includes(r.error.code)) return { fallback: true };
  return r;
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
    case "inline-cards": {
      if (!(await getSession())) return { error: { code: "locked", message: "Vyre is locked" } };
      return cardList(page.origin);
    }
    case "inline-card-fill": return cardInto(page, "card", String(msg.name || ""));
    case "inline-address-fill": return cardInto(page, "address", String(msg.name || ""));
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
    await ext.scripting.executeScript({ target: { tabId: tab.id, frameIds: [0] }, files: INLINE_JS });
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
      await syncPasskeys();
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
    case "cards": { const tab = await activeTab(); return cardList(tab ? tab.origin : null); }
    case "card-fill": case "address-fill": {
      const tab = await activeTab();
      if (!tab) return { error: { code: "no_page", message: "this tab is not a web page" } };
      return cardInto(tab, msg.type === "card-fill" ? "card" : "address", String(msg.name || ""));
    }
    case "inline-state": return { data: { inline: await inlineOn() } };
    case "inline-enable": { const r = await setInline(true); await syncPasskeys(); return r; }
    case "inline-disable": return setInline(false);
    case "passkeys-state": return { data: await syncPasskeys() };
    case "passkeys-enable": {
      if (!(await ext.permissions.contains({ origins: PAGES }))) return { error: { code: "no_permission", message: "the browser did not allow passkeys on pages" } };
      await ext.storage.local.set({ passkeys: true });
      const r = await syncPasskeys();
      return r.passkeys ? { data: r } : { error: { code: "unsupported", message: r.supported ? "the browser would not load the passkey scripts" : "passkeys need Firefox 128 or later" } };
    }
    case "passkeys-disable": await ext.storage.local.set({ passkeys: false }); return { data: await syncPasskeys() };
    case "forget": {
      await setSession(null);
      await ext.storage.local.remove(["device", "token", "deviceName"]);
      await syncPasskeys();
      return { data: { forgotten: true } };
    }
    default: return { error: { code: "bad_message", message: "unknown request" } };
  }
}

const INLINE_TYPES = ["inline-match", "inline-fill", "inline-otp", "inline-offer-save", "inline-pending", "inline-save", "inline-dismiss",
  "inline-cards", "inline-card-fill", "inline-address-fill"];

ext.runtime.onMessage.addListener((msg, sender, reply) => {
  const failed = () => reply({ error: { code: "internal", message: "the extension failed" } });
  // The popup may ask for anything. Our own content script (inline.js, top frame only) may ask
  // for the inline requests, each for the page the browser says it is on. inline.js acts only
  // on trusted clicks, and a page's own scripts cannot reach chrome.runtime at all.
  const fromPopup = sender.id === ext.runtime.id && !sender.tab && typeof sender.url === "string" && sender.url.startsWith(ext.runtime.getURL("popup.html"));
  // Passkey requests come from a page's frame only, never the popup: the origin they sign for
  // is the sender's, and the popup has none.
  if (msg && PASSKEY_TYPES.includes(msg.type)) {
    const frame = sender.id === ext.runtime.id && !fromPopup ? frameOf(sender) : null;
    if (!frame) { reply({ error: { code: "refused", message: "passkey requests come from a page" } }); return false; }
    passkey(msg, frame).then(reply, failed);
    return true;
  }
  if (fromPopup) { route(msg).then(reply, failed); return true; }
  const page = sender.id === ext.runtime.id ? pageOf(sender) : null;
  if (page && msg && INLINE_TYPES.includes(msg.type)) { inline(msg, page).then(reply, failed); return true; }
  reply({ error: { code: "refused", message: "not from the popup" } });
  return false;
});

// Registered scripts outlive the worker; bring them in line with pairing and page access on start
// and whenever page access changes.
syncPasskeys();
inlineCurrent();
for (const ev of ["onAdded", "onRemoved"]) {
  const e = /** @type {any} */ (ext.permissions)[ev];
  if (e && typeof e.addListener === "function") e.addListener(() => { syncPasskeys(); });
}
