// @ts-check
// lib/attachments: what a message may carry besides words, and the form each model's own harness takes it in (team/contracts/attachments.md). Pure: the box's tools (attachments.put, attachments.open) and the
// provider adapters (agent-core) import this one file, so the caps, the kinds and the table of native forms are written once. A file travels as { id, name, mime, bytes } and is only ever opened by id.

/** The most a message carries, and the most one file weighs. An image is held to what Claude takes; a document to what a chat can sensibly keep. */
export const LIMITS = Object.freeze({ perMessage: 5, imageBytes: 5 * 1024 * 1024, fileBytes: 25 * 1024 * 1024, messageBytes: 50 * 1024 * 1024, nameChars: 120, inlineTextBytes: 200 * 1024 });

export const IMAGE_MIMES = Object.freeze(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const ID = /^att_[A-Za-z0-9_-]{16,32}$/;
const MIME = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,60}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,100}$/;
const TEXT_MIMES = /^(text\/|application\/(json|xml|x-yaml|yaml|toml|javascript|x-sh)$)/;

/** @typedef {{ id: string, name: string, mime: string, bytes: number }} Attachment */
/** @typedef {"image" | "pdf" | "text" | "file"} Kind */
/** @typedef {"image-block" | "document-block" | "image-path" | "image-url" | "inline-text" | "path"} Form */
/** @typedef {Attachment & { form: Form, base64?: string, path?: string, text?: string, dataUri?: string }} Resolved */

/** What sort of file a mime is, for choosing a form. @param {string} mime @returns {Kind} */
export function kindOf(mime) {
  const m = String(mime || "").toLowerCase();
  if (IMAGE_MIMES.includes(m)) return "image";
  if (m === "application/pdf") return "pdf";
  if (TEXT_MIMES.test(m)) return "text";
  return "file";
}

