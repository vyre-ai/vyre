// @ts-check
// Tags in a step's context boxes. A box is text; a tag in it is a reference written as `[[kind:target]]`, kept as written and resolved only when the step runs, so what the assignee reads is
// the record as it is then, never a copy made when the Flow was written.
//   [[record:<urn>]]            one record, its fields as lines          [[record:this]]    the record the run is about
//   [[field:<urn>#<field>]]     one field's value                         [[field:this#name]]
//   [[records:<object>]]        several records of an object, one line each (the first ten)
//   [[file:<path>]]             a file, kept as its path for the assignee to open

export const TAG_RE = /\[\[(record|records|field|file):([^\]\n]{1,300})\]\]/g;
const LINE = 400;

/** The tags in a text, in order. @param {string} text @returns {{ token: string, kind: string, target: string }[]} */
export function tagsIn(text) {
  return [...String(text ?? "").matchAll(TAG_RE)].map(m => ({ token: m[0], kind: m[1], target: m[2].trim() }));
}

/** A value in one line, long ones cut. @param {any} v */
const one = v => { const s = v && typeof v === "object" ? (v.name || v.title || v.label || JSON.stringify(v)) : String(v ?? ""); return s.length > LINE ? s.slice(0, LINE) + "..." : s; };
/** @param {any} data @param {number} [max] */
const fieldsLine = (data, max = 12) => Object.entries(data || {}).slice(0, max).map(([k, v]) => `${k}: ${one(v)}`).join("; ");

/** @param {string} urn @returns {{ type: string, id: string } | null} */
export function parseUrn(urn) {
  const m = /^vyre:\/\/[^/]+\/([^/]+)\/([^/]+)$/.exec(urn);
  return m ? { type: m[1], id: m[2] } : null;
}

/**
 * The text with every tag resolved. `read` and `query` go through the chain the step runs under, so a sealed field comes back as its placeholder and a record the person may not read as unavailable. A tag
 * that cannot be resolved stays visible as "[unavailable: ...]" and never stops the step.
 * @param {string} text
 * @param {{ read: (type: string, id: string) => Promise<any>, query: (type: string, limit: number) => Promise<any[]>, here?: string | null }} io
 */
export async function resolveTags(text, io) {
  let out = String(text ?? "");
  for (const t of tagsIn(out)) {
    let s;
    try {
      if (t.kind === "file") s = `[file: ${t.target}]`;
      else if (t.kind === "records") {
        const rows = await io.query(t.target, 10);
        s = rows.length ? rows.map(r => `- ${r.id}: ${fieldsLine(r.data, 6)}`).join("\n") : `[no ${t.target} records]`;
      } else if (t.kind === "record") {
        const u = t.target === "this" ? io.here : t.target, p = u ? parseUrn(u) : null;
        const r = p ? await io.read(p.type, p.id) : null;
        s = r ? `${p?.type} ${p?.id}: ${fieldsLine(r.data)}` : `[unavailable: ${t.token}]`;
      } else {
        const [ref, field] = t.target.split("#");
        const u = ref === "this" ? io.here : ref, p = u ? parseUrn(u) : null;
        const r = p && field ? await io.read(p.type, p.id) : null;
        s = r && r.data && r.data[field] !== undefined ? one(r.data[field]) : `[unavailable: ${t.token}]`;
      }
    } catch { s = `[unavailable: ${t.token}]`; }
    out = out.split(t.token).join(s);
  }
  return out;
}
