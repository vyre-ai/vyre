// @ts-check
// Raw terminal input as named keys. Input comes in chunks that do not respect keys: a paste or
// a slow SSH link puts several in one chunk, and an escape sequence can be split across two. So
// the parser keeps what it could not finish and reads it with the next chunk. A lone ESC is
// ambiguous (the Esc key, or the start of an arrow that has not fully arrived), so it is held
// until `flush()`, which the driver calls when no more input follows within a few milliseconds.
//
// Bracketed paste (ESC[200~ ... ESC[201~) arrives as one { name: "paste", text } key, so pasted
// text goes into the filter or the compose line as text and never runs as a string of commands.

/** @typedef {{ name: string, text?: string }} Key */

const CSI = {
  A: "up", B: "down", C: "right", D: "left", H: "home", F: "end", Z: "shift-tab",
  "1~": "home", "4~": "end", "7~": "home", "8~": "end", "5~": "pageup", "6~": "pagedown", "3~": "delete", "2~": "insert",
};
const CTRL = { "\r": "enter", "\n": "enter", "\t": "tab", "\x7f": "backspace", "\b": "backspace", "\x03": "ctrl-c",
  "\x04": "ctrl-d", "\x0c": "ctrl-l", "\x15": "ctrl-u", "\x17": "ctrl-w", "\x10": "up", "\x0e": "down", "\x01": "home", "\x05": "end", "\x1a": "ctrl-z" };

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

/** A parser that turns chunks into keys. */
export function keyParser() {
  let buf = "";
  let paste = null;

  /** @returns {Key[]} */
  function feed(chunk) {
    buf += String(chunk);
    /** @type {Key[]} */
    const keys = [];
    for (;;) {
      if (paste !== null) {
        const end = buf.indexOf(PASTE_END);
        if (end === -1) { paste += buf; buf = ""; return keys; }
        paste += buf.slice(0, end);
        buf = buf.slice(end + PASTE_END.length);
        keys.push({ name: "paste", text: paste });
        paste = null;
        continue;
      }
      if (!buf) return keys;
      if (buf.startsWith(PASTE_START)) { buf = buf.slice(PASTE_START.length); paste = ""; continue; }
      const c = buf[0];
      if (c === "\x1b") {
        if (buf.length === 1) return keys; // wait: flush() decides
        const n = buf[1];
        if (n === "[" || n === "O") {
          // A CSI ends at a final byte in @-~. Not there yet: wait for the rest.
          const m = /^\x1b[\[O]([0-9;<=>?]*)([ -/]*)([@-~])/.exec(buf);
          if (!m) {
            if (/^\x1b[\[O][0-9;<=>?]*[ -/]*$/.test(buf) && buf.length < 32) return keys;
            keys.push({ name: "esc" }); buf = buf.slice(1); continue;
          }
          buf = buf.slice(m[0].length);
          const params = m[1].split(";");
          const code = m[3] === "~" ? params[0] + "~" : m[3];
          // Modifiers (ESC[1;5A is ctrl-up) are read as the plain key.
          const name = CSI[code];
          if (name) keys.push({ name });
          continue;
        }
        // ESC then anything else: the Esc key, then that key. Alt-<key> reads the same way, and
        // an Esc typed just before Enter in one chunk is not lost.
        keys.push({ name: "esc" }); buf = buf.slice(1);
        continue;
      }
      if (CTRL[c]) {
        // CRLF from a terminal that sends both is one Enter.
        buf = buf.slice(c === "\r" && buf[1] === "\n" ? 2 : 1);
        keys.push({ name: CTRL[c] });
        continue;
      }
      const cp = /** @type {number} */ (buf.codePointAt(0));
      const ch = String.fromCodePoint(cp);
      buf = buf.slice(ch.length);
      if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) continue; // other controls are ignored
      keys.push({ name: "char", text: ch });
    }
  }

  /** No more input came: a held ESC was the Esc key; an unfinished paste is kept as text. */
  function flush() {
    /** @type {Key[]} */
    const keys = [];
    if (paste !== null) { keys.push({ name: "paste", text: paste + buf }); paste = null; buf = ""; return keys; }
    if (buf === "\x1b") { keys.push({ name: "esc" }); buf = ""; return keys; }
    if (buf.startsWith("\x1b")) { keys.push({ name: "esc" }); const rest = buf.slice(1); buf = ""; keys.push(...feed(rest)); }
    return keys;
  }

  return { feed, flush, get pending() { return buf.length > 0 || paste !== null; } };
}
