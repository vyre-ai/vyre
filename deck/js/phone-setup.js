// @ts-check
// Set up this phone: the three things that make the Deck work from a pocket, in order. Install
// it to the Home Screen, turn on notifications, add a passkey. Shown at the top of Now on a phone
// until all three are done or the user says "Not now".
//
// This file is also the one implementation of subscribing to push and enrolling a passkey:
// Settings uses subscribePush, unsubscribePush, pushState and enrollPasskey from here, so the
// card and the Settings sections can never disagree about what "on" means.
//
//   setupCard()              the card, or null (not a phone, dismissed)
//   pushState()              { ok, why?, permission, reg, sub, device, devices, error, on }
//   subscribePush(label)     call straight from a click; resolves { device }, throws plain words
//   unsubscribePush(...)     forget a device, and drop this browser's subscription if it is ours
//   enrollPasskey({name, code})  call straight from a click; resolves the enrolled key
//   passkeyState()           { ok, on, keys }
//   deviceName()             "iPhone", "Android phone", "This phone", ...
//   deniedHelp()             how to turn blocked notifications back on, for this device
//
// Nothing here polls. The card redraws on its own actions and on the browser's install events.

import { h, put } from "./dom.js";
import { attempt, canProve, callWithCode } from "./api.js";
import { standalone, ios } from "./pwa.js";
import { icon } from "./icons.js";

const phone = () => matchMedia("(max-width: 760px)").matches;
const android = () => /Android/.test(navigator.userAgent);
const store = (() => { try { return window.localStorage; } catch { return null; } })();
const get = (/** @type {string} */ k) => { try { return store?.getItem(k) ?? null; } catch { return null; } };
const set = (/** @type {string} */ k, /** @type {string | null} */ v) => { try { v === null ? store?.removeItem(k) : store?.setItem(k, v); } catch {} };

const DISMISS_KEY = "vyre.setup.dismissed";
/** push.devices never gives back an endpoint to match against, so this device's id is kept here,
 * set once from push.subscribe's own answer. */
const DEVICE_KEY = "vyre.push.device";
/** The passkey this browser enrolled: { id, name, at }. A hint only; presence.keys decides. */
const PASSKEY_KEY = "vyre.passkey";

/** What to call this device when it has no name of its own. */
export function deviceName() {
  if (/iPhone|iPod/.test(navigator.userAgent)) return "iPhone";
  if (ios()) return "iPad";
  if (android()) return phone() ? "Android phone" : "Android tablet";
  return phone() ? "This phone" : "This browser";
}

// ---- install ---------------------------------------------------------------------------------
// Chrome offers its install prompt once, early, as beforeinstallprompt. Keep it from showing its
// own mini bar and hold on to it for the card's Install button. Captured at module load; see the
// note in the handoff about importing this module from app.js so an early event is not missed.

/** @type {any} */ let installPrompt = null;
let installed = false;
const installListeners = new Set();
const installChanged = () => { for (const fn of installListeners) { try { fn(); } catch (e) { console.error(e); } } };
if (typeof window !== "undefined") {
  window.addEventListener("beforeinstallprompt", e => { e.preventDefault(); installPrompt = e; installChanged(); });
  window.addEventListener("appinstalled", () => { installed = true; installPrompt = null; installChanged(); });
}

// ---- push ------------------------------------------------------------------------------------

const pushSupported = () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
const myDevice = () => get(DEVICE_KEY);
const setMyDevice = (/** @type {string | null} */ id) => set(DEVICE_KEY, id || null);

/** base64url (as push.key gives it) to the raw bytes pushManager.subscribe wants. */
const b64 = (/** @type {string} */ s) => {
  const pad = "=".repeat((4 - (s.length % 4)) % 4);
  const raw = atob((s + pad).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, c => c.charCodeAt(0));
};
const sameBytes = (/** @type {ArrayBuffer | null | undefined} */ a, /** @type {Uint8Array} */ b) => {
  if (!a) return false;
  const x = new Uint8Array(a);
  return x.length === b.length && x.every((v, i) => v === b[i]);
};

/** How to turn notifications back on once they were refused, in this device's own words. */
export function deniedHelp() {
  if (ios()) return "Notifications are off for Vyre. Turn them on in Settings, Notifications, Vyre.";
  if (android() && standalone()) return "Notifications are off for Vyre. Turn them on in Settings, Apps, Vyre, Notifications.";
  return "Notifications are blocked for this site. Turn them on from the icon beside the address, under Notifications.";
}

