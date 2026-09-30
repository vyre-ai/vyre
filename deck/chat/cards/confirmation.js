// @ts-check
// The confirmation line (confirmation.md; app-design.md 10.6): "asking is approving". The person's
// own turn said what to do, the Gate matched the send against it, and it went out with no held card.
// This is the plain after-the-fact line that says so. It is a row, not a card (toast.md's in-place
// shape), inline in the transcript at the point the send happened (Option A, 10.7), and nothing on
// it approves anything: it is never blocking.
//
// Data, from an ask of kind "confirmation" or a gate.confirmed-style payload:
//   { what, to, at, line?, said: { turn, text, href? }, undo?: { tool, input?, until? }, items?: [same] }
//   line   the plain words when the Gate wrote them ("Sent to the team · 3 recipients"); else built as "<what> · <to>"
//   said   the words of the person's own turn that matched, and the turn's id
//   undo   only where the send can really be taken back: the queued tool to call, its input, and the
//          epoch ms the window closes (past it, or absent, there is no Undo, silently)
//   items  several matched sends in one turn: one line, "3 things sent", with "Show what" to open them
// "You said to" opens the matched words inline (no navigation) and, when the turn can be reached,
// adds "Show in thread": ctx.goto(turn) scrolls to it, else ctx.open(said.href). The row carries
// data-turn for a caller that would rather scroll by anchor. Undone, the line reads "Undone · was
// sent to the team" in place. No passkey: undo is the owner's own act.

import { h, put } from "../../js/dom.js";
import { queued } from "../../js/api.js";
import { icon } from "../../js/icons.js";
import { ensureCss, problemText } from "./kit.js";

const lower = (/** @type {string} */ s) => (s ? s[0].toLowerCase() + s.slice(1) : s);

/** The plain line for one send: the Gate's own words, else "what · to". @param {any} d */
export function lineOf(d) {
  if (d && typeof d.line === "string" && d.line.trim()) return d.line.trim();
  const what = String(d?.what ?? "").trim(), to = String(d?.to ?? "").trim();
  return [what, to].filter(Boolean).join(" · ") || "Done";
}

/** Whether a send can still be undone at `now`. @param {any} d @param {number} [now] */
export const canUndo = (d, now = Date.now()) => !!(d && d.undo && typeof d.undo.tool === "string" && d.undo.tool && (d.undo.until == null || Number(d.undo.until) > now));

/**
 * @param {any} data @param {{ thread?: string, phone?: boolean, agent?: string, open?: (href: string) => void, goto?: (turn: any) => void }} [ctx]
 * @returns {HTMLElement & { update: (d: any) => void, answered: () => void, onKey: (e: any) => boolean, isOpen: () => boolean }}
 */
