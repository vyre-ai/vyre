// @ts-check
// Files added to a message, as the composer holds them: a row of chips that go from uploading to ready (or failed), the limits the box enforces said before an upload is tried, and the words for each state.
// Pure: no calls. The caps mirror lib/attachments.js LIMITS (the box is the authority; a test keeps the two equal).

export const LIMITS = Object.freeze({ perMessage: 5, imageBytes: 5 * 1024 * 1024, fileBytes: 8 * 1024 * 1024, messageBytes: 20 * 1024 * 1024 });
const IMAGES = ["image/png", "image/jpeg", "image/gif", "image/webp"];

/** @typedef {{ id: string, name: string, mime: string, bytes: number }} Attachment */
/** @typedef {{ key: string, name: string, mime: string, bytes: number, state: "uploading" | "ready" | "failed", attachment?: Attachment, why?: string }} Chip */
/** @typedef {{ name: string, mime: string, bytes: number }} Candidate */

/** "2.4 MB", "340 KB". @param {number} n */
export function sizeWord(n) {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(n / 1024))} KB`;
}

/**
 * Whether one more file may be added, or why not, in the words the person reads.
 * @param {readonly Chip[]} chips @param {Candidate} f @returns {string} "" when it may
 */
export function whyNot(chips, f) {
  const live = chips.filter((c) => c.state !== "failed");
  if (live.length >= LIMITS.perMessage) return `At most ${LIMITS.perMessage} files in one message.`;
  if (!f.bytes) return `${f.name} is empty.`;
  const image = IMAGES.includes(String(f.mime).toLowerCase());
  const cap = image ? LIMITS.imageBytes : LIMITS.fileBytes;
  if (f.bytes > cap) return `${f.name} is over ${cap / 1024 / 1024} MB${image ? "" : "; a larger file goes through a Flow or the VyreDrive mount"}.`;
  if (live.reduce((n, c) => n + c.bytes, 0) + f.bytes > LIMITS.messageBytes) return `Together the files are over ${LIMITS.messageBytes / 1024 / 1024} MB.`;
  return "";
}

/** The chip a new file starts as. @param {string} key @param {Candidate} f @returns {Chip} */
export const uploading = (key, f) => ({ key, name: f.name, mime: f.mime, bytes: f.bytes, state: "uploading" });
/** @param {readonly Chip[]} chips @param {string} key @param {Attachment} a @returns {Chip[]} */
export const ready = (chips, key, a) => chips.map((c) => (c.key === key ? { ...c, state: "ready", attachment: a } : c));
/** @param {readonly Chip[]} chips @param {string} key @param {string} why @returns {Chip[]} */
export const failed = (chips, key, why) => chips.map((c) => (c.key === key ? { ...c, state: "failed", why } : c));
/** @param {readonly Chip[]} chips @param {string} key @returns {Chip[]} */
export const without = (chips, key) => chips.filter((c) => c.key !== key);

/** What a send carries: the files that are ready. A send waits while any is still uploading. @param {readonly Chip[]} chips */
export function toSend(chips) {
  return { attachments: chips.filter((c) => c.state === "ready" && c.attachment).map((c) => /** @type {Attachment} */ (c.attachment)), waiting: chips.some((c) => c.state === "uploading") };
}

/** The words under a chip. @param {Chip} c */
export const chipLine = (c) => (c.state === "failed" ? c.why || "Did not upload" : c.state === "uploading" ? `${sizeWord(c.bytes)} · adding` : sizeWord(c.bytes));

/** The words to send when the person added files and typed nothing. @param {number} n */
export const defaultWords = (n) => (n === 1 ? "Here is a file." : "Here are some files.");
