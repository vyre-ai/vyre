// @ts-check
// A held outward send, read in full and edited before the person says yes (core/gate: gate.get gives the whole draft, gate.revise keeps an edit without sending, gate.approve sends exactly the
// edited content, gate.reject discards). Pure: the page passes in what gate.get returned and what the person typed, and gets back what to show and what to send.

const LABELS = /** @type {Record<string, string>} */ ({ subject: "Subject", body: "Message", text: "Message", cc: "Cc", bcc: "Bcc", method: "Method", url: "Address", in_reply_to: "In reply to" });
const ORDER = ["subject", "body", "text", "cc", "bcc", "method", "url", "in_reply_to"];

/** The content as it will go out: what the person last edited, else the draft. @param {any} item gate.get's answer */
export const contentOf = (item) => (item && typeof item === "object" ? item.final ?? item.draft ?? {} : {});

/**
 * What the page shows of a held item, in a steady order: each field of the content with its words. A text field can be edited when the item is a send; a list shows as one line.
 * @param {any} item @returns {{ key: string, label: string, value: string, edit: boolean }[]}
 */
export function fieldsOf(item) {
  const c = contentOf(item);
  const keys = Object.keys(c).filter((k) => typeof c[k] === "string" || (Array.isArray(c[k]) && c[k].every((/** @type {any} */ x) => typeof x === "string")));
  keys.sort((a, b) => (ORDER.includes(a) ? ORDER.indexOf(a) : 99) - (ORDER.includes(b) ? ORDER.indexOf(b) : 99) || a.localeCompare(b));
  return keys.map((key) => ({
    key,
    label: LABELS[key] ?? key.replace(/_/g, " ").replace(/^./, (x) => x.toUpperCase()),
    value: Array.isArray(c[key]) ? c[key].join(", ") : String(c[key]),
    edit: item?.kind === "send" && typeof c[key] === "string",
  }));
}

/** Only what changed, the shape gate.approve and gate.revise take as `edited` (an emptied field is "", which clears it); null when nothing changed. @param {any} item @param {Record<string, string>} typed @param {string} [to] the recipients as typed, comma separated */
export function editedOf(item, typed, to) {
  const c = contentOf(item);
  /** @type {Record<string, any>} */ const out = {};
  for (const f of fieldsOf(item)) if (f.edit && typeof typed[f.key] === "string" && typed[f.key] !== c[f.key]) out[f.key] = typed[f.key];
  if (typeof to === "string") {
    const list = to.split(",").map((x) => x.trim()).filter(Boolean);
    const was = Array.isArray(item?.to) ? item.to.map(String) : [];
    if (list.join("\n") !== was.join("\n")) out.to = list;
  }
  return Object.keys(out).length ? out : null;
}

/** The words for a send that did not go, from the box's answer. @param {any} item */
export const sendOutcome = (item) => (item?.state === "sent" ? { ok: true } : { ok: false, reason: String(item?.error || "It did not send.") });

/**
 * The held item a draft in a chat is: among this chat's held sends, the one whose subject (or words) the draft shows, else the only one, else the newest.
 * @param {{ subject?: string | null, body?: string }} draft @param {readonly { id: string, source: string, thread: string | null, title: string, detail: string, at: number }[]} needs @param {string} thread @returns {string | null} the need's id
 */
export function heldFor(draft, needs, thread) {
  const mine = needs.filter((n) => n.source === "gate" && n.thread === thread);
  if (!mine.length) return null;
  const subject = (draft.subject ?? "").trim().toLowerCase();
  const exact = subject ? mine.find((n) => n.detail.trim().toLowerCase() === subject) : undefined;
  if (exact) return exact.id;
  return [...mine].sort((a, b) => b.at - a.at)[0].id;
}
