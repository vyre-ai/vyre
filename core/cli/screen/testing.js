// @ts-check
// A stand-in terminal for tests: an input stream a test types into, and an output that keeps a
// grid of what is on the screen, following the few escape sequences the driver writes. Also
// records the modes (raw, alternate screen, cursor, paste), so a test can check that quitting
// gave the terminal back as it found it. Not shipped (package.json leaves out testing.js).

import { PassThrough, Writable } from "node:stream";
import { stripAnsi } from "./width.js";

/** @param {{ columns?: number, rows?: number }} [o] */
export function fakeTerminal({ columns = 100, rows = 30 } = {}) {
  const input = /** @type {any} */ (new PassThrough());
  input.isTTY = true;
  input.raw = false;
  input.setRawMode = v => { input.raw = v; return input; };
  let grid = Array.from({ length: rows }, () => "");
  let row = 0;
  let raw = "";
  const modes = { alt: false, cursor: true, paste: false };
  const waiters = [];
  const output = /** @type {any} */ (new Writable({ write(chunk, _e, cb) {
    const s = String(chunk);
    raw += s;
    const re = /\x1b\[([0-9;?]*)([A-Za-z])|([^\x1b]+)|\x1b/g;
    let m;
    while ((m = re.exec(s))) {
      if (m[3] !== undefined) { grid[row] = (grid[row] || "") + m[3]; continue; }
      const [p, f] = [m[1] || "", m[2]];
      if (f === "H") { row = p ? Number(p.split(";")[0]) - 1 : 0; grid[row] = ""; }
      else if (f === "J" && p === "2") grid = grid.map(() => "");
      else if (f === "J") for (let i = row + 1; i < grid.length; i++) grid[i] = "";
      else if (p === "?1049") modes.alt = f === "h";
      else if (p === "?25") modes.cursor = f === "h";
      else if (p === "?2004") modes.paste = f === "h";
    }
    for (const w of [...waiters]) w();
    cb();
  } }));
  output.columns = columns;
  output.rows = rows;
  output.isTTY = true;
  const screen = () => grid.map(l => stripAnsi(l).replace(/\s+$/, "")).join("\n");
  return {
    input, output, modes, screen,
    get raw() { return raw; },
    /** Type keys, as text (arrows as escape sequences). */
    type(...keys) { for (const k of keys) input.write(k); },
    /** Resize, as a terminal window does. */
    resize(c, r) { output.columns = c; output.rows = r; grid = Array.from({ length: r }, () => ""); output.emit("resize"); },
    /**
     * Wait until the screen matches, or fail after `ms` with what it showed.
     * @param {RegExp} re @param {number} [ms]
     */
    waitFor(re, ms = 8000) {
      return new Promise((resolve, reject) => {
        const check = () => { if (re.test(screen())) { off(); resolve(screen()); return true; } return false; };
        const timer = setTimeout(() => { off(); reject(new Error(`the screen never showed ${re}:\n${screen()}`)); }, ms);
        const off = () => { clearTimeout(timer); const i = waiters.indexOf(check); if (i >= 0) waiters.splice(i, 1); };
        if (!check()) waiters.push(check);
      });
    },
  };
}
