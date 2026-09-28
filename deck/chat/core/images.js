// @ts-check
// Inline pictures in chat (ADR 0024, cohesion item 18), the DOM-free half: what to show, how big,
// and when a picture is a link instead. No DOM here, so the Deck and the app (Expo, PWA) share it.
//
// Two sources land in a transcript row: the person's own pasted/dropped attachment (full bytes,
// this device only - composer-state.js's Attachment) and a step's screen (sight.frame's still,
// already a small scaled JPEG). An agent-made image (a tool result's own picture) is open per
// cohesion item 18 until sessions passes an image block through recall.transcript; nothing here
// invents that shape.

/** Past this many bytes, a picture renders as a file chip (name + size), never inline: a chat
 * transcript that scrolls should not carry megabytes of base64 in the DOM. Sized well above a
 * phone photo shrunk by the composer's own resize, comfortably under a raw DSLR export. */
export const INLINE_LIMIT_BYTES = 4 * 1024 * 1024;

/** The fixed box every inline picture (and its placeholder) reserves, so a picture that has not
 * loaded yet never shifts the rows around it (interaction.md section 1: never a layout jump). */
export const THUMB = Object.freeze({ w: 240, h: 180 });

/** @typedef {{ media_type: string, data: string, name?: string, size?: number }} Picture */

/** Whether `p` has enough to draw (a type and some data). @param {any} p */
export const isPicture = p => !!p && typeof p.media_type === "string" && p.media_type.startsWith("image/") && typeof p.data === "string" && p.data.length > 0;

/** Only the pictures worth inlining from a mixed list (a message's attachments): drops anything
 * too big for `--inline` (a link instead) or not an image at all. @param {readonly any[]} list */
export function inlineable(list) {
  return (Array.isArray(list) ? list : []).filter(p => isPicture(p) && (!p.size || p.size <= INLINE_LIMIT_BYTES));
}

/** The rest: too large to inline, shown as a plain file line instead. @param {readonly any[]} list */
export function tooLarge(list) {
  return (Array.isArray(list) ? list : []).filter(p => isPicture(p) && p.size > INLINE_LIMIT_BYTES);
}

/** A data: URL for a picture already in memory (the person's own attachment, this device only). @param {Picture} p */
export const dataUrl = p => `data:${p.media_type};base64,${p.data}`;

/** `sight.frame`'s answer as one picture, or null with nothing to show yet (no target, no step,
 * or the tool answered `image: null`). @param {any} r */
export function frameToPicture(r) {
  if (!r || !r.image || !r.mime) return null;
  return { media_type: r.mime, data: r.image, name: "Screen" };
}

/** A byte count in the short form a file chip uses ("240 KB", "2.1 MB"). @param {number} n */
export function humanSize(n) {
  if (!Number.isFinite(n) || n < 0) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
