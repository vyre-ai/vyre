// @ts-check
// A Mac asking to pair with this box, answered in the Deck: Now shows one card per waiting
// request, and onboarding's devices step uses the same card. The box never lists a request's
// code (core/link/box.js): the code is on the Mac's screen, so the person types it here, and the
// passkey proves they are the one looking at both. The Mac that is asking may approve itself
// here too: the box accepts that only with a fresh passkey assertion on that Mac.
//
// Tools: link.pending, link.pair.approve {code} (presence), link.pair.deny {id}.
// Events: link.pair-requested, link.paired. Nothing polls: the minutes left are redrawn once a
// minute from the request's own `expires`, only while the card is on screen and visible.

import { h, put } from "./dom.js";
import { attempt, on } from "./api.js";
import { icon } from "./icons.js";

let styled = false;
function style() {
  if (styled) return;
  styled = true;
  document.head.append(h("link", { rel: "stylesheet", href: "/css/pair.css" }));
}

/**
 * The waiting pairing requests, as a live section. Empty (and taking no room) when none wait or
 * this machine is not a box.
 * @param {{ onPaired?: (r: { name: string }) => void }} [opts]
 * @returns {{ el: HTMLElement, stop: () => void }}
 */
export function pairRequests(opts = {}) {
  style();
  const el = h("section", { class: "pair-list", "aria-label": "Macs asking to pair" });
  /** @type {Map<string, HTMLElement>} */ const cards = new Map();
  /** @type {Set<string>} */ const done = new Set();
  let seq = 0;
  async function load() {
    const n = ++seq;
    const r = await attempt("link.pending");
    if (n !== seq || r.error || !Array.isArray(r.data)) return;
    const ids = new Set(r.data.map((/** @type {any} */ p) => p.id));
    for (const [id, c] of cards) if (!ids.has(id) && !done.has(id)) { c.remove(); cards.delete(id); }
    for (const p of r.data) if (!cards.has(p.id)) { const c = pairCard(p, { onPaired: x => { done.add(p.id); opts.onPaired?.(x); } }); cards.set(p.id, c); el.append(c); }
  }
  load();
  const offs = [on("link.pair-requested", load), on("link.paired", load)];
  return { el, stop: () => { for (const f of offs) f(); for (const c of cards.values()) /** @type {any} */ (c).stop?.(); } };
}

/**
 * One request: which Mac, the code field, Approve with the passkey, Deny.
 * @param {{ id: string, name: string, login?: string, node?: string|null, expires: number }} p
 * @param {{ onPaired?: (r: { name: string }) => void }} [opts]
 */
export function pairCard(p, opts = {}) {
  style();
  const codeIn = /** @type {HTMLInputElement} */ (h("input", { class: "input pair-code", inputmode: "numeric", autocomplete: "one-time-code",
    placeholder: "123-456", maxlength: "7", "aria-label": `The code on ${p.name}`, enterkeyhint: "done",
    oninput: () => { codeIn.value = shape(codeIn.value); approve.disabled = busy || digits(codeIn.value).length !== 6; },
    onkeydown: (/** @type {KeyboardEvent} */ e) => { if (e.key === "Enter" && !approve.disabled) { e.preventDefault(); decide("approve"); } } }));
  const approve = /** @type {HTMLButtonElement} */ (h("button", { type: "button", class: "btn btn-primary", disabled: true, onclick: () => decide("approve") }, "Approve"));
  const deny = /** @type {HTMLButtonElement} */ (h("button", { type: "button", class: "btn btn-ghost", onclick: () => decide("deny") }, "Deny"));
  const note = h("div", { class: "pair-note small", role: "status" });
  const hint = h("div", { class: "small faint" }, "Approve with Touch ID on this Mac or on your phone. A passkey you made on the Mac also works on your iPhone if iCloud Keychain is on.");
  const left = h("span", { class: "code faint" });
  const form = h("div", { class: "pair-form" }, h("label", { class: "lbl", for: "pc-" + p.id }, "Code on that Mac"), codeIn, h("div", { class: "pair-actions" }, approve, deny));
  codeIn.id = "pc-" + p.id;
  const el = h("div", { class: "pair-card", role: "group", "aria-label": `${p.name} wants to pair` },
    h("div", { class: "pair-top" }, h("span", { class: "lbl beacon" }, h("span", { class: "dot beacon" }), " Pairing"), left),
    h("div", { class: "pair-title" }, icon("laptop", 16), h("span", null, "A Mac wants to pair: ", h("b", null, p.name))),
    h("div", { class: "small muted" }, [p.node, p.login].filter(Boolean).join(" · ")),
    form, hint, note);
  let busy = false;

  async function decide(/** @type {"approve" | "deny"} */ what) {
    busy = true; approve.disabled = deny.disabled = true; codeIn.disabled = true;
    put(note, what === "approve" ? "Waiting for your passkey…" : "Refusing…");
    const r = what === "approve" ? await attempt("link.pair.approve", { code: digits(codeIn.value) }, { presence: true })
      : await attempt("link.pair.deny", { id: p.id });
    busy = false;
    if (r.error) {
      approve.disabled = digits(codeIn.value).length !== 6; deny.disabled = false; codeIn.disabled = false;
      put(note, h("span", { class: "pair-err" }, why(r.error)));
      return;
    }
    stop();
    form.remove();
    hint.remove();
    left.remove();
    if (what === "approve") {
      el.classList.add("paired");
      put(note, icon("check", 14), " ", h("b", null, p.name), " is paired. Its sessions and files show up here in a minute; press Control twice on it to open Lumen.");
      opts.onPaired?.({ name: p.name });
    } else {
      el.classList.add("denied");
      put(note, `Refused. ${p.name} was told no.`);
    }
  }

  // Ten minutes from the request. Minutes are enough, so the card redraws once a minute.
  const tick = () => {
    const m = Math.ceil((p.expires - Date.now()) / 60_000);
    put(left, m > 0 ? `${m} min left` : "expired");
    if (m <= 0) { stop(); approve.disabled = true; codeIn.disabled = true; put(note, "This request expired. Run vyre link pair on the Mac again."); }
  };
  const t = window.setInterval(() => { if (document.visibilityState === "visible") tick(); }, 60_000);
  const end = window.setTimeout(tick, Math.max(0, p.expires - Date.now()) + 500);
  function stop() { clearInterval(t); clearTimeout(end); }
  tick();
  /** @type {any} */ (el).stop = stop;
  return el;
}

const digits = (/** @type {string} */ s) => String(s).replace(/\D/g, "").slice(0, 6);
const shape = (/** @type {string} */ s) => { const d = digits(s); return d.length > 3 ? `${d.slice(0, 3)}-${d.slice(3)}` : d; };

/** The box's refusals, in words that say what to do next. */
function why(/** @type {any} */ e) {
  const m = String(e.message || e);
  if (/cannot approve its own/.test(m)) return "The Mac that is asking can approve itself only with a passkey. Approve again and use Touch ID, or approve on your phone.";
  if (/no pairing request has that code/.test(m)) return "That code does not match. Check the code on the Mac and try again.";
  if (/too many wrong codes/.test(m)) return "Too many wrong codes, so every request was cancelled. Start again on the Mac.";
  if (e.code === "no_passkey" || e.code === "cancelled" || e.code === "presence_required") return `${m} Approving needs a passkey on this device: Settings, Security.`;
  if (e.missing) return "Pairing is answered on the box, and this machine is not one.";
  return m;
}
