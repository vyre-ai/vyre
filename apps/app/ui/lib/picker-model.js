// @ts-check
// The keyboard model of every picker (the composer's / @ # lists and the Answering list): which rows a typed query keeps, where
// the active row moves, what a key does, how a mention chip is deleted whole, and how far to scroll to keep the active row in
// view. Pure: no DOM, no React. The components in ui/components/PickerList.tsx and src/chat/ChatComposer.tsx only read events and call these.

/**
 * The rows a query keeps: label starts with it first, then contains it; stable inside a tier. Empty query keeps all.
 * @template {{ label: string }} T @param {readonly T[]} items @param {string} query @param {number} [cap]
 * @returns {T[]}
 */
export function filterItems(items, query, cap = 50) {
  const q = String(query ?? "").trim().toLowerCase();
  const tier = (/** @type {string} */ s) => { const l = s.toLowerCase(); return !q || l.startsWith(q) ? 0 : l.includes(q) ? 1 : 2; };
  const keep = items.map((it, i) => ({ it, i, t: tier(it.label) })).filter((x) => x.t < 2);
  keep.sort((a, b) => a.t - b.t || a.i - b.i);
  return keep.slice(0, cap).map((x) => x.it);
}

/** The next active index, wrapping at both ends; 0 for an empty list. @param {number} index @param {number} delta @param {number} count */
export function moveActive(index, delta, count) {
  if (count <= 0) return 0;
  return (((index + delta) % count) + count) % count;
}

/**
 * What a key does inside an open picker: "next" | "prev" | "pick" | "close", or null (the key goes on to the box). Enter and Tab
 * pick only when there is a row; Backspace closes only on an empty query (it then deletes the trigger character itself).
 * @param {{ key: string, shiftKey?: boolean, metaKey?: boolean, ctrlKey?: boolean, altKey?: boolean }} e @param {{ query: string, count: number }} s
 * @returns {"next" | "prev" | "pick" | "close" | null}
 */
export function pickerKey(e, { query, count }) {
  if (e.metaKey || e.ctrlKey || e.altKey) return null;
  if (e.key === "Escape") return "close";
  if (e.key === "Backspace") return query === "" ? "close" : null;
  if (!count) return null;
  if (e.key === "ArrowDown") return "next";
  if (e.key === "ArrowUp") return "prev";
  if ((e.key === "Enter" || e.key === "Tab") && !e.shiftKey) return "pick";
  return null;
}

/** How a mention of `name` reads in the words: plain, or in quotes when it has a space (core/composer-state.js writes both). @param {string} lead @param {string} name */
const forms = (lead, name) => [lead + name, `${lead}"${name}"`];
/** @param {string} s */
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Backspace right after a mention token ("@Dana Wine", "#Q3 plan", with or without the one space after it) removes the whole token.
 * Null when the caret is not at the end of one of `names` led by @ or #.
 * @param {string} text @param {number} caret @param {readonly string[]} names
 * @returns {{ text: string, caret: number } | null}
 */
export function deleteTokenBack(text, caret, names) {
  const before = text.slice(0, caret);
  const base = before.endsWith(" ") ? before.slice(0, -1) : before;
  const sorted = [...names].sort((a, b) => b.length - a.length);
  for (const n of sorted) {
    for (const lead of ["@", "#"]) for (const tok of forms(lead, n)) {
      if (!base.endsWith(tok)) continue;
      const start = base.length - tok.length;
      if (start > 0 && !/\s/.test(base[start - 1])) continue;
      return { text: text.slice(0, start) + text.slice(caret), caret: start };
    }
  }
  return null;
}

/** The scroll offset that keeps row `index` fully visible in a list `viewH` tall at `top`. @param {number} index @param {number} rowH @param {number} top @param {number} viewH */
export function scrollTopFor(index, rowH, top, viewH) {
  const y = index * rowH;
  if (y < top) return y;
  if (y + rowH > top + viewH) return y + rowH - viewH;
  return top;
}

/**
 * The composer's own shortcuts: Cmd or Ctrl + / opens the Answering list, Cmd or Ctrl + U attaches, Alt + 1..9 toggles the nth AI, Alt + 0 asks all.
 * @param {{ key: string, code?: string, metaKey?: boolean, ctrlKey?: boolean, altKey?: boolean }} e
 * @returns {string | null}
 */
export function composerShortcut(e) {
  const mod = e.metaKey || e.ctrlKey;
  if (mod && e.key === "/") return "answering";
  if (mod && e.key.toLowerCase() === "u") return "attach";
  // On a Mac Option+1 types a symbol: the physical key (code) says which digit it was.
  const digit = e.code && /^(Digit|Numpad)[0-9]$/.test(e.code) ? e.code.slice(-1) : /^[0-9]$/.test(e.key) ? e.key : null;
  if (e.altKey && !mod && digit) return digit === "0" ? "ai:all" : `ai:${Number(digit) - 1}`;
  return null;
}

/** Add or take off one AI. The empty list means "the chat's default answers"; choosing every AI collapses back to "everyone" only when asked, so it is kept as the full list. @param {readonly string[]} sel @param {string} id @param {readonly string[]} all */
export function toggleAnswering(sel, id, all) {
  const next = sel.includes(id) ? sel.filter((x) => x !== id) : [...sel, id];
  return all.filter((x) => next.includes(x)).length === next.length ? all.filter((x) => next.includes(x)) : next;
}

/** "Claude", "Claude and Codex", "Everyone". @param {readonly string[]} sel @param {readonly { id: string, label: string }[]} all @param {string | undefined} dflt */
export function answeringSummary(sel, all, dflt) {
  const ids = sel.length ? sel : dflt ? [dflt] : [];
  if (all.length > 1 && ids.length === all.length) return "Everyone";
  const names = ids.map((id) => all.find((a) => a.id === id)?.label ?? id);
  return names.length > 2 ? `${names.slice(0, 2).join(", ")} and ${names.length - 2} more` : names.join(" and ");
}

/**
 * The mention tokens still in the words: "@Name" or "#Name" (led by the start or a space, not followed by a word character), each once, in order.
 * @param {string} text @param {readonly string[]} names @returns {{ lead: "@" | "#", name: string }[]}
 */
export function tokensIn(text, names) {
  const found = [];
  for (const n of names) {
    for (const lead of /** @type {const} */ (["@", "#"])) {
      const m = new RegExp(`(^|\\s)(?:${forms(lead, n).map(esc).join("|")})(?![\\w])`).exec(text);
      if (m) found.push({ lead, name: n, at: m.index });
    }
  }
  return found.sort((a, b) => a.at - b.at).map(({ lead, name }) => ({ lead, name }));
}

/** The text with one token (and the space after it) taken out. @param {string} text @param {string} lead @param {string} name */
export function removeToken(text, lead, name) {
  const m = new RegExp(`(^|\\s)(${forms(lead, name).map(esc).join("|")})(?![\\w])`).exec(text);
  if (!m) return text;
  const start = m.index + m[1].length;
  const end = start + m[2].length;
  return text.slice(0, start) + text.slice(text[end] === " " ? end + 1 : end);
}
