// @ts-check
// The person session: over the tailnet a box can ask that a person has signed in on this device
// (one passkey, then a `__Host-vyre_person` cookie for 30 days) before it answers person-only
// calls. It says so with person_session_required. This file is the Deck's answer:
//
//   signIn()                 the passkey sign-in itself: presence.person.start {} with a proof
//                            bound to that tool and input. Call it from a tap (Safari asks for a
//                            passkey only in a user gesture). Fires window "deck:person".
//   needSignIn(retry?, err?) the sheet that asks for that tap, naming what carries on after
//                            it (carryOn). Resolves after a sign-in (to
//                            retry() when given), rejects with the ApiError on "Not now". Two
//                            calls at once share one sheet.
//   installPersonHandler()   app.js runs it once: api.js hands person_session_required here and
//                            retries the call once after a sign-in.
//   signInAfterEnroll()      right after a passkey is made on this device, sign in once too, so
//                            the first real action is not a second prompt. Quiet on any error,
//                            and nothing at all on a box without presence.person.status.
//   signOutHere()            POST /v1/person/end, then reload.
//
// Nothing here polls.

import { h, put } from "./dom.js";
import { call, attempt, endPerson, setPersonHandler, ApiError } from "./api.js";
import { openSheet } from "./sheet.js";

/** Sign in on this device with a passkey. Resolves to { kind, id, expires }; throws an ApiError.
 * @returns {Promise<{ kind: string, id: string, expires: number }>} */
export async function signIn() {
  const r = await call("presence.person.start", {}, { presence: true });
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("deck:person", { detail: r || null }));
  return r;
}

/** The one sheet on screen, shared by every call that is waiting for it. @type {Promise<void> | null} */
let pending = null;

/**
 * Ask the person to sign in on this device. Resolves once they have (to retry()'s result when a
 * retry is given); rejects with `err` (or an ApiError) when they choose "Not now" or close it.
 * @template T
 * @param {(() => Promise<T>) | undefined} [retry]
 * @param {ApiError} [err] the error that asked for it
 * @returns {Promise<T | undefined>}
 */
export async function needSignIn(retry, err) {
  if (!pending) pending = ask(err).finally(() => { pending = null; });
  try { await pending; } catch (e) { throw err || e; }
  return retry ? retry() : undefined;
}

/** What the refused call was doing, in words, for the sheet's second line. Unknown tools say nothing. */
const DOING = /** @type {Record<string, string>} */ ({
  "threads.send": "sending your message", "threads.answer": "your answer", "gate.approve": "the send",
  "gate.reject": "the discard", "gate.revise": "your edit", "term.open": "opening the terminal",
  "agents.create": "making the agent", "agents.update": "saving the agent",
});
/** @param {ApiError | undefined} err */
export function carryOn(err) {
  const what = err && DOING[/** @type {any} */ (err).tool];
  return what ? `Then Vyre carries on with ${what}.` : null;
}

/** @param {ApiError} [err] @returns {Promise<void>} */
function ask(err) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const refused = () => new ApiError("person_session_required", "Not signed in on this device.", "presence.person.start");
    const sheet = openSheet({
      title: "Sign in on this device",
      onClose: () => { if (!settled) { settled = true; reject(refused()); } },
      build(body, close, { actions }) {
        const st = h("p", { class: "small muted person-status", role: "status" });
        const go = /** @type {HTMLButtonElement} */ (h("button", { type: "button", class: "sb sb-primary sb-full", "data-act": "sign-in" }, "Sign in with your passkey"));
        const later = h("button", { type: "button", class: "sb sb-full", "data-act": "not-now", onclick: close }, "Not now");
        // signIn() asks for the passkey before anything else is awaited, so it stays in this tap.
        go.addEventListener("click", () => {
          go.disabled = true;
          put(st, "Waiting for your passkey.");
          return signIn().then(() => {
            settled = true;
            resolve();
            sheet.close();
          }, e => {
            go.disabled = false;
            put(st, String(/** @type {any} */ (e)?.message || e));
          });
        });
        const next = carryOn(err);
        put(body, h("p", { class: "person-line" }, "One passkey, and this device stays signed in for 30 days."),
          next ? h("p", { class: "small muted person-next" }, next) : null, st);
        put(actions, go, later);
      },
    });
  });
}

/** Once, from app.js: person_session_required on any call asks here, then the call goes again. */
export function installPersonHandler() {
  setPersonHandler(e => needSignIn(undefined, e));
}

/** Whether this box has person sessions at all, and this device's: { signed, id?, kind? }, or
 * null for a box without them (or out of reach). */
export async function personStatus() {
  const r = await attempt("presence.person.status");
  if (r.error || !r.data || typeof r.data !== "object") return null;
  return /** @type {{ signed: boolean, id?: string, kind?: string }} */ (r.data);
}

/** After the first passkey on this device: sign in once, quietly. Nothing on an older box. */
export async function signInAfterEnroll() {
  try {
    const s = await personStatus();
    if (!s || s.signed) return;
    await signIn();
  } catch {}
}

/** Sign this device out and start again from the box. */
export async function signOutHere() {
  await endPerson();
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("deck:person", { detail: null }));
  location.reload();
}
