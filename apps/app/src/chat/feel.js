// @ts-check
// The small words and rules of how a turn feels (CHAT-PARITY gaps 4 to 6): how long it thought, when the soft caret shows, how the running step reads. Pure; Live.tsx draws the motion.

/** "Thinking" while it thinks; "Thought for 12s" once it is done and we saw how long it took; just "Thought" when we did not (a thread loaded from before). @param {boolean} streaming @param {number} ms */
export function thoughtWord(streaming, ms) {
  if (streaming) return "Thinking";
  const s = Math.round(ms / 1000);
  if (!(s >= 1)) return "Thought";
  return s < 60 ? `Thought for ${s}s` : `Thought for ${Math.floor(s / 60)}m${s % 60 ? ` ${s % 60}s` : ""}`;
}

/** The soft caret at the end of an assistant's words shows while the message is still arriving, never on a finished one. @param {{ done: boolean }} m */
export const showsCaret = (m) => !m.done;
