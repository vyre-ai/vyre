// @ts-check
// The keyboard of the transcript: with a message selected, Up and Down move to the one above or below, and one letter does one thing to it
// (R reply, C copy, Shift+C copy as Markdown, A ask about it, E edit your own, B branch from here, P pin, M open its menu). Pure: ChatRows.tsx reads the event and does the thing.

/** What a key does to the selected message, or null. @param {{ key: string, shiftKey?: boolean, metaKey?: boolean, ctrlKey?: boolean, altKey?: boolean }} e @param {{ mine: boolean }} s @returns {"up" | "down" | "reply" | "copy" | "copy-md" | "ask" | "edit" | "branch" | "pin" | "menu" | "leave" | null} */
export function messageKey(e, { mine }) {
  if (e.metaKey || e.ctrlKey || e.altKey) return null;
  if (e.key === "ArrowUp") return "up";
  if (e.key === "ArrowDown") return "down";
  if (e.key === "Escape") return "leave";
  const k = e.key.toLowerCase();
  if (k === "c") return e.shiftKey ? "copy-md" : "copy";
  if (e.shiftKey) return null;
  if (k === "r") return "reply";
  if (k === "a") return "ask";
  if (k === "e") return mine ? "edit" : null;
  if (k === "b") return "branch";
  if (k === "p") return "pin";
  if (k === "m") return "menu";
  return null;
}

/** The index to select after Up or Down in a transcript of `count` messages from `at` (-1 when none is selected: Up lands on the last, Down on the first); it stops at the ends. @param {number} at @param {number} count @param {"up" | "down"} dir */
export function stepMessage(at, count, dir) {
  if (!count) return -1;
  if (at < 0) return dir === "up" ? count - 1 : 0;
  return Math.max(0, Math.min(count - 1, at + (dir === "up" ? -1 : 1)));
}
