// @ts-check
// /pair: the phone's side of `vyre phone add --tailscale-only`. The laptop shows this box's
// address as a QR and a one-time code (presence.code); the phone opens the address here and
// finishes on one screen, each step a row with its state (to do, done, failed with a reason):
//
//   1. Passkey        the code, then phone-setup.js enrollPasskey (the one implementation)
//   2. Notifications  phone-setup.js subscribePush, which keeps the device id in
//                     localStorage "vyre.push.device" for push.seen and the test below
//   3. Home Screen    on iPhone: Share, then Add to Home Screen
//   4. The laptop's five checks, read-only: reached the box, HTTPS, opened as an app, test
//      notification arrived (push.delivered for this device), passkey saved
//
// Works the same on a desktop browser. Nothing polls: the checks move on the Deck's event stream
// (push.delivered, presence.enrolled, push.subscribed) and on this page's own actions.
// The pure parts (normalCode, showCode, pairSteps) are js/pair-steps.js, tested by deck/test/pair.test.js.

import { h, put } from "../js/dom.js";
import { enrollPasskey, passkeyState, pushState, subscribePush, deviceName, deniedHelp } from "../js/phone-setup.js";
import { standalone, ios } from "../js/pwa.js";
import { icon } from "../js/icons.js";
import { normalCode, showCode, pairSteps } from "../js/pair-steps.js";

const WORD = { todo: "to do", done: "done", failed: "failed" };
const DEVICE_KEY = "vyre.push.device";
const myDevice = () => { try { return window.localStorage.getItem(DEVICE_KEY); } catch { return null; } };
const plain = (/** @type {any} */ e) => (e?.missing ? `The ${e.module} module is not running on your server.` : String(e?.message || e));

