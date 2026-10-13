// @ts-check
// The pure half of the Documents home (templates, made documents, waiting for signature, setup). No tool is called here.

/** @param {...any} xs */
const firstString = (...xs) => xs.find((x) => typeof x === "string" && x.trim()) ?? "";

/** The made documents, newest first: the Space's `document` records as rows. @param {any[]} recs */
export function madeRows(recs) {
  return [...recs].sort((a, b) => (b.created_at ?? b.updated_at ?? 0) - (a.created_at ?? a.updated_at ?? 0)).map((r) => {
    const d = r.data ?? {};
    return {
      id: String(r.id), urn: String(r.urn ?? ""), name: String(firstString(d.name, d.template) || "Document"), status: String(d.status ?? "Draft"), template: String(d.template ?? ""),
      file: String(d.file ?? ""), at: r.created_at ?? r.updated_at ?? 0, submission: typeof d.submission === "number" ? d.submission : d.submission ? Number(d.submission) || null : null,
    };
  });
}

export const MADE_GROUPS = /** @type {[string, string][]} */ ([["draft", "Drafts"], ["out", "Out for signature"], ["signed", "Signed"]]);

/** The title of the group a status falls in. @param {string | undefined} status */
export function madeGroupOf(status) {
  const s = String(status ?? "").toLowerCase();
  if (["signed", "completed"].includes(s)) return "Signed";
  if (["sent", "out for signature", "waiting", "pending"].includes(s)) return "Out for signature";
  return "Drafts";
}

/** @param {ReturnType<typeof madeRows>} rows */
export const asRecs = (rows) => rows.map((r) => ({ id: r.id, data: { name: r.name, status: r.status, template: r.template } }));

/** What fills each placeholder of a template: "Contact, Name" when an object has that field, "Firm details" for brand, "" when nothing here does. @param {string[]} placeholders @param {{ name: string, label: string, fields: { name: string, label: string }[] }[]} types */
export function fillsFor(placeholders, types) {
  return placeholders.map((p) => {
    const [head, ...rest] = p.split(".");
    if (head === "brand" && rest.length) return { placeholder: p, from: "Firm details" };
    const t = types.find((x) => x.name === head);
    const f = t && rest.length === 1 ? t.fields.find((x) => x.name === rest[0]) : undefined;
    return { placeholder: p, from: t && f ? `${t.label}, ${f.label}` : "" };
  });
}

/** The signing templates (the Documents app's) from templates.list, whatever wraps the rows. @param {any} answer */
export function signingTemplates(answer) {
  const rows = [answer?.body?.data, answer?.data?.body?.data, answer?.body, answer?.data, answer].find((x) => Array.isArray(x)) ?? [];
  return rows.filter((r) => r && Number.isInteger(r.id)).map((r) => ({ id: /** @type {number} */ (r.id), name: String(r.name ?? `Template ${r.id}`), folder: String(r.folder_name ?? "") }));
}

/** Whether the Documents app is on this server. @param {any} list appmods.list's answer */
export function appState(list) {
  const a = (list?.apps ?? []).find((/** @type {any} */ x) => x?.name === "documents");
  if (!a) return { installed: false, running: false, word: "Not installed" };
  const running = a.state === "running";
  return { installed: true, running, word: running ? "Running" : "Installed, not running" };
}
