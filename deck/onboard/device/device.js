// @ts-check
// The phone's sign-in page (ADR 0015 section 3). The Vyre app opens it in the system's
// authentication browser, so the passkey ceremony runs at the box's own origin, against the
// passkeys the Deck enrolled. It enrolls the phone's device key with that proof and hands the key
// id back to the app at vyre://enrolled. If the box has no passkey yet, a one-time code from
// `vyre presence code` stands in for it, as on the first-passkey page. A standalone page, like
// /onboard/passkey: one ceremony, then back to the app.

import { h, put } from "../../js/dom.js";
import { call, canProve, callWithCode } from "../../js/api.js";
import { mark, wordmark } from "../../js/icons.js";
import { parseLink, enrollInput, returnUrl } from "./link.js";

const root = /** @type {HTMLElement} */ (document.getElementById("dv"));

// The key rides in the hash, never a path or query a proxy might log, and leaves the address bar at once.
const link = parseLink(location.hash);
history.replaceState(null, "", location.pathname);

/** Back to the app. Only ever vyre://enrolled, built in link.js. */
const back = params => { location.href = returnUrl(params); };

function shell(...kids) {
  put(root, h("header", { class: "ob-top" }, h("span", { class: "brand" }, mark(20), wordmark(22))),
    h("div", { class: "ob-body" }, h("main", { class: "ob-main" }, h("div", { class: "ob-col" }, ...kids))));
}

function badLink(reason) {
  shell(
    h("div", { class: "lbl" }, "Sign in"),
    h("h1", { class: "h1" }, "This link did not come from the Vyre app."),
    h("p", { class: "lead" }, reason === "return"
      ? "Start the sign-in again from the app on your phone."
      : "The app's key is missing from the link. Start the sign-in again from the app on your phone."));
}

/** @param {{ id: string }} key */
function done(key) {
  shell(
    h("div", { class: "lbl" }, "Sign in"),
    h("h1", { class: "h1" }, `${link.ok ? link.name : "This phone"} is signed in.`),
    h("p", { class: "lead" }, "Going back to the app."),
    h("div", { class: "ob-foot" }, h("div", { class: "grow" }), h("a", { class: "btn btn-primary", href: returnUrl({ id: key.id }) }, "Open Vyre")));
  back({ id: key.id });
}

/** @param {{ publicKey: string, name: string }} l */
function screen(l) {
  const st = h("div", { class: "check-line", "aria-live": "polite" });
  const btn = /** @type {HTMLButtonElement} */ (h("button", { type: "button", class: "btn btn-primary", onclick: withPasskey }, "Use your passkey"));
  const cancel = h("button", { type: "button", class: "btn btn-ghost", onclick: () => back({ error: "cancelled" }) }, "Cancel");

  async function withPasskey() {
    btn.disabled = true;
    put(st, "Waiting for your passkey.");
    try { done(await call("presence.enroll", enrollInput(l), { presence: true })); }
    catch (e) {
      const err = /** @type {any} */ (e);
      if (err?.code === "cancelled") return back({ error: "cancelled" });
      // No passkey on the box yet, or none in this browser: the one-time code instead.
      if (err?.code === "bad_input" || err?.code === "no_passkey") return withCode(l);
      btn.disabled = false;
      put(st, err?.message || String(e));
    }
  }

  shell(
    h("div", { class: "lbl" }, "Sign in"),
    h("h1", { class: "h1" }, `Sign in ${l.name} to Vyre`),
    h("p", { class: "lead" }, "Use the passkey you approve things with in the Deck. The phone gets a key of its own, held behind Face ID or your fingerprint."),
    h("div", { class: "ob-panel" }, st),
    h("div", { class: "ob-foot" }, cancel, h("div", { class: "grow" }), btn));
  btn.focus();
}

/** @param {{ publicKey: string, name: string }} l */
function withCode(l) {
  const codeIn = /** @type {HTMLInputElement} */ (h("input", { class: "input", id: "dv-code", autocomplete: "one-time-code", autocapitalize: "characters", spellcheck: "false", inputmode: "text", placeholder: "8 characters" }));
  const st = h("div", { class: "check-line", "aria-live": "polite" });
  const btn = /** @type {HTMLButtonElement} */ (h("button", { type: "button", class: "btn btn-primary", onclick: submit }, "Sign in"));
  const cancel = h("button", { type: "button", class: "btn btn-ghost", onclick: () => back({ error: "cancelled" }) }, "Cancel");

  async function submit() {
    const code = codeIn.value.trim();
    if (!code) { put(st, "Type the code first."); codeIn.focus(); return; }
    btn.disabled = true;
    put(st, "Checking the code.");
    try { done(await callWithCode("presence.enroll", enrollInput(l), code)); }
    catch (e) { btn.disabled = false; put(st, /** @type {any} */ (e)?.message || String(e)); }
  }
  codeIn.addEventListener("keydown", e => { if (e.key === "Enter") submit(); });

  shell(
    h("div", { class: "lbl" }, "Sign in"),
    h("h1", { class: "h1" }, `Sign in ${l.name} to Vyre`),
    h("p", { class: "lead" }, "There is no passkey on your box yet. Run vyre presence code on the box and type the code here. It works once, for 10 minutes."),
    h("div", { class: "ob-panel" }, h("div", { class: "field" }, h("label", { for: "dv-code" }, "One-time code"), codeIn), st),
    h("div", { class: "ob-foot" }, cancel, h("div", { class: "grow" }), btn));
  codeIn.focus();
}

if (!link.ok) badLink(link.reason);
else if (!canProve()) withCode(link);
else screen(link);
