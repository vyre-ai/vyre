// @ts-check
// Try again after "Couldn't resume". threads.retry rewinds to a transcript uuid and sends those
// words again. The chat sends the chat message id, which is not that uuid, and the first message
// of a session cannot be rewound. Both come back as bad_input. This resends the last thing the
// person typed, on a fresh kernel session for the same person and chat.
import { ownSurface } from "./lease.js";

// The chat's delivery holds the keyboard as the stream module. That is the person's own chat, so a
// person's Try again takes it. A terminal or another person still refuses, and nothing is rewound.
const CHAT_KEYBOARD = "via:module:stream";

/**
 * @param {any} sb @param {string} id @param {string|null} message @param {any} o
 */
export async function retryOrFresh(sb, id, message, o) {
  try {
    return await sb.editRetry(id, message, null, o);
  } catch (/** @type {any} */ e) {
    if (!e || e.code !== "bad_input") throw e;
    return fresh(sb, id, o || {});
  }
}

/**
 * The last turn this thread recorded, when the transcript has no person line to read (a session
 * whose file is not on this computer). The text is the turn's own, cut as the event stores it.
 * @param {any} sb @param {string} id
 * @returns {{ uuid: string, text: string } | null}
 */
function rememberedTurn(sb, id) {
  if (!sb.deps || typeof sb.deps.ofThread !== "function") return null;
  const rows = sb.deps.ofThread(id, { types: ["thread.turn"] }) || [];
  for (let i = rows.length - 1; i >= 0; i--) {
    const p = rows[i] && rows[i].payload;
    const text = p && String(p.text || "").trim();
    if (text) return { uuid: p.uuid ? String(p.uuid) : "", text };
  }
  return null;
}

/**
 * The last words the person typed, sent again without a rewind.
 * @param {any} sb @param {string} id @param {any} o
 */
async function fresh(sb, id, o) {
  const surface = o.surface || "deck";
  let line = sb.lastUserLine(id);
  let words = line ? sb.lineText(line) : "";
  if (!line || !String(words).trim()) {
    const remembered = rememberedTurn(sb, id);
    if (!remembered) throw Object.assign(new Error("there is no message here to retry"), { code: "bad_input" });
    line = { uuid: remembered.uuid };
    words = remembered.text;
  }
  // Only one's own words. A message that names no author (the chat's send records none) is left as it was.
  const wrote = sb.authorOf(id, String(line.uuid));
  if (wrote && o.author && wrote !== o.author && !o.admin) throw Object.assign(new Error("that message is someone else's: you can edit and retry only your own"), { code: "denied" });
  const held = sb.leases && sb.leases.holder(id);
  if (held && held.surface === CHAT_KEYBOARD && ownSurface(surface) && typeof sb.lease === "function") sb.lease(id, surface);
  sb.willAccept(id, surface);
  const remembered = sb.turnTail ? sb.turnTail.last(id) : null;
  const rec = sb.record(id);
  const chat = (remembered && remembered.chat) || (rec && rec.chat) || null;
  const asker = remembered && remembered.asker ? remembered.asker : null;
  const kernelTurn = chat && asker ? { chat, asker, ...(remembered.space ? { space: remembered.space } : {}) } : null;
  const sent = await sb.send(id, words, surface, { ...(o.uuid ? { uuid: o.uuid } : {}), ...(o.author ? { author: o.author } : {}), ...(kernelTurn ? { kernelTurn } : {}) });
  return { retried: true, fresh: true, thread: id, message: String(line.uuid), uuid: sent && sent.uuid, text: words, sent: Boolean(sent && sent.sent), ...(sent && sent.sent ? {} : { note: sent && sent.note }) };
}
