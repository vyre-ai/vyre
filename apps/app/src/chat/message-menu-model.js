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
  const copyKids = m.done !== true || m.copy === false ? [] : [{ id: "copy-md", label: "Copy as Markdown" }, ...Array.from({ length: Math.min(m.codeBlocks ?? 0, 9) }, (_, i) => ({ id: `copy-code-${i}`, label: (m.codeBlocks ?? 0) > 1 ? `Copy code ${i + 1}` : "Copy code" }))];
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
    can.retry && m.mine ? { id: "retry", label: "Retry" } : null,
    can.rewind ? { id: "rewind", label: "Rewind to here" } : null,
    can.pin ? { id: "pin", label: m.pinned ? "Unpin" : "Pin", hint: "P" } : null,
  ];
  const keep = (/** @type {(MenuItem | null)[]} */ g) => /** @type {MenuItem[]} */ (g.filter(Boolean));
  return { reactions: [...(m.reactions ?? [])], groups: [keep(g1), keep(g2), keep(g3)].filter((g) => g.length) };
}

/** The hover bar's three: Copy, Reply and "...", each only when it can be done. @param {{ copy: boolean, reply: boolean }} c @returns {string[]} */
export const barItems = (c) => [c.copy ? "copy" : "", c.reply ? "reply" : "", "more"].filter(Boolean);
