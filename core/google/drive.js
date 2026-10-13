// @ts-check
// drive: Google Drive v3 search and read, read-only (scope drive.readonly), shaped small for a model. Same account rules as mail and calendar:
// the accounts come from the caller's scope (a member's is their own mailbox's Drive from the firm key), never from the input.

const FILES = "/drive/v3/files";
const TEXT_CAP = 20_000;
const FIELDS = "files(id,name,mimeType,modifiedTime,webViewLink,owners(emailAddress))";
const bad = msg => Object.assign(new Error(msg), { code: "bad_input" });

/** A search term safe inside a Drive query's single quotes. @param {string} s */
export function escapeQuery(s) {
  const t = String(s ?? "");
  if (t.length > 200) throw bad("the search is too long");
  return t.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

const ID = /^[A-Za-z0-9_-]{5,128}$/;
const DOC_EXPORT = { "application/vnd.google-apps.document": "text/plain", "application/vnd.google-apps.presentation": "text/plain", "application/vnd.google-apps.spreadsheet": "text/csv" };
const isText = m => /^text\//.test(m) || /^application\/(json|xml)$/.test(m);

/** @param {{ request: (acct: any, req: any) => Promise<any> }} deps */
export function drive({ request }) {
  return {
    /** @param {any[]} accts @param {{ q: string, limit?: number }} i */
    async search(accts, { q, limit = 10 }) {
      const rows = [];
      for (const a of accts) {
        const r = await request(a, { api: "drive", scope: "drive.readonly", path: FILES, query: { q: `fullText contains '${escapeQuery(q)}' and trashed = false`, pageSize: limit, orderBy: "modifiedTime desc", fields: FIELDS, supportsAllDrives: true, includeItemsFromAllDrives: true } });
        for (const f of r.files || []) rows.push({ account: a.name, id: String(f.id), name: String(f.name || ""), type: String(f.mimeType || ""), modified: f.modifiedTime || null, url: f.webViewLink || null });
      }
      return rows.slice(0, limit);
    },
    /** @param {any} a @param {{ id: string }} i */
    async read(a, { id }) {
      if (!ID.test(String(id))) throw bad("id must be a Drive file id");
      const meta = await request(a, { api: "drive", scope: "drive.readonly", path: `${FILES}/${id}`, query: { fields: "id,name,mimeType,modifiedTime,webViewLink", supportsAllDrives: true } });
      const out = { account: a.name, id: String(meta.id), name: String(meta.name || ""), type: String(meta.mimeType || ""), url: meta.webViewLink || null };
      const exp = DOC_EXPORT[out.type];
      if (!exp && !isText(out.type)) return { ...out, note: "this file is not text; open it in Drive" };
      const raw = exp
        ? await request(a, { api: "drive", scope: "drive.readonly", path: `${FILES}/${id}/export`, query: { mimeType: exp }, raw: true })
        : await request(a, { api: "drive", scope: "drive.readonly", path: `${FILES}/${id}`, query: { alt: "media", supportsAllDrives: true }, raw: true });
      const text = String(raw.text || "");
      return { ...out, text: text.slice(0, TEXT_CAP), ...(text.length > TEXT_CAP ? { truncated: true } : {}) };
    },
  };
}
