// keys: what the accessory row above a phone keyboard types, as the bytes a terminal expects.
// Pure: no DOM, no React. The row holds esc, tab, ctrl (sticky), the four arrows, pipe and slash.
//
//   key("esc")                      "\x1b"
//   key("up", { appCursor: true })  "\x1bOA"   (full-screen programs set application-cursor mode: DECCKM)
//   key("up")                       "\x1b[A"
//   ctrl("c")                       "\x03"
//
// ctrl is sticky: pressing it arms it for the next key, then it lets go (a second press disarms it).
// applyCtrl turns the next typed character into its control byte; a key with no control form
// passes through unchanged and still lets ctrl go.

/** The row, in order. `id` is what key() takes; `label` is what the button says. */
export const ROW = [
  { id: "esc", label: "esc" },
  { id: "tab", label: "tab" },
  { id: "ctrl", label: "ctrl", sticky: true },
  { id: "left", label: "←" },
  { id: "up", label: "↑" },
  { id: "down", label: "↓" },
  { id: "right", label: "→" },
  { id: "pipe", label: "|" },
  { id: "slash", label: "/" },
];

const ARROW = { up: "A", down: "B", right: "C", left: "D" };

/**
 * The control byte for a character: ctrl+a..z is 1..26, ctrl+[ is ESC, \ ] ^ _ are 28..31, ctrl+space and ctrl+@ are NUL, ctrl+? is DEL.
 * Anything else has none (null).
 * @param {string} ch one character
 * @returns {string|null}
 */
export function ctrl(ch) {
  if (typeof ch !== "string" || [...ch].length !== 1) return null;
  const c = ch.toLowerCase();
  if (c >= "a" && c <= "z") return String.fromCharCode(c.charCodeAt(0) - 96);
  switch (c) {
    case "@": case " ": case "2": return "\x00";
    case "[": case "3": return "\x1b";
    case "\\": case "4": return "\x1c";
    case "]": case "5": return "\x1d";
    case "^": case "6": return "\x1e";
    case "_": case "7": return "\x1f";
    case "?": case "8": return "\x7f";
    default: return null;
  }
}

/**
 * The bytes for one accessory key.
 * @param {string} id a ROW id
 * @param {{ appCursor?: boolean }} [mode] appCursor: the program asked for application cursor keys
 * @returns {string} "" for ctrl itself and for an unknown id
 */
export function key(id, mode = {}) {
  if (id === "esc") return "\x1b";
  if (id === "tab") return "\t";
  if (id === "pipe") return "|";
  if (id === "slash") return "/";
  if (Object.prototype.hasOwnProperty.call(ARROW, id)) return (mode.appCursor ? "\x1bO" : "\x1b[") + ARROW[id];
  return "";
}

/**
 * Sticky ctrl: the state after a press of an accessory key, and the bytes to send.
 * @param {{ ctrl: boolean }} state
 * @param {string} id a ROW id
 * @param {{ appCursor?: boolean }} [mode]
 * @returns {{ state: { ctrl: boolean }, send: string }}
 */
export function press(state, id, mode = {}) {
  if (id === "ctrl") return { state: { ctrl: !state.ctrl }, send: "" };
  const send = key(id, mode);
  // ctrl then an arrow or tab is sent as it is: those have no control byte, and ctrl lets go.
  return { state: { ctrl: false }, send };
}

/**
 * Text typed on the phone's own keyboard while ctrl is armed: the first character becomes its control byte and ctrl lets go.
 * Characters after the first are sent as typed.
 * @param {{ ctrl: boolean }} state @param {string} text
 * @returns {{ state: { ctrl: boolean }, send: string }}
 */
export function applyCtrl(state, text) {
  if (!state.ctrl || !text) return { state, send: text };
  const [first, ...rest] = [...text];
  return { state: { ctrl: false }, send: (ctrl(first) ?? first) + rest.join("") };
}
