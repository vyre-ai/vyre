// @ts-check
// typed: what a person typed into a terminal, as command lines (chat 0.3, task C).
//
// The terminal socket carries keys as {"t":"in","d":"..."}. This assembles them into the lines the
// person completed with Enter, the way a shell's line editor would, for the cases it can know:
// printable text, paste (bracketed or not), Backspace, Ctrl-U, Ctrl-W, Ctrl-C and Ctrl-D (the
// line is abandoned). Anything that makes the shell build the line itself (history with the up
// and down arrows or Ctrl-P, Ctrl-N, Ctrl-R, tab completion, moving the cursor, Ctrl-K, Ctrl-Y)
// marks the line unknown, and an unknown line is never reported: guessing what the shell ran is
// worse than not saying.
//
// It keeps no output and no history, only the line in progress. The caller decides what a line may
// be recorded (no-echo mode, password prompts), through start(): called when a line gets its first
// character, whatever it returns rides on the finished line as `mark`.

/** @typedef {{ text: string, known: boolean, mark: any }} Line */

export class LineTracker {
  /** @param {{ start?: () => any }} [o] */
  constructor(o = {}) {
    this.start = o.start || (() => null);
    this.reset();
    /** Inside an escape sequence: "" none, "esc" after ESC, "csi" in [ ..., "ss3" after ESC O. */
    this.esc = "";
    this.seq = "";
    this.paste = false;
  }

  reset() { this.buf = ""; this.known = true; this.mark = null; this.began = false; }

  /** The line has a first character: ask the caller once. */
  begin() { if (!this.began) { this.began = true; this.mark = this.start(); } }

  /** @param {string} d keys @returns {Line[]} the lines completed by this input */
  feed(d) {
    /** @type {Line[]} */
    const out = [];
    for (const ch of String(d)) {
      if (this.esc) { this.escape(ch); continue; }
      const c = ch.codePointAt(0) || 0;
      if (ch === "\x1b") { this.esc = "esc"; this.seq = ""; continue; }
      if (this.paste) { if (c >= 32 || ch === "\t") { this.begin(); this.buf += ch; } else if (ch === "\r" || ch === "\n") { this.begin(); this.buf += " "; } continue; }
      if (ch === "\r" || ch === "\n") {
        // A bare Enter on an empty line reports nothing; \r\n sent together is one Enter.
        if (this.began || this.buf) out.push({ text: this.buf, known: this.known, mark: this.mark });
        this.reset();
      } else if (ch === "\x7f" || ch === "\b") { this.begin(); this.buf = this.buf.slice(0, -1); }
      else if (ch === "\x15") { this.begin(); this.buf = ""; }
      else if (ch === "\x17") { this.begin(); this.buf = this.buf.replace(/\S+\s*$|\s+$/, ""); }
      else if (ch === "\x03" || ch === "\x04") { this.reset(); }
      else if (ch === "\t" || c === 0x12 || c === 0x10 || c === 0x0e || c === 0x0b || c === 0x19 || c === 0x01 || c === 0x05 || c === 0x02 || c === 0x06) { this.begin(); this.known = false; }
      else if (c >= 32) { this.begin(); this.buf += ch; }
    }
    return out;
  }

  /** One character of an escape sequence. @param {string} ch */
  escape(ch) {
    if (this.esc === "esc") {
      if (ch === "[") { this.esc = "csi"; return; }
      if (ch === "O") { this.esc = "ss3"; return; }
      // Alt+key (ESC then a key): the shell does something with it (Alt-b, Alt-d): unknown.
      this.esc = ""; this.begin(); this.known = false; return;
    }
    if (this.esc === "ss3") { this.esc = ""; this.begin(); this.known = false; return; }
    // CSI: parameters 0x30-0x3f, intermediates 0x20-0x2f, then a final byte 0x40-0x7e.
    const c = ch.codePointAt(0) || 0;
    if (c >= 0x40 && c <= 0x7e) {
      const s = this.seq + ch;
      this.esc = ""; this.seq = "";
      if (s === "200~") { this.paste = true; return; }
      if (s === "201~") { this.paste = false; return; }
      // Arrows, Home, End, Delete, and the rest: the shell edits or recalls.
      this.begin(); this.known = false;
    } else this.seq += ch;
  }
}

/** The text a prompt shows, without colour and cursor codes. @param {string} s */
export const plain = s => s.replace(/\x1b\[[0-?]*[ -\/]*[@-~]/g, "").replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "").replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");

/** True when the last thing the terminal printed asks for a secret ("Password:", "[sudo] password for alex:", "Enter passphrase for key:"). @param {string} tail */
export const asksForSecret = tail => /(?:password|passphrase|passcode)\b[^\n]{0,60}[:?]\s*$/i.test(plain(tail).slice(-200));
