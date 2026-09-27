// @ts-check
// A question ask (contract 1, kind "question": Claude Code's AskUserQuestion), as a card. One
// step per question, a stepper ("1 of 2") when there are several, then a review step, then
// Submit. Each option is a row with its label and description; multi-select rows are checkboxes.
// An "Other" row takes typed text. When options carry previews, the focused option's preview
// sits beside the list on a wide screen and under it on a phone (markdown or code, through
// lib/markdown.js, in a mono panel).
//
// The card (docs/design/system/components/question-card.md): a header with the needs-you dot,
// "Question", the step and "kit · 14:40"; the question; the choice rows with their number as a key
// chip on the right; the footer with Submit (or Next, Review) and Decline. The card grows to fit
// its choices; past its cap (the height of the view, less the composer) the choices scroll inside
// it and the footer stays in sight. The preview never squeezes the choices: beside them it scrolls
// on its own, under them (a phone) it scrolls with them.
//
// Keys (routed by session.js when focus is not in the composer): 1-9 pick an option, arrow keys
// move, space toggles (multi-select) or picks, Enter picks and moves on (on the last step it
// submits), Esc steps back. Submit calls threads.answer { ask, decision: "allow", answers,
// surface: "deck" } (no passkey, ADR 0024); Decline sends "deny". Answered here or elsewhere
// (ask.answered), the card folds to what was answered. A Mac session's ask (ask.machine) is answered
// the same way with `machine` added, and says "on <machine>"; its refusals are presence.js macProblem's.

import { h, put, add } from "../js/dom.js";
import { queued } from "../js/api.js";
import { icon } from "../js/icons.js";
import { renderMarkdown } from "./lib/markdown.js";
import { problemLine, macHeld, macLabel, macProblem } from "./presence.js";
import { fromLine, cardHead, keyHint, busyLabel, widthOf } from "./ask-item.js";
import { emptyPick, choose, answerText, answered, answerInput } from "./lib/answers.js";

/**
 * @param {{ id: string, questions?: any[], agent?: string|null, machine?: string|null, node?: string|null, elsewhere?: string|null }} ask
 * machine: the paired Mac the answer goes to; elsewhere: set once the box has shown it cannot forward it (no buttons here)
 * @returns {HTMLElement & { update: (a: any) => void, answered: (decision: string, answers?: any, from?: { where: string, at?: number|null }|null) => void,
 *   onKey: (e: KeyboardEvent) => boolean, isOpen: () => boolean }}
 */
/** The boxes that may scroll inside the card: the choices beside a preview, and the body. */
const SCROLLERS = [".cv-q-list", ".cv-q-body"];

