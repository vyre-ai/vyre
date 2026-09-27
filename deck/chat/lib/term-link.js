// @ts-check
// The terminal's link to the box (deck/chat/term.js): is the path carrying live streams at all,
// and the small pure pieces of keeping a terminal across drops (further down).
//
// Some ways of reaching the box pass tool calls but not WebSocket upgrades (the tailnet listener
// until it forwards them). There a stream fails the same way every time: the socket errors
// before it opens, or opens and closes with 1006 before a single byte arrives. An ordinary drop
// looks different: the stream was live and had printed something. So two stream-less failures in
// a row, each on a fresh ticket, mean "no link for streams", and reconnecting would only loop.

/**
 * @typedef {{ opened: boolean, data: boolean, code: number }} Attempt one socket, from a fresh ticket
 */

/** Did this socket end without ever carrying a stream? @param {Attempt} a */
export const streamless = a => !a.opened || (!a.data && a.code === 1006);

/**
 * "blocked" when the last two attempts both carried no stream, else "retry".
 * @param {Attempt[]} attempts oldest first
 * @returns {"blocked"|"retry"}
 */
export function linkVerdict(attempts) {
  const last = attempts.slice(-2);
  return last.length === 2 && last.every(streamless) ? "blocked" : "retry";
}

// Keeping a terminal across drops (ADR 0029 R4): the offset this screen has drawn up to, keys
// typed while away, and the phone's key bar.

/** Keys held while disconnected, at most this many characters (ADR 0029 R4: 4 KB). */
export const QUEUE_MAX = 4096;

/**
 * Hold keys typed while the terminal is away. Keys past the cap are dropped, not the oldest:
 * what was typed first is what the person meant first.
 * @param {string} queue @param {string} keys
 * @returns {{ queue: string, dropped: boolean }}
 */
export function holdKeys(queue, keys, max = QUEUE_MAX) {
  const room = Math.max(0, max - queue.length);
  return { queue: queue + keys.slice(0, room), dropped: keys.length > room };
}

/** A stream path with from=<offset> on it. @param {string} path @param {number} offset */
export function withFrom(path, offset) {
  const p = String(path).replace(/([?&])from=\d*(&|$)/, (_m, a, b) => (b ? a : "")).replace(/[?&]$/, "");
  return `${p}${p.includes("?") ? "&" : "?"}from=${Math.max(0, Math.floor(Number(offset) || 0))}`;
}

/**
 * A key from the key bar or the keyboard with the bar's Ctrl and Alt applied. Ctrl turns a letter
 * (or @ [ \ ] ^ _ ?, and space) into its control character; Alt puts Esc before the key.
 * @param {string} d @param {{ ctrl?: boolean, alt?: boolean }} mods
 */
export function withMods(d, { ctrl = false, alt = false } = {}) {
  let out = d;
  if (ctrl && d.length === 1) {
    const c = d.toUpperCase().charCodeAt(0);
    if (d === " ") out = "\x00";
    else if (d === "?") out = "\x7f";
    else if (c >= 0x40 && c <= 0x5f) out = String.fromCharCode(c & 0x1f);
  }
  return alt ? "\x1b" + out : out;
}

/** An arrow key, in the cursor mode the program asked for. @param {"up"|"down"|"right"|"left"} dir @param {boolean} app */
export function arrow(dir, app = false) {
  const k = { up: "A", down: "B", right: "C", left: "D" }[dir];
  return (app ? "\x1bO" : "\x1b[") + k;
}

/**
 * What this screen does with the size, from the box's "at" or "size" message: "own" (fit the
 * screen and send its size), or "watch" (draw at the owner's size and offer Take size).
 * @param {"you"|"other"|"none"|undefined} owner
 * @returns {"own"|"watch"}
 */
export const sizeRole = owner => (owner === "other" ? "watch" : "own");
