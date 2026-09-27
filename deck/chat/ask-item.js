// @ts-check
// A permission ask, inline (contract 1, kind "permission"): exactly what will run, from the
// ask's detail (Bash: the full command and its description; Edit: a diff of old and new; Write:
// the file and a preview; WebFetch: the URL; anything else: the input as keys and values), why
// (the reason Claude Code gave), and three answers: Allow once (Enter), Always in <project> (when
// the ask offers `always_project`: decision "always", scope "project"; "Always for this" when only
// `always` is offered), Deny (Esc, with an optional "tell <assistant> why" sent as `message`).
// Keys: A (or Enter) allows once, D denies at once, Esc opens Deny with a reason. No passkey: answering
// is the owner's own action (ADR 0024, no nagging). Once answered, here or on another screen (session.js calls .answered on ask.answered),
// the card loses its buttons and says what was decided; a failure says why and gives them back.
// A Mac session's ask (ask.machine) has the same buttons, sends `machine` with the answer, and says
// "on <machine>"; its refusals (sign in, passkey, offline, timeout) are presence.js macProblem's.
//
// ask.raised carries no detail, so the card is drawn from the event first and filled in by
// .update() once session.js has read threads.asks.

import { h, put } from "../js/dom.js";
import { attempt } from "../js/api.js";
import { icon } from "../js/icons.js";
import { clock } from "../js/fmt.js";
import { problemLine, macHeld, macLabel, macProblem } from "./presence.js";
import { renderUnified } from "./lib/diff.js";
import { outputEl, kvGrid } from "./blocks.js";
import { langOf } from "./lib/blocks.js";

const WORDS = { allow: "Allowed once", always: "Always allowed", deny: "Denied", cancelled: "Withdrawn" };

/** "Answered from the Capsule · 14:31": another screen answered it (Needs, the phone, the Capsule). */
export function fromLine(from) {
  if (!from || !from.where) return null;
  return h("div", { class: "cv-from" }, `Answered from ${from.where}` + (from.at ? ` · ${clock(from.at)}` : ""));
}

/** The "always" answer on offer: in a project (always_project), for this (always), or none. */
export function alwaysChoice(ask) {
  if (ask.always_project) return { label: `Always in ${ask.always_project}`, input: { decision: "always", scope: "project" } };
  if (ask.always) return { label: "Always for this", input: { decision: "always" } };
  return null;
}

/** What the ask wants, in a few words: "run a command", "edit app.js". */
export function askVerb(ask) {
  const d = ask.detail || {};
  const file = d.file || ask.destination || "";
  const short = String(file).split("/").filter(Boolean).pop() || file;
  switch (ask.tool) {
    case "Bash": return "run a command";
    case "Edit": case "MultiEdit": return short ? `edit ${short}` : "edit a file";
    case "Write": return short ? `write ${short}` : "write a file";
    case "Read": return short ? `read ${short}` : "read a file";
    case "WebFetch": return "fetch a page";
    case "WebSearch": return "search the web";
    default: return ask.summary || `use ${ask.tool}`;
  }
}

/** The "what exactly will run" part, from the ask's detail. */
function what(ask) {
  const d = ask.detail;
  if (!d) {
    return h("div", { class: "ask-grid" },
      h("span", { class: "gate-key" }, "Tool"), h("span", { class: "gate-val" }, ask.tool),
      ask.destination ? h("span", { class: "gate-key" }, "Where") : null, ask.destination ? h("span", { class: "gate-val" }, ask.destination) : null,
    );
  }
  switch (ask.tool) {
    case "Bash":
      return [h("pre", { class: "cv-cmd" }, h("code", null, "$ " + String(d.command ?? ""))), d.description ? h("div", { class: "cv-note" }, String(d.description)) : null];
    case "Edit": case "MultiEdit":
      return [h("div", { class: "cv-file" }, icon("file", 12), h("span", { class: "cv-file-path" }, String(d.file || ""))), renderUnified(d.old ?? "", d.new ?? "")];
    case "Write":
      return [h("div", { class: "cv-file" }, icon("file", 12), h("span", { class: "cv-file-path" }, String(d.file || "")), h("span", { class: "cv-file-note" }, "new file")),
        d.content != null ? outputEl(d.content, { lang: langOf(d.file), max: 16 }) : null];
    case "WebFetch":
      return h("div", { class: "cv-link" }, icon("search", 12), h("span", null, String(d.url || "")));
    default: {
      const grid = kvGrid(d.input || Object.fromEntries(Object.entries(d).filter(([k]) => k !== "input")));
      return grid || h("div", { class: "cv-note" }, ask.summary || ask.tool);
    }
  }
}