/** @param {any} ctx */
export default async function pair(ctx) {
  /** @type {import("../js/pair-steps.js").PairInput} */
  const st = { key: null, keyError: null, push: null, pushError: null, ios: ios(), standalone: standalone(),
    https: location.protocol === "https:", delivered: false, denied: deniedHelp() };

  const codeIn = /** @type {HTMLInputElement} */ (h("input", { class: "input pp-code", id: "pp-code", autocomplete: "one-time-code", inputmode: "text",
    autocapitalize: "characters", spellcheck: "false", maxlength: "9", placeholder: "XXXX-XXXX", "aria-describedby": "pp-code-help" }));
  codeIn.addEventListener("blur", () => { codeIn.value = showCode(codeIn.value); });
  const keyStatus = h("p", { class: "small pp-status", role: "status" });
  const addKey = /** @type {HTMLButtonElement} */ (h("button", { type: "submit", class: "btn btn-primary" }, "Add passkey"));
  const keyForm = h("form", { class: "pp-form", onsubmit: (/** @type {Event} */ e) => {
    e.preventDefault();
    const code = normalCode(codeIn.value);
    if (!code) { put(keyStatus, "The code is 8 letters and numbers, as your laptop shows it."); codeIn.focus(); return; }
    addKey.disabled = true;
    st.keyError = null;
    put(keyStatus, "Waiting for your passkey.");
    // Straight from the submit: Safari makes a passkey only inside a user gesture.
    enrollPasskey({ name: deviceName(), code }).then(async () => {
      put(keyStatus, "");
      const k = await passkeyState();
      st.key = k.on ? k : { ...k, on: true };
      draw();
    }, e => { addKey.disabled = false; put(keyStatus, ""); st.keyError = plain(e); draw(); });
  } },
    h("label", { class: "small pp-label", for: "pp-code", id: "pp-code-help" }, "Type the code your laptop shows."),
    h("div", { class: "pp-form-row" }, codeIn, addKey), keyStatus);

  const pushStatus = h("p", { class: "small pp-status", role: "status" });
  const turnOn = /** @type {HTMLButtonElement} */ (h("button", { type: "button", class: "btn btn-primary" }, "Turn on"));
  // subscribePush asks for permission before anything is awaited, so it stays in this tap. It
  // keeps the device id it gets in localStorage "vyre.push.device" itself.
  turnOn.addEventListener("click", () => {
    turnOn.disabled = true;
    st.pushError = null;
    put(pushStatus, "Asking for permission.");
    return subscribePush(deviceName()).then(async () => {
      put(pushStatus, "");
      st.push = await pushState();
      turnOn.disabled = false;
      draw();
    }, async e => {
      turnOn.disabled = false;
      put(pushStatus, "");
      st.pushError = plain(e);
      st.push = await pushState();
      draw();
    });
  });

  const rows = { passkey: h("li", { class: "pp-step" }), notify: h("li", { class: "pp-step" }), install: h("li", { class: "pp-step" }) };
  const checkList = h("ul", { class: "pp-checks", "aria-label": "What your laptop checks" });

  /** @param {HTMLElement} el @param {import("../js/pair-steps.js").Step} s @param {any} [control] */
  const stepRow = (el, s, control) => {
    el.dataset.state = s.state;
    put(el,
      h("span", { class: "pp-dot", "aria-hidden": "true" }, s.state === "done" ? icon("check", 12) : null),
      h("div", { class: "pp-main" },
        h("div", { class: "pp-title" }, s.title, h("span", { class: "pp-word" }, WORD[s.state])),
        s.reason ? h("p", { class: "small muted pp-reason" }, s.reason) : null,
        s.state === "done" ? null : control));
  };

  const draw = () => {
    const s = pairSteps(st);
    stepRow(rows.passkey, s.passkey, s.passkey.state === "done" || (st.key && !st.key.ok) ? null : keyForm);
    stepRow(rows.notify, s.notify, st.push && st.push.ok && st.push.permission !== "denied" ? h("div", null, turnOn, pushStatus) : null);
    stepRow(rows.install, s.install, null);
    put(checkList, s.checks.map(c => h("li", { class: "pp-check", "data-state": c.state },
      h("span", { class: "pp-dot", "aria-hidden": "true" }, c.state === "done" ? icon("check", 10) : null),
      h("span", { class: "pp-check-t" }, c.title), h("span", { class: "pp-word" }, WORD[c.state]),
      c.reason ? h("p", { class: "small muted pp-reason" }, c.reason) : null)));
  };

  put(ctx.root, h("div", { class: "pp" },
    h("header", { class: "pp-head" },
      h("h1", { class: "h2" }, "Add this phone"),
      h("p", { class: "muted" }, "Finish here while your laptop watches. Each step turns to done on both screens.")),
    h("ol", { class: "pp-steps" }, rows.passkey, rows.notify, rows.install),
    h("section", { class: "pp-sec", "aria-labelledby": "pp-checks-h" },
      h("h2", { class: "lbl", id: "pp-checks-h" }, "Your laptop checks"),
      checkList)));
  draw();

  // The checks move on events, never a timer.
  ctx.on("push.delivered", (/** @type {any} */ e) => {
    const d = myDevice();
    if (d && e.payload?.device === d) { st.delivered = true; draw(); }
  });
  ctx.on("presence.enrolled", async () => { if (st.key?.on) return; st.key = await passkeyState(); if (ctx.alive()) draw(); });
  ctx.on("push.subscribed", async () => { st.push = await pushState(); if (ctx.alive()) draw(); });
  if (typeof matchMedia === "function") {
    const mq = matchMedia("(display-mode: standalone)");
    const moved = () => { st.standalone = standalone(); draw(); };
    mq.addEventListener?.("change", moved);
    ctx.cleanup(() => mq.removeEventListener?.("change", moved));
  }

  const [k, p] = await Promise.all([passkeyState(), pushState()]);
  if (!ctx.alive()) return;
  st.key = k; st.push = p;
  draw();
}

