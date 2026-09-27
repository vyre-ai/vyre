// The app as an installed web app, served by the box at /app/ (the pwa writes /app/sw.js and the
// manifest). Three things, all wired once at launch by startPwa():
//   - the service worker at /app/sw.js, scope /app/ (not on a localhost dev server, which has no box)
//   - the worker's {type: "vyre:navigate", path} messages (a tapped notification) routed in the app
//   - push.seen {surface: "app", visible, standalone}: at launch, on show and hide (keepalive), and
//     on the first input after a quiet minute, as the Deck's pwa.js does, so the box holds back a
//     push that would only repeat what is on screen
// Notifications are turned on only from a tap (enablePush, the Now control), never on load; the
// steps are the Deck's phone-setup.js subscribePush: permission, push.key, subscribe, push.subscribe.

import { beacon, call } from "../api/box";
import { fromB64url } from "../auth/person";
import { APP_BASE, navigateTarget, seenReporter } from "./model";
import type { PushStatus } from "./pwa.d";

const SW = `${APP_BASE}/sw.js`;
const SCOPE = `${APP_BASE}/`;
/** push.devices gives back no endpoint, so this device's id is kept from push.subscribe's answer. */
const DEVICE = "vyre.push.device";

const standalone = () =>
  (navigator as { standalone?: boolean }).standalone === true || matchMedia("(display-mode: standalone)").matches;
const ios = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.userAgent.includes("Macintosh") && navigator.maxTouchPoints > 1);
const supported = () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
const devServer = () => __DEV__ && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);

const store = {
  get: (k: string) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set: (k: string, v: string) => {
    try {
      localStorage.setItem(k, v);
    } catch {}
  },
};

export function startPwa(navigate: (path: string) => void): () => void {
  const off: (() => void)[] = [];
  if ("serviceWorker" in navigator && !devServer()) {
    navigator.serviceWorker.register(SW, { scope: SCOPE }).catch(() => {});
    const onMessage = (e: MessageEvent) => {
      const to = navigateTarget(e.data);
      if (to) navigate(to);
    };
    navigator.serviceWorker.addEventListener("message", onMessage);
    off.push(() => navigator.serviceWorker.removeEventListener("message", onMessage));
  }

  // A hint, never shown: a box without push.seen, or out of reach, is fine.
  const seen = seenReporter((visible) => {
    const input = { surface: "app", visible, standalone: standalone() };
    if (visible) void call("push.seen", input).catch(() => {});
    else void beacon("push.seen", input);
  });
  const visible = () => document.visibilityState === "visible";
  if (visible()) seen.shown();
  const onVisibility = () => (visible() ? seen.shown() : seen.hidden());
  const onInput = () => seen.input(visible());
  document.addEventListener("visibilitychange", onVisibility);
  addEventListener("pointerdown", onInput, { passive: true, capture: true });
  addEventListener("keydown", onInput, { passive: true, capture: true });
  off.push(() => {
    document.removeEventListener("visibilitychange", onVisibility);
    removeEventListener("pointerdown", onInput, { capture: true });
    removeEventListener("keydown", onInput, { capture: true });
  });
  return () => off.forEach((f) => f());
}

const registration = () => navigator.serviceWorker.getRegistration(SCOPE).catch(() => undefined);

const sameKey = (a: ArrayBuffer | null | undefined, b: Uint8Array) => {
  if (!a) return false;
  const x = new Uint8Array(a);
  return x.length === b.length && x.every((v, i) => v === b[i]);
};

export async function pushStatus(): Promise<PushStatus> {
  if (ios() && !standalone()) return "install";
  if (!supported()) return "unsupported";
  if (Notification.permission === "denied") return "denied";
  if (Notification.permission !== "granted" || !store.get(DEVICE)) return "off";
  const reg = await registration();
  const sub = reg ? await reg.pushManager.getSubscription().catch(() => null) : null;
  return sub ? "on" : "off";
}

export async function enablePush(): Promise<void> {
  if (ios() && !standalone()) throw new Error("iOS only delivers notifications to the Home Screen app. Add Vyre to your Home Screen, open it from there, then turn them on.");
  if (!supported()) throw new Error("This browser does not support push notifications.");
  // First, before anything is awaited: iOS shows the prompt only inside the tap.
  const perm = await Notification.requestPermission();
  if (perm !== "granted") throw new Error(perm === "denied" ? "Notifications are blocked for this site. Turn them on in the browser's site settings." : "Notifications were not allowed.");
  const key = await call<{ public_key?: string }>("push.key");
  if (key.error) throw new Error(key.error.message);
  const server = fromB64url(String(key.data?.public_key ?? ""));
  if (!(await registration())) throw new Error("The app's service worker is not running here, so this browser cannot get notifications. Reload and try again.");
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription().catch(() => null);
  // A subscription made with an older key (a new Vault, a new box) can never be sent to: replace it.
  if (sub && !sameKey(sub.options?.applicationServerKey, server)) {
    await sub.unsubscribe().catch(() => {});
    sub = null;
  }
  const made = !sub;
  try {
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: server as BufferSource });
  } catch (e) {
    throw new Error(`The browser did not subscribe: ${e instanceof Error ? e.message : String(e)}`);
  }
  const label = `Vyre on ${/iPhone/.test(navigator.userAgent) ? "iPhone" : /Android/.test(navigator.userAgent) ? "Android" : "this browser"}`;
  const r = await call<{ device?: string }>("push.subscribe", { subscription: sub.toJSON(), label });
  if (r.error) {
    if (made) void sub.unsubscribe().catch(() => {});
    throw new Error(r.error.message);
  }
  if (r.data?.device) store.set(DEVICE, r.data.device);
}
