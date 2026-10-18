// @ts-check
// The audit-file rules (documents.signing.audit and documents.signing.status), kept pure so the Documents module and the signing client share one copy:
// who may see the audit link, which address may be fetched, whether a file is already saved, and whether a body fits the cap. No I/O here.

/** The audit link a caller may see: a person's own surface only, and only https. A model, a harness or a module never gets it (the file is saved on the server). @param {string} caller @param {string | null} url */
export function auditShown(caller, url) {
  const person = ["cli", "local", "deck", "capsule", "device"].includes(String(caller || ""));
  return person && typeof url === "string" && /^https:\/\//.test(url) ? url : null;
}

/** The audit file's address when it is https on the app's own origin, else null: the server fetches only from the app itself (documents.signing.audit). @param {string} appOrigin @param {unknown} url */
export function auditAllowed(appOrigin, url) {
  if (typeof url !== "string") return null;
  try {
    const u = new URL(url), own = new URL(String(appOrigin));
    return u.protocol === "https:" && u.origin === own.origin && !u.username && !u.password ? url : null;
  } catch { return null; }
}

/** Whether the audit file is already saved: the Drive's stat answers a path and a version for a saved file, and nothing for a missing one. @param {any} stat */
export function savedAlready(stat) {
  return Boolean(stat && typeof stat === "object" && typeof stat.path === "string" && stat.version != null);
}

/** Whether a body of `bytes` fits the cap; an unknown size never does. @param {number} bytes @param {number} cap */
export function auditBodyWithin(bytes, cap) {
  return Number.isFinite(bytes) && bytes >= 0 && bytes <= cap;
}
