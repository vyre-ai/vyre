// @ts-check
// The detail sheet of one Needs you item on the phone (docs/design/phone.md section 5): an ask
// (a tool call), a draft held at the Gate, a question from a session, or a Mac asking to pair.
//
// Header: the agent's tile and "<agent> asks · <project>", close; the title; a violet dot and
// "Held 4 min"; Open session, which closes the sheet and opens the exact moment in Chat.
//
// The no-nag rule: Approve, Always in <project>, Deny, Answer, Later and Discard are the owner's
// own acts and prove nothing (js/needs.js sends them with presence "asked"). Only Send, which
// goes outside as the person, asks for Face ID. Deny, Discard and Later are handed back to the
// caller (onLater), which waits them out behind its Undo toast; the rest are sent from here, and
// on success the sheet closes and the caller hears onDone.
//
//   openNeedSheet(n, { word: "Face ID", onDone(what), onLater(what), onPaired(name) })

import { h, put, go } from "./dom.js";
import { openSheet, closeGlyph } from "./sheet.js";
import * as needs from "./needs.js";
import { form, gateFields } from "./editable.js";
import { pairCard } from "./pair.js";
import { initial, clock, since } from "./fmt.js";
import { coveredUntil } from "./api.js";
import { titleOf, heldFor, sheetWho, sessionHref, sheetPrimary, factRows, questionAnswers, pushTarget, elsewhere } from "./need-rows.js";

const NS = "http://www.w3.org/2000/svg";
/**
 * The phone's glyphs, on a 24 grid with a 1.5 stroke (section 2).
 * @param {"face-id"|"check"|"x"|"send"|"right"|"history"|"chat"|"terminal"} name @param {number} [size]
 */
