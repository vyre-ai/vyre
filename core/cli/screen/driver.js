// @ts-check
// The one part of the screen that touches a terminal. It takes the alternate screen (so the
// shell's scrollback is left as it was), hides the cursor, turns on raw mode and bracketed
// paste, and hands named keys to the screen. It paints frames by diffing rows: only a row that
// changed is written, and a burst of streamed text is painted at most about 30 times a second.
//
// A terminal left in raw mode, on the alternate screen or with the cursor hidden looks broken to
// the person using it, so `stop` undoes all of it and is safe to call more than once, and it
// runs on every way out: quit, a signal, an uncaught error. `suspend` hands the terminal back
// for a while (Claude Code, a presence prompt, talking to an agent) and `resume` takes it again.

import { keyParser } from "./keys.js";

export const ENTER = "\x1b[?1049h\x1b[?25l\x1b[?2004h\x1b[2J";
export const LEAVE = "\x1b[?2004l\x1b[?25h\x1b[?1049l";
const FRAME_MS = 33;
const ESC_MS = 25;

/**
 * @param {{ input: any, output: any }} io
 * @param {{ real?: boolean, onKeys: (keys: import("./keys.js").Key[]) => void, onResize?: () => void }} o
 *   real: the process's own terminal, so signals and uncaught errors are handled here too.
 */
export function terminal(io, { real = false, onKeys, onResize }) {
  const { input, output } = io;
  const parser = keyParser();
  let prev = /** @type {string[]} */ ([]);
  let on = false;
  let escTimer = null;
  let frameTimer = null;
  let lastPaint = 0;
  /** @type {() => string[]} */
  let frame = () => [];

  const size = () => ({ columns: output.columns || 80, rows: output.rows || 24 });

  const onData = chunk => {
    clearTimeout(escTimer);
    const keys = parser.feed(chunk);
    if (keys.length) onKeys(keys);
    // A lone ESC (or a sequence cut short) waits a moment for the rest, then counts as Esc.
    if (parser.pending) escTimer = setTimeout(() => { const k = parser.flush(); if (k.length) onKeys(k); }, ESC_MS);
  };
  const resized = () => { prev = []; paintNow(); onResize?.(); };

  function paintNow() {
    clearTimeout(frameTimer);
    frameTimer = null;
    if (!on) return;
    lastPaint = Date.now();
    const lines = frame();
    let s = prev.length ? "" : "\x1b[H\x1b[2J";
    for (let i = 0; i < lines.length; i++) if (lines[i] !== prev[i]) s += `\x1b[${i + 1};1H${lines[i]}\x1b[0m\x1b[K`;
    if (lines.length < prev.length) s += `\x1b[${lines.length + 1};1H\x1b[J`;
    prev = lines;
    if (s) output.write(s);
  }

  /** Ask for a paint: soon, and never more than about 30 a second. */
  function paint() {
    if (!on || frameTimer) return;
    frameTimer = setTimeout(paintNow, Math.max(0, FRAME_MS - (Date.now() - lastPaint)));
  }

  function take() {
    if (on) return;
    on = true;
    prev = [];
    output.write(ENTER);
    input.setRawMode?.(true);
    input.setEncoding?.("utf8");
    input.on("data", onData);
    input.resume();
    output.on?.("resize", resized);
  }

  function give() {
    if (!on) return;
    on = false;
    clearTimeout(frameTimer); frameTimer = null;
    clearTimeout(escTimer);
    input.removeListener("data", onData);
    output.removeListener?.("resize", resized);
    output.write(LEAVE);
    try { input.setRawMode?.(false); } catch {}
    input.pause();
  }

  // Every way out of the process restores the terminal first.
  const onSignal = sig => { give(); unhook(); process.kill(process.pid, sig); };
  const onCrash = err => { give(); unhook(); process.stderr.write(`  vyre: ${err && err.message ? err.message : err}\n`); process.exit(1); };
  const onStop = () => { give(); process.once("SIGCONT", onCont); process.kill(process.pid, "SIGTSTP"); };
  const onCont = () => { take(); paintNow(); };
  const signals = ["SIGTERM", "SIGHUP"];
  function hook() {
    if (!real) return;
    for (const s of signals) process.once(s, onSignal);
    process.on("uncaughtException", onCrash);
    process.on("unhandledRejection", onCrash);
  }
  function unhook() {
    for (const s of signals) process.removeListener(s, onSignal);
    process.removeListener("uncaughtException", onCrash);
    process.removeListener("unhandledRejection", onCrash);
    process.removeListener("SIGCONT", onCont);
  }

  return {
    size,
    /** @param {() => string[]} f what to paint */
    start(f) { frame = f; hook(); take(); paintNow(); },
    paint, paintNow,
    /** ctrl-z: give the terminal back and stop, as a shell job does. Only the real terminal. */
    background() { if (real) onStop(); },
    suspend: give,
    resume() { take(); paintNow(); },
    stop() { give(); unhook(); },
    get active() { return on; },
  };
}
