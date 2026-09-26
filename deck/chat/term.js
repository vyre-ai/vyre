// @ts-check
// A terminal in a folder on the box (ADR 0024, contracts 4 and 5). openTerminal starts one
// (term.open, with the one passkey term.unlock asks for the first time this screen opens a
// terminal in 12 hours); mountTerminal draws it with xterm.js over /v1/streams/term/pty.
//
// Rules this file keeps:
//  - xterm's script and stylesheet load only when a terminal opens, never with Chat;
//  - the passkey is asked for only when the box says unlock_required, and on a reload only from a
//    button (a browser shows a passkey prompt only after a tap);
//  - a hidden tab keeps its socket (closing it would end the terminal 10 s later); reconnects
//    after a drop wait for the tab to be visible, with a fresh ticket from term.attach, backing
//    off 1, 2, 4 ... 30 s;
//  - a path to the box that carries tool calls but not WebSockets (lib/term-link.js: two stream-less
//    sockets in a row, each on a fresh ticket) shows a "needs the box link" state with Try again,
//    and no reconnect loop;
//  - the box replays the last 64 KB on every attach, so the screen is reset before each one;
//  - no timers but the reconnect wait. Every string from the box is a text node (deck/js/dom.js).

import { h, put } from "../js/dom.js";
import { attempt } from "../js/api.js";
import { surfaceId } from "../glass/util.js";
import { linkVerdict } from "./lib/term-link.js";

/** Tickets term.open already issued, so the first mount needs no second round trip. One use, 30 s. */
/** @type {Map<string, { path: string, cwd: string, until: number }>} */
const fresh = new Map();

/** A rough size before xterm has measured anything; the first fit corrects it. */
function guessSize() {
  const w = typeof window === "undefined" ? 800 : window.innerWidth;
  const hgt = typeof window === "undefined" ? 600 : window.innerHeight;
  return { cols: Math.max(20, Math.min(240, Math.floor((w - 32) / 8))), rows: Math.max(8, Math.min(80, Math.floor((hgt - 120) / 18))) };
}

/** Error codes from term.* in plain words. @param {any} err */
export function termError(err) {
  if (!err) return "";
  if (err.missing && err.code !== "offline") return "Terminals are not available on this machine yet (the term module is not running).";
  const words = {
    unlock_required: "Prove it is you to open a terminal from this screen.",
    presence_required: "Prove it is you to open a terminal from this screen.",
    cancelled: "The passkey was cancelled, so no terminal was opened.",
    no_passkey: "This browser cannot use a passkey. Open the Deck in Safari or Chrome over your tailnet.",
    not_available: "That folder is outside the folders the box shares, or it holds keys.",
    too_many: "Eight terminals are already open. Close one first.",
    not_found: "That terminal has ended.",
    offline: "vyred did not answer. The box may be asleep or out of reach.",
  };
  return words[err.code] || String(err.message || err);
}

/**
 * Open a terminal in a folder. Asks for a passkey only when the box says this screen has not
 * unlocked terminals yet. Call it from a tap: the passkey prompt needs one.
 * @param {string} cwd
 * @returns {Promise<{ term: string } | { error: any }>}
 */
export async function openTerminal(cwd) {
  const surface = surfaceId();
  const input = { cwd: String(cwd || ""), surface, ...guessSize() };
  let r = await attempt("term.open", input);
  if (r.error && r.error.code === "unlock_required") {
    const u = await attempt("term.unlock", { surface }, { presence: true });
    if (u.error) return { error: u.error };
    r = await attempt("term.open", input);
  }
  if (r.error) return { error: r.error };
  fresh.set(r.data.term, { path: r.data.path, cwd: r.data.cwd, until: Date.now() + 25_000 });
  return { term: r.data.term };
}

let loading = /** @type {Promise<{ Terminal: any, FitAddon: any }>|null} */ (null);

/** xterm and its fit addon, and their stylesheets, once per page. */
function loadXterm() {
  if (loading) return loading;
  for (const href of [new URL("../vendor/xterm/xterm.css", import.meta.url).href, new URL("./term.css", import.meta.url).href]) {
    if (!document.querySelector(`link[data-term-css="${href}"]`)) document.head.append(h("link", { rel: "stylesheet", href, "data-term-css": href }));
  }
  loading = Promise.all([import("../vendor/xterm/xterm.js"), import("../vendor/xterm/addon-fit.js")])
    .then(([x, f]) => ({ Terminal: x.Terminal, FitAddon: f.FitAddon }))
    .catch(e => { loading = null; throw e; });
  return loading;
}

