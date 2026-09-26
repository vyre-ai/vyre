// @ts-check
// The first-passkey page (ADR 0004): onboard.finish's ending sends the person here when
// passkeyUrl is set, as https://<addr>/onboard/passkey#e=<code>. The code is single use, lasts
// 10 minutes, and only proves presence.enroll — security's design, not this file's. A standalone
// page, not part of the onboarding wizard or the Deck's router: it exists only to run one
// WebAuthn ceremony and hand back to the Deck.

import { h, put } from "../../js/dom.js";
import { canProve, callWithCode } from "../../js/api.js";
import { icon, mark, wordmark } from "../../js/icons.js";

const root = /** @type {HTMLElement} */ (document.getElementById("pk"));

// The code rides in the hash, never the path or a query string a proxy might log, and is taken
// out of the address bar at once so it is never left in history or shown over a shoulder.
const code = new URLSearchParams(location.hash.slice(1)).get("e");
if (code) history.replaceState(null, "", location.pathname);

const b64url = buf => btoa(String.fromCharCode(.../** @type {any} */ (new Uint8Array(buf)))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

function shell(...kids) {
  put(root, h("header", { class: "ob-top" }, h("span", { class: "brand" }, mark(20), wordmark(22))),
    h("div", { class: "ob-body" }, h("main", { class: "ob-main" }, h("div", { class: "ob-col" }, ...kids))));
}

function done() {
  shell(
    h("div", { class: "lbl" }, "Passkey"),
    h("h1", { class: "h1" }, "Passkey added."),
    h("p", { class: "lead" }, "It's yours to approve a held item or take over a session with, from now on — Touch ID, Face ID, or whatever this device offers."),
    h("div", { class: "ob-foot" }, h("a", { class: "btn btn-primary", href: "/now" }, "Open Vyre")));
}

function missingCode() {
  shell(
    h("div", { class: "lbl" }, "Passkey"),
    h("h1", { class: "h1" }, "This link is missing its code."),
    h("p", { class: "lead" }, "Open the link Vyre gave you again, or add a passkey later from Settings."),
    h("div", { class: "ob-foot" }, h("a", { class: "btn", href: "/now" }, "Open Vyre")));
}

function screen() {
  const nameIn = /** @type {HTMLInputElement} */ (h("input", { class: "input", id: "pk-name", autocomplete: "off", placeholder: "e.g. My MacBook" }));
  const st = h("div", { class: "check-line", "aria-live": "polite" });
  const btn = /** @type {HTMLButtonElement} */ (h("button", { type: "button", class: "btn btn-primary", onclick: enroll }, "Add a passkey"));
  const skip = h("a", { class: "btn btn-ghost", href: "/now" }, "Skip for now");

  async function enroll() {
    btn.disabled = true;
    put(st, "Waiting for your passkey…");
    /** @type {any} */ let cred;
    try {
      cred = await navigator.credentials.create({ publicKey: {
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        rp: { name: "Vyre", id: location.hostname },
        user: { id: crypto.getRandomValues(new Uint8Array(16)), name: nameIn.value.trim() || "you", displayName: nameIn.value.trim() || "you" },
        pubKeyCredParams: [{ type: "public-key", alg: -7 }, { type: "public-key", alg: -257 }],
        authenticatorSelection: { userVerification: "required" }, timeout: 60_000,
      } });
    } catch (e) { btn.disabled = false; put(st, `The passkey was not created: ${/** @type {any} */ (e)?.message || e}`); return; }
    if (!cred) { btn.disabled = false; put(st, "The passkey was cancelled."); return; }
    const r = cred.response;
    try {
      await callWithCode("presence.enroll", {
        kind: "passkey", name: nameIn.value.trim() || "This device",
        public_key: b64url(r.getPublicKey()), alg: r.getPublicKeyAlgorithm(),
        rp_id: location.hostname, credential_id: b64url(cred.rawId),
      }, /** @type {string} */ (code));
    } catch (e) {
      btn.disabled = false;
      put(st, /** @type {any} */ (e)?.message || String(e));
      return;
    }
    done();
  }

  shell(
    h("div", { class: "lbl" }, "Passkey"),
    h("h1", { class: "h1" }, "Add a passkey."),
    h("p", { class: "lead" }, "It proves you're the one approving a held item or taking over a session — never typed, never phished. Touch ID, Face ID, or a security key."),
    h("div", { class: "ob-panel" }, h("div", { class: "field" }, h("label", { for: "pk-name" }, "Name this device"), nameIn), st),
    h("div", { class: "ob-foot" }, skip, h("div", { class: "grow" }), btn));
  nameIn.focus();
}

if (!canProve()) {
  shell(
    h("div", { class: "lbl" }, "Passkey"),
    h("h1", { class: "h1" }, "This browser cannot create a passkey." ),
    h("p", { class: "lead" }, "Open this link in Safari or Chrome, over your tailnet, or add one later from Settings."),
    h("div", { class: "ob-foot" }, h("a", { class: "btn", href: "/now" }, "Open Vyre")));
} else if (!code) missingCode();
else screen();