const MINUS = "\u2212";

/**
 * The diff summary (detail.changes, detail.totals, detail.truncated from the switchboard): a
 * "Changed files +188 -133" row that opens to one row per file. Additions in the positive
 * colour, removals neutral, never red. Null when the ask carries no changes.
 * @param {any} d the ask's detail
 * @param {{ open: boolean }} view whether the per-file rows show; kept across redraws
 */
export function changesRow(d, view) {
  const rows = Array.isArray(d?.changes) ? d.changes : [];
  if (!rows.length) return null;
  const sum = (k) => rows.reduce((n, r) => n + (r.binary ? 0 : Number(r[k]) || 0), 0);
  const t = d.totals || {};
  const files = Number(t.files) || rows.length;
  const added = t.added ?? sum("added"), removed = t.removed ?? sum("removed");
  const counts = (a, r) => [h("span", { class: "cv-ch-add" }, `+${a}`), h("span", { class: "cv-ch-del" }, `${MINUS}${r}`)];
  const wrap = h("div", { class: "cv-changes" });
  const draw = () => {
    const head = h("button", { class: "cv-ch-head", type: "button", "aria-expanded": String(view.open), onclick: () => { view.open = !view.open; draw(); } },
      icon("chevron", 12),
      h("span", { class: "cv-ch-label", title: `${files} ${files === 1 ? "file" : "files"}` }, files === 1 ? "Changed file" : "Changed files"),
      h("span", { class: "cv-ch-counts" }, ...counts(added, removed)));
    const list = view.open ? h("div", { class: "cv-ch-list" },
      ...rows.map(r => h("div", { class: "cv-ch-row" },
        h("span", { class: "cv-ch-file", title: String(r.file || "") }, String(r.file || "")),
        h("span", { class: "cv-ch-counts" }, ...(r.binary ? [h("span", { class: "cv-ch-bin" }, "binary")] : counts(Number(r.added) || 0, Number(r.removed) || 0))))),
      d.truncated && files > rows.length ? h("div", { class: "cv-ch-more" }, `and ${files - rows.length} more`) : null) : null;
    put(wrap, head, list);
  };
  draw();
  return wrap;
}

/**
 * @param {{ id: string, tool: string, summary?: string|null, destination?: string|null, reason?: string|null, agent?: string|null,
 *   kind?: string, detail?: any, always?: boolean, always_project?: string|null, machine?: string|null, node?: string|null, elsewhere?: string|null }} ask
 * machine: the paired Mac the session runs on; the answer goes there (threads.answer's `machine`) and
 * the card says "on <machine>". elsewhere: set once the box has shown it cannot forward answers, so
 * the card says "Answer it on <mac>" with no buttons (presence.js macHeld).
 * @returns {HTMLElement & { update: (a: any) => void, answered: (decision: string, answers?: any, from?: { where: string, at?: number|null }|null) => void,
 *   onKey: (e: KeyboardEvent) => boolean, isOpen: () => boolean }}
 * answered's `from`: the screen that answered, when it was another one ("Answered from the Capsule · 14:31").
 */