/** xterm's colours from the Deck's tokens, so light and dark follow the Deck. */
function theme() {
  const cs = getComputedStyle(document.documentElement);
  const v = (name, dflt) => cs.getPropertyValue(name).trim() || dflt;
  return {
    background: v("--panel", "#161513"), foreground: v("--text", "#F1EEE6"),
    cursor: v("--focus", "#C6F36B"), cursorAccent: v("--panel", "#161513"),
    selectionBackground: v("--rule-strong", "#3A3733"),
    red: v("--beacon-ink", "#FF7A59"), brightRed: v("--beacon-dot", "#FF7A59"),
    green: v("--focus", "#C6F36B"), brightGreen: v("--signal-hover", "#D4F88A"),
    yellow: v("--recall-ink", "#EBC76B"), brightYellow: v("--recall", "#EBC76B"),
    brightBlack: v("--label", "#8C877D"),
  };
}

const monoFont = () => getComputedStyle(document.documentElement).getPropertyValue("--mono").trim() || "ui-monospace, Menlo, monospace";

/**
 * Draw a live terminal in container. Returns cleanup, which closes the socket; the box ends the
 * terminal 10 s later unless something reattaches (term.close ends it at once).
 * @param {HTMLElement} container
 * @param {{ term: string, onBack?: () => void }} o
 * @returns {() => void}
 */
