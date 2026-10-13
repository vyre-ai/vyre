// @ts-check
// Tags in a context box, the app's half: the same `[[kind:target]]` tokens the engine resolves at run (kernel/flows/tags.js). The box stores them as written; these make them readable.

export const TAG_RE = /\[\[(record|records|field|file):([^\]\n]{1,300})\]\]/g;

/** @param {string} text @returns {{ token: string, kind: string, target: string }[]} */
export const parseTags = (text) => [...String(text ?? "").matchAll(TAG_RE)].map((m) => ({ token: m[0], kind: m[1], target: m[2].trim() }));

/** The words for a tag. @param {{ kind: string, target: string }} t @param {{ types?: { name: string, label: string }[] }} [o] */
export function tagLabel(t, o = {}) {
  const type = (/** @type {string} */ n) => (o.types || []).find((x) => x.name === n)?.label || n;
  if (t.kind === "file") return `File ${t.target}`;
  if (t.kind === "records") return `Several ${type(t.target)} records`;
  if (t.kind === "field") { const [ref, f] = t.target.split("#"); return ref === "this" ? `${f} of this record` : `${f} of ${ref.split("/").slice(-2).join("/")}`; }
  return t.target === "this" ? "This record" : `Record ${t.target.split("/").slice(-2).join("/")}`;
}

/** The token a pick makes. @param {{ kind: "this" | "field" | "record" | "records" | "file", type?: string, urn?: string, field?: string, path?: string }} p */
export function tagToken(p) {
  switch (p.kind) {
    case "this": return "[[record:this]]";
    case "field": return `[[field:${p.urn || "this"}#${p.field}]]`;
    case "record": return `[[record:${p.urn}]]`;
    case "records": return `[[records:${p.type}]]`;
    default: return `[[file:${p.path}]]`;
  }
}
