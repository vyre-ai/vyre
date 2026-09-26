// @ts-check
// What an inline card says when a human-only call (threads.answer, gate.approve, gate.reject: the
// floor's list in core/presence/index.js, ADR 0004) did not go through. The call itself is
// api.js's call(..., { presence: true }); this only words the failure. A cancelled passkey, a
// browser that cannot make one, or a box with none enrolled all end in the same place: Settings,
// Security, where a passkey for this phone is added.

import { h, link } from "../js/dom.js";

/** Did the proof, not the call, fail? @param {any} err an ApiError from api.js */
export function proofFailed(err) {
  return err?.code === "cancelled" || err?.code === "no_passkey" || err?.code === "presence_required"
    || /no passkey is enrolled/i.test(String(err?.message || ""));
}

/**
 * The line under a card's buttons: the reason, and for a proof that failed, where to fix it.
 * @param {any} err
 */
export function problemLine(err) {
  const why = err?.missing ? `The ${err.module} module is not running.` : String(err?.message || err || "It did not go through.");
  return h("div", { class: "gate-note chat-problem", role: "alert" },
    h("span", { class: "err" }, why),
    proofFailed(err) ? [" ", link("/settings#security", { class: "link" }, "Add a passkey on this phone")] : null);
}
