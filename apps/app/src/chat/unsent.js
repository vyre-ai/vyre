// @ts-check
// The one optimistic send of every chat screen (store.ts): the person's words show at once, dimmed ("Sending"), and the box's own row takes their place. When the box does not take them (a refusal,
// no answer, a lost connection) the words stay in the thread as "Not sent", with the reason in plain words, Retry and Delete. Retry sends the same words with the same message id, so the box never says
// them twice (stream.send keeps one message per id). Nothing here removes the person's words by itself: only Delete does, or the box's own echo of that message. The ones not sent are kept with the
// chat's cache (`saved`), so leaving the chat and coming back still shows them.

/**
 * What a send was, enough to make it again: which door (`send`, or `sendTo` with its people), the words, the client message id and the options (mentions, mode, attachments...), all plain data.
 * @typedef {{ via: "send" | "sendTo", text: string, message: string, o?: Record<string, any> }} SendSpec
 * @typedef {{ spec: SendSpec, reason: string }} Unsent
 */

/** What the person reads when a send threw without words of its own. */
export const NOT_SENT = "This message was not sent.";

/**
 * @param {{
 *   folder: { addOptimistic(text: string, message?: string): string, failOptimistic(key: string, reason: string): boolean, retryOptimistic(key: string): boolean, dropOptimistic(key: string): boolean, item(key: string): any },
 *   perform: (s: SendSpec) => Promise<string | null>,
 *   changed: (key: string) => void,
 *   saved?: (list: Unsent[]) => void,
 * }} deps `perform` makes the send and resolves with why the box refused it, or null; `changed` repaints the row (and the list when one came or went); `saved` keeps the list of the ones not sent
 */
export function createUnsent({ folder, perform, changed, saved }) {
  /** @type {Map<string, SendSpec>} row key -> the send, while its row is in the thread and not echoed */ const sends = new Map();
  /** A row the box has since echoed (or that was deleted) is no longer ours. */
  const prune = () => { for (const k of [...sends.keys()]) if (!folder.item(k)) sends.delete(k); };
  const list = () => { prune(); /** @type {Unsent[]} */ const out = []; for (const [k, spec] of sends) { const it = folder.item(k); if (it && it.failed) out.push({ spec, reason: String(it.failed) }); } return out; };
  const keep = () => { try { saved?.(list()); } catch { /* the cache is a convenience */ } };

  /** @param {string} key @param {SendSpec} spec */
  async function attempt(key, spec) {
    /** @type {string | null} */ let why;
    try { why = await perform(spec); } catch (e) { why = e instanceof Error && e.message ? e.message : NOT_SENT; }
    if (why) { if (folder.failOptimistic(key, why)) { changed(key); keep(); } }
    else if (sends.has(key)) keep();
    return why;
  }

  return {
    /** Send: the row shows at once; resolves with why it was not sent (the row stays, "Not sent"), or null. @param {SendSpec} spec */
    send(spec) {
      const key = folder.addOptimistic(spec.text, spec.message);
      sends.set(key, spec);
      changed(key);
      return attempt(key, spec);
    },
    /** Send a "Not sent" row again: the same words, the same message id. Resolves with why it failed again, or null. @param {string} key */
    async retry(key) {
      const spec = sends.get(key);
      const it = folder.item(key);
      if (!spec || !it || !it.failed) return null;
      if (!folder.retryOptimistic(key)) return null;
      changed(key);
      return attempt(key, spec);
    },
    /** The person deletes a row that was not sent. Only a "Not sent" row can be deleted this way. @param {string} key */
    discard(key) {
      const it = folder.item(key);
      if (!it || !it.failed) return false;
      sends.delete(key);
      if (folder.dropOptimistic(key)) changed(key);
      keep();
      return true;
    },
    /** Put back the rows not sent that the chat's cache kept (the chat was left and opened again). @param {unknown} kept */
    restore(kept) {
      if (!Array.isArray(kept)) return;
      for (const u of kept.slice(0, 50)) {
        const spec = u && typeof u === "object" ? /** @type {any} */ (u).spec : null;
        if (!spec || typeof spec.text !== "string" || !spec.text.trim() || typeof spec.message !== "string" || (spec.via !== "send" && spec.via !== "sendTo")) continue;
        if ([...sends.values()].some((s) => s.message === spec.message) || folder.item("u:" + spec.message)) continue; // already here, or the box took it after all
        const key = folder.addOptimistic(spec.text, spec.message);
        sends.set(key, { via: spec.via, text: spec.text, message: spec.message, ...(spec.o && typeof spec.o === "object" ? { o: spec.o } : {}) });
        folder.failOptimistic(key, String(/** @type {any} */ (u).reason || NOT_SENT));
        changed(key);
      }
    },
    /** The rows not sent, for the cache. */
    list,
    /** Forget rows the box has echoed since (call after frames are folded); keeps the cache true. */
    settle() { const n = sends.size; prune(); if (sends.size !== n) keep(); },
  };
}
