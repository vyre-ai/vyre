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
//   a row), "#" saves a memory (threads.remember, to this project or about you). "@" anywhere
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

import { h, put } from "../js/dom.js";
import { attempt, queued as viaOutbox, on } from "../js/api.js";
import { icon } from "../js/icons.js";
import {
  draftKind, draftBody, kindLabel, findMention, applyMention, rankFiles, historyStore, remember, recall, recalling, stopRecall,
  upAction, enterAction, createEsc, escape, nextMode, modeLabel, actionFor, addImage, removeImage, sendImages, newUuid, IMAGE_TYPES,
  modelChoices, shortModel,
} from "./core/composer-state.js";
import { findCommand, rankCommands, applyCommand, normalizeCommands, sourceLabel } from "./core/commands.js";
import { scorePath, compareScores } from "./core/match.js";
import { CAPS, NEEDS_UPDATE, SEND_IMAGES } from "./core/caps.js";
import { localSend, dropLocal, localShell, confirmSend } from "./core/session-state.js";
import { listMenu, keysLine } from "./pickers.js";

const touch = () => typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;
const isMacOS = () => typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(String(navigator.platform || navigator.userAgent || ""));

/** Sent messages per thread, kept in this browser across reloads. */
const HISTORY_KEY = "vyre.chat.history";
const HISTORY = historyStore();
try { const raw = localStorage.getItem(HISTORY_KEY); if (raw) HISTORY.load(JSON.parse(raw)); } catch {}
const saveHistory = () => { try { localStorage.setItem(HISTORY_KEY, JSON.stringify(HISTORY)); } catch {} };

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
/** A fallback "/" list is asked again after this long (the session was not running: it had none). */
const COMMANDS_RETRY_MS = 15_000;