/**
 * Where push stands on this device. `ok: false` with `why` ("install": iOS needs the Home Screen
 * app first; "unsupported") means there is nothing to switch. `sub` is the browser's own
 * subscription; `on` is true only when the box also knows this device.
 */
export async function pushState() {
  if (ios() && !standalone()) return { ok: false, why: "install" };
  if (!pushSupported()) return { ok: false, why: "unsupported" };
  const permission = Notification.permission;
  // getRegistration, not ready: ready never settles when no worker was registered.
  const reg = await navigator.serviceWorker.getRegistration().catch(() => undefined);
  const sub = reg ? await reg.pushManager.getSubscription().catch(() => null) : null;
  const d = await attempt("push.devices");
  const devices = /** @type {any[]} */ (Array.isArray(d.data) ? d.data : []);
  const device = myDevice();
  // Known to the box, or (when the box cannot be asked) as far as this browser can tell.
  const on = !!sub && !!device && (d.error ? true : devices.some(x => x.device === device));
  return { ok: true, permission, reg, sub, device, devices, error: d.error || null, on };
}

/**
 * Turn notifications on for this device. Call it directly from a click handler: iOS shows the
 * permission prompt only for a user gesture, so the prompt is the first thing this does, before
 * anything is awaited. Reuses a live subscription made with the box's current key.
 * @param {string} [label]
 * @returns {Promise<{ device: string | null }>}
 */
export async function subscribePush(label = deviceName()) {
  if (ios() && !standalone()) throw new Error("iOS only delivers notifications to the Home Screen app. Add Vyre to your Home Screen, open it from there, then turn them on.");
  if (!pushSupported()) throw new Error("This browser does not support push notifications.");
  const perm = await Notification.requestPermission();
  if (perm !== "granted") throw Object.assign(new Error(perm === "denied" ? deniedHelp() : "Notifications were not allowed."), { code: "not_allowed" });
  const key = await attempt("push.key");
  if (key.error) throw key.error;
  const server = b64(String(key.data?.public_key || ""));
  if (!(await navigator.serviceWorker.getRegistration().catch(() => undefined))) {
    throw new Error("The Deck's service worker is not running here, so this browser cannot get notifications. Reload the page and try again.");
  }
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription().catch(() => null);
  // A subscription made with an older key (a new Vault, a new box) can never be sent to: replace it.
  if (sub && !sameBytes(sub.options?.applicationServerKey, server)) { await sub.unsubscribe().catch(() => {}); sub = null; }
  const made = !sub;
  try { if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: server }); }
  catch (e) { throw new Error(`The browser did not subscribe: ${/** @type {any} */ (e)?.message || e}`); }
  const r = await attempt("push.subscribe", { subscription: sub.toJSON(), label });
  if (r.error) { if (made) sub.unsubscribe().catch(() => {}); throw r.error; }
  const device = r.data?.device || null;
  setMyDevice(device);
  return { device };
}

/**
 * Forget a device on the box: by its id, or by this browser's endpoint when the id was lost
 * (another tab, cleared storage). Drops this browser's own subscription when it is the one
 * forgotten. Throws the tool's error.
 * @param {{ device?: string | null, endpoint?: string, sub?: PushSubscription | null }} which
 */
export async function unsubscribePush({ device, endpoint, sub }) {
  const r = await attempt("push.unsubscribe", device ? { device } : { endpoint });
  if (r.error) throw r.error;
  const mine = myDevice();
  if (device && device === mine) setMyDevice(null);
  if (sub && ((device && device === mine) || endpoint === sub.endpoint)) await sub.unsubscribe().catch(() => {});
  if (!device && endpoint) setMyDevice(null);
  return r.data;
}

// ---- passkey (ADR 0004) ----------------------------------------------------------------------