export function glyph(name, size = 16) {
  const D = {
    "face-id": ["M4 8.5V6a2 2 0 012-2h2.5M15.5 4H18a2 2 0 012 2v2.5M20 15.5V18a2 2 0 01-2 2h-2.5M8.5 20H6a2 2 0 01-2-2v-2.5",
      "M9 9.5v1.2M15 9.5v1.2M12 9.5v3.8h-1M9.3 16.2a4 4 0 005.4 0"],
    check: ["M5 12.5l4.5 4.5L19 7.5"],
    x: ["M6.5 6.5l11 11M17.5 6.5l-11 11"],
    send: ["M12 19V5M6 11l6-6 6 6"],
    right: ["M9.5 6l6 6-6 6"],
    history: ["M4.5 12a7.5 7.5 0 102.2-5.3L4.5 9", "M4.5 4.5V9H9", "M12 8v4.2l2.8 1.8"],
    terminal: ["M3.5 5.5h17v13h-17z", "M7.5 10l2.5 2-2.5 2M12.5 15h4"],
    chat: ["M4 5.5h16v10.5h-8.5L7 19.5V16H4z"],
  };
  const svg = document.createElementNS(NS, "svg");
  for (const [k, v] of Object.entries({ width: String(size), height: String(size), viewBox: "0 0 24 24", fill: "none", stroke: "currentColor",
    "stroke-width": size >= 26 ? "1.7" : "1.5", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" })) svg.setAttribute(k, v);
  for (const d of D[name] || []) { const p = document.createElementNS(NS, "path"); p.setAttribute("d", d); svg.append(p); }
  return svg;
}

/** An error, in plain words: a fact, not an alarm (section 11). */
export function problem(/** @type {any} */ e) {
  if (e?.missing) return `The ${e.module || "needed"} module is not running, so this cannot be answered here yet.`;
  if (e?.code === "offline") return "Can't reach your box. Nothing was sent.";
  if (e?.code === "cancelled") return "Face ID was cancelled. Nothing was sent.";
  if (e?.code === "no_passkey") return "This phone has no passkey yet, so it cannot send. Add one in Settings.";
  if (e?.code === "denied") return "The box does not let this phone answer this. Answer it from the terminal or chat.";
  return String(e?.message || e || "It did not go through.");
}

/**
 * @typedef {"approve"|"always"|"send"|"answer"|"pair"} Done
 * @typedef {"deny"|"discard"|"later"} Later
 * @typedef {{ word: string, onDone?: (what: Done, n: any) => void, onLater?: (what: Later, n: any) => void, onPaired?: (name: string) => void }} Opts
 */

/**
 * Open one item's sheet.
 * @param {any} n a needs.js item, or { kind: "pair", id, at, pair }
 * @param {Opts} o
 */
export function openNeedSheet(n, o) {
  const title = titleOf(n);
  /** @type {(() => void)[]} */ const offs = [];
  const s = openSheet({ title, label: `${title}. ${sheetWho(n)}`, onClose: () => { for (const f of offs.splice(0)) f(); },
    build(body, close, { head, actions }) {
      const href = n.kind === "pair" ? null : sessionHref(n);
      put(head,
        h("div", { class: "nsh-who" },
          h("div", { class: "nsh-who-l" }, h("span", { class: "nsh-tile", "aria-hidden": "true" }, n.kind === "pair" ? "m" : n.agent ? initial(n.agent) : glyph("terminal", 14)), h("span", null, sheetWho(n))),
          h("button", { type: "button", class: "sheet-close", "aria-label": "Close", onclick: close }, closeGlyph(16))),
        h("h2", { class: "sheet-title nsh-title" }, title),
        h("div", { class: "nsh-held" },
          h("span", { class: "nsh-held-l" }, h("span", { class: "nsh-dot", "aria-hidden": "true" }), n.kind === "pair" ? minutesLeft(n.pair?.expires) : heldFor(n.at)),
          href ? h("a", { class: "nsh-open", href, onclick: (/** @type {MouseEvent} */ e) => { e.preventDefault(); close(); go(href); } }, "Open session", glyph("right", 16)) : null));
      const ctl = { close, actions, body };
      if (n.kind === "draft") draftBody(n, o, ctl, offs);
      else if (n.kind === "question") questionBody(n, o, ctl);
      else if (n.kind === "pair") pairBody(n, o, ctl);
      else askBody(n, o, ctl, offs);
      // A Mac session's ask or question on a box that cannot forward the answer: shown, not answered here.
      const mac = elsewhere(n);
      if (mac) {
        for (const b of body.querySelectorAll("button, input")) /** @type {HTMLButtonElement} */ (b).disabled = true;
        put(actions, h("p", { class: "nsh-note", role: "status" }, `Answer it on ${mac}`));
      }
      // Answered from another screen while this is open: say so, and nothing here can act twice.
      if (n.kind !== "pair") offs.push(needs.watch(list => {
        if (list.some(x => x.id === n.id) || busy.has(n.id)) return;
        for (const b of actions.querySelectorAll("button")) /** @type {HTMLButtonElement} */ (b).disabled = true;
        put(actions, h("p", { class: "nsh-note", role: "status" }, "This was answered on another screen."));
      }));
    } });
  return s;
}

/** Items being answered from a sheet right now, so the "answered elsewhere" line stays away. */
const busy = new Set();

/**
 * Send one answer from the sheet: buttons off while it goes, the reason under them on failure,
 * the sheet closed on success.
 * @param {any} n @param {HTMLElement} actions @param {HTMLElement} status @param {() => Promise<any>} run @param {() => void} ok
 */
async function send(n, actions, status, run, ok) {
  const buttons = /** @type {HTMLButtonElement[]} */ ([...actions.querySelectorAll("button")]);
  for (const b of buttons) b.disabled = true;
  put(status);
  busy.add(n.id);
  try { await run(); ok(); }
  catch (e) {
    // The box cannot forward answers to this Mac (needs.js): the line says where, the buttons stay off.
    if (/** @type {any} */ (e)?.elsewhere) { put(status, h("span", null, problem(e))); return; }
    put(status, h("span", { class: "nsh-failed" }, "failed"), h("span", null, problem(e)));
    for (const b of buttons) b.disabled = false;
  } finally { busy.delete(n.id); }
}

const statusLine = () => h("p", { class: "nsh-status", role: "status" });

/** @param {any} n @param {Opts} o @param {{ close: () => void, actions: HTMLElement, body: HTMLElement }} c @param {(() => void)[]} offs */
function askBody(n, o, { close, actions, body }, offs) {
  const cmd = String(n.detail?.command || n.detail?.file || n.detail?.url || n.command || n.tool || "");
  const isShell = n.tool === "Bash" || !!pushTarget(cmd) || !n.tool;
  const why = n.intent || n.why || "";
  const facts = factRows(n);
  put(body,
    h("pre", { class: "nsh-cmd" }, isShell ? h("span", { class: "nsh-dollar", "aria-hidden": "true" }, "$ ") : null, cmd),
    why ? [h("div", { class: "nsh-lbl" }, `Why ${n.agent || "it"} wants to`), h("p", { class: "nsh-why" }, why)] : null,
    facts.length ? h("div", { class: "nsh-facts" }, facts.map(f =>
      h("div", { class: "nsh-fact" }, h("span", null, f.label), h("span", null, f.value, f.counts ? h("span", { class: "nsh-counts" }, f.counts) : null)))) : null);

  const status = statusLine();
  const done = (/** @type {Done} */ what) => () => { close(); o.onDone?.(what, n); };
  const approve = h("button", { type: "button", class: "sb sb-primary sb-full", onclick: () =>
    send(n, actions, status, () => needs.answer(n, { label: "Approve", decision: "allow" }), done("approve")) }, sheetPrimary(n, o.word));
  const deny = h("button", { type: "button", class: "sb", onclick: () => { close(); o.onLater?.("deny", n); } }, "Deny");
  const row = h("div", { class: "sb-row" });
  let project = n.always_project || null;
  const drawRow = () => put(row, project ? h("button", { type: "button", class: "sb", onclick: () =>
    send(n, actions, status, () => needs.answer(n, { label: `Always in ${project}`, decision: "always" }), done("always")) }, `Always in ${projectName(n, project)}`) : null, deny);
  drawRow();
  put(actions, approve, row, status);

  // always_project can arrive a moment after ask.raised. The button joins the row then, but never
  // while a finger is down on the buttons: the row would move under it.
  let down = false, pending = false;
  actions.addEventListener("pointerdown", () => { down = true; });
  const up = () => { down = false; if (pending) { pending = false; drawRow(); } };
  actions.addEventListener("pointerup", up);
  actions.addEventListener("pointercancel", up);
  offs.push(needs.watch(list => {
    const now = list.find(x => x.id === n.id);
    if (!now || project || !now.always_project) return;
    project = now.always_project; n.always_project = project;
    if (down) pending = true; else drawRow();
  }));
}

/** "Harlow Legal" for the project an Always rule is written to, when the ask is in it. */
const projectName = (/** @type {any} */ n, /** @type {string} */ slug) => (n.project === slug && n.projectName) || slug;

/**
 * The quiet line under Send while a presence session covers this device: "Face ID covers sends
 * until 14:32", or nothing. The box's word on the item wins (js/api.js coveredUntil).
 * @param {any} presence the item's {required, covered, since} @param {string} word presenceWord() @param {number} [now]
 */
export function coverLine(presence, word, now = Date.now()) {
  const until = coveredUntil(presence);
  if (!until || until <= now) return "";
  const who = /^(passkey|fingerprint)$/.test(word) ? `Your ${word}` : word;
  // presence.since: when the person last proved it on this box, where the box says.
  const ago = typeof presence?.since === "number" && presence.since <= now ? `, confirmed ${since(presence.since, now)} ago` : "";
  return `${who} covers sends until ${clock(until)}${ago}`;
}

/** @param {any} n @param {Opts} o @param {{ close: () => void, actions: HTMLElement, body: HTMLElement }} c @param {(() => void)[]} offs */
function draftBody(n, o, { close, actions, body }, offs) {
  const g = n.gate || { kind: "send", to: [], draft: null, sources: [] };
  const status = statusLine();
  const primary = /** @type {HTMLButtonElement} */ (h("button", { type: "button", class: "sb sb-primary sb-full" }));
  // Covered by a presence session (the same check as the line under it): no Face ID is asked, so
  // the button says just "Send" and drops the Face ID mark.
  let edited = false;
  const label = () => { const covered = !!coverLine(n.presence, o.word);
    put(primary, covered ? null : glyph("face-id", 22), sheetPrimary(n, o.word, edited, covered)); };
  // The final words, To through Body, each a real input that reads as text until tapped (js/editable.js).
  const f = g.draft ? form(gateFields({ to: g.to, draft: g.draft }), { onchange: changed => { edited = changed; label(); }, cls: "nsh-form" }) : null;
  label();
  const recalled = g.sources?.length ? g.sources : g.recalled ? [{ text: g.recalled }] : [];
  put(body,
    g.error ? h("p", { class: "nsh-status nsh-sec" }, h("span", { class: "nsh-failed" }, "failed"), h("span", null, `It came back held: ${problem(g.error)}`)) : null,
    f ? f.el : h("div", { class: "nsh-sec" },
      g.summary ? h("p", { class: "nsh-why" }, g.summary) : null,
      h("p", { class: "nsh-note", style: { marginTop: "8px" } }, "The full draft cannot be shown here, so it cannot be sent from here. Open it on the Deck or in the session.")),
    recalled.length ? h("div", { class: "nsh-recall" },
      h("div", { class: "nsh-recall-h" }, glyph("history", 14), "From memory"),
      recalled.map((/** @type {any} */ x) => h("p", null, x.text, x.from ? h("span", { class: "nsh-from" }, x.from) : null))) : null);
  if (!f) primary.disabled = true;
  primary.addEventListener("click", () => {
    const bad = f?.error();
    if (bad) { put(status, h("span", { class: "nsh-failed" }, "failed"), h("span", null, bad)); return; }
    const edited = f && f.changed() ? f.edited() : null;
    send(n, actions, status, () => needs.answer(n, { label: "Send", decision: "approve" }, edited), () => { close(); o.onDone?.("send", n); });
  });
  const cover = h("p", { class: "nsh-note nsh-cover" });
  const drawCover = () => { const t = coverLine(n.presence, o.word); cover.hidden = !t; put(cover, t); label(); };
  drawCover();
  window.addEventListener("deck:presence", drawCover);
  offs.push(() => window.removeEventListener("deck:presence", drawCover));
  put(actions, primary, cover, h("button", { type: "button", class: "sb sb-full", onclick: () => { close(); o.onLater?.("discard", n); } }, "Discard"), status);
}

/** @param {any} n @param {Opts} o @param {{ close: () => void, actions: HTMLElement, body: HTMLElement }} c */
function questionBody(n, o, { close, actions, body }) {
  const qs = /** @type {{ question: string, header?: string, multiSelect?: boolean, options?: { label: string, description?: string }[] }[]} */ (n.questions || []);
  /** @type {Map<number, Set<string>>} */ const picked = new Map();
  /** @type {Map<number, string>} */ const typed = new Map();
  const status = statusLine();
  const answer = /** @type {HTMLButtonElement} */ (h("button", { type: "button", class: "sb sb-primary sb-full", disabled: true }, "Answer"));
  const ready = () => { answer.disabled = !qs.length || !questionAnswers(qs, picked, typed); };
  put(body, qs.map((q, i) => {
    const rows = h("div", { class: "nsh-choices", role: q.multiSelect ? "group" : "radiogroup", "aria-label": q.question });
    const other = /** @type {HTMLInputElement} */ (h("input", { type: "text", class: "nsh-other", placeholder: "Something else", "aria-label": `Something else: ${q.question}`,
      autocomplete: "off", enterkeyhint: "done" }));
    const choices = (q.options || []).map(opt => {
      const b = h("button", { type: "button", class: "nsh-choice", role: q.multiSelect ? "checkbox" : "radio", "aria-checked": "false" },
        h("span", { class: "nsh-choice-t" }, opt.label), opt.description ? h("span", { class: "nsh-choice-n" }, opt.description) : null);
      b.addEventListener("click", () => {
        const set = picked.get(i) || new Set();
        if (q.multiSelect) { if (set.has(opt.label)) set.delete(opt.label); else set.add(opt.label); }
        else { set.clear(); set.add(opt.label); other.value = ""; typed.delete(i); other.classList.remove("has-text"); }
        picked.set(i, set);
        for (const c of choices) c.setAttribute("aria-checked", String(set.has(c.querySelector(".nsh-choice-t")?.textContent || "")));
        ready();
      });
      return b;
    });
    other.addEventListener("input", () => {
      typed.set(i, other.value);
      other.classList.toggle("has-text", !!other.value.trim());
      // One choice or the typed text, for a single-select question.
      if (!q.multiSelect && other.value.trim()) { picked.delete(i); for (const c of choices) c.setAttribute("aria-checked", "false"); }
      ready();
    });
    put(rows, choices, other);
    return h("div", null, h("p", { class: "nsh-q" }, q.question), rows);
  }));
  answer.addEventListener("click", () => {
    const answers = questionAnswers(qs, picked, typed);
    if (!answers) return;
    send(n, actions, status, () => needs.answer(n, { label: "Answer", decision: "allow", answers }), () => { close(); o.onDone?.("answer", n); });
  });
  put(actions, answer, h("button", { type: "button", class: "sb sb-full", onclick: () => { close(); o.onLater?.("later", n); } }, "Later"), status);
}

/** A Mac asking to pair: pair.js's own card (the code, Approve with the passkey, Deny). */
function pairBody(/** @type {any} */ n, /** @type {Opts} */ o, /** @type {{ close: () => void, actions: HTMLElement, body: HTMLElement }} */ { close, body }) {
  const card = pairCard(n.pair, { onPaired: r => { setTimeout(close, 900); o.onPaired?.(r.name); } });
  put(body, h("div", { class: "nsh-pair" },
    h("p", { class: "nsh-why" }, "Type the code shown on that Mac. Approving it proves it is you with your passkey."), card));
  const code = /** @type {HTMLElement | null} */ (card.querySelector(".pair-code"));
  requestAnimationFrame(() => code?.focus({ preventScroll: true }));
}

const minutesLeft = (/** @type {number} */ t) => { const m = Math.ceil((Number(t) - Date.now()) / 60_000); return m > 0 ? `${m} min left` : "expired"; };