export function askCard(ask) {
  const el = /** @type {any} */ (h("div", { class: "ask-card cv-ask", tabindex: "-1" }));
  el._kind = "card";
  const state = { busy: false, decided: /** @type {string|null} */ (null), error: /** @type {any} */ (null), denying: false, why: "",
    from: /** @type {{ where: string, at?: number|null }|null} */ (null), again: /** @type {(o: { presence?: boolean }) => void} */ (() => {}) };
  const who = ask.agent || "Vyre";
  const changesView = { open: false };

  /** @param {string} decision @param {Record<string, any>} [extra] @param {{ presence?: boolean }} [opts] a passkey proof first (a Mac's refusal asked for one) */
  const answer = async (decision, extra = {}, opts = {}) => {
    if (state.busy || state.decided) return;
    state.busy = true; state.error = null; draw();
    const input = { ask: ask.id, decision, surface: "deck", ...extra, ...(decision === "deny" && state.why.trim() ? { message: state.why.trim() } : {}),
      ...(ask.machine ? { machine: ask.machine } : {}) };
    const r = await attempt("threads.answer", input, opts.presence ? { presence: true } : {});
    state.busy = false;
    if (!r.error) state.decided = decision;
    else if (!macHeld(ask, r.error)) { state.error = r.error; state.again = o => answer(decision, extra, { ...opts, ...o }); }
    draw();
  };
  const problem = () => state.error ? (ask.machine ? macProblem(state.error, ask.machine, ask, state.again) : problemLine(state.error)) : null;

  function draw() {
    const title = h("div", { class: "gate-row cv-ask-top" }, h("span", { class: "cv-ask-dot", "aria-hidden": "true" }), h("span", { class: "ask-title" }, `${who} wants to ${askVerb(ask)}`),
      ask.machine && !ask.elsewhere ? macLabel(ask.machine) : null);
    if (state.decided) {
      put(el, title, h("div", { class: "gate-resolved" }, icon(state.decided === "deny" || state.decided === "cancelled" ? "close" : "check", 14), WORDS[state.decided] || state.decided),
        fromLine(state.from));
      el.classList.add("answered");
      return;
    }
    // A session on the paired Mac, and a box that cannot forward the answer: the card says where to answer.
    if (ask.elsewhere) {
      put(el, title, h("div", { class: "cv-ask-what" }, what(ask)),
        ask.reason ? h("div", { class: "gate-note cv-ask-why" }, String(ask.reason)) : null,
        changesRow(ask.detail, changesView),
        h("div", { class: "cv-elsewhere" }, icon("laptop", 12), `Answer it on ${ask.elsewhere}`));
      return;
    }
    const whyInput = state.denying ? h("input", { class: "cv-why", type: "text", placeholder: `Tell ${who} why (optional)`, value: state.why,
      oninput: e => { state.why = e.target.value; },
      onkeydown: e => {
        if (e.key === "Enter") { e.preventDefault(); answer("deny"); }
        else if (e.key === "Escape") { e.preventDefault(); state.denying = false; draw(); el.focus?.(); }
      } }) : null;
    put(el, title,
      h("div", { class: "cv-ask-what" }, what(ask)),
      ask.reason ? h("div", { class: "gate-note cv-ask-why" }, String(ask.reason)) : null,
      changesRow(ask.detail, changesView),
      state.denying ? h("div", { class: "cv-deny-row" }, whyInput,
        h("button", { class: "btn btn-ghost", disabled: state.busy, onclick: () => answer("deny") }, "Deny"),
        h("button", { class: "btn btn-ghost btn-sm", disabled: state.busy, onclick: () => { state.denying = false; draw(); } }, "Back"))
      : h("div", { class: "gate-actions" },
        h("button", { class: "btn btn-primary", disabled: state.busy, onclick: () => answer("allow") }, "Allow once", h("span", { class: "kbd" }, "A")),
        alwaysBtn(),
        h("button", { class: "btn btn-ghost", disabled: state.busy, onclick: () => { state.denying = true; draw(); } }, "Deny", h("span", { class: "kbd" }, "D")),
      ),
      problem(),
    );
    if (whyInput) whyInput.focus?.();
  }

  function alwaysBtn() {
    const c = alwaysChoice(ask);
    return c ? h("button", { class: "btn btn-ghost cv-always", disabled: state.busy, onclick: () => answer(c.input.decision, c.input.scope ? { scope: c.input.scope } : {}) }, c.label) : null;
  }

  el.update = a => { Object.assign(ask, a); if (!state.decided) draw(); };
  el.answered = (decision, _answers, from) => {
    // Answered here already: the event only confirms it, and says nothing about another screen.
    if (!state.decided && from) state.from = from;
    state.busy = false; state.error = null; state.decided = ["allow", "always", "deny"].includes(decision) ? decision : "cancelled"; draw();
  };
  el.isOpen = () => !state.decided && !ask.elsewhere;
  /** A key routed here by the session (focus not in the composer). Returns whether it was used. */
  el.onKey = e => {
    if (state.decided || state.busy || ask.elsewhere) return false;
    if ((e.key === "Enter" || e.key === "a" || e.key === "A") && !state.denying) { answer("allow"); return true; }
    if ((e.key === "d" || e.key === "D") && !state.denying) { answer("deny"); return true; }
    if (e.key === "Escape") { if (state.denying) { state.denying = false; draw(); } else { state.denying = true; draw(); } return true; }
    return false;
  };
  draw();
  return el;
}
