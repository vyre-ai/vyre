// @ts-check
// The star button at the top of the Deck: one tap stars vyre-ai/vyre on GitHub through the account the person has connected. Not connected: the same
// tap opens the repo so they can do it there. Gone once starred, and never shown with a count. Only the person's own tap counts: a click a
// script made (isTrusted false) does nothing, so no page and no agent can star on their behalf. The repo is the box's own, never taken from here.
// Reads the star state once when it is drawn; nothing polls. A box without the star tools shows nothing at all.
import { h, put } from "./dom.js";
import { icon } from "./icons.js";
import { attempt as apiAttempt } from "./api.js";

export const REPO_URL = "https://github.com/vyre-ai/vyre";

/**
 * @param {{ attempt?: typeof apiAttempt, open?: (url: string) => void }} [deps]
 * @returns {HTMLElement & { ready: Promise<void> }}
 */
export function starButton(deps = {}) {
  const attempt = deps.attempt || apiAttempt;
  const open = deps.open || (url => { window.open(url, "_blank", "noopener,noreferrer"); });
  const note = h("span", { class: "star-note small muted", role: "status", "aria-live": "polite" });
  const btn = /** @type {HTMLButtonElement} */ (h("button", { class: "btn btn-ghost btn-sm star-btn", type: "button", "aria-label": "Star Vyre on GitHub", title: "Star Vyre on GitHub" },
    icon("star", 14), h("span", null, "Star")));
  const el = /** @type {any} */ (h("div", { class: "star", hidden: true }, btn, note));
  let connected = false, busy = false;

  btn.addEventListener("click", async (/** @type {Event} */ e) => {
    // Only the person's own tap: a click made by a script is not one.
    if (!e || /** @type {any} */ (e).isTrusted !== true || busy) return;
    if (!connected) { open(REPO_URL); return; }
    busy = true; btn.disabled = true; put(note);
    const r = await attempt("github.star", {});
    busy = false; btn.disabled = false;
    if (r.error) { put(note, String(r.error.message || "GitHub did not take that.")); return; }
    el.hidden = true;
  });

  el.ready = (async () => {
    const r = await attempt("github.star.status", {});
    // No answer (a box without the tool, or an error): nothing is offered. Starred: gone.
    if (r.error || !r.data || /** @type {any} */ (r.data).starred === true) return;
    connected = /** @type {any} */ (r.data).connected === true;
    el.hidden = false;
  })();
  return el;
}
