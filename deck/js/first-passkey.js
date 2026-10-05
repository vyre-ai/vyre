// @ts-check
// The box has no passkey at all: nothing the Deck asks a person for (Send, Allow)
// can be proved yet, so Finish setup on Now offers one button, "Make a passkey". It asks the server for a
// one-time code (presence.code) and runs the browser's own passkey prompt with it. Where the server will
// not hand this device a code (the first one is meant for its own terminal or the loopback onboarding,
// core/onboard), the commands that print the link sit under "Other ways".

import { h, put } from "./dom.js";
import { attempt, on, canProve } from "./api.js";
import { enrollPasskey } from "./phone-setup.js";

let styled = false;
/** The card's styles live in css/pair.css, loaded once when the card first draws. */
function style() {
  if (styled) return;
  styled = true;
  document.head.append(h("link", { rel: "stylesheet", href: "/css/pair.css" }));
}

/**
 * @param {{ onChange?: (open: boolean) => void }} [o] onChange: whether the row is showing, for the card around it
 * @returns {{ el: HTMLElement, stop: () => void }} empty (and taking no room) while a passkey exists
 */
export function firstPasskeyCard({ onChange } = {}) {
  style();
  const el = h("div", { class: "fs-row first-passkey", hidden: true });
  /** @type {string | null} */ let held = null;
  async function check() {
    const r = await attempt("presence.keys");
    const none = Array.isArray(r.data) && !r.data.some((/** @type {any} */ k) => k.kind === "passkey");
    el.hidden = !none;
    onChange?.(none);
    if (!none) { el.replaceChildren(); return; }
    draw();
  }
  function draw() {
    const status = h("p", { class: "small muted fs-status", role: "status", "aria-live": "polite" });
    const more = h("details", { class: "fp-more" },
      h("summary", { class: "small" }, "Other ways"),
      h("p", { class: "small muted" }, "Your server prints a link that makes the passkey on the device you open it on. It works once, for 10 minutes."),
      h("div", { class: "fp-cmds" },
        h("div", null, h("span", { class: "small faint" }, "On your Mac"), h("code", null, "vyre box add")),
        h("div", null, h("span", { class: "small faint" }, "Or on your server"), h("code", null, "vyre up"))));
    const btn = /** @type {HTMLButtonElement} */ (h("button", { type: "button", class: "btn btn-sm btn-primary" }, "Make a passkey"));
    // The passkey prompt must start inside the tap, before anything is awaited (Safari), so `go` is called straight from a click.
    const go = async () => {
      btn.disabled = true;
      put(status, "Waiting for your passkey prompt.");
      try { await enrollPasskey({ code: held || "" }); held = null; put(status, "Passkey made."); await check(); }
      catch (e) {
        btn.disabled = false;
        btn.textContent = "Try again";
        put(status, String(/** @type {any} */ (e)?.message || e));
      }
    };
    btn.addEventListener("click", async () => {
      if (held) { void go(); return; }
      if (!canProve()) { more.open = true; put(status, "This browser cannot make a passkey. Open Vyre in Safari or Chrome, or use one of the other ways."); return; }
      btn.disabled = true;
      put(status, "Asking your server for a one-time code.");
      const c = await attempt("presence.code");
      btn.disabled = false;
      const code = c.data?.code;
      if (!code) { more.open = true; put(status, "Your server will not make this one from here. Use one of the other ways."); return; }
      held = String(code);
      btn.textContent = "Continue";
      put(status, "Code ready. Tap Continue for your passkey prompt.");
    });
    put(el,
      h("div", { class: "fs-main" },
        h("div", { class: "fs-title" }, "Make a passkey"),
        h("p", { class: "small muted" }, "It confirms messages you send out, payments, deletions and new devices. One tap covers 30 minutes.")),
      h("div", { class: "fs-act" }, btn),
      status, more);
  }
  void check();
  const offs = [on("presence.enrolled", check), on("presence.removed", check)];
  return { el, stop: () => { for (const f of offs) f(); } };
}
