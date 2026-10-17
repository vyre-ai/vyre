// @ts-check
// The mail composer's pure part: what its form holds, and the input mail.send takes for it (ADR 0016 decision 8). No React, no calls.
// Addresses are typed as a comma list; empty copies are left out, so a send without them is the same send as before. Files are the
// Space's Files by path (the sender reads them when the person says yes, and refuses if one changed), never bytes from the form.

export const MAX_FILES = 10;

/** @typedef {{ path: string, name: string }} FileRef */
/** @typedef {{ to: string, cc: string, bcc: string, subject: string, body: string, files: FileRef[] }} MailForm */

/** A blank mail. @returns {MailForm} */
export const blankMail = () => ({ to: "", cc: "", bcc: "", subject: "", body: "", files: [] });

/** A comma list of addresses, trimmed, with empty entries dropped. @param {string} s */
export const addressesOf = (s) => String(s || "").split(",").map((x) => x.trim()).filter(Boolean);

/**
 * What is wrong with the form before it is held, or null. The sender checks the same things again; this is so the person sees them while typing.
 * @param {MailForm} f
 * @returns {string | null}
 */
export function problemOf(f) {
  if (!addressesOf(f.to).length) return "Say who it goes to.";
  if (f.files.length > MAX_FILES) return `An email takes at most ${MAX_FILES} files.`;
  return null;
}

/**
 * The input mail.send takes for this form.
 * @param {MailForm} f
 */
export function sendInput(f) {
  /** @type {Record<string, any>} */
  const out = { to: addressesOf(f.to), subject: f.subject, body: f.body };
  const cc = addressesOf(f.cc), bcc = addressesOf(f.bcc);
  if (cc.length) out.cc = cc;
  if (bcc.length) out.bcc = bcc;
  if (f.files.length) out.attachments = f.files.map((x) => ({ path: x.path, name: x.name }));
  return out;
}
