// @ts-check
// What an inline card says when a call did not go through: a human-only one (gate.approve,
// gate.reject: the floor's list in core/presence/index.js, ADR 0004) or an answer (threads.answer). The call itself is
// api.js's call(..., { presence: true }); this only words the failure. A cancelled passkey, a
// browser that cannot make one, or a box with none enrolled all end in the same place: Settings,
// Security, where a passkey for this phone is added.

import { h, link } from "../js/dom.js";
import { icon } from "../js/icons.js";

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

// ---- answering an ask on the paired Mac (federation v2) ------------------------------------------
// A Mac session's ask (source "mac", machine, node on the relayed event) is answered from here with
// threads.answer { ..., machine }; the box forwards it. Its refusals each get their own step, and the
// card stays open for all of them:
//   person_session_required  this browser is not signed in as the person: a passkey proof on the
//                            answer does not help, so the card sends the person to the box's own
//                            sign-in page (/person/signin, made by presence.person.start), then Try again
//   presence_required        a gated ask (outbound send, vault): a fresh passkey or Touch ID, then again
//   mac_offline, timeout     the box's words and Try again
// A relayed ask (source "mac") already means the box forwards answers, so the card tries. A box that
// cannot refuses in a way that says so: an unknown tool or input, or unsupported. Then the card, and
// every Mac card after it on this page, falls back to "Answer it on <mac>".

const HELD = new Set(["no_such_tool", "bad_input", "unsupported", "not_supported", "unknown", "unknown_tool"]);
let held = false;

/** Has this box shown it cannot answer a Mac's ask? New Mac cards then say where to answer instead. */
export const macAnswersHeld = () => held;

/** The box's own page that signs this browser in as the person (presence.person.start, no cc). */
export const PERSON_SIGNIN = "/person/signin";

/**
 * Which step a refused Mac answer needs: "sign_in", "presence", "retry", "held" (the box cannot
 * forward answers) or null (show the reason).
 * @param {any} err @param {{ node?: string|null }} [_ask]
 */
export function macRefusal(err, _ask) {
  const code = err?.code;
  if (code === "person_session_required") return "sign_in";
  if (code === "presence_required") return "presence";
  if (code === "mac_offline" || code === "timeout") return "retry";
  if (HELD.has(code)) return "held";
  return null;
}

/**
 * After a refused answer: when the box cannot forward it, mark the ask (elsewhere: its machine) and
 * the page, and say so. Returns whether the card should now show "Answer it on <mac>".
 * @param {{ machine?: string|null, node?: string|null, elsewhere?: string|null }} ask @param {any} err
 */
export function macHeld(ask, err) {
  if (!ask.machine || macRefusal(err, ask) !== "held") return false;
  held = true;
  ask.elsewhere = ask.machine;
  return true;
}

/** "on alex's MacBook Pro": where a Mac card's answer runs. @param {string} machine */
export function macLabel(machine) {
  return h("span", { class: "cv-on-mac" }, icon("laptop", 12), `on ${machine}`);
}

/**
 * The line under a Mac card's buttons: the refusal's own step. `again` sends the same answer once
 * more, with a passkey proof when the step asks for one.
 * @param {any} err @param {string} machine @param {{ node?: string|null }} ask
 * @param {(opts: { presence?: boolean }) => void} again
 */
export function macProblem(err, machine, ask, again) {
  const kind = macRefusal(err, ask);
  const line = (why, ...kids) => h("div", { class: "gate-note chat-problem cv-mac-step", role: "alert" }, h("span", { class: "err" }, why), ...kids);
  const btn = (label, opts) => h("button", { class: "btn btn-ghost btn-sm", type: "button", onclick: () => again(opts) }, label);
  if (kind === "sign_in") {
    // A proof on the answer is not a sign-in: the box's page signs this browser in, then the answer goes again.
    return line(`Sign this browser in to answer asks on ${machine}.`, " ",
      h("a", { class: "link cv-person-signin", href: PERSON_SIGNIN, target: "_blank", rel: "noopener" }, "Sign in"), " ",
      btn("Try again", {}));
  }
  if (kind === "presence") {
    return line(`This answer lets ${machine} do something protected. Prove it is you first.`, " ",
      btn("Use passkey or Touch ID", { presence: true }), " ", link("/settings#security", { class: "link" }, "Add a passkey on this phone"));
  }
  if (kind === "retry") return line(String(err?.message || `${machine} did not answer`), " ", btn("Try again", {}));
  // A passkey that was cancelled on the way (after one of the steps above): the usual words.
  if (proofFailed(err)) return h("div", null, problemLine(err), btn("Try again", { presence: true }));
  return problemLine(err);
}
