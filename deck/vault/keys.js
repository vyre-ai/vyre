// @ts-check
// The Vault's keyboard map. One pure function from a key event (or its plain parts) to an action
// name, so the view stays small and node can test the map.
//
//   /  filter      j k  move      Enter  open      Esc  close or clear
//   c  copy the main secret      u  copy the username      t  copy the one-time code
//   e  edit      n  new item      f  favorite      L  lock      ?  this list
//
// Nothing fires inside an input, a textarea, a select or anything contenteditable, or with a
// modifier held (Cmd-C stays the browser's), except Esc, which always closes.

/** @type {Record<string, string>} */
export const KEYMAP = {
  "/": "filter", j: "down", k: "up", ArrowDown: "down", ArrowUp: "up", Enter: "open", Escape: "close",
  c: "copy", u: "copy-username", t: "copy-code", e: "edit", n: "new", f: "favorite", L: "lock", "?": "help",
};

/** Rows for the help sheet, in the order people learn them. */
export const HELP = [
  ["/", "Filter the list"], ["j  k", "Next and previous item"], ["Enter", "Open the item"], ["Esc", "Close, or clear the filter"],
  ["c", "Copy the main secret"], ["u", "Copy the username"], ["t", "Copy the one-time code"],
  ["e", "Edit the item"], ["n", "New item"], ["f", "Favorite or unfavorite"], ["L", "Lock the Vault"], ["?", "Show these keys"],
];

/**
 * @param {{ key: string, metaKey?: boolean, ctrlKey?: boolean, altKey?: boolean, target?: any }} e
 * @returns {string | null}
 */
export function actionFor(e) {
  if (e.key === "Escape") return "close";
  if (e.metaKey || e.ctrlKey || e.altKey) return null;
  if (typing(e.target)) return null;
  return Object.prototype.hasOwnProperty.call(KEYMAP, e.key) ? KEYMAP[e.key] : null;
}

/** Is the event's target somewhere text goes? */
export function typing(t) {
  if (!t) return false;
  const tag = String(t.tagName || "").toUpperCase();
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag === "INPUT") return !["button", "checkbox", "radio", "range", "submit", "reset"].includes(String(t.type || "text").toLowerCase());
  return Boolean(t.isContentEditable);
}
