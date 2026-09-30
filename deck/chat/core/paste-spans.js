// @ts-check
// Which stretches of a draft the person pasted (an email, a ticket, a page), so the box never reads a
// "#Name" inside them as a tag: someone else wrote it (reviewer-2 M-P2). The composer tells this what
// happened, the textarea's value before and after each change and, for a paste, the text that arrived;
// it answers with the pasted spans still in the draft, sent as `pasted: [string]` on threads.send and
// threads.start. Offsets follow every edit, so typing before a span moves it, typing inside one keeps
// the whole stretch marked (the safe side: it can only tag less), and deleting one drops it.

/** @typedef {{ start: number, end: number }} Span */

/** @returns {{ edit: (before: string, after: string, pasted?: string|null) => void, spans: () => Span[], of: (text: string) => string[], reset: () => void }} */
export function pasteTracker() {
  /** @type {Span[]} */ let spans = [];
  return {
    /**
     * The draft went from `before` to `after`. `pasted` is the clipboard text when this change was a paste.
     * @param {string} before @param {string} after @param {string|null} [pasted]
     */
    edit(before, after, pasted = null) {
      if (before === after) return;
      let p = 0;
      const max = Math.min(before.length, after.length);
      while (p < max && before[p] === after[p]) p++;
      let s = 0;
      while (s < max - p && before[before.length - 1 - s] === after[after.length - 1 - s]) s++;
      const oldEnd = before.length - s, newEnd = after.length - s, delta = newEnd - oldEnd;
      /** @type {Span[]} */ const next = [];
      for (const sp of spans) {
        if (sp.end <= p) next.push(sp);
        else if (sp.start >= oldEnd) next.push({ start: sp.start + delta, end: sp.end + delta });
        else if (p <= sp.start && oldEnd >= sp.end) continue; // replaced or deleted outright
        else next.push({ start: Math.min(sp.start, p), end: sp.end >= oldEnd ? sp.end + delta : newEnd });
      }
      if (pasted && newEnd > p && after.slice(p, newEnd).includes(pasted)) {
        const at = p + after.slice(p, newEnd).indexOf(pasted);
        next.push({ start: at, end: at + pasted.length });
      }
      spans = next.filter(x => x.end > x.start).sort((a, b) => a.start - b.start);
    },
    spans: () => spans.map(x => ({ ...x })),
    /** The pasted spans of `text` (the draft as it stands), as strings; only those still inside it. @param {string} text */
    of: text => spans.filter(x => x.end <= text.length).map(x => text.slice(x.start, x.end)).filter(Boolean),
    reset() { spans = []; },
  };
}