export function mountTerminal(container, { term, onBack }) {
  const surface = surfaceId();
  let dead = false, ended = false;
  let backoff = 1, retry = 0;
  /** How each socket since the last live stream ended: lib/term-link.js decides from these. */
  /** @type {import("./lib/term-link.js").Attempt[]} */ let attempts = [];
  /** @type {WebSocket|null} */ let ws = null;
  /** @type {any} */ let xt = null;
  /** @type {any} */ let fit = null;
  /** @type {ResizeObserver|null} */ let ro = null;
  /** @type {MutationObserver|null} */ let mo = null;
  let frame = 0;
  const enc = new TextEncoder();

  const dot = h("span", { class: "dot term-dot", "aria-hidden": "true" });
  const word = h("span", { class: "term-word" }, "Connecting");
  const where = h("span", { class: "term-where mono" }, "");
  const back = h("button", { type: "button", class: "btn btn-ghost btn-sm", onclick: () => onBack?.() }, "Back");
  const closeBtn = h("button", { type: "button", class: "btn btn-sm", onclick: () => closeIt() }, "Close");
  const note = h("div", { class: "term-note", role: "status", "aria-live": "polite", hidden: true });
  const screen = h("div", { class: "term-screen" });
  const root = h("section", { class: "term", "aria-label": "Terminal" },
    h("header", { class: "term-head" }, back, h("span", { class: "term-title" }, where), h("span", { class: "term-status" }, dot, word), closeBtn),
    note, screen);
  put(container, root);

  /** @param {"connecting"|"live"|"waiting"|"ended"|"locked"|"error"|"blocked"} state @param {string} [msg] @param {any} [action] */
  function status(state, msg = "", action = null) {
    root.dataset.state = state;
    word.textContent = { connecting: "Connecting", live: "Live", waiting: "Reconnecting", ended: "Ended", locked: "Locked", error: "Not connected", blocked: "No live link" }[state];
    if (msg || action) { put(note, h("span", null, msg), action ? [" ", action] : null); note.hidden = false; }
    else { put(note); note.hidden = true; }
  }

  const setWhere = cwd => {
    if (!cwd) return;
    const parts = String(cwd).split("/").filter(Boolean);
    where.textContent = parts.length ? parts[parts.length - 1] : "/";
    where.setAttribute("title", String(cwd));
  };

  const send = obj => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); };

  async function ticket() {
    const f = fresh.get(term);
    fresh.delete(term);
    if (f && f.until > Date.now()) return { data: f };
    return attempt("term.attach", { term, surface });
  }

  async function connect() {
    if (dead || ended) return;
    clearTimeout(retry);
    status("connecting");
    let X;
    try { X = await loadXterm(); } catch { status("error", "The terminal did not load."); return; }
    if (dead) return;
    if (!xt) {
      xt = new X.Terminal({ theme: theme(), fontFamily: monoFont(), fontSize: 13, lineHeight: 1.2, cursorBlink: true, scrollback: 5000, allowProposedApi: false });
      fit = new X.FitAddon();
      xt.loadAddon(fit);
      xt.open(screen);
      xt.onData(d => send({ t: "in", d }));
      xt.onBinary(d => send({ t: "in", d }));
      xt.onResize(s => send({ t: "size", cols: s.cols, rows: s.rows }));
      ro = new ResizeObserver(() => { cancelAnimationFrame(frame); frame = requestAnimationFrame(() => { try { fit.fit(); } catch {} }); });
      ro.observe(screen);
      // The Deck switches light and dark on <html data-theme>; follow it.
      mo = new MutationObserver(() => { if (xt) xt.options.theme = theme(); });
      mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "class"] });
      try { fit.fit(); } catch {}
    }
    const r = await ticket();
    if (dead) return;
    if (r.error) {
      if (r.error.code === "unlock_required") { status("locked", "Terminals on this screen are locked.", h("button", { type: "button", class: "btn btn-sm btn-primary", onclick: unlock }, "Unlock")); return; }
      if (r.error.code === "not_found") { finish("That terminal has ended."); return; }
      if (r.error.code === "offline") { later("The box did not answer."); return; }
      status("error", termError(r.error)); return;
    }
    setWhere(r.data.cwd);
    const url = (location.protocol === "https:" ? "wss://" : "ws://") + location.host + r.data.path;
    let sock;
    try { sock = new WebSocket(url); }
    catch {
      attempts.push({ opened: false, data: false, code: 1006 });
      if (linkVerdict(attempts) === "blocked") blocked(); else later("The connection could not start.");
      return;
    }
    sock.binaryType = "arraybuffer";
    ws = sock;
    const seen = { opened: false, data: false, code: 0 };
    sock.onopen = () => {
      if (ws !== sock) return;
      seen.opened = true;
      // What follows first is the box's replay of the recent screen: start from a clean one.
      xt.reset();
      status("live");
      send({ t: "size", cols: xt.cols, rows: xt.rows });
      xt.focus();
    };
    sock.onmessage = e => {
      if (ws !== sock) return;
      if (!seen.data) { seen.data = true; backoff = 1; attempts = []; }
      xt.write(typeof e.data === "string" ? enc.encode(e.data) : new Uint8Array(e.data));
    };
    sock.onclose = e => {
      if (ws !== sock) return;
      ws = null;
      if (dead) return;
      seen.code = e.code;
      // The box closes with 1000 and a reason when the terminal itself ended.
      if (e.code === 1000 && /^(exited|closed|detached|stopped)$/.test(e.reason)) {
        finish(e.reason === "exited" ? "The shell exited." : e.reason === "closed" ? "The terminal was closed." : "The terminal ended.");
        return;
      }
      if (!seen.data) {
        attempts.push({ ...seen });
        if (linkVerdict(attempts) === "blocked") { blocked(); return; }
      }
      later("The connection dropped.");
    };
  }

  /** This path to the box does not carry live streams: say so and wait for a tap, never loop. */
  function blocked() {
    clearTimeout(retry);
    try { xt?.reset(); } catch {}
    status("blocked", "The terminal needs the box link. Your Deck reaches the box through a path that does not carry live streams yet.",
      h("button", { type: "button", class: "btn btn-sm btn-primary", onclick: () => { attempts = []; backoff = 1; connect(); } }, "Try again"));
  }

  /** Reconnect with a fresh ticket, backing off, only while the tab is visible. */
  function later(reason) {
    if (dead || ended) return;
    status("waiting", `${reason} Trying again in ${backoff} s.`);
    clearTimeout(retry);
    if (document.visibilityState !== "visible") return;
    retry = window.setTimeout(connect, backoff * 1000);
    backoff = Math.min(30, backoff * 2);
  }

  const onVisible = () => { if (document.visibilityState === "visible" && !ws && !ended && !dead && root.dataset.state === "waiting") connect(); };
  document.addEventListener("visibilitychange", onVisible);

  async function unlock() {
    status("connecting");
    const u = await attempt("term.unlock", { surface }, { presence: true });
    if (dead) return;
    if (u.error) { status("locked", termError(u.error), h("button", { type: "button", class: "btn btn-sm btn-primary", onclick: unlock }, "Try again")); return; }
    connect();
  }

  function finish(msg) {
    ended = true;
    clearTimeout(retry);
    closeBtn.disabled = true;
    status("ended", msg);
    if (xt) xt.options.cursorBlink = false;
  }

  async function closeIt() {
    closeBtn.disabled = true;
    const r = await attempt("term.close", { term });
    if (r.error && !dead) { closeBtn.disabled = false; status(root.dataset.state === "live" ? "live" : "error", termError(r.error)); return; }
    finish("The terminal was closed.");
    onBack?.();
  }

  connect();

  return () => {
    dead = true;
    clearTimeout(retry);
    cancelAnimationFrame(frame);
    document.removeEventListener("visibilitychange", onVisible);
    ro?.disconnect(); mo?.disconnect();
    const s = ws; ws = null;
    try { s?.close(1000); } catch {}
    try { xt?.dispose(); } catch {}
    xt = null;
  };
}
