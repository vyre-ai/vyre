// @ts-check
// The composer, like Claude Code in the terminal (the Composer board). The rules live in
// core/composer-state.js, shared with the phone; this file is the Deck's DOM for them.
//
// - Enter sends. While a turn runs it steers: the words join the running turn at its next step
//   (threads.send mode "steer", the box's default for a running turn; it answers {sent, steered,
//   uuid, turn}, the uuid the box's own), drawn at once with a "steering" marker that
//   thread.steered confirms. Alt+Enter, or the "Queue for after this turn" toggle, queues them
//   instead (mode "queue"; the answer is {sent: false, queued: true, queued_id: <row id>, uuid,
//   busy}): a row above the composer with Edit, Take back and Steer now. A
//   session busy in a terminal queues every message, steer or not. Shift+Enter is a new line; on
//   a touch screen Enter is a new line and the send button sends (hold it to queue).
// - The first character picks the mode and the composer names it: "/" commands (a picker with
//   the session's own list, threads.commands, else a static one; /model and /rewind open their
//   pickers here), "!" runs a shell command in the session's folder (threads.shell, the output as
//   a row), "/remember" saves a memory (threads.remember, to this project or about you), and "#" anywhere
//   tags a vault item, file, artifact, repo or project (mentions.search). "@" anywhere
//   opens files in the session's folder (files.search, ranked by core/match.js).
// - Esc stops the turn; Esc Esc with nothing typed opens the rewind picker; Esc leaves the shell
//   or memory mode and closes a picker. Shift+Tab cycles the permission mode (the chip under the
//   box); the model chip opens the model picker; the thinking chip turns thinking on or off.
// - Up in an empty composer recalls the last message sent here (per thread, the last 100), or
//   takes the newest queued message back to edit (threads.edit {thread, queued, text}). Down goes back.
// - A pasted image is attached (thumbnails; threads.send's caps: at most 5, 5 MB each, png, jpeg,
//   gif or webp) and sent with the words as images [{media_type, data}], once the box takes them
//   (core/caps.js SEND_IMAGES, learnt from threads.tasks with the rest of sessions 034c71e5; a
//   box that has not said yet is asked on the first paste, and an older one says so).
// - "!" answers {code, output} (and thread.shell echoes it); a denied line (the security floor)
//   is an error on its row. "#" answers {scope, file}: the note names the file.
//
// The model chip opens the model picker: the aliases (opus, sonnet, haiku) and every model
// sessions.models.get names per purpose, "now" on this thread's; threads.model switches it (a
// stopped thread when it next runs) and model.switched moves the chip.
//
// Tools are learnt through core/caps.js: the first "no such tool" from an older box (or its
// threads.tasks answering so, for the tools that shipped with it) switches a control off, with "Needs the sessions update" as its title; the words stay in the box. A paired Mac's session (opts.machine) keeps the plain send it had: threads.send
// {thread, text, surface, machine}, no chips, and the notes for an offline or slow Mac.
//
// A session busy in the user's terminal takes the message into the inbox queue instead: threads.send
// answers {queued: true, queued_id: <row id>, uuid, name, note} (an older box: no queued_id), and
// opts.onQueue hears how many wait and for whom (the Mac's lease line).

import { h, put, link } from "../js/dom.js";
import { kbd } from "../js/platform.js";
import { attempt, queued as viaOutbox, on } from "../js/api.js";
import { icon } from "../js/icons.js";
import {
  draftKind, draftBody, teammateRole, kindLabel, findMention, applyMention, findVaultMention, rankFiles, historyStore, remember, recall, recalling, stopRecall,
  upAction, enterAction, createEsc, escape, nextMode, modeLabel, actionFor, addImage, removeImage, sendImages, newUuid, IMAGE_TYPES,
  modelChoices, shortModel,
} from "./core/composer-state.js";
import { findCommand, rankCommands, applyCommand, normalizeCommands, sourceLabel } from "./core/commands.js";
import { scorePath, compareScores } from "./core/match.js";
import { queryInput, suggestRows, applySuggestion, pickedInput, tokenBefore } from "./core/suggest.js";
import { CAPS, NEEDS_UPDATE, SEND_IMAGES } from "./core/caps.js";
import { localSend, dropLocal, localShell, confirmSend } from "./core/session-state.js";
import { markMade, nearRole } from "./core/made.js";
import { listMenu, keysLine } from "./pickers.js";
import { answerRows, chipWord, accountAtStart, accountToken, isModel, EFFORTS, chipLine, runsOn } from "./core/answer-with.js";
import { providerMark, providerName } from "../js/provider-mark.js";
import { pasteTracker, NOT_TYPED } from "./core/paste-spans.js";
import { tagPicker } from "./tag-picker.js";
import { voiceStatus, listen as listenVoice } from "./core/voice.js";
import { ago, agoLong } from "../js/need-rows.js";

const touch = () => typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;
const isMacOS = () => typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(String(navigator.platform || navigator.userAgent || ""));

/** Sent messages per thread, kept in this browser across reloads. */
const HISTORY_KEY = "vyre.chat.history";
const HISTORY = historyStore();
try { const raw = localStorage.getItem(HISTORY_KEY); if (raw) HISTORY.load(JSON.parse(raw)); } catch {}
const saveHistory = () => { try { localStorage.setItem(HISTORY_KEY, JSON.stringify(HISTORY)); } catch {} };

/** An unsent draft per thread (Paseo's input/state.ts): what you were typing comes back after a
 *  thread switch or a reload, until it is sent. Debounced (below) so a keystroke costs no write;
 *  capped like HISTORY's rings so a long-lived box does not grow this file forever. */
const DRAFT_KEY = "vyre.chat.drafts";
const DRAFT_MAX_THREADS = 50;
/** @type {Map<string, string>} */
const DRAFTS = new Map();
try {
  const raw = localStorage.getItem(DRAFT_KEY);
  if (raw) { const obj = JSON.parse(raw); if (obj && typeof obj === "object") for (const [k, v] of Object.entries(obj)) if (typeof v === "string" && v) DRAFTS.set(k, v); }
} catch {}
const saveDrafts = () => { try { localStorage.setItem(DRAFT_KEY, JSON.stringify(Object.fromEntries(DRAFTS))); } catch {} };
/** @param {string} thread @param {string} text */
function setDraft(thread, text) {
  DRAFTS.delete(thread); DRAFTS.set(thread, text); // re-insert: most-recently-drafted last
  while (DRAFTS.size > DRAFT_MAX_THREADS) DRAFTS.delete(/** @type {string} */ (DRAFTS.keys().next().value));
  saveDrafts();
}
/** @param {string} thread */
function clearDraft(thread) { if (DRAFTS.delete(thread)) saveDrafts(); }

/** Where a "#" memory goes. */
const SCOPES = Object.freeze([
  { id: "project", label: "This project", hint: "Only here" },
  { id: "user", label: "About you", hint: "Every project and chat" },
  { id: "local", label: "Just this folder", hint: "Not shared" },
]);
/** The browser sizes a textarea to its text by itself (Chrome 123, Safari 26). */
const FIELD_SIZING = typeof CSS !== "undefined" && typeof CSS.supports === "function" && CSS.supports("field-sizing", "content");
const frame = typeof requestAnimationFrame === "function" ? (/** @type {() => void} */ f) => requestAnimationFrame(f) : (/** @type {() => void} */ f) => setTimeout(f, 16);
/** A message with images is not queued: the box keeps only a queued message's words (sessions to fix). */
const IMAGES_NO_QUEUE = "Images can't wait in the queue yet. Send them as a steer now (Enter), or after this turn.";
/** How long the send button is held to queue. */
const HOLD_MS = 450;
// This module's own timers (holdTimer, leaseTimer, fileTimer, below) call .unref?.() right after
// setTimeout: a no-op in the browser, but in a Node test that fails (or otherwise never calls
// composer.stop()) before its own timer fires, it stops that one dangling timer from keeping the
// whole test-runner process alive - a hanging glob is worse than a test that leaks harmlessly.
/** A fallback "/" list is asked again after this long (the session was not running: it had none). */
const COMMANDS_RETRY_MS = 15_000;

/**
 * @param {{ thread: string, agents?: string[], threads?: { id: string, name: string|null }[], holder?: string|null, surface?: string,
 *   machine?: string|null, onOffline?: (machine: string|null) => void, onQueue?: (n: number, name: string) => void, onStop?: () => void,
 *   session?: import("./core/session-state.js").Session, patch?: (keys: string[]) => void, cwd?: () => string|null, name?: () => string,
 *   project?: () => string|null, onRewind?: () => void, onUndo?: () => void, onTasks?: () => void, onThinkingView?: () => void, onOverlayEscape?: () => boolean, onFind?: (query: string) => void,
 *   onRecall?: (hit: { session: string, seq: number, role: string, ts: number, name: string|null, title: string|null, cwd: string|null, snippet: string }) => void }} opts
 * session and patch: the view's session-state and how it redraws what changed (steers, queue rows and shell rows are drawn
 * here, on send). onOffline: called with the Mac's name when a send finds it offline, with null when a send goes through.
 * project: this thread's project slug, for "@role" (team.default.get/team.add both require one) - null with no project.
 * onFind: "/find [words]" (a local command, nothing sent) - words is "" when none were typed.
 * onRecall: a "From your past sessions" row was tapped (recall.related's own hit shape) - opening
 * and rendering that session at its seq is the caller's job; without onRecall the hint never shows.
 * @returns {{ el: HTMLElement, focus: () => void, stop: () => void, setMachine: (m: string|null) => void, setBusy: (on: boolean) => void,
 *   setText: (text: string, note?: string) => void, tag: (v: { kind: string, id: string, name: string }) => string, editQueued: (q: { uuid: string|null, queued?: any, text: string }) => void,
 *   key: (e: KeyboardEvent) => boolean, keyUp: (e: KeyboardEvent) => boolean, draw: () => void, value: () => string }}
 */