/** WebAuthn's own base64url (api.js keeps its copy private). */
const b64url = (/** @type {ArrayBuffer} */ buf) => btoa(String.fromCharCode(.../** @type {any} */ (new Uint8Array(buf)))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/**
 * Add a passkey, with a one-time code from `vyre presence code` standing in for the proof there
 * is no passkey yet to make. Call it directly from a click handler: Safari makes a passkey only
 * for a user gesture, so the WebAuthn prompt comes before anything is awaited.
 * @param {{ name?: string, code: string }} input
 * @returns {Promise<{ id: string, kind: string, name: string, created: number }>}
 */
export async function enrollPasskey({ name, code }) {
  if (!canProve()) throw new Error("This browser cannot create a passkey. Open the Deck in Safari or Chrome over your tailnet.");
  const c = String(code || "").trim();
  if (!c) throw new Error("Type the code from vyre presence code first.");
  const label = String(name || "").trim() || deviceName();
  /** @type {any} */ let cred;
  try {
    cred = await navigator.credentials.create({ publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      rp: { name: "Vyre", id: location.hostname },
      user: { id: crypto.getRandomValues(new Uint8Array(16)), name: label, displayName: label },
      pubKeyCredParams: [{ type: "public-key", alg: -7 }, { type: "public-key", alg: -257 }],
      authenticatorSelection: { userVerification: "required" }, timeout: 60_000,
    } });
  } catch (e) {
    const x = /** @type {any} */ (e);
    throw new Error(x?.name === "NotAllowedError" ? "The passkey was cancelled or timed out." : `The passkey was not created: ${x?.message || x}`);
  }
  if (!cred) throw new Error("The passkey was cancelled.");
  const r = cred.response;
  const id = b64url(cred.rawId);
  const k = await callWithCode("presence.enroll", {
    kind: "passkey", name: label,
    public_key: b64url(r.getPublicKey()), alg: r.getPublicKeyAlgorithm(),
    rp_id: location.hostname, credential_id: id,
  }, c);
  set(PASSKEY_KEY, JSON.stringify({ id: k?.id || id, name: k?.name || label, at: Date.now() }));
  return k;
}

/**
 * Does this device have a passkey? Yes when the box lists the one this browser enrolled, or a
 * passkey named like this device (iOS keeps Safari's storage apart from the Home Screen app's, so
 * the name is how the app recognises a key made in Safari). When the box cannot be asked, the
 * local note is taken at its word.
 */
export async function passkeyState() {
  if (!canProve()) return { ok: false, on: false, keys: [] };
  /** @type {{ id?: string } | null} */ let mine = null;
  try { mine = JSON.parse(get(PASSKEY_KEY) || "null"); } catch {}
  const r = await attempt("presence.keys");
  if (r.error) return { ok: true, on: !!mine, keys: [], error: r.error };
  const keys = /** @type {any[]} */ (Array.isArray(r.data) ? r.data : []).filter(k => k.kind === "passkey");
  const name = deviceName();
  const on = keys.some(k => (mine && k.id === mine.id) || k.name === name);
  if (mine && !keys.some(k => k.id === mine?.id)) set(PASSKEY_KEY, null); // removed on the box
  return { ok: true, on, keys };
}

// ---- the card --------------------------------------------------------------------------------

const NS = "http://www.w3.org/2000/svg";
/** iOS's Share glyph: a tray with an arrow out of it. */
function shareGlyph() {
  const svg = document.createElementNS(NS, "svg");
  for (const [k, v] of Object.entries({ width: "15", height: "15", viewBox: "0 0 24 24", fill: "none", "aria-hidden": "true", class: "ps-share" })) svg.setAttribute(k, v);
  for (const d of ["M8.5 9.5H7A1.5 1.5 0 0 0 5.5 11v8.5A1.5 1.5 0 0 0 7 21h10a1.5 1.5 0 0 0 1.5-1.5V11A1.5 1.5 0 0 0 17 9.5h-1.5", "M12 14V3M8.5 6.5L12 3l3.5 3.5"]) {
    const p = document.createElementNS(NS, "path");
    for (const [k, v] of Object.entries({ d, stroke: "currentColor", "stroke-width": "1.8", "stroke-linecap": "round", "stroke-linejoin": "round" })) p.setAttribute(k, v);
    svg.append(p);
  }
  return svg;
}

/** The card's stylesheet, added once, the same way app.js adds a view's. */
function style() {
  const href = "/css/views/phone-setup.css";
  if (document.head.querySelector(`link[href="${href}"]`)) return;
  document.head.append(h("link", { rel: "stylesheet", href }));
}

const plain = (/** @type {any} */ e) => (e?.missing ? `The ${e.module} module is not running, so this cannot be done here yet.` : String(e?.message || e));

