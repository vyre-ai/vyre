// @ts-check
// The /pair screen's pure parts (deck/views/pair.js): the one-time code as typed and as the box
// compares it, and every row's state from what the page knows. No DOM, no calls.

/** The one-time code as the box compares it: capitals, no dash or spaces, 8 characters; "" when
 * what was typed cannot be one. @param {string} s */
export function normalCode(s) {
  const c = String(s || "").toUpperCase().replace(/[\s-]/g, "");
  return /^[A-Z0-9]{8}$/.test(c) ? c : "";
}

/** The code as the laptop shows it, XXXX-XXXX, for as much as was typed. @param {string} s */
export function showCode(s) {
  const c = String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
  return c.length > 4 ? `${c.slice(0, 4)}-${c.slice(4)}` : c;
}

/**
 * @typedef {{ id: string, title: string, state: "todo" | "done" | "failed", reason?: string }} Step
 * @typedef {{ key?: { ok: boolean, on: boolean } | null, keyError?: string | null,
 *   push?: { ok: boolean, why?: string, on?: boolean, permission?: string } | null, pushError?: string | null,
 *   ios: boolean, standalone: boolean, https: boolean, delivered: boolean, denied?: string }} PairInput
 */

/**
 * Every row's state, from what this page knows. Pure.
 * @param {PairInput} i
 * @returns {{ passkey: Step, notify: Step, install: Step, checks: Step[] }}
 */
export function pairSteps(i) {
  /** @type {Step} */ let passkey;
  if (i.key?.on) passkey = { id: "passkey", title: "Passkey", state: "done" };
  else if (i.key && !i.key.ok) passkey = { id: "passkey", title: "Passkey", state: "failed", reason: "This browser cannot make a passkey. Open Vyre in Safari or Chrome." };
  else if (i.keyError) passkey = { id: "passkey", title: "Passkey", state: "failed", reason: i.keyError };
  else passkey = { id: "passkey", title: "Passkey", state: "todo" };

  /** @type {Step} */ let notify;
  const p = i.push;
  if (p?.on) notify = { id: "notify", title: "Notifications", state: "done" };
  else if (i.pushError) notify = { id: "notify", title: "Notifications", state: "failed", reason: i.pushError };
  else if (p && !p.ok && p.why === "install") notify = { id: "notify", title: "Notifications", state: "todo", reason: "Add Vyre to your Home Screen and open it from there first." };
  else if (p && !p.ok) notify = { id: "notify", title: "Notifications", state: "failed", reason: "This browser does not support push notifications." };
  else if (p?.permission === "denied") notify = { id: "notify", title: "Notifications", state: "failed", reason: i.denied || "Notifications are blocked for this site." };
  else notify = { id: "notify", title: "Notifications", state: "todo" };

  /** @type {Step} */ const install = i.standalone ? { id: "install", title: "Home Screen", state: "done" }
    : i.ios ? { id: "install", title: "Home Screen", state: "todo", reason: "Tap Share, then Add to Home Screen. Open Vyre from the Home Screen to finish." }
    : { id: "install", title: "Home Screen", state: "todo", reason: "Open your browser menu and choose Install app, or Add to Home screen." };

  /** @type {Step[]} */ const checks = [
    { id: "reached", title: "Reached the box", state: "done" },
    i.https ? { id: "https", title: "HTTPS", state: "done" }
      : { id: "https", title: "HTTPS", state: "failed", reason: "This page is not on https, so passkeys and notifications cannot work. Open the https address your laptop shows." },
    { id: "app", title: "Opened as an app", state: i.standalone ? "done" : "todo" },
    { id: "test", title: "Test notification arrived", state: i.delivered ? "done" : "todo" },
    { id: "key", title: "Face ID key saved", state: passkey.state === "done" ? "done" : "todo" },
  ];
  return { passkey, notify, install, checks };
}
