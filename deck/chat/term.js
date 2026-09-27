// @ts-check
// A terminal in a folder on the box (ADR 0024, contracts 4 and 5). openTerminal starts one
// (term.open, no passkey: it is the owner's own screen); mountTerminal draws it with xterm.js over
// /v1/streams/term/pty.
//
// The contract is core/term/index.js's header (ADR 0029 R4). Rules this file keeps:
//  - xterm's script and stylesheet load only when a terminal opens, never with Chat;
//  - a hidden tab keeps its socket, so the screen stays current. A closed socket never ends the
//    terminal: the box keeps it with nobody attached for term.keep_hours (12 h by default).
//    Reconnects after a drop wait for the tab to be visible, with a fresh ticket from
//    term.attach, backing off 1, 2, 4 ... 30 s;
//  - a path to the box that carries tool calls but not WebSockets (lib/term-link.js: two stream-less
//    sockets in a row, each on a fresh ticket) shows a "needs the box link" state with Try again,
//    and no reconnect loop;
//  - the screen keeps its own scrollback and never resets it on a reattach. It counts the bytes
//    it has drawn and reattaches with from=<offset> (on term.attach and on the URL), so the box
//    sends only what it missed, then {"t":"at"} with its count, which the screen adopts. When
//    those bytes have left the box's 1 MB ring ({"t":"cut"}), a dim line says so and the replay
//    follows from the oldest line kept;
//  - keys typed while away are held (up to 4 KB) and sent once the box has caught the screen up;
//    the screen dims meanwhile;
//  - closes: 1000 is a real end (the box's reason says which); 1012 "restarting" is vyred
//    stopping with the shell alive, so the screen reattaches at once; anything else is a drop;
//  - after a box update the shell is gone: term.closed {reason: "box updated"} on the event
//    stream, and term.attach answers terminal_closed for a day. One line says so, with a button
//    that opens a new terminal in the same folder;
//  - the size: one screen owns it (the first to attach, or the last to Take size) and only its
//    size resizes the shell. The box says {"t":"size",cols,rows,"owner"} after the "at" and on every
//    change. Owning, this screen fits and sends its size as before. Not owning, it draws at the
//    owner's size, scaled down to fit (letterboxed, never reflowed), and shows "Watching at
//    <cols>x<rows> · Take size"; its own fitted size still goes to the box as the size it would
//    like. A box that sends no size frames: fit and send, no Take size (lib/term-link.js);
//  - on a phone a key bar gives Esc, Tab, Ctrl, Alt, arrows and Paste;
//  - no timers but the reconnect wait. Every string from the box is a text node (deck/js/dom.js).

import { h, put, go } from "../js/dom.js";
import { attempt, on } from "../js/api.js";
import { surfaceId } from "../glass/util.js";
import { linkVerdict, holdKeys, withFrom, withMods, arrow, step, reopened, onClose, onAttachError, remember,
  unsized, sizeReopened, drawAt, watching, onFit, onSizeFrame, takeSize, watchLabel, letterbox } from "./lib/term-link.js";

/** Tickets term.open already issued, so the first mount needs no second round trip. One use, 30 s. */
/** @type {Map<string, { path: string, cwd: string, until: number }>} */
const fresh = new Map();

const OPENED = "vyre.terms";

/** The terminals this browser opened (lib/term-link.js remember). Never throws. @returns {import("./lib/term-link.js").Opened[]} */
function opened() {
  try { const v = JSON.parse(localStorage.getItem(OPENED) || "[]"); return Array.isArray(v) ? v : []; } catch { return []; }
}
/** @param {import("./lib/term-link.js").Opened} entry */
function keep(entry) {
  try { localStorage.setItem(OPENED, JSON.stringify(remember(opened(), entry))); } catch {}
}
/** @param {string} term */
const openedAs = term => opened().find(r => r.term === term) || null;

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
    not_available: "That folder is outside the folders the box shares, or it holds keys.",
    too_many: "Eight terminals are already open. Close one first.",
    not_found: "That terminal has ended.",
    terminal_closed: "The box was updated and this terminal was closed.",
    offline: "vyred did not answer. The box may be asleep or out of reach.",
  };
  return words[err.code] || String(err.message || err);
}