export function questionCard(ask) {
  const el = /** @type {any} */ (h("section", { class: "ask-card cv-q", tabindex: "0", "aria-label": `Question from ${ask.agent || "Vyre"}` }));
  el._kind = "card";
  let questions = Array.isArray(ask.questions) ? ask.questions : [];
  let picks = questions.map(() => emptyPick());
  let cursor = questions.map(() => 0);
  const state = { step: 0, busy: /** @type {"submit"|"decline"|null} */ (null), width: 0, error: /** @type {any} */ (null), decided: /** @type {string|null} */ (null), shown: /** @type {Record<string, string>|null} */ (null),
    from: /** @type {{ where: string, at?: number|null }|null} */ (null), again: /** @type {(o: { presence?: boolean }) => void} */ (() => {}) };
  const who = ask.agent || "Vyre";
  const many = () => questions.length > 1;
  const reviewStep = () => questions.length; // only reached when there are several
  const onReview = () => many() && state.step === reviewStep();
  /** @type {HTMLElement|null} */ let nextBtn = null;
  /** @type {HTMLInputElement|null} */ let otherInput = null;

  function rows(i) { return questions[i].options.length + 1; } // the options, then "Other"

  function pickAt(i, row, advance) {
    const q = questions[i];
    const label = row < q.options.length ? q.options[row].label : null;
    cursor[i] = row;
    if (label == null) {
      if (!q.multiSelect || !picks[i].other) picks[i] = choose(q, picks[i], null);
      draw(); otherInput?.focus?.(); return;
    }
    picks[i] = choose(q, picks[i], label);
    if (advance && !q.multiSelect) { next(); return; }
    draw();
  }

  function next() {
    const i = state.step;
    if (!onReview() && !answered(questions[i], picks[i])) return;
    if (!many() || onReview()) { submit(); return; }
    state.step = Math.min(state.step + 1, reviewStep());
    draw(); el.focus?.();
  }
  function back() { if (state.step > 0) { state.step--; draw(); el.focus?.(); } }

  const onMac = () => (ask.machine ? { machine: ask.machine } : {});
  // A Mac's refusal asks for a passkey on the card (macProblem), so the outbox never proves on its own.
  const presence = (/** @type {{ presence?: boolean }} */ o) => ({ presence: o.presence ? true : ask.machine ? false : undefined });
  /** @param {{ presence?: boolean }} [opts] a passkey proof first (a Mac's refusal asked for one) */
  async function submit(opts = {}) {
    if (state.busy || state.decided) return;
    let input;
    try { input = { ...answerInput(ask.id, questions, picks), ...onMac() }; } catch (e) { state.error = e; draw(); return; }
    state.width = widthOf(el, "submit");
    state.busy = "submit"; state.error = null; draw();
    const r = await queued("threads.answer", input, presence(opts));
    state.busy = null;
    if (!r.error) { state.decided = "allow"; state.shown = input.answers; }
    else failed(r.error, o => submit({ ...opts, ...o }));
    draw();
  }
  /** @param {{ presence?: boolean }} [opts] */
  async function decline(opts = {}) {
    if (state.busy || state.decided) return;
    state.width = widthOf(el, "decline");
    state.busy = "decline"; state.error = null; draw();
    const r = await queued("threads.answer", { ask: ask.id, decision: "deny", surface: "deck", ...onMac() }, presence(opts));
    state.busy = null;
    if (!r.error) state.decided = "deny";
    else failed(r.error, o => decline({ ...opts, ...o }));
    draw();
  }
  function failed(err, again) { if (!macHeld(ask, err)) { state.error = err; state.again = again; } }
  const problem = () => state.error ? (ask.machine ? macProblem(state.error, ask.machine, ask, state.again) : problemLine(state.error)) : null;

  function draw() {
    // The choices' scroll survives a redraw (a pick, an arrow key), then the focused row is kept in sight.
    const scrolled = SCROLLERS.map(sel => /** @type {any} */ (el.querySelector?.(sel))?.scrollTop || 0);
    const q0 = questions[state.step];
    const title = cardHead({ kind: "Question", who, at: ask.at ?? ask.created_at, open: !state.decided,
      mac: ask.machine && !ask.elsewhere ? macLabel(ask.machine) : null,
      extra: [many() && !state.decided ? h("span", { class: "cv-q-step" }, onReview() ? "Review" : `${state.step + 1} of ${questions.length}`) : null,
        q0 && q0.header && !onReview() && !ask.elsewhere ? h("span", { class: "cv-q-chip" }, q0.header) : null] });
    otherInput = null; nextBtn = null;
    if (state.decided) { put(el, title, folded()); el.classList.add("answered"); return; }
    if (!questions.length) { put(el, title, h("div", { class: "cv-note" }, "Reading the question…")); return; }
    // A session on the paired Mac, and a box that cannot forward the answer: the questions show and say where to answer.
    if (ask.elsewhere) {
      put(el, title, h("dl", { class: "cv-q-review" }, questions.map(q => [h("dt", null, q.header || q.question), h("dd", null, q.options.map(o => o.label).join(" / "))])),
        h("div", { class: "cv-elsewhere" }, icon("laptop", 12), `Answer it on ${ask.elsewhere}`));
      return;
    }
    put(el, title, onReview() ? review() : stepView(state.step), actions(), problem());
    keepInSight(scrolled);
  }

  /** Put the choices back where they were scrolled, then scroll just enough to show the focused row. */
  function keepInSight(tops) {
    const boxes = SCROLLERS.map(sel => /** @type {any} */ (el.querySelector?.(sel)));
    boxes.forEach((b, n) => { if (b) b.scrollTop = tops[n]; });
    const row = /** @type {any} */ (el.querySelector?.(".cv-q-opt.cv-focus"));
    const box = boxes.find(b => b && b.scrollHeight > b.clientHeight + 1 && b.contains?.(row));
    if (!row || !box || !row.getBoundingClientRect) return;
    const r = row.getBoundingClientRect(), b = box.getBoundingClientRect();
    if (r.top < b.top) box.scrollTop -= b.top - r.top;
    else if (r.bottom > b.bottom) box.scrollTop += r.bottom - b.bottom;
  }

  function folded() {
    const a = state.shown;
    const list = a && Object.keys(a).length ? h("dl", { class: "cv-q-done" }, Object.entries(a).map(([k, v]) => [h("dt", null, headerFor(k)), h("dd", null, v)])) : null;
    return [list, h("div", { class: "gate-resolved" }, icon(state.decided === "deny" ? "close" : "check", 14),
      state.decided === "deny" ? "Declined" : state.decided === "cancelled" ? "Withdrawn" : "Answered"), fromLine(state.from)];
  }
  const headerFor = question => { const q = questions.find(x => x.question === question); return (q && q.header) || question; };

  function stepView(i) {
    const q = questions[i];
    const pick = picks[i];
    const focusRow = cursor[i];
    const hasPreview = q.options.some(o => o.preview);
    const qid = `${ask.id}-q${i}`;
    const list = h("div", { class: "cv-q-opts", role: q.multiSelect ? "group" : "radiogroup", "aria-labelledby": `${qid}-text` },
      q.options.map((o, n) => {
        const on = pick.chosen.includes(o.label);
        const desc = o.description ? `${qid}-d${n}` : null;
        return h("button", { class: "cv-q-opt cv-choice" + (on ? " cv-choice-on" : "") + (n === focusRow ? " cv-focus" : ""), type: "button", role: q.multiSelect ? "checkbox" : "radio",
          "aria-checked": String(on), "aria-describedby": desc, "aria-keyshortcuts": n < 9 ? String(n + 1) : null, onclick: () => pickAt(i, n, false) },
          mark(q, on),
          h("span", { class: "cv-q-txt" }, h("span", { class: "cv-q-label" }, o.label), desc ? h("span", { class: "cv-q-desc", id: desc }, o.description) : null),
          numChip(n),
        );
      }),
      otherRow(i),
    );
    const preview = hasPreview ? previewPanel(q.options[Math.min(focusRow, q.options.length - 1)]) : null;
    // Beside the choices (wide), each column scrolls on its own; under them (narrow), the body scrolls
    // as one so the choices come first. The CSS picks which box scrolls (SCROLLERS).
    return h("div", { class: "cv-q-q" },
      h("div", { class: "cv-q-head" }, h("span", { class: "cv-q-text", id: `${qid}-text` }, q.question),
        q.multiSelect ? h("span", { class: "cv-note" }, "Pick any") : null),
      h("div", { class: "cv-q-body" + (hasPreview ? " cv-q-has-preview" : "") }, hasPreview ? h("div", { class: "cv-q-list" }, list) : list, preview),
    );
  }

  /** The radio (one answer) or the check box (several). */
  function mark(q, on) {
    return h("span", { class: "cv-q-mark" + (q.multiSelect ? " cv-q-box cv-chk" + (on ? " cv-chk-on" : "") : " cv-q-dot cv-radio" + (on ? " cv-radio-on" : "")), "aria-hidden": "true" }, on && q.multiSelect ? "✓" : "");
  }
  /** The row's number key as a key chip on the right (1 to 9; desktop only, the CSS hides it on touch). */
  function numChip(n) { return n < 9 ? h("span", { class: "kbd cv-q-num", "aria-hidden": "true" }, String(n + 1)) : null; }

  function otherRow(i) {
    const q = questions[i], pick = picks[i];
    const n = q.options.length;
    const row = h("button", { class: "cv-q-opt cv-choice cv-q-other" + (pick.other ? " cv-choice-on" : "") + (cursor[i] === n ? " cv-focus" : ""), type: "button", role: q.multiSelect ? "checkbox" : "radio",
      "aria-checked": String(pick.other), "aria-keyshortcuts": n < 9 ? String(n + 1) : null, onclick: () => pickAt(i, n, false) },
      mark(q, pick.other),
      h("span", { class: "cv-q-txt" }, h("span", { class: "cv-q-label" }, "Other")),
      numChip(n));
    if (!pick.other) return row;
    otherInput = /** @type {any} */ (h("input", { class: "cv-q-input", type: "text", placeholder: "Type your answer", value: pick.text,
      oninput: e => { picks[i] = { ...picks[i], text: e.target.value }; if (nextBtn) /** @type {any} */ (nextBtn).disabled = !answered(q, picks[i]); },
      onkeydown: e => {
        if (e.key === "Enter") { e.preventDefault(); next(); }
        else if (e.key === "Escape") { e.preventDefault(); el.focus?.(); }
      } }));
    return h("div", { class: "cv-q-other-wrap" }, row, otherInput);
  }

  function previewPanel(o) {
    const panel = h("div", { class: "cv-q-preview msg-text" });
    if (o && o.preview) add(panel, renderMarkdown(o.preview)); else add(panel, h("span", { class: "cv-note" }, "No preview"));
    return panel;
  }

  function review() {
    return h("dl", { class: "cv-q-review" }, questions.map((q, i) => [
      h("dt", null, q.header || q.question),
      h("dd", null, answerText(q, picks[i]) || "(no answer)", " ", h("button", { class: "btn btn-ghost btn-sm", type: "button", onclick: () => { state.step = i; draw(); } }, "Change")),
    ]));
  }

  function actions() {
    const last = !many() || onReview();
    const ready = onReview() ? questions.every((q, i) => answered(q, picks[i])) : answered(questions[state.step], picks[state.step]);
    const sending = state.busy === "submit", declining = state.busy === "decline";
    const keep = on => (on && state.width ? { minWidth: `${state.width}px` } : null);
    nextBtn = h("button", { class: "btn btn-primary cv-ask-btn" + (sending ? " cv-ask-busy" : ""), type: "button", "data-act": "submit",
      disabled: !!state.busy || !ready, "aria-busy": sending ? "true" : null, "aria-keyshortcuts": "Enter", style: keep(sending), onclick: next },
    sending ? busyLabel("Sending") : [last ? "Submit" : state.step === questions.length - 1 ? "Review" : "Next", keyHint("⏎")]);
    return h("div", { class: "gate-actions cv-q-actions" },
      nextBtn,
      state.step > 0 ? h("button", { class: "btn btn-ghost", type: "button", disabled: !!state.busy, onclick: back }, "Back") : null,
      h("button", { class: "btn btn-ghost cv-ask-btn" + (declining ? " cv-ask-busy" : ""), type: "button", "data-act": "decline", disabled: !!state.busy,
        "aria-busy": declining ? "true" : null, style: keep(declining), onclick: () => decline() }, declining ? busyLabel("Declining") : "Decline"),
    );
  }

  el.update = a => {
    Object.assign(ask, a);
    if (Array.isArray(a.questions) && a.questions.length) {
      // A fuller copy (threads.asks has the previews the event dropped): keep what was picked.
      const had = questions;
      questions = a.questions;
      picks = questions.map((q, i) => (had[i] && had[i].question === q.question ? picks[i] : emptyPick()));
      cursor = questions.map((_, i) => cursor[i] || 0);
    }
    if (!state.decided) draw();
  };
  el.answered = (decision, answers, from) => {
    // Answered on another screen (Needs, the phone): say where. Answered here: the event only confirms it.
    if (!state.decided && from) state.from = from;
    state.busy = null; state.error = null;
    state.decided = decision === "allow" || decision === "always" ? "allow" : decision === "deny" ? "deny" : "cancelled";
    if (answers && typeof answers === "object" && !Array.isArray(answers)) state.shown = answers;
    else if (!state.shown && state.decided === "allow") { try { state.shown = answerInput(ask.id, questions, picks).answers; } catch { state.shown = null; } }
    draw();
  };
  el.isOpen = () => !state.decided && !ask.elsewhere;
  el.onKey = e => {
    if (state.decided || state.busy || !questions.length || ask.elsewhere) return false;
    if (e.key === "Escape") { back(); return true; }
    if (onReview()) { if (e.key === "Enter") { submit(); return true; } return false; }
    const i = state.step, q = questions[i];
    if (/^[1-9]$/.test(e.key)) { const n = Number(e.key) - 1; if (n < rows(i)) { pickAt(i, n, true); return true; } return false; }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") { cursor[i] = (cursor[i] + (e.key === "ArrowDown" ? 1 : rows(i) - 1)) % rows(i); draw(); return true; }
    if (e.key === " ") { pickAt(i, cursor[i], false); return true; }
    if (e.key === "Enter") {
      if (!q.multiSelect && !answered(q, picks[i])) { pickAt(i, cursor[i], true); return true; }
      next(); return true;
    }
    return false;
  };
  draw();
  return el;
}
