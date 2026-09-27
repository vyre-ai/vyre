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

// Keeping a terminal across drops (ADR 0029 R4, core/term/index.js): the offset this screen has
// drawn up to, keys typed while away, what a closed socket or a refused term.attach means, and
// the phone's key bar.

/** Keys held while disconnected, at most this many bytes of UTF-8 (ADR 0029 R4: 4 KB). */
export const QUEUE_MAX = 4096;

/** UTF-8 length of a string, without a TextEncoder. @param {string} s */
export function utf8Length(s) {
  let n = 0;
  for (const ch of s) {
    const c = /** @type {number} */ (ch.codePointAt(0));
    n += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4;
  }
  return n;
}

/**
 * Hold keys typed while the terminal is away. Keys past the cap are dropped, not the oldest:
 * what was typed first is what the person meant first. A character is kept whole or not at all.
 * @param {string} queue @param {string} keys
 * @returns {{ queue: string, dropped: boolean }}
 */
export function holdKeys(queue, keys, max = QUEUE_MAX) {
  let room = Math.max(0, max - utf8Length(queue));
  let kept = "";
  for (const ch of keys) {
    const n = utf8Length(ch);
    if (n > room) return { queue: queue + kept, dropped: true };
    kept += ch; room -= n;
  }
  return { queue: queue + kept, dropped: false };
}

/** A stream path with from=<offset> on it. @param {string} path @param {number} offset */
export function withFrom(path, offset) {
  const p = String(path).replace(/([?&])from=\d*(&|$)/, (_m, a, b) => (b ? a : "")).replace(/[?&]$/, "");
  return `${p}${p.includes("?") ? "&" : "?"}from=${Math.max(0, Math.floor(Number(offset) || 0))}`;
}

/** A byte offset from the box, or null for anything that is not one. @param {any} v */
const offsetOf = v => (typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null);

/**
 * Where a screen stands on its stream: the box's byte count of what it has drawn, whether it has
 * drawn anything, and whether the box is done replaying to this socket.
 * @typedef {{ offset: number, drawn: boolean, caughtUp: boolean }} Track
 */

/** A fresh socket on a screen that keeps what it drew: same offset, not caught up yet. @param {Track} s @returns {Track} */
export const reopened = s => ({ ...s, caughtUp: false });

/**
 * One thing arriving on the stream: a binary frame (its byte count) or a text frame, parsed.
 *   binary  counts toward the offset;
 *   "cut"   the bytes after the screen's offset have left the box's ring: the replay starts at
 *           `from`. The screen keeps what it drew (never a reset) and writes `mark` before it;
 *   "at"    the box's count, adopted as it is, even below the screen's own (a box that restarted
 *           before it wrote its count down). The first one on a socket ends the replay: `live`.
 * @param {Track} s @param {number | { t?: string, [k: string]: any }} ev
 * @returns {{ state: Track, mark: string|null, live: boolean }}
 */
export function step(s, ev) {
  if (typeof ev === "number") {
    const n = Math.max(0, Math.floor(ev) || 0);
    return { state: { ...s, offset: s.offset + n, drawn: s.drawn || n > 0 }, mark: null, live: false };
  }
  const same = { state: s, mark: null, live: false };
  if (!ev || typeof ev !== "object") return same;
  if (ev.t === "cut") {
    const from = offsetOf(ev.from);
    if (from === null) return same;
    const asked = offsetOf(ev.asked);
    const lost = asked === null ? 0 : from - asked;
    const mark = s.drawn
      ? `[${lost > 0 ? bytes(lost) + " of output" : "Output"} from while this screen was away was not kept]`
      : "[Earlier output was not kept]";
    return { state: { ...s, offset: from }, mark, live: false };
  }
  if (ev.t === "at") {
    const at = offsetOf(ev.offset);
    if (at === null) return same;
    return { state: { ...s, offset: at, caughtUp: true }, mark: null, live: !s.caughtUp };
  }
  return same;
}

/** A byte count in plain words. @param {number} n */
export function bytes(n) {
  if (n < 1024) return `${n} byte${n === 1 ? "" : "s"}`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * What a closed socket means. 1000 is a real end, with the box's reason; 1012 "restarting" is
 * vyred stopping, the shell lives on, so reattach at once with term.attach and from; anything
 * else is a drop, retried with backoff.
 * @param {number} code @param {string} [reason]
 * @returns {{ act: "end", why: string } | { act: "reattach" } | { act: "retry" }}
 */
export function onClose(code, reason = "") {
  if (code === 1000) {
    const why = {
      exited: "The shell exited.",
      closed: "The terminal was closed.",
      detached: "The terminal ended: nobody was attached for too long.",
      stopped: "vyred stopped, and this terminal could not outlive it.",
    }[reason] || "The terminal ended.";
    return { act: "end", why };
  }
  if (code === 1012) return { act: "reattach" };
  return { act: "retry" };
}

/**
 * What a refused term.attach means. terminal_closed: a box update took the shell (answered for a
 * day after); not_found: it ended, or it belongs to another screen; no answer or a restarting
 * box: try again; anything else is shown as it is.
 * @param {{ code?: string } | null | undefined} err
 * @returns {"gone"|"ended"|"retry"|"error"}
 */
export function onAttachError(err) {
  const code = String(err?.code || "");
  if (code === "terminal_closed") return "gone";
  if (code === "not_found") return "ended";
  if (/^(offline|restarting|unreachable|timeout|http_50[234])$/.test(code)) return "retry";
  return "error";
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
 * The terminals this browser opened, newest first, at most `max`: the surface each was opened
 * from (a window resized past the phone width must not become another screen) and its folder
 * (for "open a new one here" after a box update). Holds no output.
 * @typedef {{ term: string, surface: string, cwd: string }} Opened
 * @param {any} list @param {Opened} entry @returns {Opened[]}
 */
export function remember(list, entry, max = 16) {
  const rows = Array.isArray(list) ? list.filter(r => r && typeof r.term === "string" && r.term !== entry.term) : [];
  return [entry, ...rows].slice(0, max);
}