/**
 * Open a terminal in a folder.
 * @param {string} cwd
 * @returns {Promise<{ term: string } | { error: any }>}
 */
export async function openTerminal(cwd) {
  const surface = surfaceId();
  const input = { cwd: String(cwd || ""), surface, ...guessSize() };
  const r = await attempt("term.open", input);
  if (r.error) return { error: r.error };
  fresh.set(r.data.term, { path: r.data.path, cwd: r.data.cwd, until: Date.now() + 25_000 });
  keep({ term: r.data.term, surface, cwd: String(r.data.cwd || cwd || "") });
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
    red: v("--beacon-ink", "#B8A4FF"), brightRed: v("--beacon-dot", "#B8A4FF"),
    green: v("--focus", "#C6F36B"), brightGreen: v("--focus", "#C6F36B"),
    yellow: v("--recall-ink", "#EBC76B"), brightYellow: v("--recall", "#EBC76B"),
    brightBlack: v("--label", "#8C877D"),
  };
}

const monoFont = () => getComputedStyle(document.documentElement).getPropertyValue("--mono").trim() || "ui-monospace, Menlo, monospace";

/**
 * Draw a live terminal in container. Returns cleanup, which closes the socket; the box keeps the
 * terminal (12 h by default) for a reattach, and term.close ends it at once.
 * @param {HTMLElement} container
 * @param {{ term: string, onBack?: () => void }} o
 * @returns {() => void}
 */
