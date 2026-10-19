// @ts-check
// The menu a right-click (web, Mac) or a long press (phone) opens on a message: every action of the message, in calm groups, each item shown only when this message can do it (the same rules as the hover bar's).
// Pure: what the message can do goes in, the groups and their keys come out. The component draws them and runs the actions.

/** @typedef {{ id: string, label: string, hint?: string, danger?: boolean, children?: { id: string, label: string }[] }} MenuItem */
/** @typedef {{ reactions: string[], groups: MenuItem[][] }} MessageMenu */

/**
 * @param {{ mine?: boolean, done?: boolean, reactions?: readonly string[], can: { reply?: boolean, forward?: boolean, fork?: boolean, ask?: boolean, second?: boolean, edit?: boolean, retry?: boolean, rewind?: boolean, pin?: boolean }, pinned?: boolean, codeBlocks?: number, copy?: boolean }} m
 * @returns {MessageMenu}
 */
export function messageMenu(m) {
  const can = m.can;
  const copyKids = m.done !== true || m.copy === false ? [] : [{ id: "copy-text", label: "Copy text" }, { id: "copy-md", label: "Copy as Markdown" }, ...Array.from({ length: Math.min(m.codeBlocks ?? 0, 9) }, (_, i) => ({ id: `copy-code-${i}`, label: (m.codeBlocks ?? 0) > 1 ? `Copy code ${i + 1}` : "Copy code" }))];
  /** @type {(MenuItem | null)[]} */ const g1 = [
    can.reply ? { id: "reply", label: "Reply", hint: "R" } : null,
    can.forward ? { id: "forward", label: "Forward…" } : null,
    copyKids.length ? { id: "copy", label: "Copy", hint: "C", children: copyKids } : null,
  ];
  /** @type {(MenuItem | null)[]} */ const g2 = [
    can.fork ? { id: "fork", label: m.mine ? "Fork before this message" : "Fork from here", hint: "B" } : null,
    can.ask ? { id: "ask", label: "Ask about this", hint: "A" } : null,
    can.second && !m.mine ? { id: "second", label: "Second opinion" } : null,
  ];
  /** @type {(MenuItem | null)[]} */ const g3 = [
    can.edit && m.mine ? { id: "edit", label: "Edit", hint: "E" } : null,
    can.retry && !m.mine ? { id: "retry", label: "Retry" } : null,
    can.rewind ? { id: "rewind", label: "Rewind to here" } : null,
    can.pin ? { id: "pin", label: m.pinned ? "Unpin" : "Pin", hint: "P" } : null,
  ];
  const keep = (/** @type {(MenuItem | null)[]} */ g) => /** @type {MenuItem[]} */ (g.filter(Boolean));
  return { reactions: [...(m.reactions ?? [])], groups: [keep(g1), keep(g2), keep(g3)].filter((g) => g.length) };
}

/** The hover bar's three: Copy, Reply and "...", each only when it can be done. @param {{ copy: boolean, reply: boolean }} c @returns {string[]} */
export const barItems = (c) => [c.copy ? "copy" : "", c.reply ? "reply" : "", "more"].filter(Boolean);

/**
 * The person's own message a row answers: the nearest message before `key`, when it is theirs; null when another person's message, or none, comes first.
 * Retry on an answer and Try again on a failed reply send this one again.
 * @param {readonly { key: string }[]} rows @param {string} key
 * @param {(k: string) => { kind?: string, text?: string, command?: boolean, queued?: boolean } | null | undefined} item @param {(k: string) => boolean} mine
 * @returns {{ uuid: string, text: string } | null}
 */
export function askedBefore(rows, key, item, mine) {
  for (let i = rows.findIndex((r) => r.key === key) - 1; i >= 0; i--) {
    const it = item(rows[i].key);
    if (!it || it.kind !== "user" || it.command || it.queued) continue;
    return rows[i].key.startsWith("u:") && mine(rows[i].key) ? { uuid: rows[i].key.slice(2), text: String(it.text ?? "") } : null;
  }
  return null;
}

/**
 * What a chat's driver lets the message menu offer, from threads.get's thread (its provider and caps): Retry, Edit and Rewind go back (rewind.conversation),
 * Fork from here needs a fork and going back, an agent thread's fork only a fork. Claude can do all; not known yet offers all, as before.
 * @param {any} thread @returns {{ rewind: boolean, fork: boolean, branch: boolean }}
 */
export function threadMay(thread) {
  if (!thread || typeof thread !== "object" || !thread.provider || thread.provider === "claude") return { rewind: true, fork: true, branch: true };
  const c = thread.caps && typeof thread.caps === "object" ? thread.caps : {};
  // the server's own reading (lib/caps-flags normalizeCaps, switchboard needCap): only rewind.conversation true goes back
  const rewind = Boolean(c.rewind && typeof c.rewind === "object" && c.rewind.conversation === true);
  const fork = c.fork === true;
  return { rewind, fork, branch: fork && rewind };
}
