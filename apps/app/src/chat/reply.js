// @ts-check
// Quoted replies, WhatsApp style (0.2.9): a reply stays in the same timeline and carries a small quote of the message it answers. The frame says `reply_to` (the message's id) and `quote`
// ({ message, author, text }); the app never makes a side thread of it. Pure, so Node tests it.

/** How many characters of a quoted message are shown. */
export const QUOTE_MAX = 140;

/** A message's words for a quote: whitespace folded, cut with an ellipsis. @param {unknown} text @param {number} [n] */
export function excerpt(text, n = QUOTE_MAX) {
  const t = String(text ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t;
}

/** The quote of a row, from its frame's fields; null when the message is not a reply. @param {{ replyTo?: string, quote?: { message?: string, author?: string, text?: string } } | null | undefined} it @returns {{ message: string, author: string, text: string } | null} */
export function quoteOf(it) {
  if (!it) return null;
  const q = it.quote && typeof it.quote === "object" ? it.quote : null;
  const message = typeof it.replyTo === "string" && it.replyTo ? it.replyTo : typeof q?.message === "string" ? q.message : "";
  if (!message) return null;
  return { message, author: typeof q?.author === "string" ? q.author : "", text: excerpt(q?.text ?? "") };
}

/** What a frame's data holds as the quote, checked: strings only, the words clipped. @param {any} d a user-message frame's data */
export function quoteFromData(d) {
  const reply = typeof d?.reply_to === "string" && d.reply_to ? d.reply_to : "";
  const q = d?.quote && typeof d.quote === "object" ? d.quote : null;
  if (!reply && !(typeof q?.message === "string" && q.message)) return {};
  return {
    replyTo: reply || String(q.message),
    ...(q ? { quote: { message: String(q.message ?? reply), author: typeof q.author === "string" ? q.author : "", text: excerpt(q.text ?? "") } } : {}),
  };
}

/** The send input for a reply: the id of the message answered, nothing else. @param {{ message?: string } | null | undefined} replyTo */
export const replyInput = (replyTo) => (replyTo && replyTo.message ? { reply_to: replyTo.message } : {});

/** The row key of a message in the transcript: a person's message is u:<id>, an assistant's reply a:<id>. @param {readonly string[]} keys @param {string} message @returns {number} the index, or -1 */
export function jumpIndex(keys, message) {
  for (const k of [`u:${message}`, `a:${message}`, `m:${message}`]) { const i = keys.indexOf(k); if (i >= 0) return i; }
  return -1;
}