export function mountComposer(opts) {
  const { thread } = opts;
  const S = opts.session || null;
  const patch = opts.patch || (() => {});
  /** The paired Mac this session lives on, or null for the box's own. */
  let machine = opts.machine || null;
  let leaseTimer = null;
  let sending = false;
  let busy = false;
  let queueToggle = false;
  /** Pasted images waiting to go with the next message. */
  let images = /** @type {import("./core/composer-state.js").Attachment[]} */ ([]);
  /** A queued message taken back into the box to edit (Up, or its Edit button). */
  let editing = /** @type {{ uuid: string|null, queued?: any } | null} */ (null);
  let scope = "project";
  /** "/goal" mode: Enter adds the title, then a milestone at a time; Cmd+Enter or "Set goal" sends
   *  it (the milestone-list piece of the goal + milestones cheap win - the engine is sessions'). */
  let goal = /** @type {{ title: string, milestones: string[] } | null} */ (null);
  const hist = HISTORY.get(thread);
  const esc = createEsc();
  const menu = listMenu();
  /** The session's commands, once asked for; `commandsAt` when, if they were the static fallback. */
  let commands = /** @type {import("./core/commands.js").Command[]|null} */ (null);
  let commandsAt = 0;
  let fileTimer = /** @type {any} */ (null), fileSeq = 0;
  let draftTimer = /** @type {any} */ (null);
  /** Write (or clear) the draft now; cancels a pending debounced one. */
  function flushDraft() { clearTimeout(draftTimer); draftTimer = null; const v = ta.value; if (v) setDraft(thread, v); else clearDraft(thread); }
  const scheduleDraftSave = () => { clearTimeout(draftTimer); draftTimer = setTimeout(flushDraft, 200); draftTimer.unref?.(); };

  // Which stretches of the draft were pasted: sent as `pasted` so a #Name inside one never tags (reviewer-2 M-P2).
  const pastes = pasteTracker();
  let prevValue = "", pendingPaste = false;
  /**
   * Text counts as typed only when a keystroke's own `inputType` says so: a missing one is a programmatic edit (a draft
   * restored, an earlier message recalled) and paste, drop, undo, redo and replacement text are never typing. The code's
   * own deliberate insertions (a picked command, file or tag) announce themselves with `own` (reviewer-2 M-N3).
   * @param {string} [inputType] @param {boolean} [own]
   */
  const trackValue = (inputType, own = false) => { if (ta.value !== prevValue) { pastes.edit(prevValue, ta.value, own ? false : pendingPaste || !inputType || NOT_TYPED.has(inputType)); prevValue = ta.value; pendingPaste = false; } };

  const ta = /** @type {HTMLTextAreaElement} */ (h("textarea", {
    rows: 1, placeholder: "Message this session", "aria-label": "Message", enterkeyhint: "send",
    oninput: (/** @type {any} */ e) => { trackValue(e?.inputType); grow(); maybeLease(); if (recalling(hist)) stopRecall(hist); suggest(); drawChips(); scheduleDraftSave(); scheduleHint(); scheduleNear(); },
    onkeydown: onKey, onkeyup: (/** @type {KeyboardEvent} */ e) => { if (keyUp(e)) e.preventDefault(); }, onpaste: onPaste,
  }));
  const thumbs = h("div", { class: "composer-images", hidden: true });
  let holdTimer = /** @type {any} */ (null), held = false;
  const send = h("button", { class: "ibtn composer-send", "aria-label": "Send", title: "Send (hold to queue for after this turn)",
    onpointerdown: () => { held = false; clearTimeout(holdTimer); holdTimer = setTimeout(() => { held = true; }, HOLD_MS); holdTimer.unref?.(); },
    onpointerup: () => clearTimeout(holdTimer),
    onclick: () => { const hold = held; held = false; clearTimeout(holdTimer); submit({ button: true, hold }); } }, icon("send", 16));
  const stopBtn = h("button", { class: "btn btn-ghost btn-sm composer-stop", type: "button", hidden: true, title: "Stop this turn (Esc)",
    onclick: () => opts.onStop?.() }, "Stop", h("span", { class: "kbd" }, "Esc"));
  const chips = h("div", { class: "composer-chips" });
  /** "From your past sessions" (recall.related), quiet rows above the input row. */
  const hintBox = h("div", { class: "composer-hints", hidden: true });
  // Attach: the same path as a paste (a picked or dropped file).
  const picker = /** @type {HTMLInputElement} */ (h("input", { type: "file", accept: IMAGE_TYPES.join(","), multiple: true, hidden: true,
    onchange: () => { const fs = [...(picker.files || [])]; picker.value = ""; takeFiles(fs); } }));
  const attachBtn = h("button", { class: "ibtn composer-attach", type: "button", "aria-label": "Attach images", title: "Attach images (PNG, JPEG, GIF, WebP)",
    onclick: () => picker.click() }, icon("plus", 16));
  const micBtn = h("button", { class: "ibtn composer-mic", type: "button", disabled: !!machine, "aria-label": "Talk", title: "Tap to talk, hold to push-to-talk (Ctrl+M)",
    onpointerdown: /** @type {any} */ (e => { if (e.button !== undefined && e.button !== 0) return; try { micBtn.setPointerCapture(e.pointerId); } catch {} voicePressBegin(); }),
    onpointerup: () => voicePressEnd(), onpointercancel: () => voicePressEnd() }, icon("mic", 16));
  const voicePill = h("div", { class: "composer-voice-pill", hidden: true, role: "status" });
  const wrap = h("div", { class: "composer-wrap", ondragover: (/** @type {DragEvent} */ e) => { if (!machine) e.preventDefault(); },
    ondrop: (/** @type {DragEvent} */ e) => { const fs = [...(e.dataTransfer?.files || [])]; if (!fs.length || machine) return; e.preventDefault(); takeFiles(fs); } }, menu.el,
    h("div", { class: "composer-row" }, attachBtn, micBtn, picker, ta, stopBtn, send),
  );
  /** Messages waiting in the inbox queue of a session busy in the terminal (the Mac's), by the id thread.queued gives. */
  const waiting = new Map();
  let busyName = "";
  function drawQueued() { opts.onQueue?.(waiting.size, busyName); }
  const note = h("div", { class: "composer-note", role: "status" });
  // The tip sits on the left of the hint line, the key hints stay on the right (tip.md; chat's tip-line.js fills it).
  const tipSlot = h("div", { class: "composer-tip", hidden: true });
  const hint = h("div", { class: "composer-hint" }, tipSlot, h("span", { class: "composer-keys" }, keysLine(["Enter", "to send"], ["Shift+Enter", "new line"], ["/", "commands"], ["@", "files"], ["!", "shell"], ["#", "tag"])));
  const root = h("div", { class: "composer" }, note, thumbs, hintBox, voicePill, wrap, chips, hint);

  // The box fits its text. Where CSS can size it (field-sizing, chat.css) nothing runs per key.
  // Elsewhere it is measured once a frame, and the height is reset only when the text got
  // shorter, so a key on a line that fits costs one read, never a layout of the timeline.
  let growing = false, grownLen = 0;
  function grow() {
    if (FIELD_SIZING || growing) return;
    growing = true;
    frame(() => {
      growing = false;
      const shrank = ta.value.length < grownLen;
      grownLen = ta.value.length;
      if (!shrank && (ta.scrollHeight || 0) <= (ta.clientHeight || 0)) return;
      if (shrank) ta.style.height = "auto";
      ta.style.height = Math.min(200, ta.scrollHeight || 0) + "px";
    });
  }
  const caret = () => (typeof ta.selectionStart === "number" ? ta.selectionStart : ta.value.length);
  const setValue = (/** @type {string} */ v, at = v.length, own = false) => {
    ta.value = v; try { ta.setSelectionRange?.(at, at); } catch {} trackValue(undefined, own); grow(); drawChips(); flushDraft();
    // An empty box is a fresh compose: the next message gets its own hint, not the last one's "not now".
    if (!v) { clearTimeout(hintTimer); hintDismissed = false; hideHints(); }
  };
  // "#": one universal tag (chat/tag-picker.js, shared with the new-session sheet).
  const tagUI = tagPicker({ ta, menu, caret, setValue: (v, at) => setValue(v, at, true), attempt, use: (tool, fn) => CAPS.use(tool, fn) });
  const say = (/** @type {any} */ what, soft = true) => { note.classList.toggle("soft", soft); put(note, what); };

  function maybeLease() {
    if (leaseTimer || machine) return; // a Mac's lease is not forwarded
    leaseTimer = setTimeout(() => { leaseTimer = null; }, 4000); leaseTimer.unref?.();
    attempt("threads.lease", { thread }).catch(() => {});
  }

  /** Can the chips act? A Switchboard session on this box with its state at hand. */
  const rich = () => !!S && !machine;
  /** A tool's control is off once the box said it has no such tool. @param {string} tool */
  const off = tool => CAPS.has(tool) === false;

  // ---- the chips under the box ------------------------------------------------------------

  let chipSig = "";
  function drawChips() {
    drawAttach();
    if (goal) {
      ta.placeholder = goal.title ? "Add a milestone, Enter to add another" : "What's the goal?";
      root.setAttribute("data-mode", "goal");
      chips.hidden = false;
      put(chips,
        h("span", { class: "composer-kind" }, "Goal"),
        goal.title ? h("span", { class: "small ellipsis" }, goal.title) : null,
        goal.milestones.length ? h("span", { class: "composer-scopes", role: "list", "aria-label": "Milestones" },
          goal.milestones.map((m, i) => h("span", { class: "btn btn-ghost btn-sm composer-scope", role: "listitem" }, m,
            h("button", { type: "button", "aria-label": "Remove " + m, onclick: () => { goal?.milestones.splice(i, 1); drawChips(); ta.focus(); } }, "×")))) : null,
        h("button", { class: "btn btn-ghost btn-sm", type: "button", disabled: !goal.title,
          title: goal.title ? "Send the goal and its milestones" : "Type a goal first", onclick: () => finishGoal() },
          "Set goal", h("span", { class: "kbd" }, kbd("Enter"))),
        h("button", { class: "btn btn-ghost btn-sm", type: "button", onclick: () => cancelGoal() }, "Cancel", h("span", { class: "kbd" }, "Esc")),
      );
      chipSig = "";
      return;
    }
    const kind = draftKind(ta.value);
    ta.placeholder = machine ? "Message this session"
      : busy ? `Steer ${opts.name?.() || "the session"}, or Alt+Enter to queue for after` : "Message this session";
    root.setAttribute("data-mode", kind);
    if (!rich()) { chips.hidden = true; chips.replaceChildren(); chipSig = ""; return; }
    chips.hidden = false;
    const s = /** @type {import("./core/session-state.js").Session} */ (S);
    // Called on every keystroke: rebuilt only when something it shows changed.
    const vts = tagUI.chips();
    const sig = JSON.stringify([vts.map(t => t.name), kind, busy, queueToggle, scope, s.mode, s.model, s.thinking, s.provider, s.effort ?? null, machine ? null : runsOn(ta.value, answers, providerName), answers.map(a => [a.provider, a.account, a.now]),
      ["threads.model", "threads.mode", "threads.thinking", "threads.shell"].map(off), kind === "shell" ? opts.cwd?.() : null]);
    if (sig === chipSig) return;
    chipSig = sig;
    const chip = (/** @type {string} */ cls, /** @type {string} */ tool, /** @type {string} */ title, /** @type {() => void} */ fn, /** @type {any[]} */ ...kids) =>
      h("button", { class: "btn btn-ghost btn-sm composer-chip " + cls, type: "button", disabled: off(tool), title: off(tool) ? NEEDS_UPDATE : title, onclick: fn }, ...kids);
    const label = kindLabel(kind);
    // The one picker: who answers, its model and the effort, as one chip ("Codex · GPT-5 high"). A menu whenever there is anything to choose.
    const who = s.provider ? chipWord(answers, s.provider, providerName(s.provider)) : "";
    const cur = answers.find(a => a.now);
    const modelLabel = cur?.models.find(m => isModel(s.model, m.id))?.label || shortModel(s.model) || "";
    const line = chipLine(who, modelLabel, /** @type {any} */ (s).effort);
    const choosable = answers.length > 1 || answers.some(a => a.models.length > 0 || a.effort);
    const fallback = !answers.length; // an older box without providers.list: the model menu it always had
    const gate = fallback ? "threads.model" : "threads.switch";
    put(chips,
      !machine && (s.provider || s.model) ? h("button", { class: "btn btn-ghost btn-sm composer-chip composer-answer", type: "button", disabled: fallback ? off(gate) : (!choosable || off(gate)),
        title: choosable || fallback ? "Choose who answers, its model and effort" : "The account that answers", "aria-label": `Answered by ${line}`, "aria-haspopup": choosable || fallback ? "menu" : null,
        onclick: () => (fallback ? openModels() : openAnswerWith()) },
        s.provider ? providerMark(s.provider, 18) : null, h("span", { class: "composer-answer-name" }, line || "Model"), choosable || fallback ? icon("chevron", 16) : null) : null,
      chip("composer-mode", "threads.mode", "Next mode (Shift+Tab)", () => cycleMode(), modeLabel(s.mode), h("span", { class: "kbd" }, "⇧Tab")),
      chip("composer-thinking", "threads.thinking", "Thinking on or off (Alt+T)", () => toggleThinking(), s.thinking === true ? "Thinking on" : s.thinking === false ? "Thinking off" : "Thinking"),
      tagUI.chipsEl(),
      // "@codex ...": this one turn runs on that account, and says which when the provider has more than one.
      (() => { const on = machine ? null : runsOn(ta.value, answers, providerName); return on ? h("span", { class: "composer-kind composer-runs-on", role: "status" }, "This turn runs on " + on) : null; })(),
      label && kind !== "command" ? h("span", { class: "composer-kind" }, label,
        kind === "shell" ? h("span", { class: "faint" }, " · runs in " + shortDir(opts.cwd?.() || "") + (off("threads.shell") ? " · " + NEEDS_UPDATE : "")) : null) : null,
      kind === "memory" ? h("span", { class: "composer-scopes", role: "radiogroup", "aria-label": "Save this to" },
        SCOPES.map(sc => h("button", { class: "btn btn-ghost btn-sm composer-scope", type: "button", role: "radio", "aria-checked": String(scope === sc.id),
          title: sc.hint, onclick: () => { scope = sc.id; drawChips(); ta.focus(); } }, sc.label))) : null,
      busy && kind === "message" ? h("button", { class: "btn btn-ghost btn-sm composer-queue", type: "button", "aria-pressed": String(queueToggle),
        title: "Alt+Enter queues one message", onclick: () => { queueToggle = !queueToggle; drawChips(); ta.focus(); } },
        queueToggle ? "Queued for after this turn" : "Queue for after this turn") : null,
    );
  }

  async function cycleMode() {
    if (!rich()) return;
    const s = /** @type {any} */ (S);
    if (off("threads.mode")) { say(NEEDS_UPDATE); return; }
    const was = s.mode, next = nextMode(s.mode, s.modes);
    s.mode = next;
    patch(["@session"]);
    drawChips();
    const r = await CAPS.use("threads.mode", () => attempt("threads.mode", { thread, mode: next }));
    if (r.error) { s.mode = was; patch(["@session"]); drawChips(); say(r.missing ? NEEDS_UPDATE : "Could not change the mode: " + r.error.message); return; }
    // Not running: the box takes no mode ({mode: null, note}), so the chip goes back and says why.
    const d = /** @type {any} */ (r.data) || {};
    if (d.mode === null) { s.mode = was; patch(["@session"]); drawChips(); say(String(d.note || "The mode applies to a running session.")); }
  }

  async function toggleThinking() {
    if (!rich()) return;
    const s = /** @type {any} */ (S);
    if (off("threads.thinking")) { say(NEEDS_UPDATE); return; }
    // Not said yet (the box does not keep it on the record): on, if this session has thought.
    const was = s.thinking;
    const want = !(was ?? s.items.some((/** @type {any} */ it) => it.kind === "reasoning"));
    s.thinking = want;
    drawChips();
    const r = await CAPS.use("threads.thinking", () => attempt("threads.thinking", { thread, on: want }));
    if (r.error) { s.thinking = was; drawChips(); say(r.missing ? NEEDS_UPDATE : "Could not change thinking: " + r.error.message); return; }
    // {thread, thinking: true|false}, or {thinking: null, note} when the session is not running.
    const d = /** @type {any} */ (r.data) || {};
    if (d.thinking === null) { s.thinking = was; drawChips(); say(String(d.note || "Thinking switches on a running session.")); return; }
    if (typeof d.thinking === "boolean") s.thinking = d.thinking;
    patch(["@session"]);
  }

  // ---- who answers (model-picker.md) ----------------------------------------------------------

  /** The accounts that can answer, from providers.list: read once now and again when the menu opens. */
  let answers = /** @type {import("./core/answer-with.js").AnswerRow[]} */ ([]);
  async function loadAnswers() {
    const r = await attempt("providers.list", {});
    if (r.error) return false;
    const s = /** @type {any} */ (S) || {};
    answers = answerRows(r.data, { provider: s.provider, account: s.account });
    drawChips();
    return true;
  }
  async function openAnswerWith() {
    if (!rich() || (answers.length < 2 && !answers.some(a => a.models.length || a.effort))) return;
    const ok = await loadAnswers();
    const cur = /** @type {any} */ (S)?.model || null;
    // Each account, then its models under it: an account row changes who answers, a model row also picks the model.
    /** @type {any[]} */ const list = [];
    if (ok) for (const a of answers) {
      list.push({ key: a.provider + ":" + (a.account || ""), value: { account: a }, render: () => [
        providerMark(a.provider, 22), h("span", { class: "cv-menu-name" }, a.label), a.sub ? h("span", { class: "cv-menu-desc" }, a.sub) : null,
        a.now ? h("span", { class: "cv-menu-badge" }, "now") : null] });
      for (const m of a.models) list.push({ key: a.provider + ":" + (a.account || "") + ":" + m.id, value: { account: a, model: m }, render: () => [
        h("span", { class: "cv-menu-name cv-menu-sub" }, m.label), a.now && isModel(cur, m.id) ? h("span", { class: "cv-menu-badge" }, "now") : null] });
    }
    // Effort, for the account that answers now when its provider has it: how hard it thinks, from the next turn.
    const now = answers.find(a => a.now);
    const sEffort = /** @type {any} */ (S)?.effort ?? null;
    if (ok && now?.effort) for (const e of EFFORTS) list.push({ key: "effort:" + (e.id || "default"), value: { effort: e }, render: () => [
      h("span", { class: "cv-menu-name cv-menu-sub" }, "Effort: " + e.label), (e.id ?? null) === sEffort ? h("span", { class: "cv-menu-badge" }, "now") : null] });
    menu.setKind("answer");
    menu.open(list, row => (row.value.effort ? pickEffort(row.value.effort) : pickAnswer(row.value.account, row.value.model || null)), "Answer with", keysLine(["↑↓", "move"], ["⏎", "choose"], ["Esc", "close"]));
  }
  /** How hard it thinks, from the next turn: threads.effort (null is the model's own default). */
  async function pickEffort(/** @type {{ id: string|null, label: string }} */ e) {
    menu.close();
    const s = /** @type {any} */ (S);
    const was = s.effort ?? null;
    if (was === e.id) { ta.focus(); return; }
    s.effort = e.id; patch(["@session"]); drawChips();
    const r = await CAPS.use("threads.effort", () => attempt("threads.effort", { thread, ...(e.id ? { effort: e.id } : {}) }));
    if (r.error) { s.effort = was; patch(["@session"]); drawChips(); say(r.missing ? NEEDS_UPDATE : "Could not change the effort: " + (r.error.message || r.error.code)); }
    ta.focus();
  }
  /** Change who answers, and with a model row which model, from the next turn in this same session (its memory and files go with it).
   * Another provider or account: threads.switch (model included). The same one: threads.model. The box leaves the one switch line. */
  async function pickAnswer(/** @type {import("./core/answer-with.js").AnswerRow} */ a, /** @type {{ id: string, label: string }|null} */ model = null) {
    menu.close();
    if (a.now && !model) { ta.focus(); return; }
    if (a.now && model && isModel(/** @type {any} */ (S)?.model, model.id)) { ta.focus(); return; }
    const tool = a.now ? "threads.model" : "threads.switch";
    const input = a.now ? { thread, model: model?.id } : { thread, provider: a.provider, ...(a.account ? { account: a.account } : {}), ...(model ? { model: model.id } : {}) };
    const r = await CAPS.use(tool, () => attempt(tool, input));
    if (r.error) say(r.missing ? NEEDS_UPDATE : r.error.code === "busy" ? "A turn is running. Stop it or wait for it to end, then choose again." : "Could not switch: " + (r.error.message || r.error.code));
    else { if (model && a.now) { /** @type {any} */ (S).model = model.id; patch(["@session"]); } await loadAnswers(); }
    ta.focus();
  }

  // Only a session that can switch has anything to choose from; the composer in a test or a recorded view has no session state.
  if (S) loadAnswers();

  async function openModels() {
    if (!rich()) return;
    if (off("threads.model")) { say(NEEDS_UPDATE); return; }
    // The box's aliases, the per-purpose map, and this thread's own (sessions.models.get).
    const r = await CAPS.use("sessions.models.get", () => attempt("sessions.models.get", {}));
    const list = modelChoices({ current: /** @type {any} */ (S).model, purposes: /** @type {any} */ (r.data)?.purposes, aliases: /** @type {any} */ (r.data)?.aliases });
    menu.setKind("model");
    menu.open(list.map(m => ({ key: m.id, value: m, render: () => [
      h("span", { class: "cv-menu-name" }, m.label || m.id), m.description ? h("span", { class: "cv-menu-desc" }, m.description) : null,
      m.now ? h("span", { class: "cv-menu-badge" }, "now") : null] })),
    row => pickModel(row.value), "Switch the model for this session", keysLine(["↑↓", "move"], ["⏎", "switch"], ["Esc", "close"]));
  }
  async function pickModel(/** @type {any} */ m) {
    menu.close();
    const s = /** @type {any} */ (S);
    const was = s.model;
    s.model = String(m.id);
    patch(["@session"]); drawChips();
    const r = await CAPS.use("threads.model", () => attempt("threads.model", { thread, model: String(m.id) }));
    if (r.error) { s.model = was; patch(["@session"]); drawChips(); say(r.missing ? NEEDS_UPDATE : "Could not switch the model: " + r.error.message); }
    // A stopped thread takes it when it next runs: the box says so. model.switched follows either way.
    else if (/** @type {any} */ (r.data)?.note) say(String(/** @type {any} */ (r.data).note));
    ta.focus();
  }

  // ---- "/" and "@" --------------------------------------------------------------------------

  async function loadCommands() {
    if (commands && (!commandsAt || Date.now() - commandsAt < COMMANDS_RETRY_MS)) return commands;
    if (machine) { commands = normalizeCommands(null); commandsAt = 0; return commands; }
    // {thread, commands: [{name, description, argumentHint}]}; empty while the thread is not
    // running (the list comes with the session), so the static one stands in and is asked again.
    const r = await CAPS.use("threads.commands", () => attempt("threads.commands", { thread }));
    const d = /** @type {any} */ (r.data);
    const got = Array.isArray(d) ? d : Array.isArray(d?.commands) ? d.commands : null;
    commands = normalizeCommands(got);
    commandsAt = got && got.length ? 0 : (r.missing ? 0 : Date.now());
    return commands;
  }

  function suggest() {
    const text = ta.value, at = caret();
    const cmd = findCommand(text, at);
    if (cmd) { showCommands(cmd); return; }
    const men = findMention(text, at);
    if (men && !machine) { showFiles(men); return; }
    const vm = findVaultMention(text, at);
    if (vm && !machine && !draftKind(text).startsWith("shell")) { tagUI.show(vm); return; }
    if (menu.kind === "command" || menu.kind === "mention" || menu.kind === "vault") menu.close();
  }

  async function showCommands(/** @type {import("./core/commands.js").CommandRange} */ range) {
    const list = rankCommands(await loadCommands(), range.query).slice(0, 12);
    // The text moved on while the list loaded.
    if (!findCommand(ta.value, caret())) return;
    menu.setKind("command");
    const groups = [...new Set(list.map(c => c.source))];
    menu.open(list.map(c => ({ key: c.name, value: c, render: () => [
      h("span", { class: "cv-menu-name" }, "/" + c.name), c.hint ? h("span", { class: "cv-menu-hint" }, c.hint) : null,
      h("span", { class: "cv-menu-desc" }, c.description), sourceLabel(c.source) ? h("span", { class: "cv-menu-badge" }, sourceLabel(c.source)) : null] })),
    row => pickCommand(row.value), groups.length > 1 ? "Commands and skills" : "Commands", keysLine(["↑↓", "move"], ["⏎", "run"], ["Tab", "complete"], ["Esc", "close"]));
  }
  function pickCommand(/** @type {import("./core/commands.js").Command} */ c, complete = false) {
    menu.close();
    if (c.local && !complete) { setValue(""); runLocal(c.local); return; }
    const range = findCommand(ta.value, caret()) || { start: 0, end: ta.value.indexOf(" ") < 0 ? ta.value.length : ta.value.indexOf(" "), query: "" };
    const r = applyCommand(ta.value, range, c.name);
    setValue(r.text, r.caret, true);
    ta.focus();
  }
  function runLocal(/** @type {string} */ what, query = "") {
    if (what === "model") { if (answers.length) openAnswerWith(); else openModels(); }
    else if (what === "rewind") opts.onRewind?.();
    else if (what === "undo") opts.onUndo?.();
    else if (what === "find") opts.onFind?.(query);
    else if (what === "goal") { goal = { title: query, milestones: [] }; setValue(""); drawChips(); }
  }
  /** Enter in goal mode: the first line is the title, each one after is a milestone. Empty does
   *  nothing (Cmd+Enter or "Set goal" finishes; Esc cancels - onEscape, below). */
  function advanceGoal() {
    const v = ta.value.trim();
    if (!v || !goal) return;
    if (!goal.title) goal.title = v; else goal.milestones.push(v);
    setValue("");
  }
  /** Sends the goal as one message (title + a numbered milestone list) - the engine (parsing it
   *  into a tracked goal, notifying on each milestone) is sessions', not the composer's. */
  function finishGoal() {
    if (!goal || !goal.title) return;
    const text = "Goal: " + goal.title + (goal.milestones.length
      ? "\nMilestones:\n" + goal.milestones.map((m, i) => (i + 1) + ". " + m).join("\n") : "");
    goal = null;
    // A running turn: this joins the queue like any other command sent mid-turn, not a steer.
    sendMessage(text, busy && !machine ? "queue" : null);
  }
  function cancelGoal() { goal = null; setValue(""); }

  // ---- tap-to-talk / push-to-talk (voice) ---------------------------------------------------
  //
  // TAP the mic or Ctrl+M to start; talk as long as you like; tap or Ctrl+M again to STOP (the
  // words stay to edit). Enter stops and sends. Esc cancels and removes only what this dictation
  // added - never anything typed before or after it. HOLD past VOICE_HOLD_MS for quick
  // push-to-talk instead: release stops (never sends) - Wispr Flow/superwhisper's own pattern.
  // Interim and final words land at the cursor (never over typed text); a command word recognised
  // only at the end of a final ("send it", "new line", "scratch that") is stripped and acted on.

  const VOICE_HOLD_MS = 350;
  const VOICE_SILENCE_WARN_MS = 2 * 60_000;
  const VOICE_SILENCE_STOP_MS = 5 * 60_000;
  const VOICE_COMMANDS = Object.freeze([
    { id: "send", re: /\s*\bsend it\b\.?\s*$/i },
    { id: "newline", re: /\s*\bnew line\b\.?\s*$/i },
    { id: "scratch", re: /\s*\bscratch that\b\.?\s*$/i },
  ]);

  /** null: not checked yet; true/false: whether the box has a voice key. Checked once per mount. */
  let voiceKnown = /** @type {boolean|null} */ (null);
  /** @type {{ stop: () => void }|null} */
  let voiceSession = null;
  /** True between opening and listenVoice() answering. */
  let voiceOpening = false;
  /** True once actually streaming (voiceOpening resolved to a live session). */
  let voiceListening = false;
  /** True from a stop tap until onDone/onError answers: the box is finishing the last words, not
   *  hearing new ones - the pill and mic read differently (session-view voice states, queued
   *  after native-core's composer piece landed). */
  let voiceStopping = false;
  let voiceWantStopOnOpen = false, voiceWantCancelOnOpen = false;
  /** This press/hold's own bookkeeping, reset at the start of every press. */
  let voicePressTimer = /** @type {any} */ (null), voiceHeld = false, voicePressWasOpen = false;
  /** Ctrl+M is a keydown/keyup pair; e.ctrlKey can already be false by keyup if Ctrl let go
   *  first, so the M key's own up (not actionFor's Ctrl+M match) ends the press. */
  let voiceKeyDown = false;
  /** The dictated span this utterance owns in ta.value: [voiceStart, voiceEnd). Esc removes
   *  exactly this; nothing typed before or after it is ever touched. */
  let voiceStart = 0, voiceEnd = 0;
  /** local/voice/listen.js's own "final" is cumulative (its committed string, growing with each
   *  phrase) - this is how much of it has already become box text, so a new final's own newly
   *  added tail is what gets checked for a command word. */
  let voiceCommittedLen = 0;
  /** Offsets within the cumulative committed text where each phrase began, oldest first -
   *  "scratch that" truncates back to the last one. */
  let voiceSegmentStarts = /** @type {number[]} */ ([]);
  let voiceStartedAt = 0, voiceElapsedTimer = /** @type {any} */ (null);
  let voiceSilenceWarn = /** @type {any} */ (null), voiceSilenceStop = /** @type {any} */ (null);

  const voiceKeyNote = () => ["Add a voice key in ", link("/settings", {}, "Settings"), " to use voice."];

  /** Replaces [voiceStart, voiceEnd) with text, moves voiceEnd, caret at the end of it. */
  function voiceReplace(/** @type {string} */ text) {
    const before = ta.value.slice(0, voiceStart), after = ta.value.slice(voiceEnd);
    const at = voiceStart + text.length;
    setValue(before + text + after, at);
    voiceEnd = at;
  }
  function voiceElapsedText() {
    const s = Math.max(0, Math.round((Date.now() - voiceStartedAt) / 1000));
    return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
  }
  function drawVoicePill() {
    if (!voiceListening) { voicePill.hidden = true; voicePill.replaceChildren(); return; }
    voicePill.hidden = false;
    if (voiceStopping) { put(voicePill, h("span", { class: "composer-voice-dot" }), "Transcribing…"); return; }
    put(voicePill, h("span", { class: "composer-voice-dot" }), "Listening " + voiceElapsedText());
  }
  function startVoiceElapsed() { voiceStartedAt = Date.now(); clearInterval(voiceElapsedTimer); voiceElapsedTimer = setInterval(drawVoicePill, 1000); voiceElapsedTimer.unref?.(); }
  function stopVoiceElapsed() { clearInterval(voiceElapsedTimer); voiceElapsedTimer = null; }
  function resetSilenceTimers() {
    clearTimeout(voiceSilenceWarn); clearTimeout(voiceSilenceStop);
    voiceSilenceWarn = setTimeout(() => say("Still listening? Tap to stop."), VOICE_SILENCE_WARN_MS); voiceSilenceWarn.unref?.();
    voiceSilenceStop = setTimeout(() => stopTalk(), VOICE_SILENCE_STOP_MS); voiceSilenceStop.unref?.();
  }
  function clearSilenceTimers() { clearTimeout(voiceSilenceWarn); clearTimeout(voiceSilenceStop); voiceSilenceWarn = voiceSilenceStop = null; }

  /** A command word at the very end of a final's cumulative text, or null. */
  function matchVoiceCommand(/** @type {string} */ text) {
    for (const c of VOICE_COMMANDS) { const m = c.re.exec(text); if (m) return { id: c.id, index: m.index }; }
    return null;
  }

  function finishTalk() {
    voiceListening = false; voiceStopping = false; voiceSession = null;
    micBtn.classList.remove("on", "held", "stopping");
    micBtn.style.removeProperty("--voice-level");
    micBtn.setAttribute("aria-label", "Talk");
    stopVoiceElapsed(); clearSilenceTimers(); drawVoicePill();
  }
  function finishTalkAndSend() {
    const session = voiceSession;
    finishTalk();
    session?.stop();
    submit({ button: true });
  }

  async function openVoice() {
    if (voiceSession || voiceOpening || machine) return;
    voiceOpening = true; voiceWantStopOnOpen = false; voiceWantCancelOnOpen = false;
    if (voiceKnown === null) { const s = await voiceStatus(); voiceKnown = s ? s.ready : null; }
    if (voiceKnown !== true) {
      voiceOpening = false;
      say(voiceKnown === false ? voiceKeyNote() : "Could not reach voice.");
      return;
    }
    voiceStart = caret(); voiceEnd = voiceStart; voiceCommittedLen = 0; voiceSegmentStarts = [];
    say("Listening…");
    micBtn.classList.add("on");
    micBtn.setAttribute("aria-label", "Stop listening");
    const session = await listenVoice({
      onOpen: () => { voiceListening = true; startVoiceElapsed(); resetSilenceTimers(); drawVoicePill(); put(note); },
      onPartial: text => { resetSilenceTimers(); voiceReplace(text); },
      onFinal: text => {
        resetSilenceTimers();
        const priorLen = voiceCommittedLen; // this final's own text, before whatever it just added
        const m = matchVoiceCommand(text);
        if (m) {
          const words = text.slice(0, m.index);
          if (m.id === "send") { voiceCommittedLen = words.length; voiceReplace(words); say("\"send it\": sending"); finishTalkAndSend(); return; }
          if (m.id === "newline") { voiceCommittedLen = words.length; voiceReplace(words + "\n"); say("\"new line\""); return; }
          // "scratch that": undo whatever this final just added: back to the length as of the
          // previous final. If nothing new came before the command (words itself is no longer
          // than that), there was nothing to undo here, so undo the phrase before that instead.
          let kept = words.slice(0, priorLen);
          if (words.length <= priorLen) {
            voiceSegmentStarts.pop();
            kept = kept.slice(0, voiceSegmentStarts.length ? voiceSegmentStarts[voiceSegmentStarts.length - 1] : 0);
          }
          voiceCommittedLen = kept.length;
          voiceReplace(kept);
          say("\"scratch that\": removed the last phrase");
          return;
        }
        if (text.length > voiceCommittedLen) voiceSegmentStarts.push(voiceCommittedLen);
        voiceCommittedLen = text.length;
        voiceReplace(text);
      },
      onDone: text => {
        const was = voiceListening;
        finishTalk();
        if (text && was) voiceReplace(text);
        put(note); ta.focus();
      },
      onError: message => { finishTalk(); say(message); },
      onLevel: level => micBtn.style.setProperty("--voice-level", String(Math.max(0, Math.min(1, level)))),
    });
    voiceOpening = false;
    if (voiceWantCancelOnOpen) { voiceWantCancelOnOpen = false; cancelVoiceNow(session); return; }
    if (voiceWantStopOnOpen) { voiceWantStopOnOpen = false; session.stop(); return; }
    voiceSession = session;
  }
  function stopTalk() {
    if (voiceSession) {
      voiceStopping = true;
      micBtn.classList.add("stopping");
      micBtn.setAttribute("aria-label", "Transcribing");
      stopVoiceElapsed(); clearSilenceTimers(); drawVoicePill();
      voiceSession.stop();
      return;
    }
    if (voiceOpening) voiceWantStopOnOpen = true;
  }
  /** Stops and removes exactly [voiceStart, voiceEnd) - nothing else in the box moves. */
  function cancelVoiceNow(/** @type {{ stop: () => void }} */ session) {
    const before = ta.value.slice(0, voiceStart), after = ta.value.slice(voiceEnd);
    setValue(before + after, voiceStart);
    session.stop();
  }
  function cancelTalk() {
    if (voiceSession) { const s = voiceSession; finishTalk(); cancelVoiceNow(s); return; }
    if (voiceOpening) voiceWantCancelOnOpen = true;
  }

  /** The mic button, or Ctrl+M: tap starts and stays open; held past VOICE_HOLD_MS, release stops. */
  function voicePressBegin() {
    if (machine) return;
    voicePressWasOpen = voiceListening || voiceOpening;
    if (voicePressWasOpen) return; // already open: wait for the release to stop it (tap-to-stop)
    voiceHeld = false;
    clearTimeout(voicePressTimer);
    voicePressTimer = setTimeout(() => { voiceHeld = true; micBtn.classList.add("held"); }, VOICE_HOLD_MS); voicePressTimer.unref?.();
    openVoice();
  }
  function voicePressEnd() {
    clearTimeout(voicePressTimer);
    micBtn.classList.remove("held");
    if (voicePressWasOpen) { stopTalk(); return; } // a tap (or Ctrl+M) while already open: stop
    if (voiceHeld) stopTalk(); // held past the threshold: release stops, push-to-talk
    voiceHeld = false; // else: a quick tap that just opened it - stays open
  }

  // ---- "From your past sessions" (recall.related) ------------------------------------------

  /** Under this many characters, no call - the hint is for a real thought in progress, not "hi". */
  const HINT_MIN_CHARS = 12;
  const HINT_DEBOUNCE_MS = 350;
  let hintTimer = /** @type {any} */ (null);
  /** Guards a stale answer: only the most recent request's reply is drawn. */
  let hintSeq = 0;
  /** "Not now" for this compose - cleared the next time the box goes empty (a send or a clear). */
  let hintDismissed = false;
  /** @type {{ session: string, seq: number, role: string, ts: number, name: string|null, title: string|null, cwd: string|null, snippet: string }[]} */
  let hints = [];

  function scheduleHint() {
    clearTimeout(hintTimer);
    if (!wantHint()) { hideHints(); return; }
    hintTimer = setTimeout(runHint, HINT_DEBOUNCE_MS); hintTimer.unref?.();
  }
  /** Whether the box is in a state worth asking recall.related about at all. */
  function wantHint() {
    return !!opts.onRecall && !machine && draftKind(ta.value) === "message" && ta.value.trim().length >= HINT_MIN_CHARS && !hintDismissed;
  }
  async function runHint() {
    if (!wantHint()) { hideHints(); return; }
    const cwd = opts.cwd?.();
    if (!cwd) { hideHints(); return; }
    const text = ta.value.trim();
    const my = ++hintSeq;
    const r = await attempt("recall.related", { project_cwds: [cwd], text, limit: 3 });
    if (my !== hintSeq || !wantHint()) return; // a newer keystroke, or the box moved on, while this was in flight
    if (r.error) { hideHints(); return; }
    const d = /** @type {any} */ (r.data) || {};
    hints = Array.isArray(d.hits) ? d.hits : [];
    drawHints();
  }
  function hideHints() { if (!hints.length && hintBox.hidden) return; hints = []; drawHints(); }
  function dismissHints() { hintDismissed = true; hideHints(); }
  function drawHints() {
    if (!hints.length) { hintBox.hidden = true; hintBox.replaceChildren(); return; }
    hintBox.hidden = false;
    put(hintBox,
      h("div", { class: "composer-hints-head" }, h("span", { class: "lbl" }, "From your past sessions"),
        h("button", { type: "button", class: "ibtn composer-hints-close", "aria-label": "Dismiss", title: "Dismiss (Esc)", onclick: () => dismissHints() }, icon("close", 12))),
      hints.map(hit => h("button", { type: "button", class: "composer-hint-row", title: agoLong(hit.ts),
        onclick: () => opts.onRecall?.(hit) },
        h("span", { class: "composer-hint-snip ellipsis" }, hit.snippet || ""),
        h("span", { class: "composer-hint-meta faint" }, (hit.role === "user" ? "you said" : "you were told") + " · " + ago(hit.ts)))),
    );
  }

  function showFiles(/** @type {import("./core/composer-state.js").MentionRange} */ range) {
    clearTimeout(fileTimer);
    const cwd = opts.cwd?.() || null;
    const folder = shortDir(cwd || "");
    if (!range.query) {
      menu.setKind("mention");
      menu.open([], () => {}, "Files in " + (folder || "this folder"), "Type part of a name");
      return;
    }
    const seq = ++fileSeq;
    fileTimer = setTimeout(async () => {
      // Agents, projects, threads and people from suggest (one ranked list for every surface),
      // then the files of this session's folder.
      const [r, s] = await Promise.all([attempt("files.search", { q: range.query, limit: 50, where: "here" }),
        CAPS.use("suggest.query", () => attempt("suggest.query", queryInput(ta.value, caret())))]);
      if (seq !== fileSeq) return;
      const found = r.error ? [] : (/** @type {any} */ (r.data)?.results || []).map((/** @type {any} */ x) => ({ path: String(x.path || ""), mtime: x.mtime ?? x.modified }));
      const now = findMention(ta.value, caret());
      if (!now) return;
      const named = s.error ? [] : suggestRows(s.data, 5).filter(x => x.kind === "mention");
      // Accounts that can answer one turn: only while the word is the very first of the draft ("@codex ..."), as send reads it.
      const q = now.query.toLowerCase();
      const accts = now.start === 0 ? answers.filter(a => accountToken(a, answers, providerName).toLowerCase().startsWith(q)).slice(0, 5) : [];
      const list = rankFiles(found, now.query, cwd, scorePath, compareScores);
      menu.setKind("mention");
      menu.open([
        ...accts.map(a => ({ key: "a:" + a.provider + ":" + (a.account || ""), value: { account: a }, render: () => [providerMark(a.provider, 18), h("span", { class: "cv-menu-name" }, accountToken(a, answers, providerName)),
          a.sub ? h("span", { class: "cv-menu-desc" }, a.sub) : null, h("span", { class: "cv-menu-badge" }, "Accounts")] })),
        ...named.map(x => ({ key: "s:" + x.source + ":" + x.id, value: { suggestion: x }, render: () => [h("span", { class: "cv-menu-name" }, x.label),
          x.detail ? h("span", { class: "cv-menu-desc" }, x.detail) : null, h("span", { class: "cv-menu-badge" }, x.sub || x.kind)] })),
        ...list.map(f => {
          const cut = f.rel.lastIndexOf("/");
          return { key: f.path, value: f, render: () => [h("span", { class: "cv-menu-dir" }, cut >= 0 ? f.rel.slice(0, cut + 1) : ""), h("span", { class: "cv-menu-name" }, cut >= 0 ? f.rel.slice(cut + 1) : f.rel)] };
        })], row => (row.value.account ? pickAccount(row.value.account) : row.value.suggestion ? pickSuggestion(row.value.suggestion) : pickFile(row.value.rel)),
      accts.length || named.length ? "People, agents and files" : "Files in " + (folder || "this folder"), keysLine(["⏎", "insert"], ["Esc", "close"]));
    }, 120);
    fileTimer.unref?.();
  }
  /** An account chosen from the @ menu: "@Codex " in place of what was typed; send reads it as the account for one turn. */
  function pickAccount(/** @type {import("./core/answer-with.js").AnswerRow} */ a) {
    const range = findMention(ta.value, caret());
    menu.close();
    if (!range) return;
    const r = applyMention(ta.value, range, accountToken(a, answers, providerName));
    setValue(r.text, r.caret, true);
    ta.focus();
  }
  /** A word completed from suggest (Tab on a word, or an @ name): put it in and say it was picked. */
  function pickSuggestion(/** @type {ReturnType<typeof suggestRows>[number]} */ row) {
    menu.close();
    const r = applySuggestion(ta.value, caret(), row);
    setValue(r.text, r.caret, true);
    void CAPS.use("suggest.picked", () => attempt("suggest.picked", pickedInput(row)));
    ta.focus();
  }
  /** Tab on a plain word asks suggest for what it may be; nothing opens on its own while typing. */
  async function showSuggestions() {
    const at = caret(), text = ta.value;
    const { token } = tokenBefore(text, at);
    if (token.length < 2 || token.startsWith("@") || token.startsWith("/")) return false;
    const seq = ++fileSeq;
    const r = await CAPS.use("suggest.query", () => attempt("suggest.query", queryInput(text, at)));
    if (seq !== fileSeq || ta.value !== text || caret() !== at) return true;
    const rows = r.error ? [] : suggestRows(r.data, 8).filter(x => x.kind !== "mention" && x.kind !== "command");
    if (!rows.length) { say("No suggestions for that word", true); return true; }
    if (rows.length === 1) { pickSuggestion(rows[0]); return true; }
    menu.setKind("suggest");
    menu.open(rows.map(x => ({ key: x.source + ":" + x.id, value: x, render: () => [h("span", { class: "cv-menu-name" }, x.label),
      x.detail ? h("span", { class: "cv-menu-desc" }, x.detail) : null] })), row => pickSuggestion(row.value), "Suggestions", keysLine(["↑↓", "move"], ["⏎", "insert"], ["Esc", "close"]));
    return true;
  }
  function pickFile(/** @type {string} */ rel) {
    const range = findMention(ta.value, caret());
    menu.close();
    if (!range) return;
    const r = applyMention(ta.value, range, rel);
    setValue(r.text, r.caret, true);
    ta.focus();
  }

  // ---- images ---------------------------------------------------------------------------------

  function onPaste(/** @type {ClipboardEvent} */ e) {
    // The next input event's new text is pasted (its inputType says so too, where the browser gives one).
    const items = [...(e.clipboardData?.items || [])].filter(it => it.kind === "file" && IMAGE_TYPES.includes(it.type));
    if (!items.length || machine) { pendingPaste = true; setTimeout(() => { pendingPaste = false; }, 0); return; }
    e.preventDefault();
    takeFiles(items.map(it => it.getAsFile()));
  }
  /** Pasted, picked or dropped files: the images among them, once the box says it takes them. @param {(File|null)[]} list */
  function takeFiles(list) {
    const files = list.filter(f => f && IMAGE_TYPES.includes(f.type)).map(f => ({ type: /** @type {File} */ (f).type, file: f }));
    if (!files.length) { if (list.length) say("Only PNG, JPEG, GIF and WebP images can be attached."); return; }
    imagesOk().then(ok => {
      if (!ok) { drawAttach(); say("Images: " + NEEDS_UPDATE.toLowerCase() + "."); return; }
      attach(files);
    });
  }
  /** The attach button: on a Switchboard session whose box has not said no to images. */
  function drawAttach() {
    attachBtn.hidden = !rich() || CAPS.has(SEND_IMAGES) === false;
  }
  /** Does the box take images? Asked once (threads.tasks shipped with them) when not known yet. */
  async function imagesOk() {
    if (CAPS.has(SEND_IMAGES) === null && CAPS.has("threads.tasks") !== false) await CAPS.use("threads.tasks", () => attempt("threads.tasks", { thread }));
    return CAPS.has(SEND_IMAGES) === true;
  }
  /** @param {{ type: string, file: File|null }[]} items */
  function attach(items) {
    for (const it of items) {
      const file = it.file;
      if (!file) continue;
      const rd = new FileReader();
      rd.onload = () => {
        const url = String(rd.result || "");
        const data = url.slice(url.indexOf(",") + 1);
        const r = addImage(images, { media_type: it.type, data, name: file.name || "Pasted image", size: file.size });
        images = r.list;
        if (r.error) say(r.error);
        drawImages();
      };
      rd.readAsDataURL(file);
    }
  }
  function drawImages() {
    thumbs.hidden = !images.length;
    put(thumbs, images.map((im, i) => h("span", { class: "composer-thumb" },
      h("img", { src: `data:${im.media_type};base64,${im.data}`, alt: im.name || "Pasted image" }),
      h("button", { class: "composer-thumb-x", type: "button", "aria-label": "Remove image", onclick: () => { images = removeImage(images, i); drawImages(); } }, "×"))));
  }

  // ---- sending ----------------------------------------------------------------------------------

  const retry = () => h("button", { class: "btn btn-ghost btn-sm composer-retry", type: "button", onclick: () => submit({ button: true }) }, "Try again");

  /** Enter, the send button, or a hold on it. @param {{ button?: boolean, hold?: boolean, alt?: boolean, shift?: boolean }} how */
  function submit(how = {}) {
    // The send button while listening: stop and send, same as Enter (finishTalkAndSend calls
    // back into submit() once voiceListening is already false, so this never loops).
    if (voiceListening) { finishTalkAndSend(); return; }
    // The Send button (or its hold) while a goal is being built: keyboard Cmd+Enter finishes
    // (handled in onKey, below, where the modifier is at hand); a click just adds the line.
    if (goal) { advanceGoal(); return; }
    const a = enterAction({ text: ta.value, running: busy && !machine, queueToggle, images: images.length, touch: touch(), ...how });
    if (a.do === "refuse") { say(IMAGES_NO_QUEUE); return; }
    if (a.do !== "send" || sending) return;
    if (editing) { saveEdit(); return; }
    if (a.kind === "shell") { runShell(draftBody(ta.value)); return; }
    if (a.kind === "memory") { saveMemory(draftBody(ta.value)); return; }
    // "@codex ...": this turn runs on that account (threads.send's account mention); the session stays where it is. Not a teammate.
    if (a.kind === "teammate" && !machine && accountAtStart(ta.value, answers, providerName)) { sendMessage(ta.value.trim(), a.mode); return; }
    if (a.kind === "teammate" && !machine) { askTeammate(teammateRole(ta.value), draftBody(ta.value), ta.value); return; }
    if (a.kind === "command" && !machine) {
      const name = ta.value.trim().slice(1).split(/\s/)[0];
      const local = (commands || normalizeCommands(null)).find(c => c.local && (c.name === name || c.aliases?.includes(name)));
      if (local && local.local) {
        const query = ta.value.trim().slice(1 + name.length).trim();
        setValue(""); runLocal(local.local, query); return;
      }
    }
    sendMessage(ta.value.trim(), a.mode);
  }

  /** What each sent message carried, by its words: the pasted spans and the tags. A failed send or a queued message taken back
   * puts the words in the box again with this map, so what the person typed (#tags, asks) survives and what was pasted stays marked.
   * A draft restored across a reload has no map and stays all not-typed. @type {Map<string, { pasted: string[], mentions: any[] }>} */
  const sentMeta = new Map();
  /** The words back in the box, with the pasted map and tags they were sent with when known. @param {string} text */
  function restoreWords(text) {
    const m = sentMeta.get(text);
    if (!m) { setValue(text); return; }
    setValue(text, text.length, true);
    pastes.reset();
    let from = 0;
    for (const span of m.pasted) { const i = text.indexOf(span, from); if (i >= 0) { pastes.mark(i, i + span.length); from = i + span.length; } }
    tagUI.restore(m.mentions);
    drawChips();
  }

  /** @param {string} text @param {"steer"|"queue"|null} mode */
  async function sendMessage(text, mode) {
    sending = true;
    // The tags still in the words go with the turn as {kind, id, name}; the text keeps its #tokens.
    const mentions = tagUI.take();
    const acct = machine ? null : accountAtStart(text, answers, providerName);
    if (acct) mentions.push(acct.mention);
    const pasted = [...new Set(pastes.of(ta.value).map(x => x.trim()).filter(x => x && text.includes(x)))];
    sentMeta.set(text, { pasted, mentions });
    if (sentMeta.size > 50) sentMeta.delete(/** @type {string} */ (sentMeta.keys().next().value));
    const uuid = newUuid();
    const imgs = images;
    images = []; drawImages();
    setValue("");
    send.disabled = true;
    put(note); note.classList.remove("soft");
    remember(hist, text); saveHistory();
    queueToggle = false;
    // Drawn at once (a steer, a queued row, or a plain send's words), except a / command, which the
    // transcript shows its own way.
    const drawn = !machine && !!S && (!!mode || !text.startsWith("/"));
    // The pictures themselves, not just a count: this device drew them once already (the thumbs
    // under the composer), so the sent row can show the same pictures inline (cohesion item 18).
    if (drawn) patch(localSend(/** @type {any} */ (S), { uuid, text, mode: mode || "send", at: Date.now(), ...(imgs.length ? { images: imgs } : {}) }));
    /** @type {Record<string, any>} */
    const input = machine ? { thread, text, surface: "deck", machine }
      : { thread, text, surface: "deck", uuid, ...(mode ? { mode } : {}), ...(mentions.length ? { mentions } : {}), ...(pasted.length ? { pasted } : {}), ...(imgs.length && CAPS.has(SEND_IMAGES) === true ? { images: sendImages(imgs) } : {}) };
    // Through the outbox (ADR 0029): a box out of reach keeps the words on this device and sends
    // them, once, when it is back. Meanwhile the note says so and the composer takes the next one.
    let waited = false;
    const r = await viaOutbox("threads.send", input, { onWait: () => {
      waited = true; sending = false; send.disabled = false;
      note.classList.add("soft");
      put(note, icon("clock", 12), " Sending when your server answers: ", h("span", { class: "faint" }, text.length > 60 ? text.slice(0, 59) + "…" : text));
    } });
    sending = false;
    send.disabled = false;
    if (waited && !r.error) { put(note); note.classList.remove("soft"); }
    drawChips();
    const back = () => {
      if (drawn) patch(dropLocal(/** @type {any} */ (S), uuid));
      if (!ta.value) restoreWords(text);
      if (!images.length && imgs.length) { images = imgs; drawImages(); }
    };
    // One note, replaced each time, and the words go back in the box so nothing typed is lost.
    if (r.error && r.error.code === "mac_offline") {
      back();
      const who = machine || "your Mac";
      say([h("span", null, `${who} is offline; your message was not sent`), " ", retry()]);
      opts.onOffline?.(who);
      return;
    }
    // The Mac did not answer in time: the message may have gone through, so say so before a resend.
    if (r.error && r.error.code === "timeout") {
      back();
      say([h("span", null, r.error.message || "The Mac did not answer in time; your message may not have been sent"), " ",
        h("span", { class: "faint" }, "It may have been sent. Check before sending again."), " ", retry()]);
      return;
    }
    if (r.error) { say("Could not send: " + r.error.message, false); back(); return; }
    const d = /** @type {any} */ (r.data) || {};
    if (machine) opts.onOffline?.(null);
    if (d.queued != null && d.queued !== false) {
      // Queued: asked for (mode "queue"), or a session busy in a terminal, which queues every
      // message. The answer names the row (queued_id, and the box's uuid; an older box only says
      // queued: true and thread.queued names it). A steer drawn on send was not one: it becomes the row.
      const id = d.queued_id ?? (d.queued === true ? null : d.queued);
      // A session busy in a terminal queued it anyway: the box kept the words, not the images.
      // They go back in the box, so they can be sent once the turn ends.
      if (imgs.length && !images.length) { images = imgs; drawImages(); say("Queued without the images: a queued message keeps only its words. They are back on the server to send after this turn."); }
      if (drawn && mode !== "queue") patch(dropLocal(/** @type {any} */ (S), uuid));
      if (drawn && mode === "queue") patch(confirmSend(/** @type {any} */ (S), uuid, d.uuid));
      if (S && !machine && (id != null || drawn)) patch(localSend(S, { uuid: d.uuid || uuid, text, mode: "queue", at: Date.now(), queued: id }));
      if (id != null && !machine) return;
      busyName = d.name || busyName;
      if (![...waiting.values()].includes(text)) waiting.set("pending:" + text, text);
      drawQueued();
      if (machine && d.note) say(`On ${machine} · ${d.note}`);
      return;
    }
    // A steer: the box's uuid names the words drawn under ours (thread.steered will use it).
    if (drawn) patch(confirmSend(/** @type {any} */ (S), uuid, d.uuid));
    if (d.sent === false) {
      back();
      say([h("span", null, d.note || "The session did not take the message."), " ", retry()]);
      return;
    }
    // Images only go to a box that said it takes them (attach() asked); one that changed its mind sends none.
    if (imgs.length && !machine && CAPS.has(SEND_IMAGES) !== true) say("Sent without the images: " + NEEDS_UPDATE.toLowerCase() + ".");
  }

  async function runShell(/** @type {string} */ command) {
    if (!command || !S) return;
    if (off("threads.shell")) { say(NEEDS_UPDATE); return; }
    const id = newUuid(), t0 = Date.now();
    const text = ta.value;
    setValue("");
    patch(localShell(S, { id, command, at: t0 }));
    const r = await CAPS.use("threads.shell", () => attempt("threads.shell", { thread, command }));
    if (r.error) {
      patch(localShell(S, { id, command, at: t0, error: r.missing ? NEEDS_UPDATE : r.error.message }));
      if (r.missing && !ta.value) setValue(text);
      if (r.missing) say(NEEDS_UPDATE);
      return;
    }
    // {thread, code, output} (stdout, then stderr), and a note when the session is not running.
    const d = /** @type {any} */ (r.data) || {};
    patch(localShell(S, { id, command, at: t0, output: String(d.output ?? ""), exit: typeof d.code === "number" ? d.code : null, duration_ms: Date.now() - t0 }));
    say(d.note ? ["Shell · ", String(d.note)] : ["Shell · Claude sees the output with your next message"]);
  }

  async function saveMemory(/** @type {string} */ text) {
    if (!text) return;
    if (off("threads.remember")) { say(NEEDS_UPDATE); return; }
    const where = SCOPES.find(s => s.id === scope) || SCOPES[0];
    const was = ta.value;
    setValue("");
    say(["Saving to memory · ", where.label]);
    const r = await CAPS.use("threads.remember", () => attempt("threads.remember", { thread, text, scope }));
    if (r.error) { if (!ta.value) setValue(was); say(r.missing ? NEEDS_UPDATE : "Could not save: " + r.error.message); return; }
    // {thread, scope, file}: the CLAUDE.md it went into.
    const file = String(/** @type {any} */ (r.data)?.file || "");
    say([h("span", { class: "lbl" }, "Saved to memory"), " · ", where.label, " ", h("span", { class: "faint" }, file ? file.split(/[\\/]/).pop() + ": " + text : text)]);
  }

  // ---- "@role": a project teammate's own turn (teammates.md section 2) ----------------------

  /** The project's roles, read when asked and kept a minute (nothing polls). */
  let rolesAt = 0, rolesList = /** @type {string[]} */ ([]);
  async function knownRoles(fresh = false) {
    const project = opts.project?.();
    if (!project) return [];
    if (!fresh && Date.now() - rolesAt < 60_000) return rolesList;
    const r = await attempt("team.list", { project });
    rolesAt = Date.now();
    rolesList = r.error || !Array.isArray(r.data) ? [] : /** @type {any[]} */ (r.data).map(x => String(x.role || "")).filter(Boolean);
    return rolesList;
  }

  /** "Did you mean @design?" while the person types a name one slip from a role this project has. Tab or a tap takes it; sending as typed still works. */
  let nearTimer = /** @type {any} */ (null), nearSeq = 0, nearFor = /** @type {string|null} */ (null);
  function scheduleNear() {
    clearTimeout(nearTimer);
    const role = draftKind(ta.value) === "teammate" && !/\s/.test(ta.value) ? teammateRole(ta.value) : null;
    if (!role || !opts.project?.() || machine) { if (nearFor) { nearFor = null; put(note); note.classList.remove("soft"); } return; }
    const seq = ++nearSeq;
    nearTimer = setTimeout(async () => {
      const roles = await knownRoles();
      if (seq !== nearSeq) return;
      const near = nearRole(role, roles);
      if (!near) { if (nearFor) { nearFor = null; put(note); note.classList.remove("soft"); } return; }
      nearFor = near;
      say([h("span", null, "Did you mean "), h("button", { class: "btn btn-ghost btn-sm cv-near", type: "button", onclick: () => takeNear() }, "@" + near),
        h("span", null, "? "), keysLine(["Tab", "takes it"])]);
    }, 250);
    nearTimer.unref?.();
  }
  /** Put the near role in place of the typed one. Returns whether it did. */
  function takeNear() {
    if (!nearFor) return false;
    const rest = ta.value.replace(/^@[A-Za-z][A-Za-z0-9-]{0,40}/, "");
    setValue("@" + nearFor + (rest || " "), undefined, true);
    nearFor = null; put(note); note.classList.remove("soft");
    ta.focus();
    return true;
  }

  /** @param {string|null} role @param {string} text @param {string} raw the whole draft, "@role" and all */
  async function askTeammate(role, text, raw) {
    if (!role || !text || sending) return;
    sending = true; send.disabled = true;
    // Not CAPS.use: a role simply not existing yet answers not_found the same way an absent tool
    // does (vyred's generic 404), and CAPS's own isMissing() cannot tell the two apart from the
    // status code alone - it would mark team.ask missing FOR GOOD the first time any one role
    // came up empty, breaking every later @role even to a teammate that exists. Checked directly,
    // same distinction session.js's own recall.transcript not_found already makes.
    const r = await attempt("team.ask", { to: role, text });
    sending = false; send.disabled = false;
    if (!r.error) { setValue(""); put(note); note.classList.remove("soft"); nearFor = null; return; }
    if (r.error.missing && r.error.code !== "not_found") { say(NEEDS_UPDATE); return; }
    if (r.error.code !== "not_found") { say(`Could not reach ${role}: ${r.error.message || r.error.code}`); return; }
    // No role of that name: the person's own agent by that name (its own chat, anywhere), else a
    // new role made at once (native-core.md section 9: no confirm card). A role beats an agent of
    // the same name here; the two are never merged.
    const mine = await attempt("agents.list", {});
    const agent = Array.isArray(/** @type {any} */ (mine.data)) ? /** @type {any[]} */ (mine.data).find(a => String(a.name || "").toLowerCase() === role) : null;
    if (agent) { await askAgent(String(agent.name), text); return; }
    const project = opts.project?.();
    if (!project) { say(`There's no ${role} teammate here.`); return; }
    const d = await attempt("team.default.get", { project });
    if (d.error || !/** @type {any} */ (d.data)?.enabled) {
      const to = `/settings?project=${encodeURIComponent(project)}#teammates`;
      say([h("span", null, `Teammates are off for this project, so there's no ${role} here. `), link(to, null, "Turn them on in Settings")]);
      return;
    }
    await createAndAsk(role, text, project, raw);
  }

  /** "@kit ...": the person's own agent, a personal chat that works anywhere. Sent without waiting for the reply; it opens in the agent's own chat. */
  async function askAgent(/** @type {string} */ name, /** @type {string} */ text) {
    sending = true; send.disabled = true;
    const r = await attempt("agents.ask", { agent: name, text, surface: "deck", wait: false });
    sending = false; send.disabled = false;
    if (r.error) { say(r.error.missing ? NEEDS_UPDATE : `Could not reach ${name}: ${r.error.message || r.error.code}`); return; }
    setValue("");
    say([h("span", null, `Sent to ${name}. `), link(`/agents/${encodeURIComponent(name)}`, null, `Open ${name}'s chat`)]);
  }

  /** The middle tier of the box's own model list (sessions.models.get's aliases, its one list:
   *  no model id lives here, test/cohesion-drift.test.js) - never the most capable one, for a
   *  guessed teammate nobody has scoped yet. Falls back to the cheapest, then to none (the
   *  server's own default) when the box names one alias or fewer, or the call fails. */
  async function guessModel() {
    const r = await attempt("sessions.models.get", {});
    const aliases = Array.isArray(/** @type {any} */ (r.data)?.aliases) ? /** @type {any} */ (r.data).aliases : [];
    const id = aliases[1]?.id || aliases[aliases.length - 1]?.id;
    return typeof id === "string" ? id : null;
  }

  /** @param {string} role @param {string} text @param {string} project @param {string} raw */
  async function createAndAsk(role, text, project, raw) {
    sending = true; send.disabled = true;
    // A generic template on a guess: no role-specific brief guessed from the name (guessing wrong is
    // worse than asking; the role's charter is drafted by an agent from the project, teammates' side),
    // never worktree isolation, and the box's own middle-tier model (read from sessions.models.get,
    // not named here) since it exists on a guess and should not spend Opus turns proving out a role
    // nobody has scoped yet.
    const model = await guessModel();
    const r = await attempt("team.add", { project, role, brief: "Ask me about anything; I'll figure out the role from what you send me.",
      isolation: "folder", tools: ["files", "web"], ...(model ? { model } : {}) });
    sending = false; send.disabled = false;
    if (r.error) { say(`Could not add ${role}: ${r.error.message || r.error.code}`); return; }
    rolesAt = 0;
    const d = /** @type {any} */ (r.data) || {};
    markMade(project, role, typeof d.agent === "string" ? d.agent : typeof d.id === "string" ? d.id : null);
    await askTeammate(role, text, raw);
  }

  /** A queued message back in the box: Enter saves the new words (threads.edit), Esc lets it be. */
  function editQueued(/** @type {{ uuid: string|null, queued?: any, text: string }} */ q) {
    if (!q) return;
    if (off("threads.edit")) { say(NEEDS_UPDATE); return; }
    if (q.queued == null) { say("Still queueing; edit it in a moment."); return; }
    editing = { uuid: q.uuid, queued: q.queued };
    restoreWords(q.text);
    say([h("span", { class: "lbl" }, "Editing a queued message"), " ", keysLine(["⏎", "saves"], ["Esc", "leaves it as it was"])]);
    ta.focus();
  }
  async function saveEdit() {
    const e = editing;
    if (!e) return;
    const text = ta.value.trim();
    // The edited words go with the same pasted spans and tags a send carries, so an edit cannot turn pasted text into a tag. `pasted` is
    // always sent, [] when nothing was pasted: sessions hears an edited queued message only when the key is an array (an absent key = all not typed).
    const pasted = [...new Set(pastes.of(ta.value).map(x => x.trim()).filter(x => x && text.includes(x)))];
    const mentions = tagUI.chips().map(t => ({ kind: t.kind, id: t.id, name: t.name }));
    const r = await CAPS.use("threads.edit", () => attempt("threads.edit", { thread, queued: e.queued, text, ...(mentions.length ? { mentions } : {}), pasted }));
    if (r.error) { say(r.missing ? NEEDS_UPDATE : "Could not change it: " + r.error.message); return; }
    // thread.queued comes back with the same id and the new words; the row shows them now.
    const q = S?.queued.find(x => x.queued === e.queued);
    if (q) { q.text = text; patch(["@queued"]); }
    editing = null;
    setValue("");
    put(note);
  }

  // ---- keys -----------------------------------------------------------------------------------

  /** Esc, from the box or from anywhere on the page. @returns {boolean} whether it did something */
  function onEscape() {
    // Listening (like goal mode and the rewind picker) closes first: Esc cancels the recording
    // AND removes exactly what this dictation added - anything typed before or after it stays.
    if (voiceSession || voiceOpening) { cancelTalk(); return true; }
    // Goal mode (like the rewind picker) closes first: Esc cancels it, not a general clear.
    if (goal) { cancelGoal(); return true; }
    // A sheet over the composer (the rewind picker) closes first.
    if (opts.onOverlayEscape?.()) return true;
    // A past-sessions hint dismisses easily: Esc while it shows closes it, not the box's own escape.
    if (hints.length) { dismissHints(); return true; }
    const act = escape(esc, { now: Date.now(), running: busy && !machine && !!opts.onStop, text: ta.value, pickerOpen: menu.isOpen(), recalled: recalling(hist) || !!editing });
    if (act === "close") { menu.close(); return true; }
    if (act === "interrupt") { opts.onStop?.(); return true; }
    if (act === "rewind") { if (opts.onRewind && !machine) { opts.onRewind(); return true; } return false; }
    if (act === "clear") { stopRecall(hist); editing = null; setValue(""); put(note); return true; }
    if (act === "leave-mode") { setValue(draftKind(ta.value) === "teammate" ? draftBody(ta.value) : ta.value.slice(1)); return true; }
    return false;
  }

  /**
   * Keys the whole page hears while this session is on screen and focus is not in a text field
   * (the view calls this): Esc, Shift+Tab, Alt+T, Ctrl+O, Ctrl+B.
   * @param {KeyboardEvent} e @returns {boolean} handled
   */
  function key(e) {
    if (e.key === "Escape") return onEscape();
    const id = actionFor(/** @type {any} */ (e), isMacOS());
    if (id === "mode" && rich()) { cycleMode(); return true; }
    if (id === "thinking" && rich()) { toggleThinking(); return true; }
    if (id === "thinking-view" && opts.onThinkingView) { opts.onThinkingView(); return true; }
    if (id === "tasks" && opts.onTasks) { opts.onTasks(); return true; }
    if (id === "voice" && !/** @type {any} */ (e).repeat && !machine) { voiceKeyDown = true; voicePressBegin(); return true; }
    return false;
  }
  /** Ctrl+M's own release: the whole session view, not only the textarea (session.js wires this
   *  to a document keyup, same as key() to its keydown). */
  function keyUp(/** @type {KeyboardEvent} */ e) {
    if (voiceKeyDown && String(e.key).toLowerCase() === "m") { voiceKeyDown = false; voicePressEnd(); return true; }
    return false;
  }

  function onKey(/** @type {KeyboardEvent} */ e) {
    if (e.isComposing) return;
    if (menu.isOpen()) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); menu.move(e.key === "ArrowDown" ? 1 : -1); return; }
      // Tab completes a command's name without running it (a local one too).
      if (e.key === "Tab" && !e.shiftKey && menu.kind === "command") { e.preventDefault(); const row = menu.selected(); if (row) pickCommand(row.value, true); return; }
      if ((e.key === "Enter" && !e.shiftKey) || (e.key === "Tab" && !e.shiftKey)) { if (menu.pick()) { e.preventDefault(); return; } }
    }
    if (e.key === "Escape") { if (onEscape()) e.preventDefault(); return; }
    // Tab takes "Did you mean @design?".
    if (e.key === "Tab" && !e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey && nearFor && takeNear()) { e.preventDefault(); return; }
    // Tab on a word: suggest's completions (the box's names, entities and phrases).
    if (e.key === "Tab" && !e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey && !menu.isOpen() && rich()) {
      const { token } = tokenBefore(ta.value, caret());
      if (token.length >= 2 && !token.startsWith("@") && !token.startsWith("/")) { e.preventDefault(); void showSuggestions(); return; }
    }
    const id = actionFor(/** @type {any} */ (e), isMacOS());
    if (id === "mode") { if (rich()) { e.preventDefault(); cycleMode(); } return; }
    if (id === "thinking" || id === "thinking-view" || id === "tasks" || id === "voice") { if (key(e)) e.preventDefault(); return; }
    if (e.key === "ArrowUp" && !e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey) {
      const firstLine = !ta.value.slice(0, caret()).includes("\n");
      const act = upAction({ text: ta.value, firstLine, recalling: recalling(hist), queued: machine ? 0 : (S?.queued.length || 0) });
      if (act === "edit-queued" && S) { e.preventDefault(); editQueued(S.queued[S.queued.length - 1]); return; }
      if (act === "recall") { const v = recall(hist, "up", ta.value); if (v !== null) { e.preventDefault(); setValue(v); } }
      return;
    }
    if (e.key === "ArrowDown" && recalling(hist) && !ta.value.slice(caret()).includes("\n")) {
      const v = recall(hist, "down", ta.value);
      if (v !== null) { e.preventDefault(); setValue(v); }
      return;
    }
    if (e.key === "Enter" && voiceListening && !e.shiftKey && !e.isComposing) { e.preventDefault(); finishTalkAndSend(); return; }
    if (e.key === "Enter" && goal && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      if (e.metaKey || e.ctrlKey) finishGoal(); else advanceGoal();
      return;
    }
    if (e.key === "Enter") {
      const a = enterAction({ text: ta.value, running: busy && !machine, shift: e.shiftKey, alt: e.altKey, meta: e.metaKey, ctrl: e.ctrlKey,
        queueToggle, composing: e.isComposing, touch: touch(), pickerOpen: false, images: images.length });
      if (a.do === "send") { e.preventDefault(); submit({ alt: e.altKey }); }
    }
  }

  const offs = [
    on("thread.queued", e => {
      if (e.thread !== thread || !e.payload?.queued) return;
      waiting.delete("pending:" + e.payload.text);
      waiting.set(String(e.payload.queued), String(e.payload.text || ""));
      drawQueued();
    }),
    on("thread.unqueued", e => {
      if (e.thread !== thread || e.payload?.queued == null) return;
      waiting.delete(String(e.payload.queued));
      drawQueued();
    }),
    // Handed over (or typed in directly): a queued one leaves the list, and the note goes with the last.
    on("thread.sent", e => {
      if (e.thread !== thread) return;
      const id = e.payload?.queued;
      if (id != null) { waiting.delete(String(id)); waiting.delete("pending:" + e.payload.text); }
      drawQueued();
      if (machine && id != null && !waiting.size) { put(note); note.classList.remove("soft"); }
    }),
    CAPS.on(() => drawChips()),
  ];
  // The mic is never left open: the window losing focus (another app or tab) stops it, keeping
  // the words so far - the same as a tap to stop, not Esc's cancel.
  const onWindowBlur = () => { if (voiceListening) stopTalk(); };
  window.addEventListener("blur", onWindowBlur);
  drawChips();

  // What was mid-typed here, restored (Paseo's own draft persistence): a fresh box always starts
  // empty, so this always applies once, after everything above it is set up.
  if (DRAFTS.has(thread)) setValue(/** @type {string} */ (DRAFTS.get(thread)));

  return {
    el: root, key, keyUp, editQueued, draw: drawChips, value: () => String(ta.value ?? ""), tipSlot, input: ta,
    focus: () => ta.focus(),
    setMachine: m => { machine = m || null; drawChips(); },
    setBusy: v => {
      const was = busy;
      busy = !!v && !!opts.onStop;
      stopBtn.hidden = !busy;
      if (was && !busy) queueToggle = false;
      drawChips();
    },
    tag: v => tagUI.add(v),
    setText: (t, why) => { setValue(String(t ?? "")); if (why) say(why); ta.focus(); },
    stop: () => { flushDraft(); voiceSession?.stop(); stopVoiceElapsed(); clearSilenceTimers(); window.removeEventListener("blur", onWindowBlur); clearTimeout(hintTimer); for (const off of offs) off(); clearTimeout(leaseTimer); clearTimeout(fileTimer); clearTimeout(holdTimer); menu.close(); },
  };
}

/** The last two folders of a path: …/alex/work. @param {string} d */
function shortDir(d) {
  if (!d) return "";
  const parts = String(d).split("/").filter(Boolean);
  return (parts.length > 2 ? "…/" : "/") + parts.slice(-2).join("/");
}
