// @ts-check
// The chat's small things, pure (SPEC-0.3.0 12.1 to 12.4): what Copy puts on the clipboard, what Cmd-F finds, what a key does, and the words in the header.
// Nothing here draws or reads a clock; ChatScreen and ChatRows call it and the tests pin the rules.

/** Markdown as plain words: fences, emphasis, headings and link syntax removed; the text of a list stays. @param {string} md */
export function mdToPlain(md) {
  return String(md ?? "")
    .replace(/```[^\n]*\n([\s\S]*?)```/g, "$1")
    .replace(/`([^`\n]+)`/g, "$1")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\(([^)]*)\)/g, "$1 ($2)")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/(^|[^*\w])\*(?!\s)([^*\n]+?)\*(?!\w)/g, "$1$2")
    .replace(/^>\s?/gm, "")
    .trim();
}

/** The fenced code in an answer, in order: [{ lang, code }]. @param {string} text */
export function codeBlocks(text) {
  /** @type {{ lang: string, code: string }[]} */ const out = [];
  const re = /```([^\n`]*)\n([\s\S]*?)```/g;
  let m;
  while ((m = re.exec(String(text ?? "")))) out.push({ lang: m[1].trim(), code: m[2].replace(/\n$/, "") });
  return out;
}

/** What Copy and "Copy as Markdown" put on the clipboard for one answer. @param {string} text */
export const copyForms = (text) => ({ plain: mdToPlain(text), markdown: String(text ?? "") });

/**
 * Find in this conversation: the rows whose words hold the query (case-insensitive, the query as typed), oldest first, with how many times.
 * @param {{ key: string, text: string }[]} items @param {string} query
 * @returns {{ key: string, count: number }[]}
 */
export function findMatches(items, query) {
  const q = String(query ?? "").trim().toLowerCase();
  if (!q) return [];
  /** @type {{ key: string, count: number }[]} */ const out = [];
  for (const it of items) {
    const hay = String(it.text ?? "").toLowerCase();
    let n = 0, i = hay.indexOf(q);
    while (i >= 0) { n++; i = hay.indexOf(q, i + q.length); }
    if (n) out.push({ key: it.key, count: n });
  }
  return out;
}

/** The next (dir 1) or previous (dir -1) match, wrapping; -1 when there is none. @param {number} at @param {1 | -1} dir @param {number} n */
export const stepMatch = (at, dir, n) => (n <= 0 ? -1 : at < 0 ? (dir > 0 ? 0 : n - 1) : (at + dir + n) % n);

/** "3 of 12" for the find bar; "No matches" when the query found nothing. @param {number} at @param {number} n @param {string} query */
export const findLabel = (at, n, query) => (!String(query ?? "").trim() ? "" : n === 0 ? "No matches" : `${at + 1} of ${n}`);

/**
 * What a key does in the chat. `meta` is Cmd on a Mac and Ctrl elsewhere. Returns null for a key the chat leaves alone.
 * @param {{ key: string, meta?: boolean, shift?: boolean, alt?: boolean }} e
 * @param {{ composerEmpty: boolean, busy: boolean, findOpen: boolean, canEdit: boolean }} c
 * @returns {{ do: "find" | "close-find" | "stop" | "edit-last" | "steer" | "switch" } | { do: "jump", n: number } | null}
 */
export function keyAction(e, c) {
  const k = e.key;
  if (e.meta && !e.alt && (k === "f" || k === "F")) return { do: "find" };
  if (e.meta && !e.alt && (k === "k" || k === "K")) return { do: "switch" };
  if (e.meta && !e.alt && !e.shift && k === "Enter") return { do: "steer" };
  if (e.meta && !e.alt && !e.shift && /^[1-9]$/.test(k)) return { do: "jump", n: Number(k) };
  if (k === "Escape") return c.findOpen ? { do: "close-find" } : c.busy ? { do: "stop" } : null;
  if (k === "ArrowUp" && !e.meta && !e.shift && !e.alt && c.composerEmpty && c.canEdit) return { do: "edit-last" };
  return null;
}

/** The last message the person sent: its message id and words, from the rows and the items. @param {{ key: string, kind: string }[]} rows @param {(key: string) => any} item @param {(key: string) => boolean} mine */
export function lastOwnMessage(rows, item, mine) {
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    if (r.kind !== "user" || r.key.startsWith("o:")) continue;
    const it = item(r.key);
    if (it && mine(r.key) && !it.queued) return { uuid: r.key.slice(2), text: String(it.text ?? "") };
  }
  return null;
}

/** A word that is an id or a path, never for a person's eyes: ses_ab12cd34, a long hex run, /srv/x, ~/x, C:\x. @param {string} s */
export const looksTechnical = (s) => /^(?:[a-z]{2,5})_[A-Za-z0-9]{6,}$/.test(s) || /^[0-9a-f]{12,}$/i.test(s) || /^(?:\/|~\/|[A-Za-z]:\\|\.\.?\/)/.test(s) || /^[\w.-]+\/[\w./-]+$/.test(s) && s.includes("/");

/**
 * The header's words: the title (the project, or what the chat is about) and one quiet line with the project and which AI answers. No ids and no paths.
 * @param {{ title?: string, project?: string | null, space?: string | null, answeredBy?: string[], where?: string | null }} h
 */
export function headerParts(h) {
  const clean = (/** @type {string | null | undefined} */ s) => { const t = String(s ?? "").trim(); return t && !looksTechnical(t) ? t : ""; };
  const project = clean(h.project);
  const title = clean(h.title) || project || "Chat";
  const ai = [...new Set((h.answeredBy ?? []).map(clean).filter(Boolean))].slice(0, 2);
  const answers = ai.length ? `${ai.join(" and ")} ${ai.length > 1 ? "answer" : "answers"}` : "";
  const line = [project && project !== title ? project : "", clean(h.space), answers, clean(h.where)].filter(Boolean).join(" · ");
  return { title, line };
}