/**
 * The "Set up this phone" card, or null when this is not a phone or the user said "Not now".
 * It starts hidden and shows itself once it knows a step is left; when every step is done it
 * removes itself.
 * @returns {HTMLElement | null}
 */
export function setupCard() {
  if (!phone() || get(DISMISS_KEY)) return null;
  style();
  const steps = h("ol", { class: "ps-steps" });
  const card = h("section", { class: "ps-card", "aria-labelledby": "ps-h", hidden: true },
    h("div", { class: "ps-top" },
      h("h2", { id: "ps-h", class: "ps-title" }, "Set up this phone"),
      h("button", { type: "button", class: "btn btn-ghost btn-sm", onclick: () => { set(DISMISS_KEY, String(Date.now())); stop(); card.remove(); } }, "Not now")),
    h("p", { class: "small muted ps-lede" }, "Three steps, then Vyre can reach you and you can answer from here."),
    steps);

  /** @type {{ push: any, key: any }} */
  const st = { push: null, key: null };
  let enrolling = false;
  const installRow = h("li", { class: "ps-step" });
  const pushRow = h("li", { class: "ps-step" });
  const keyRow = h("li", { class: "ps-step" });
  put(steps, installRow, pushRow, keyRow);

  const isInstalled = () => standalone() || installed;

  /** One step: a dot for its state, what it is, why, and one control. */
  const stepBody = (/** @type {HTMLElement} */ el, /** @type {"done"|"todo"|"blocked"} */ state, /** @type {string} */ title, /** @type {any[]} */ lines, /** @type {any} */ control) => {
    el.dataset.state = state;
    put(el,
      h("span", { class: "ps-dot", "aria-hidden": "true" }, state === "done" ? icon("check", 12) : null),
      h("div", { class: "ps-main" },
        h("div", { class: "ps-step-title" }, title, h("span", { class: "ps-sr" }, state === "done" ? " (done)" : state === "blocked" ? " (not yet possible)" : "")),
        lines),
      control ? h("div", { class: "ps-act" }, control) : null);
  };
  const line = (/** @type {any[]} */ ...s) => h("p", { class: "small muted ps-line" }, s);
  const status = () => h("p", { class: "small ps-status", role: "status" });

  const drawInstall = () => {
    if (isInstalled()) {
      stepBody(installRow, "done", "Install", [line(standalone() ? "Running from your Home Screen." : "Installed. Open Vyre from your Home Screen.")], null);
      return;
    }
    if (ios()) {
      stepBody(installRow, "todo", "Install", [line("Add Vyre to your Home Screen: tap Share ", shareGlyph(), ", then Add to Home Screen.")], null);
      return;
    }
    if (installPrompt) {
      const s = status();
      const btn = /** @type {HTMLButtonElement} */ (h("button", { type: "button", class: "btn btn-sm btn-primary", onclick: async () => {
        const p = installPrompt;
        if (!p) return;
        btn.disabled = true;
        try {
          p.prompt();
          const choice = await p.userChoice;
          installPrompt = null; // a prompt can be shown once
          if (choice?.outcome === "accepted") installed = true;
          else put(s, "Not installed. Your browser menu has Install app when you want it.");
        } catch (e) { put(s, plain(e)); }
        drawInstall(); settle();
      } }, "Install"));
      stepBody(installRow, "todo", "Install", [line("Puts Vyre on your Home Screen, full screen, like an app."), s], btn);
      return;
    }
    stepBody(installRow, "todo", "Install", [line("Open your browser menu and choose Install app, or Add to Home screen.")], null);
  };

  const WHAT = "Only that something needs you, never what: asks and held drafts.";
  const drawPush = () => {
    const p = st.push;
    if (!p) { stepBody(pushRow, "todo", "Notifications", [line("Checking.")], null); return; }
    if (!p.ok && p.why === "install") { stepBody(pushRow, "blocked", "Notifications", [line("Needs the Home Screen app first (iOS 16.4 or later)."), line(WHAT)], null); return; }
    if (!p.ok) { stepBody(pushRow, "blocked", "Notifications", [line("This browser does not support push notifications.")], null); return; }
    if (p.on) { stepBody(pushRow, "done", "Notifications", [line(WHAT)], null); return; }
    if (p.permission === "denied") { stepBody(pushRow, "blocked", "Notifications", [line(WHAT), line(deniedHelp())], null); return; }
    const s = status();
    const btn = /** @type {HTMLButtonElement} */ (h("button", { type: "button", class: "btn btn-sm btn-primary" }, "Turn on"));
    // requestPermission runs inside subscribePush before anything is awaited, so it stays in
    // this click's user gesture.
    btn.addEventListener("click", () => {
      btn.disabled = true;
      put(s, "Asking for permission.");
      subscribePush(deviceName()).then(
        async () => { st.push = await pushState(); drawPush(); settle(); },
        async e => { put(s, plain(e)); btn.disabled = false; if (Notification.permission === "denied") { st.push = await pushState(); drawPush(); } });
    });
    stepBody(pushRow, "todo", "Notifications", [line(WHAT), s], btn);
  };

  const drawKey = () => {
    const k = st.key;
    const WHY = "Approve sends and answer asks with Face ID.";
    if (!k) { stepBody(keyRow, "todo", "Passkey", [line("Checking.")], null); return; }
    if (!k.ok) { stepBody(keyRow, "blocked", "Passkey", [line("This browser cannot make a passkey. Open Vyre in Safari or Chrome.")], null); return; }
    if (k.on) { stepBody(keyRow, "done", "Passkey", [line(WHY)], null); return; }
    if (!enrolling) {
      stepBody(keyRow, "todo", "Passkey", [line(WHY)],
        h("button", { type: "button", class: "btn btn-sm btn-primary", onclick: () => { enrolling = true; drawKey(); } }, "Add"));
      return;
    }
    const s = status();
    const codeIn = /** @type {HTMLInputElement} */ (h("input", { class: "input", id: "ps-code", autocomplete: "one-time-code", spellcheck: "false",
      autocapitalize: "off", placeholder: "the code" }));
    const nameIn = /** @type {HTMLInputElement} */ (h("input", { class: "input", id: "ps-name", autocomplete: "off", value: deviceName() }));
    const add = /** @type {HTMLButtonElement} */ (h("button", { type: "submit", class: "btn btn-sm btn-primary" }, "Add passkey"));
    const form = h("form", { class: "ps-form", onsubmit: (/** @type {Event} */ e) => {
      e.preventDefault();
      if (!codeIn.value.trim()) { put(s, "Type the code first."); codeIn.focus(); return; }
      add.disabled = true;
      put(s, "Waiting for your passkey.");
      // Called in the submit's own gesture: Safari makes a passkey only for one.
      enrollPasskey({ name: nameIn.value, code: codeIn.value }).then(
        async () => { enrolling = false; st.key = await passkeyState(); if (!st.key.on) st.key = { ...st.key, on: true }; drawKey(); settle(); },
        e2 => { add.disabled = false; put(s, plain(e2)); });
    } },
      h("label", { class: "small ps-label", for: "ps-code" }, "Run ", h("code", null, "vyre presence code"), " on your Mac and type the code here."),
      codeIn,
      h("label", { class: "small ps-label", for: "ps-name" }, "Name this phone"),
      nameIn,
      h("div", { class: "ps-form-act" }, add, h("button", { type: "button", class: "btn btn-ghost btn-sm", onclick: () => { enrolling = false; drawKey(); } }, "Cancel")),
      s);
    stepBody(keyRow, "todo", "Passkey", [line(WHY), form], null);
    codeIn.focus();
  };

  /** Show the card while a step is left; take it away when none is. */
  const settle = () => {
    if (!st.push || !st.key) return;
    const pushDone = st.push.on || (!st.push.ok && st.push.why === "unsupported");
    const keyDone = st.key.on || !st.key.ok;
    if (isInstalled() && pushDone && keyDone) { stop(); card.remove(); return; }
    card.hidden = false;
  };

  // The card goes when Now is left; the next install event notices and lets go of it.
  const onInstall = () => { if (!card.isConnected) { stop(); return; } drawInstall(); settle(); };
  installListeners.add(onInstall);
  const stop = () => installListeners.delete(onInstall);

  drawInstall(); drawPush(); drawKey();
  Promise.all([pushState(), passkeyState()]).then(([p, k]) => {
    st.push = p; st.key = k;
    drawPush(); drawKey(); settle();
  });
  return card;
}