/**
 * @param {{ thread: string, agents?: string[], threads?: { id: string, name: string|null }[], holder?: string|null, surface?: string,
 *   machine?: string|null, onOffline?: (machine: string|null) => void, onQueue?: (n: number, name: string) => void, onStop?: () => void,
 *   session?: import("./core/session-state.js").Session, patch?: (keys: string[]) => void, cwd?: () => string|null, name?: () => string,
 *   onRewind?: () => void, onTasks?: () => void, onThinkingView?: () => void, onOverlayEscape?: () => boolean }} opts
 * session and patch: the view's session-state and how it redraws what changed (steers, queue rows and shell rows are drawn
 * here, on send). onOffline: called with the Mac's name when a send finds it offline, with null when a send goes through.
 * @returns {{ el: HTMLElement, focus: () => void, stop: () => void, setMachine: (m: string|null) => void, setBusy: (on: boolean) => void,
 *   setText: (text: string, note?: string) => void, editQueued: (q: { uuid: string|null, queued?: any, text: string }) => void,
 *   key: (e: KeyboardEvent) => boolean, draw: () => void, value: () => string }}
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
  const hist = HISTORY.get(thread);
  const esc = createEsc();
  const menu = listMenu();
  /** The session's commands, once asked for; `commandsAt` when, if they were the static fallback. */
  let commands = /** @type {import("./core/commands.js").Command[]|null} */ (null);
  let commandsAt = 0;
  let fileTimer = /** @type {any} */ (null), fileSeq = 0;

  const ta = /** @type {HTMLTextAreaElement} */ (h("textarea", {
    rows: 1, placeholder: "Message this session", "aria-label": "Message", enterkeyhint: "send",
    oninput: () => { grow(); maybeLease(); if (recalling(hist)) stopRecall(hist); suggest(); drawChips(); },
    onkeydown: onKey, onpaste: onPaste,
  }));
  const thumbs = h("div", { class: "composer-images", hidden: true });
  let holdTimer = /** @type {any} */ (null), held = false;
  const send = h("button", { class: "ibtn composer-send", "aria-label": "Send", title: "Send (hold to queue for after this turn)",
    onpointerdown: () => { held = false; clearTimeout(holdTimer); holdTimer = setTimeout(() => { held = true; }, HOLD_MS); },
    onpointerup: () => clearTimeout(holdTimer),
    onclick: () => { const hold = held; held = false; clearTimeout(holdTimer); submit({ button: true, hold }); } }, icon("send", 16));
  const stopBtn = h("button", { class: "btn btn-ghost btn-sm composer-stop", type: "button", hidden: true, title: "Stop this turn (Esc)",
    onclick: () => opts.onStop?.() }, "Stop", h("span", { class: "kbd" }, "Esc"));
  const chips = h("div", { class: "composer-chips" });
  // Attach: the same path as a paste (a picked or dropped file).
  const picker = /** @type {HTMLInputElement} */ (h("input", { type: "file", accept: IMAGE_TYPES.join(","), multiple: true, hidden: true,
    onchange: () => { const fs = [...(picker.files || [])]; picker.value = ""; takeFiles(fs); } }));
  const attachBtn = h("button", { class: "ibtn composer-attach", type: "button", "aria-label": "Attach images", title: "Attach images (PNG, JPEG, GIF, WebP)",
    onclick: () => picker.click() }, icon("plus", 16));
  const wrap = h("div", { class: "composer-wrap", ondragover: (/** @type {DragEvent} */ e) => { if (!machine) e.preventDefault(); },
    ondrop: (/** @type {DragEvent} */ e) => { const fs = [...(e.dataTransfer?.files || [])]; if (!fs.length || machine) return; e.preventDefault(); takeFiles(fs); } }, menu.el,
    h("div", { class: "composer-row" }, attachBtn, picker, ta, stopBtn, send),
  );
  /** Messages waiting in the inbox queue of a session busy in the terminal (the Mac's), by the id thread.queued gives. */
  const waiting = new Map();
  let busyName = "";
  function drawQueued() { opts.onQueue?.(waiting.size, busyName); }
  const note = h("div", { class: "composer-note", role: "status" });
  // The tip sits on the left of the hint line, the key hints stay on the right (tip.md; chat's tip-line.js fills it).
  const tipSlot = h("div", { class: "composer-tip", hidden: true });
  const hint = h("div", { class: "composer-hint" }, tipSlot, h("span", { class: "composer-keys" }, keysLine(["Enter", "to send"], ["Shift+Enter", "new line"], ["/", "commands"], ["@", "files"], ["!", "shell"], ["#", "memory"])));
  const root = h("div", { class: "composer" }, note, thumbs, wrap, chips, hint);

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
  const setValue = (/** @type {string} */ v, at = v.length) => { ta.value = v; try { ta.setSelectionRange?.(at, at); } catch {} grow(); drawChips(); };
  const say = (/** @type {any} */ what, soft = true) => { note.classList.toggle("soft", soft); put(note, what); };

  function maybeLease() {
    if (leaseTimer || machine) return; // a Mac's lease is not forwarded
    leaseTimer = setTimeout(() => { leaseTimer = null; }, 4000);
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
    const kind = draftKind(ta.value);
    ta.placeholder = machine ? "Message this session"
      : busy ? `Steer ${opts.name?.() || "the session"}, or Alt+Enter to queue for after` : "Message this session";
    root.setAttribute("data-mode", kind);
    if (!rich()) { chips.hidden = true; chips.replaceChildren(); chipSig = ""; return; }
    chips.hidden = false;
    const s = /** @type {import("./core/session-state.js").Session} */ (S);
    // Called on every keystroke: rebuilt only when something it shows changed.
    const sig = JSON.stringify([kind, busy, queueToggle, scope, s.mode, s.model, s.thinking,
      ["threads.model", "threads.mode", "threads.thinking", "threads.shell"].map(off), kind === "shell" ? opts.cwd?.() : null]);
    if (sig === chipSig) return;
    chipSig = sig;
    const chip = (/** @type {string} */ cls, /** @type {string} */ tool, /** @type {string} */ title, /** @type {() => void} */ fn, /** @type {any[]} */ ...kids) =>
      h("button", { class: "btn btn-ghost btn-sm composer-chip " + cls, type: "button", disabled: off(tool), title: off(tool) ? NEEDS_UPDATE : title, onclick: fn }, ...kids);
    const label = kindLabel(kind);
    put(chips,
      chip("composer-model", "threads.model", "Switch the model", () => openModels(), shortModel(s.model) || "Model"),
      chip("composer-mode", "threads.mode", "Next mode (Shift+Tab)", () => cycleMode(), modeLabel(s.mode), h("span", { class: "kbd" }, "⇧Tab")),
      chip("composer-thinking", "threads.thinking", "Thinking on or off (Alt+T)", () => toggleThinking(), s.thinking === true ? "Thinking on" : s.thinking === false ? "Thinking off" : "Thinking"),
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

  async function openModels() {
    if (!rich()) return;
    if (off("threads.model")) { say(NEEDS_UPDATE); return; }
    // No list of models on the box: the aliases, the per-purpose map, and this thread's own.
    const r = await CAPS.use("sessions.models.get", () => attempt("sessions.models.get", {}));
    const list = modelChoices({ current: /** @type {any} */ (S).model, purposes: /** @type {any} */ (r.data)?.purposes });
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
    if (menu.kind === "command" || menu.kind === "mention") menu.close();
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
    setValue(r.text, r.caret);
    ta.focus();
  }
  function runLocal(/** @type {string} */ what) {
    if (what === "model") openModels();
    else if (what === "rewind") opts.onRewind?.();
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
      const r = await attempt("files.search", { q: range.query, limit: 50, where: "here" });
      if (seq !== fileSeq) return;
      const found = r.error ? [] : (/** @type {any} */ (r.data)?.results || []).map((/** @type {any} */ x) => ({ path: String(x.path || ""), mtime: x.mtime ?? x.modified }));
      const now = findMention(ta.value, caret());
      if (!now) return;
      const list = rankFiles(found, now.query, cwd, scorePath, compareScores);
      menu.setKind("mention");
      menu.open(list.map(f => {
        const cut = f.rel.lastIndexOf("/");
        return { key: f.path, value: f, render: () => [h("span", { class: "cv-menu-dir" }, cut >= 0 ? f.rel.slice(0, cut + 1) : ""), h("span", { class: "cv-menu-name" }, cut >= 0 ? f.rel.slice(cut + 1) : f.rel)] };
      }), row => pickFile(row.value.rel), "Files in " + (folder || "this folder"), keysLine(["⏎", "insert"], ["Esc", "close"]));
    }, 120);
  }
  function pickFile(/** @type {string} */ rel) {
    const range = findMention(ta.value, caret());
    menu.close();
    if (!range) return;
    const r = applyMention(ta.value, range, rel);
    setValue(r.text, r.caret);
    ta.focus();
  }

  // ---- images ---------------------------------------------------------------------------------

  function onPaste(/** @type {ClipboardEvent} */ e) {
    const items = [...(e.clipboardData?.items || [])].filter(it => it.kind === "file" && IMAGE_TYPES.includes(it.type));
    if (!items.length || machine) return;
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
    const a = enterAction({ text: ta.value, running: busy && !machine, queueToggle, images: images.length, touch: touch(), ...how });
    if (a.do === "refuse") { say(IMAGES_NO_QUEUE); return; }
    if (a.do !== "send" || sending) return;
    if (editing) { saveEdit(); return; }
    if (a.kind === "shell") { runShell(draftBody(ta.value)); return; }
    if (a.kind === "memory") { saveMemory(draftBody(ta.value)); return; }
    if (a.kind === "command" && !machine) {
      const name = ta.value.trim().slice(1).split(/\s/)[0];
      const local = (commands || normalizeCommands(null)).find(c => c.name === name && c.local);
      if (local && local.local) { setValue(""); runLocal(local.local); return; }
    }
    sendMessage(ta.value.trim(), a.mode);
  }

  /** @param {string} text @param {"steer"|"queue"|null} mode */
  async function sendMessage(text, mode) {
    sending = true;
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
    if (drawn) patch(localSend(/** @type {any} */ (S), { uuid, text, mode: mode || "send", at: Date.now(), ...(imgs.length ? { images: imgs.length } : {}) }));
    /** @type {Record<string, any>} */
    const input = machine ? { thread, text, surface: "deck", machine }
      : { thread, text, surface: "deck", uuid, ...(mode ? { mode } : {}), ...(imgs.length && CAPS.has(SEND_IMAGES) === true ? { images: sendImages(imgs) } : {}) };
    // Through the outbox (ADR 0029): a box out of reach keeps the words on this device and sends
    // them, once, when it is back. Meanwhile the note says so and the composer takes the next one.
    let waited = false;
    const r = await viaOutbox("threads.send", input, { onWait: () => {
      waited = true; sending = false; send.disabled = false;
      note.classList.add("soft");
      put(note, icon("clock", 12), " Sending when your box answers: ", h("span", { class: "faint" }, text.length > 60 ? text.slice(0, 59) + "…" : text));
    } });
    sending = false;
    send.disabled = false;
    if (waited && !r.error) { put(note); note.classList.remove("soft"); }
    drawChips();
    const back = () => {
      if (drawn) patch(dropLocal(/** @type {any} */ (S), uuid));
      if (!ta.value) setValue(text);
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
      if (imgs.length && !images.length) { images = imgs; drawImages(); say("Queued without the images: a queued message keeps only its words. They are back in the box to send after this turn."); }
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
    if (drawn && d.uuid) patch(confirmSend(/** @type {any} */ (S), uuid, d.uuid));
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

  /** A queued message back in the box: Enter saves the new words (threads.edit), Esc lets it be. */
  function editQueued(/** @type {{ uuid: string|null, queued?: any, text: string }} */ q) {
    if (!q) return;
    if (off("threads.edit")) { say(NEEDS_UPDATE); return; }
    if (q.queued == null) { say("Still queueing; edit it in a moment."); return; }
    editing = { uuid: q.uuid, queued: q.queued };
    setValue(q.text);
    say([h("span", { class: "lbl" }, "Editing a queued message"), " ", keysLine(["⏎", "saves"], ["Esc", "leaves it as it was"])]);
    ta.focus();
  }
  async function saveEdit() {
    const e = editing;
    if (!e) return;
    const text = ta.value.trim();
    const r = await CAPS.use("threads.edit", () => attempt("threads.edit", { thread, queued: e.queued, text }));
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
    // A sheet over the composer (the rewind picker) closes first.
    if (opts.onOverlayEscape?.()) return true;
    const act = escape(esc, { now: Date.now(), running: busy && !machine && !!opts.onStop, text: ta.value, pickerOpen: menu.isOpen(), recalled: recalling(hist) || !!editing });
    if (act === "close") { menu.close(); return true; }
    if (act === "interrupt") { opts.onStop?.(); return true; }
    if (act === "rewind") { if (opts.onRewind && !machine) { opts.onRewind(); return true; } return false; }
    if (act === "clear") { stopRecall(hist); editing = null; setValue(""); put(note); return true; }
    if (act === "leave-mode") { setValue(ta.value.slice(1)); return true; }
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
    const id = actionFor(/** @type {any} */ (e), isMacOS());
    if (id === "mode") { if (rich()) { e.preventDefault(); cycleMode(); } return; }
    if (id === "thinking" || id === "thinking-view" || id === "tasks") { if (key(e)) e.preventDefault(); return; }
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
  drawChips();

  return {
    el: root, key, editQueued, draw: drawChips, value: () => String(ta.value ?? ""), tipSlot, input: ta,
    focus: () => ta.focus(),
    setMachine: m => { machine = m || null; drawChips(); },
    setBusy: v => {
      const was = busy;
      busy = !!v && !!opts.onStop;
      stopBtn.hidden = !busy;
      if (was && !busy) queueToggle = false;
      drawChips();
    },
    setText: (t, why) => { setValue(String(t ?? "")); if (why) say(why); ta.focus(); },
    stop: () => { for (const off of offs) off(); clearTimeout(leaseTimer); clearTimeout(fileTimer); clearTimeout(holdTimer); menu.close(); },
  };
}

/** The last two folders of a path: …/alex/work. @param {string} d */
function shortDir(d) {
  if (!d) return "";
  const parts = String(d).split("/").filter(Boolean);
  return (parts.length > 2 ? "…/" : "/") + parts.slice(-2).join("/");
}
