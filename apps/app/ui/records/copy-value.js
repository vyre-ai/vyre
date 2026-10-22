// @ts-check
// What a property row can copy: an email, a phone, a URL, or an id-like value. A name, a note, a link to another record and a sealed value are not copied from the row.

const COPY_KINDS = new Set(["email", "emails", "phone", "phones", "url", "urls"]);
const NAMED = /^(email|phone|url|website)$/i;
const ID_NAME = /(^|_)(id|ref)$/i;
const ID_VALUE = /^[A-Z]{2,6}-\d{3,}$/;

/** @param {unknown} value @returns {string} */
function textOf(value) {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (Array.isArray(value)) return value.map(textOf).filter(Boolean).join(", ");
  return "";
}

/** The text to put on the clipboard for this field, or "" when the row should not offer copy. @param {{ name?: unknown, label?: unknown, kind?: unknown } | null | undefined} field @param {unknown} value */
export function copyValue(field, value) {
  const text = textOf(value);
  if (!text || !field) return "";
  const kind = String(field.kind ?? "");
  if (COPY_KINDS.has(kind)) return text;
  if (kind !== "text" && kind !== "") return "";
  const name = String(field.name ?? "");
  const label = String(field.label ?? "");
  if (NAMED.test(name) || ID_NAME.test(name) || label === "ID" || ID_VALUE.test(text)) return text;
  return "";
}

/** The record's path in the app. @param {unknown} id */
export function recordPath(id) {
  return `/u/record/${encodeURIComponent(String(id ?? ""))}`;
}
