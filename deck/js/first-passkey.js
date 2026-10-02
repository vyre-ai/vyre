// @ts-check
// The box has no passkey at all: nothing the Deck asks a person for (Send, Allow, approving a Mac)
// can be proved yet, so Now says so first. The Deck cannot make the first one by itself: the box
// hands the one-time link only to its own terminal or the loopback onboarding (core/onboard,
// onboard.passkey), so the card names the commands that print it.

import { h } from "./dom.js";
import { attempt, on } from "./api.js";
import { icon } from "./icons.js";

/** @returns {{ el: HTMLElement, stop: () => void }} empty (and taking no room) while a passkey exists */
export function firstPasskeyCard() {
  const el = h("section", { class: "first-passkey", hidden: true, "aria-labelledby": "fp-h" });
  async function check() {
    const r = await attempt("presence.keys");
    const none = Array.isArray(r.data) && !r.data.some((/** @type {any} */ k) => k.kind === "passkey");
    el.hidden = !none;
    if (!none) return;
    el.replaceChildren(
      h("div", { class: "lbl beacon" }, h("span", { class: "dot beacon" }), " No passkey yet"),
      h("h2", { class: "h3", id: "fp-h" }, "Make your first passkey"),
      h("p", { class: "small muted" }, "Your passkey confirms messages you send out, payments, deletions, vault secrets and new devices. One tap covers 30 minutes. The link to make it comes from your server itself, once, for 10 minutes:"),
      h("div", { class: "fp-cmds" },
        h("div", null, h("span", { class: "small faint" }, "On your Mac"), h("code", null, "vyre box add")),
        h("div", null, h("span", { class: "small faint" }, "Or on your server"), h("code", null, "vyre up"))),
      h("p", { class: "small faint" }, icon("lock", 12), " Open the link it prints on the device you want the passkey on."));
  }
  check();
  const offs = [on("presence.enrolled", check), on("presence.removed", check)];
  return { el, stop: () => { for (const f of offs) f(); } };
}