export function mountTerminal(container, { term, onBack }) {
  // The surface it was opened from: the same browser in a narrower window is still that screen.
  const mine = openedAs(term);
  const surface = mine?.surface || surfaceId();
  /** Its folder, for a new terminal there after a box update. */
  let cwd = mine?.cwd || "";
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
  /**
   * The box's count of bytes this screen has drawn (a reattach asks for what follows), whether
   * anything is drawn, and whether the box is done replaying to this socket, so keys go straight
   * through. lib/term-link.js step() moves it.
   * @type {import("./lib/term-link.js").Track}
   */
  let track = { offset: 0, drawn: false, caughtUp: false };
  /** Keys typed while away. */
  let queue = "";
  /** Who owns the size, and what this screen last sent on this socket (lib/term-link.js). */
  /** @type {import("./lib/term-link.js").Sizing} */ let sizing = unsized;
  const mods = { ctrl: false, alt: false };

  const dot = h("span", { class: "dot term-dot", "aria-hidden": "true" });
  const word = h("span", { class: "term-word" }, "Connecting");
  const where = h("span", { class: "term-where mono" }, "");
  const back = h("button", { type: "button", class: "btn btn-ghost btn-sm", onclick: () => onBack?.() }, "Back");
  const closeBtn = h("button", { type: "button", class: "btn btn-sm", onclick: () => closeIt() }, "Close");
  const note = h("div", { class: "term-note", role: "status", "aria-live": "polite", hidden: true });
  const screen = h("div", { class: "term-screen" });
  const watchWords = h("span", { class: "term-watch-words" }, "");
  const takeBtn = h("button", { type: "button", class: "term-take", title: "Size the terminal to this screen", onclick: () => take() }, "Take size");
  const watch = h("span", { class: "term-watch", hidden: true }, watchWords, h("span", { class: "term-watch-sep", "aria-hidden": "true" }, " · "), takeBtn);

  /** A key-bar button: it never takes focus from the terminal. @param {string} label @param {() => void} act @param {object} [attrs] */
  const key = (label, act, attrs = {}) => h("button", { type: "button", class: "term-key", onpointerdown: e => e.preventDefault(), onclick: () => { act(); xt?.focus(); }, ...attrs }, label);
  const ctrlKey = key("Ctrl", () => toggle("ctrl"), { "aria-pressed": "false" });
  const altKey = key("Alt", () => toggle("alt"), { "aria-pressed": "false" });
  const app = () => Boolean(xt && xt.modes && xt.modes.applicationCursorKeysMode);
  const keys = h("div", { class: "term-keys", role: "toolbar", "aria-label": "Terminal keys" },
    key("Esc", () => input("\x1b")), key("Tab", () => input("\t")), ctrlKey, altKey,
    key("←", () => input(arrow("left", app())), { "aria-label": "Left" }),
    key("↑", () => input(arrow("up", app())), { "aria-label": "Up" }),
    key("↓", () => input(arrow("down", app())), { "aria-label": "Down" }),
    key("→", () => input(arrow("right", app())), { "aria-label": "Right" }),
    key("Paste", () => paste()));

  const root = h("section", { class: "term", "aria-label": "Terminal" },
    h("header", { class: "term-head" }, back, h("span", { class: "term-title" }, where), h("span", { class: "term-status" }, dot, word), watch, closeBtn),
    note, screen, keys);
  put(container, root);

  /** @param {"connecting"|"live"|"waiting"|"ended"|"error"|"blocked"|"gone"} state @param {string} [msg] @param {any} [action] */
  function status(state, msg = "", action = null) {
    root.dataset.state = state;
    word.textContent = { connecting: "Connecting", live: "Live", waiting: "Reconnecting", ended: "Ended", error: "Not connected", blocked: "No live link", gone: "Closed" }[state];
    if (msg || action) { put(note, h("span", null, msg), action ? [" ", action] : null); note.hidden = false; }
    else { put(note); note.hidden = true; }
    // Dim what is drawn while the box catches this screen up.
    if (state === "live" || state === "ended" || state === "gone" || !track.drawn) delete root.dataset.catching; else root.dataset.catching = "";
    showWatch();
  }

  const setWhere = dir => {
    if (!dir) return;
    cwd = String(dir);
    const parts = cwd.split("/").filter(Boolean);
    where.textContent = parts.length ? parts[parts.length - 1] : "/";
    where.setAttribute("title", cwd);
  };
  setWhere(cwd);

  const send = obj => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); };

  /** @param {"ctrl"|"alt"} m */
  function toggle(m) {
    mods[m] = !mods[m];
    (m === "ctrl" ? ctrlKey : altKey).setAttribute("aria-pressed", String(mods[m]));
  }

  /** Keys to the shell: straight through when live, else held until the box has caught up. @param {string} d */
  function input(d) {
    if (mods.ctrl || mods.alt) {
      d = withMods(d, mods);
      mods.ctrl = mods.alt = false;
      ctrlKey.setAttribute("aria-pressed", "false"); altKey.setAttribute("aria-pressed", "false");
    }
    if (ended) return;
    if (ws && ws.readyState === 1 && track.caughtUp) { send({ t: "in", d }); return; }
    const r = holdKeys(queue, d);
    queue = r.queue;
    if (r.dropped && root.dataset.state !== "live") status(/** @type {any} */ (root.dataset.state), "Some keys were not kept: the terminal holds 4 KB of typing while it is away.");
  }

  async function paste() {
    try {
      const text = await navigator.clipboard.readText();
      if (text && xt) xt.paste(text);
    } catch { if (!dead && root.dataset.state === "live") status("live", "Paste needs permission to read the clipboard."); }
  }

  /** The size this screen would fit, without resizing anything. @returns {{ cols: number, rows: number } | null} */
  function fitted() {
    try { const d = fit?.proposeDimensions(); return d && d.cols > 0 && d.rows > 0 ? { cols: d.cols, rows: d.rows } : null; } catch { return null; }
  }

  /** "Watching at <cols>x<rows> · Take size", only while live and another screen owns the size. */
  function showWatch() {
    const on = watching(sizing) && root.dataset.state === "live" && !ended;
    watch.hidden = !on;
    if (on) watchWords.textContent = watchLabel(sizing);
  }

  /**
   * Draw xterm at the size the sizing says: this screen's own when it owns it, else the owner's,
   * scaled down to fit and centred (never reflowed to this screen's width).
   */
  function draw() {
    if (!xt) return;
    const want = fitted();
    const at = want ? drawAt(sizing, want) : watching(sizing) ? { cols: sizing.cols, rows: sizing.rows } : null;
    if (at && (at.cols !== xt.cols || at.rows !== xt.rows)) { try { xt.resize(at.cols, at.rows); } catch {} }
    const el = /** @type {HTMLElement|null} */ (xt.element);
    if (!el) return;
    if (!watching(sizing)) {
      delete root.dataset.watching;
      el.style.transform = ""; el.style.transformOrigin = "";
      return;
    }
    root.dataset.watching = "";
    const drawn = /** @type {HTMLElement|null} */ (el.querySelector(".xterm-screen"));
    const cs = getComputedStyle(screen);
    const box = { w: screen.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight), h: screen.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom) };
    const lb = letterbox({ w: drawn?.offsetWidth || 0, h: drawn?.offsetHeight || 0 }, box);
    el.style.transformOrigin = "0 0";
    el.style.transform = `translate(${lb.x}px, ${lb.y}px) scale(${lb.scale})`;
  }

  /** @param {{ state: import("./lib/term-link.js").Sizing, send: any }} r */
  function apply(r) {
    sizing = r.state;
    if (r.send) send(r.send);
    draw();
    showWatch();
  }

  /** This screen was fitted: draw at the right size and tell the box this screen's size. */
  function fitAndSend() {
    if (!xt) return;
    if (!ws || ws.readyState !== 1) { draw(); return; }
    apply(onFit(sizing, fitted()));
  }

  /** Take size: this screen owns it, at its fitted size. The box's owner:true frame follows. */
  function take() {
    if (!ws || ws.readyState !== 1) return;
    apply(takeSize(sizing, fitted()));
    xt?.focus();
  }

  async function ticket() {
    const f = fresh.get(term);
    fresh.delete(term);
    if (f && f.until > Date.now()) return { data: f };
    return attempt("term.attach", { term, surface, from: track.offset });
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
      xt.onData(d => input(d));
      xt.onBinary(d => input(d));
      // Sizes go to the box from fitAndSend only: a resize to the owner's size is not this screen's.
      ro = new ResizeObserver(() => { cancelAnimationFrame(frame); frame = requestAnimationFrame(() => fitAndSend()); });
      ro.observe(screen);
      // The Deck switches light and dark on <html data-theme>; follow it.
      mo = new MutationObserver(() => { if (xt) xt.options.theme = theme(); });
      mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "class"] });
      draw();
    }
    const r = await ticket();
    if (dead) return;
    if (r.error) {
      const verdict = onAttachError(r.error);
      if (verdict === "gone") { gone(); return; }
      if (verdict === "ended") { finish("That terminal has ended."); return; }
      if (verdict === "retry") { later(r.error.code === "offline" ? "The box did not answer." : "The box is restarting."); return; }
      status("error", termError(r.error)); return;
    }
    setWhere(r.data.cwd);
    // The URL's from wins over the one given to term.attach; 0 for a new terminal.
    const url = (location.protocol === "https:" ? "wss://" : "ws://") + location.host + withFrom(r.data.path, track.offset);
    let sock;
    try { sock = new WebSocket(url); }
    catch {
      attempts.push({ opened: false, data: false, code: 1006 });
      if (linkVerdict(attempts) === "blocked") blocked(); else later("The connection could not start.");
      return;
    }
    sock.binaryType = "arraybuffer";
    ws = sock;
    track = reopened(track);
    sizing = sizeReopened(sizing);
    const seen = { opened: false, data: false, code: 0 };
    sock.onopen = () => {
      if (ws !== sock) return;
      seen.opened = true;
      // The box replays what this screen missed, then says "at": live from there.
    };
    sock.onmessage = e => {
      if (ws !== sock) return;
      if (!seen.data) { seen.data = true; backoff = 1; attempts = []; }
      if (typeof e.data !== "string") {
        const b = new Uint8Array(e.data);
        track = step(track, b.byteLength).state;
        xt.write(b);
        return;
      }
      let m;
      try { m = JSON.parse(e.data); } catch { return; }
      if (m && m.t === "size") { apply(onSizeFrame(sizing, m, fitted())); return; }
      const r = step(track, m);
      track = r.state;
      // Bytes this screen missed have left the box's ring: say so under what it already drew,
      // then the replay from the oldest line kept follows.
      if (r.mark) xt.write(`${r.state.drawn ? "\r\n" : ""}\x1b[2m${r.mark}\x1b[0m\r\n`);
      if (r.live) {
        status("live");
        fitAndSend();
        if (queue) { const q = queue; queue = ""; send({ t: "in", d: q }); }
        xt.focus();
      }
    };
    sock.onclose = e => {
      if (ws !== sock) return;
      ws = null;
      track = reopened(track);
      if (dead || ended) return;
      seen.code = e.code;
      const c = onClose(e.code, e.reason);
      // 1000: the terminal itself ended, and the reason says how.
      if (c.act === "end") { finish(c.why); return; }
      // 1012 "restarting": vyred is stopping and the shell lives on; reattach from here, at once.
      if (c.act === "reattach") { backoff = 1; attempts = []; later("The box is restarting.", true); return; }
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
    status("blocked", "The terminal needs the box link. Your Deck reaches the box through a path that does not carry live streams yet.",
      h("button", { type: "button", class: "btn btn-sm btn-primary", onclick: () => { attempts = []; backoff = 1; connect(); } }, "Try again"));
  }

  /**
   * Reconnect with a fresh ticket, backing off, only while the tab is visible. `soon`: the first
   * try goes at once (a vyred restart), then the usual backoff.
   * @param {string} reason @param {boolean} [soon]
   */
  function later(reason, soon = false) {
    if (dead || ended) return;
    const held = queue ? " Your typing is held and goes through when it is back." : "";
    status("waiting", soon ? `${reason} Reconnecting.${held}` : `${reason} Trying again in ${backoff} s.${held}`);
    clearTimeout(retry);
    if (document.visibilityState !== "visible") return;
    if (soon) { retry = window.setTimeout(connect, 0); return; }
    retry = window.setTimeout(connect, backoff * 1000);
    backoff = Math.min(30, backoff * 2);
  }

  const onVisible = () => { if (document.visibilityState === "visible" && !ws && !ended && !dead && root.dataset.state === "waiting") connect(); };
  document.addEventListener("visibilitychange", onVisible);

  function finish(msg) {
    ended = true;
    queue = "";
    clearTimeout(retry);
    closeBtn.disabled = true;
    status("ended", msg);
    if (xt) xt.options.cursorBlink = false;
  }

  /** A box update took the shell. One line, and a new terminal in the same folder when this screen knows it. */
  function gone() {
    if (dead) return;
    finish("");
    const s = ws; ws = null;
    try { s?.close(1000); } catch {}
    const again = cwd ? h("button", { type: "button", class: "btn btn-sm btn-primary", onclick: async () => {
      again.disabled = true;
      const r = await openTerminal(cwd);
      if (dead) return;
      if ("error" in r) { again.disabled = false; status("gone", termError(r.error), again); return; }
      go("/chat?term=" + encodeURIComponent(r.term));
    } }, "Open a new terminal here") : null;
    status("gone", "The box was updated and this terminal was closed.", again);
  }

  // After a deploy the box says so on the event log, for every screen that had the terminal.
  const unhear = on("term.closed", ev => { if (ev?.payload?.term === term && ev.payload.reason === "box updated") gone(); });

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
    try { unhear(); } catch {}
    ro?.disconnect(); mo?.disconnect();
    const s = ws; ws = null;
    try { s?.close(1000); } catch {}
    try { xt?.dispose(); } catch {}
    xt = null;
  };
}