/** A file name safe to show, to join onto a folder and to hand to a model: no folders, no control characters, no leading dot, cut at 120. Empty becomes "file". @param {unknown} name */
export function cleanName(name) {
  const base = String(name ?? "").split(/[\\/]/).pop() || "";
  const s = base.replace(/[\u0000-\u001f\u007f<>:"|?*]/g, " ").replace(/\s+/g, " ").trim().replace(/^\.+/, "").slice(0, LIMITS.nameChars).trim();
  return s || "file";
}

/** The cap for one file of this mime. @param {string} mime */
export const capFor = mime => (kindOf(mime) === "image" ? LIMITS.imageBytes : LIMITS.fileBytes);

/**
 * One attachment as it travels on a message, or why not. Returns the clean record (only the four fields).
 * @param {unknown} raw @returns {{ ok: true, attachment: Attachment } | { ok: false, error: string }}
 */
export function checkAttachment(raw) {
  const a = raw && typeof raw === "object" ? /** @type {any} */ (raw) : {};
  if (typeof a.id !== "string" || !ID.test(a.id)) return { ok: false, error: "an attachment is named by the id the box gave it when the file was added" };
  const mime = typeof a.mime === "string" ? a.mime.toLowerCase() : "";
  if (!MIME.test(mime)) return { ok: false, error: "an attachment needs its type, such as image/png or application/pdf" };
  const bytes = a.bytes;
  if (!Number.isInteger(bytes) || bytes < 0) return { ok: false, error: "an attachment needs its size in bytes" };
  if (bytes === 0) return { ok: false, error: "that file is empty" };
  if (bytes > capFor(mime)) return { ok: false, error: `that ${kindOf(mime) === "image" ? "image" : "file"} is over ${Math.round(capFor(mime) / 1024 / 1024)} MB` };
  return { ok: true, attachment: { id: a.id, name: cleanName(a.name), mime, bytes } };
}

/**
 * The list a message carries, or why not: at most five, none twice, together at most 50 MB.
 * @param {unknown} raw @returns {{ ok: true, list: Attachment[] } | { ok: false, error: string }}
 */
export function checkList(raw) {
  if (raw == null) return { ok: true, list: [] };
  if (!Array.isArray(raw)) return { ok: false, error: "attachments is a list of { id, name, mime, bytes }" };
  if (raw.length > LIMITS.perMessage) return { ok: false, error: `at most ${LIMITS.perMessage} files in one message` };
  /** @type {Attachment[]} */ const list = [];
  for (const r of raw) {
    const c = checkAttachment(r);
    if (!c.ok) return c;
    if (list.some(x => x.id === c.attachment.id)) return { ok: false, error: `${c.attachment.name} is attached twice` };
    list.push(c.attachment);
  }
  if (list.reduce((n, a) => n + a.bytes, 0) > LIMITS.messageBytes) return { ok: false, error: `together the files are over ${LIMITS.messageBytes / 1024 / 1024} MB` };
  return { ok: true, list };
}

/**
 * The native form a provider takes a file in. Claude: an image or a PDF as a content block; Codex: an image as a local path it is told about; Grok: an image as a data address and short text inline.
 * Anything else, or a provider not named, is a path in the session's folder with a sentence saying so. Never a form that fights what the model ships.
 * @param {string} provider @param {Attachment} a @returns {Form}
 */
export function formFor(provider, a) {
  const kind = kindOf(a.mime), p = String(provider || "").toLowerCase();
  if (p === "claude") return kind === "image" ? "image-block" : kind === "pdf" ? "document-block" : "path";
  if (p === "codex") return kind === "image" ? "image-path" : "path";
  if (p === "grok") return kind === "image" ? "image-url" : kind === "text" && a.bytes <= LIMITS.inlineTextBytes ? "inline-text" : "path";
  return "path";
}

/** Where a file is put in the session's folder when a model reads it by path. `.vyre/attachments/<id>-<name>`, so two files of one name never meet. @param {string} cwd @param {Attachment} a */
export const pathIn = (cwd, a) => `${String(cwd).replace(/\/+$/, "")}/.vyre/attachments/${a.id}-${cleanName(a.name)}`;

/**
 * Give each attachment the one thing its form needs. `open(id, as)` is the box's attachments.open (as "base64" or "path"); nothing here reads a file itself.
 * @param {string} provider @param {Attachment[]} list
 * @param {(id: string, as: "base64" | "path") => Promise<{ base64?: string, path?: string }>} open
 * @returns {Promise<Resolved[]>}
 */
export async function resolve(provider, list, open) {
  /** @type {Resolved[]} */ const out = [];
  for (const a of list) {
    const form = formFor(provider, a);
    if (form === "image-block" || form === "document-block") { const r = await open(a.id, "base64"); out.push({ ...a, form, base64: String(r.base64 || "") }); }
    else if (form === "image-url") { const r = await open(a.id, "base64"); out.push({ ...a, form, dataUri: `data:${a.mime};base64,${String(r.base64 || "")}` }); }
    else if (form === "inline-text") { const r = await open(a.id, "base64"); out.push({ ...a, form, text: Buffer.from(String(r.base64 || ""), "base64").toString("utf8") }); }
    else { const r = await open(a.id, "path"); out.push({ ...a, form, path: String(r.path || "") }); }
  }
  return out;
}

/** The sentence a model reads beside the words: what was attached, in plain words, and where a file is when it must be read by path. Images a harness shows natively are named, not repeated. @param {Resolved[]} list */
export function noteFor(list) {
  if (!list.length) return "";
  const size = (/** @type {number} */ n) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
  const lines = list.map(a => {
    const what = kindOf(a.mime) === "image" ? "image" : kindOf(a.mime) === "pdf" ? "PDF" : kindOf(a.mime) === "text" ? "text file" : "file";
    if (a.form === "path" || a.form === "image-path") return `- ${a.name} (${what}, ${size(a.bytes)}) is at ${a.path}`;
    if (a.form === "inline-text") return `- ${a.name} (${what}, ${size(a.bytes)}):\n${a.text}`;
    return `- ${a.name} (${what}, ${size(a.bytes)}) is attached above`;
  });
  return `The person attached ${list.length === 1 ? "a file" : `${list.length} files`}:\n${lines.join("\n")}`;
}
