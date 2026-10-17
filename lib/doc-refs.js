// @ts-check
// A reference in an instructions file (AGENTS.md). The editor's @ and # pickers store a pick as a markdown link whose target is the item's vyre:// address:
//   [@Sam](vyre://acme/person/p_1)   [#Doe estate](vyre://acme/record/...)   [#intake.pdf](vyre://acme/file/Clients/intake.pdf)
// That is still plain markdown for any tool that reads the file on disk. The editor shows only "@Sam" and keeps the address aside (toEditable / fromEditable), the preview draws a chip, and the
// prompt turns each one into a line the model can use (renderForPrompt). One module, so the stored form, the editor, the preview and the prompt cannot drift. Pure.

const LINK = /\[([@#])((?:[^\]\\\n]|\\.)+)\]\((vyre:\/\/[^\s()]+)\)/g;
const esc = (/** @type {string} */ s) => s.replace(/([\\[\]])/g, "\\$1");
const unesc = (/** @type {string} */ s) => s.replace(/\\([\\[\]])/g, "$1");
const reEsc = (/** @type {string} */ s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** A path segment safe inside a markdown link target: parentheses are escaped too, which encodeURIComponent leaves. @param {string} s */
const seg = (s) => encodeURIComponent(s).replace(/[()]/g, (c) => (c === "(" ? "%28" : "%29"));

/** @typedef {{ lead: "@" | "#", name: string, urn: string, kind: string, start: number, end: number }} DocRef */

/**
 * What an address is: its first path segment after the Space when that names a kind of thing, else a record of that type. A record type a person made with one of those names (a type called "tag") is a
 * record type, not the kind: `customTypes` is the names of the Space's own types (records.address-kind answers it from the type definitions), and a first segment in it is a record.
 * @param {string} urn @param {Iterable<string>} [customTypes]
 */
export function kindOf(urn, customTypes) {
  const m = /^vyre:\/\/[^/]+\/([^/]+)\//.exec(urn);
  const first = m ? m[1] : "";
  if (customTypes && new Set(customTypes).has(first)) return "record";
  return ["person", "agent", "role", "team", "project", "file", "tag", "type", "template", "folder", "linked"].includes(first) ? first : "record";
}

/** The words a model reads for a kind. @type {Record<string, string>} */
const WORD = { person: "person", agent: "agent", role: "role", team: "team", project: "project", file: "file", tag: "tag", type: "record type", template: "playbook", folder: "folder", linked: "linked file", record: "record" };

/**
 * The address for a picked item. A pick of the # tree carries its own urn (a record's is already an address; `file/<path>`, `tag/<name>`, `type/<object>`, `template/<id>`, `folder/<path>` and a linked
 * folder's `<link id>:<path>` are the tree's short forms); a person or an agent is picked by name with its id.
 * @param {{ space: string, kind: string, urn?: string, id?: string }} o
 */
export function refUrn({ space, kind, urn, id }) {
  const u = String(urn ?? "");
  if (u.startsWith("vyre://")) return u.replace(/\s/g, "%20");
  const host = `vyre://${seg(space || "space")}`;
  if (kind === "person" || kind === "agent" || kind === "role" || kind === "team") return `${host}/${kind}/${seg(String(id ?? ""))}`;
  if (kind === "linked") return `${host}/linked/${seg(u)}`;
  if (kind === "file" || kind === "tag" || kind === "collection") return `${host}/${u.split("/").map(seg).join("/")}`;
  return `${host}/${kind === "project" ? "project" : "record"}/${seg(u)}`;
}

/** The link as stored. @param {"@" | "#"} lead @param {string} name @param {string} urn */
export const refLink = (lead, name, urn) => `[${lead}${esc(name)}](${urn})`;

/** Every reference in the text, in order. @param {string} text @returns {DocRef[]} */
export function parseRefs(text) {
  /** @type {DocRef[]} */ const out = [];
  for (const m of String(text ?? "").matchAll(LINK)) out.push({ lead: /** @type {"@" | "#"} */ (m[1]), name: unesc(m[2]), urn: m[3], kind: kindOf(m[3]), start: m.index ?? 0, end: (m.index ?? 0) + m[0].length });
  return out;
}

/**
 * The text as the editor shows it: each reference is only "@Sam" or "#Doe estate", never its address. `refs` is what was taken out, by the token, so fromEditable can put it back.
 * @param {string} md @returns {{ text: string, refs: Map<string, string> }}
 */
export function toEditable(md) {
  /** @type {Map<string, string>} */ const refs = new Map();
  const text = String(md ?? "").replace(LINK, (_all, lead, name, urn) => { const n = unesc(name); if (!refs.has(lead + n)) refs.set(lead + n, urn); return lead + n; });
  return { text, refs };
}

/**
 * The editor's text back to stored markdown: every "@Sam" or "#Doe estate" whose token is in `refs` becomes its link again. A token is a whole word (not the start of a longer one), longest names first.
 * Anything else typed is left alone, so a word that never came from a pick stays plain text.
 * @param {string} text @param {ReadonlyMap<string, string>} refs
 */
export function fromEditable(text, refs) {
  const keys = [...refs.keys()].sort((a, b) => b.length - a.length);
  if (!keys.length) return text;
  const re = new RegExp(`(^|[^\\w\\\\[/])(${keys.map(reEsc).join("|")})(?!\\w)`, "g");
  return text.replace(re, (_all, pre, tok) => `${pre}${refLink(tok[0], tok.slice(1), /** @type {string} */ (refs.get(tok)))}`);
}

/**
 * The text for a prompt: each reference becomes "@Sam (person, vyre://acme/person/p_1)" so the model can pass the address to a tool. One the reader may not read keeps only its name.
 * `may` is the caller's read check, asked once per address; it is never given anything to decide with but the reference.
 * @param {string} text @param {(ref: DocRef) => boolean} may
 */
export function renderForPrompt(text, may) {
  const t = String(text ?? "");
  let out = "", at = 0;
  for (const r of parseRefs(t)) {
    out += t.slice(at, r.start) + (may(r) ? `${r.lead}${r.name} (${WORD[r.kind] ?? "record"}, ${r.urn})` : `${r.lead}${r.name}`);
    at = r.end;
  }
  return out + t.slice(at);
}
