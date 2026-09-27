// @ts-check
// The hosted app's sign-in hop (core/presence/person.js). The app sends the person here, to the
// box's own address, with a PKCE challenge (cc) and where to go back (return). The passkey is
// asked here, for this box, and the box hands back a one-time code in the address the app gave,
// if that app is one the box allows. Only the app holding the verifier can trade the code.
// A plain page; pwa styles it.

import { personCode, signIn } from "../../js/api.js";

const root = /** @type {HTMLElement} */ (document.getElementById("signin"));
const q = new URLSearchParams(location.search);
const cc = q.get("cc") || "";
const back = q.get("return") || "";

/** @param {string} text @param {string} [label] @param {() => void} [act] */
function show(text, label, act) {
  root.textContent = "";
  const h = document.createElement("h1");
  h.textContent = "Sign in to Vyre";
  const p = document.createElement("p");
  p.textContent = text;
  root.append(h, p);
  if (label && act) {
    const b = document.createElement("button");
    b.className = "btn primary";
    b.textContent = label;
    b.addEventListener("click", act);
    root.append(b);
  }
}

let where = "the app";
try { where = new URL(back).host; } catch {}

async function go() {
  show("Confirm with your passkey.");
  try {
    if (cc) {
      const r = await personCode({ cc, return: back, label: where });
      location.replace(r.redirect);
    } else {
      await signIn();
      show("This browser is signed in for 30 days.", "Open Vyre", () => location.assign("/"));
    }
  } catch (e) {
    show(/** @type {any} */ (e).message || "Signing in did not work.", "Try again", go);
  }
}

show(cc ? `${where} wants to act for you on this box, on this device, for 30 days.` : "Sign this browser in for 30 days.", "Sign in with your passkey", go);