export function confirmationLine(data, ctx = {}) {
  ensureCss("confirmation");
  const el = /** @type {any} */ (h("div", { class: "cv-row cv-confirm", role: "status", "aria-live": "polite" }));
  el._kind = "assistant";
  el._ts = data?.at ?? null;
  /** Per send (by index, 0 alone): undone, busy, an error, whether its words are open. */
  const st = /** @type {Record<number, { undone: boolean, busy: boolean, error: any, said: boolean }>} */ ({});
  const of = (/** @type {number} */ i) => (st[i] ||= { undone: false, busy: false, error: null, said: false });
  let showAll = false;
  /** @type {any} */ let timer = null;

  const items = () => (Array.isArray(data?.items) && data.items.length > 1 ? data.items : null);

  /** The reach for the turn that authorized a send, or null when nothing can be opened. */
  function reach(/** @type {any} */ d) {
    const s = d?.said || {};
    if (s.turn != null && typeof ctx.goto === "function") return () => ctx.goto?.(s.turn);
    if (s.href && typeof ctx.open === "function") return () => ctx.open?.(s.href);
    return null;
  }

  async function undo(/** @type {number} */ i, /** @type {any} */ d) {
    const s = of(i);
    if (s.busy || s.undone || !canUndo(d)) return;
    s.busy = true; s.error = null; draw();
    const r = await queued(d.undo.tool, d.undo.input || {});
    s.busy = false;
    if (r.error) s.error = r.error; else s.undone = true;
    draw();
  }

  /** One send's row. @param {any} d @param {number} i @param {boolean} [single] the only row (carries the anchor) */
  function row(d, i, single = true) {
    const s = of(i), text = lineOf(d);
    const go = reach(d);
    const saidText = String(d?.said?.text ?? "").trim();
    const canSay = !!(saidText || go);
    const line = s.undone ? (d.undoneLine || `Undone · was ${lower(text)}`) : text;
    const inner = h("div", { class: "cv-confirm-row" + (s.undone ? " cv-confirm-undone" : ""), "data-turn": single && d?.said?.turn != null ? String(d.said.turn) : null },
      h("span", { class: "cv-confirm-ico", "aria-hidden": "true" }, icon(s.undone ? "close" : "check", 16)),
      h("span", { class: "cv-confirm-line ellipsis", title: line }, line),
      !s.undone && canUndo(d) ? h("button", { class: "btn btn-ghost btn-sm cv-confirm-undo", type: "button", "data-act": "undo", disabled: s.busy, "aria-busy": s.busy ? "true" : null,
        onclick: () => undo(i, d) }, s.busy ? "Undoing" : "Undo") : null,
      canSay ? h("button", { class: "cv-confirm-said-btn", type: "button", "data-act": "said", "aria-expanded": String(s.said), onclick: () => { s.said = !s.said; draw(); } }, "You said to") : null);
    const quote = s.said && canSay ? h("div", { class: "cv-confirm-quote" },
      saidText ? h("blockquote", { class: "cv-confirm-said" }, saidText) : null,
      go ? h("button", { class: "cv-confirm-goto", type: "button", "data-act": "goto", onclick: () => go() }, "Show in thread") : null) : null;
    const problem = s.error ? h("div", { class: "cv-confirm-problem" }, "Could not undo. " + problemText(s.error)) : null;
    return h("div", { class: "cv-confirm-item" }, inner, quote, problem);
  }

  function draw() {
    const many = items();
    if (!many) { put(el, row(data?.items?.length === 1 ? { ...data, ...data.items[0] } : data, 0)); return; }
    const head = h("div", { class: "cv-confirm-row" },
      h("span", { class: "cv-confirm-ico", "aria-hidden": "true" }, icon("check", 16)),
      h("span", { class: "cv-confirm-line ellipsis" }, `${many.length} things sent`),
      h("button", { class: "cv-confirm-said-btn", type: "button", "data-act": "show", "aria-expanded": String(showAll), onclick: () => { showAll = !showAll; draw(); } }, showAll ? "Hide" : "Show what"));
    // One row per turn: the individual lines sit above it, quietly, when opened.
    put(el, showAll ? h("div", { class: "cv-confirm-list" }, many.map((/** @type {any} */ d, /** @type {number} */ i) => row({ said: data.said, ...d }, i + 1, false))) : null,
      h("div", { class: "cv-confirm-item", "data-turn": data?.said?.turn != null ? String(data.said.turn) : null }, head));
  }

  /** The Undo button leaves by itself when its window closes. */
  function arm() {
    if (timer) clearTimeout(timer);
    const ends = [data, ...(items() || [])].map(d => (canUndo(d) && d.undo.until != null ? Number(d.undo.until) : 0)).filter(Boolean);
    if (!ends.length || typeof setTimeout !== "function") return;
    const wait = Math.max(0, Math.max(...ends) - Date.now());
    timer = setTimeout(() => { timer = null; draw(); }, Math.min(wait + 20, 2 ** 31 - 1));
    timer?.unref?.();
  }

  el.update = (/** @type {any} */ d) => { data = { ...data, ...d }; el._ts = data.at ?? el._ts; draw(); arm(); };
  // Not an ask that waits: nothing to answer, nothing takes keys.
  el.answered = () => {};
  el.isOpen = () => false;
  el.onKey = () => false;
  draw(); arm();
  return el;
}
