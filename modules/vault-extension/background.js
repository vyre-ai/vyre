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

/* global chrome */

const DEFAULT_URL = "http://127.0.0.1:7788";
/** @type {{ session: string, expires: number } | null} */
let mem = null;

try { chrome.storage.session.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" }); } catch { /* older Chrome: already the default */ }

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
  const s = await chrome.storage.local.get(["url", "device", "token", "deviceName"]);
  return { url: s.url || DEFAULT_URL, device: s.device || null, token: s.token || null, deviceName: s.deviceName || null };
}

async function getSession() {
  if (mem && mem.expires > Date.now()) return mem;
  const s = await chrome.storage.session.get(["session", "expires"]);
  mem = s.session && s.expires > Date.now() ? { session: s.session, expires: s.expires } : null;
  return mem;
}

async function setSession(session, expires) {
  mem = session ? { session, expires } : null;
  if (session) await chrome.storage.session.set({ session, expires });
  else await chrome.storage.session.remove(["session", "expires"]);
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
    if (out.error.code === "revoked" || out.error.code === "unauthorized") { await setSession(null); await chrome.storage.local.remove(["device", "token", "deviceName"]); }
  }
  return out;
}

/** The active tab and its origin, which activeTab grants once the person clicks the action. */
async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
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

async function fill(name) {
  const tab = await activeTab();
  if (!tab) return { error: { code: "no_page", message: "this tab is not a web page" } };
  const r = await api("POST", "fill", { name, url: tab.origin }, { session: true });
  if (r.error) return r;
  /** @type {any} */
  let creds = { origin: tab.origin, username: r.data.username, password: r.data.password, totp: r.data.totp || "" };
  r.data = null;
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id, frameIds: [0] }, files: ["fill.js"] });
    const [res] = await chrome.scripting.executeScript({
      target: { tabId: tab.id, frameIds: [0] },
      func: c => /** @type {any} */ (globalThis).vyreFill(c),
      args: [creds],
    });
    const out = res && res.result ? res.result : { filled: [] };
    return { data: { filled: out.filled || [], why: out.why || null } };
  } catch {
    return { error: { code: "inject_failed", message: "could not fill this page" } };
  } finally {
    creds = null;
  }
}

/** @param {any} msg */
async function route(msg) {
  switch (msg && msg.type) {
    case "state": return state();
    case "save-url": {
      const o = allowedUrl(msg.url);
      if (!o) return { error: { code: "bad_url", message: "use http://127.0.0.1:<port>, http://localhost:<port> or your https://<you>.vyre.run address" } };
      const old = await settings();
      await chrome.storage.local.set({ url: o });
      if (old.url !== o) { await setSession(null); await chrome.storage.local.remove(["device", "token", "deviceName"]); }
      return { data: { url: o } };
    }
    case "pair": {
      const r = await api("POST", "pair", { code: String(msg.code || ""), name: String(msg.name || "browser").slice(0, 64) });
      if (r.error) return r;
      await chrome.storage.local.set({ device: r.data.device, token: r.data.token, deviceName: r.data.name });
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
    case "forget": {
      await setSession(null);
      await chrome.storage.local.remove(["device", "token", "deviceName"]);
      return { data: { forgotten: true } };
    }
    default: return { error: { code: "bad_message", message: "unknown request" } };
  }
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  // Only this extension's own popup may ask. Content scripts run in pages, and a page is exactly
  // what must never drive a fill.
  const fromPopup = sender.id === chrome.runtime.id && !sender.tab && typeof sender.url === "string" && sender.url.startsWith(chrome.runtime.getURL("popup.html"));
  if (!fromPopup) { reply({ error: { code: "refused", message: "not from the popup" } }); return false; }
  route(msg).then(reply, () => reply({ error: { code: "internal", message: "the extension failed" } }));
  return true;
});
