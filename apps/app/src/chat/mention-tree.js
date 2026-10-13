// @ts-check
// The trees the nested @ and # pickers walk (ui/lib/nest-model.js). Pure: the box's answers go in, nodes come out.
//   #  Projects (a template, then its projects) · Records (an object, then its records) · Files (folders, then files) · Tags
//   @  People · Teams and roles · Agents · AIs
// A branch you can choose whole carries a `pick` of kind "collection": a reference to the whole object, template, folder; its id is
// type/<object>, template/<id> or folder/<path>. The server treats it as a reference, never as text. A single item picks as
// "record", "project", "file" or "tag" (id: its urn, file/<path>, tag/<name>).

/** @typedef {import("../../ui/lib/nest-model.js").NestNode} NestNode */

const SKIP = /^(def-|flow-|kit-)/;
const PER_OBJECT = 300;

/** The tags on a record: a comma string or a list, lower-cased, no empties. @param {unknown} v @returns {string[]} */
export function tagsOf(v) {
  const list = Array.isArray(v) ? v : typeof v === "string" ? v.split(",") : [];
  return list.map((x) => String(x).trim().toLowerCase()).filter(Boolean);
}

/** @param {any} d the answer of work.template.list: { templates: [...] } or the list @returns {{ template: string, name: string, many: string }[]} */
function templateRows(d) {
  const list = Array.isArray(d) ? d : Array.isArray(d?.templates) ? d.templates : [];
  return list.filter((/** @type {any} */ t) => t && t.template && !t.archived).map((/** @type {any} */ t) => ({ template: String(t.template), name: String(t.name || t.template), many: String(t.noun?.many || t.name || t.template) }));
}

/** A project template is a Playbook in the words people read ("Estate plan playbook"); the tools and records keep work.template.*. @param {string} name */
const playbook = (name) => (/playbook$/i.test(name.trim()) ? name.trim() : `${name.trim()} playbook`);

/** @param {string} name */
const all = (name) => `${name} (all)`;

/** The folders and files under the Drive's root, from a flat list of paths. @param {readonly { path: string }[]} files @param {Record<string, string>} names @returns {NestNode[]} */
function fileTree(files, names) {
  /** @type {{ kids: Map<string, any>, file: boolean }} */ const root = { kids: new Map(), file: false };
  for (const f of files) {
    const parts = String(f.path || "").split("/").filter(Boolean);
    let at = root;
    parts.forEach((seg, i) => {
      if (!at.kids.has(seg)) at.kids.set(seg, { kids: new Map(), file: i === parts.length - 1 });
      at = at.kids.get(seg);
    });
  }
  /** @param {{ kids: Map<string, any> }} dir @param {string} base @returns {NestNode[]} */
  const level = (dir, base) => [...dir.kids.entries()]
    .sort(([a, x], [b, y]) => Number(x.file) - Number(y.file) || a.localeCompare(b))
    .map(([seg, n]) => {
      const path = base ? `${base}/${seg}` : seg;
      if (n.file) return { key: seg, label: seg, sub: base.split("/").map((_, i, a) => names[a.slice(0, i + 1).join("/")] ?? a[i]).join(" / "), pick: { pick: seg, urn: `file/${path}`, kind: "file" } };
      const label = names[path] ?? seg;
      return { key: seg, label, pick: { pick: all(label), urn: `folder/${path}`, kind: "collection" }, kids: level(n, path) };
    });
  return level(root, "");
}

/**
 * The # tree.
 * @param {{ world: { types: any[], byType: Record<string, any[]> } | null | undefined, titleOf: (def: any, rec: any) => string, templates: unknown, files: readonly { path: string }[], names: Record<string, string> }} o
 * @returns {NestNode[]}
 */
export function hashTree({ world, titleOf, templates, files, names }) {
  const types = (world?.types ?? []).filter((/** @type {any} */ d) => !d.internal && !SKIP.test(String(d.name)));
  const projectDef = (world?.types ?? []).find((/** @type {any} */ d) => d.name === "project");
  const projects = (world?.byType?.project ?? []).map((/** @type {any} */ r) => ({ ...r, title: titleOf(projectDef, r) }));
  const leaf = (/** @type {any} */ r) => ({ key: String(r.urn), label: r.title, sub: undefined, pick: { pick: r.title, urn: String(r.urn), kind: "project" } });
  /** @type {NestNode[]} */ const byTemplate = templateRows(templates).map((t) => ({
    key: t.template, label: playbook(t.name), pick: { pick: all(t.many), urn: `template/${t.template}`, kind: "collection" },
    kids: projects.filter((/** @type {any} */ r) => r.data?.template === t.template).map(leaf),
  }));
  const known = new Set(byTemplate.map((t) => t.key));
  const loose = projects.filter((/** @type {any} */ r) => !known.has(String(r.data?.template ?? "")));
  if (loose.length) byTemplate.push({ key: "none", label: "No template", kids: loose.map(leaf) });

  /** @type {NestNode[]} */ const objects = types.filter((/** @type {any} */ d) => d.name !== "project").map((/** @type {any} */ d) => {
    const label = String(d.label ?? d.name);
    const sealedKeys = (d.fields ?? []).filter((/** @type {any} */ f) => f.kind === "sealed" || f.seal).map((/** @type {any} */ f) => f.name);
    return {
      key: String(d.name), label, pick: { pick: all(label), urn: `type/${d.name}`, kind: "collection" },
      kids: (world?.byType?.[d.name] ?? []).slice(0, PER_OBJECT).map((/** @type {any} */ r) => {
        const title = titleOf(d, r);
        const sealed = sealedKeys.filter((/** @type {string} */ k) => r?.data?.[k] != null && (typeof r.data[k] !== "object" || r.data[k].present !== false)).length;
        return { key: String(r.urn), label: title, sealed, pick: { pick: title, urn: String(r.urn), kind: "record" } };
      }),
    };
  });

  /** @type {Map<string, number>} */ const tally = new Map();
  for (const list of Object.values(world?.byType ?? {})) for (const r of list) for (const t of new Set(tagsOf(r?.data?.tags))) tally.set(t, (tally.get(t) ?? 0) + 1);
  const tags = [...tally.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([t, n]) => ({ key: t, label: t, sub: `${n} record${n === 1 ? "" : "s"}`, pick: { pick: t, urn: `tag/${t}`, kind: "tag" } }));

  // Nothing is offered that opens onto nothing: a template with no projects, an object with no records, a category with neither.
  const filled = (/** @type {NestNode[]} */ list) => list.filter((n) => n.kids?.length);
  return filled([
    { key: "projects", label: "Projects", kids: filled(byTemplate) },
    { key: "records", label: "Records", kids: filled(objects) },
    { key: "files", label: "Files", kids: fileTree(files, names) },
    { key: "tags", label: "Tags", kids: tags },
  ]);
}

/**
 * The @ tree. An empty group is left out. An assistant is an Agent unless it is one of the chat's own AIs (`ais`, by name).
 * @param {{ people: readonly { name: string, family: string, doing?: string, group?: string }[], teams: readonly { name: string, kind: string }[], ais?: readonly string[] }} o
 * @returns {NestNode[]}
 */
export function atTree({ people, teams, ais = [] }) {
  const isAi = (/** @type {{ name: string, group?: string }} */ p) => p.group === "ai" || ais.some((a) => a.toLowerCase() === p.name.toLowerCase());
  const one = (/** @type {{ name: string, family: string, doing?: string }} */ p) => ({ key: p.name, label: p.name, family: p.family, sub: p.family === "assistant" ? p.doing || undefined : undefined, pick: { pick: p.name } });
  const groups = [
    { key: "people", label: "People", kids: people.filter((p) => p.family !== "assistant").map(one) },
    { key: "teams", label: "Teams and roles", kids: teams.map((t) => ({ key: `${t.kind}:${t.name}`, label: t.name, sub: t.kind === "role" ? "Role" : "Team", pick: { pick: t.name } })) },
    { key: "agents", label: "Agents", kids: people.filter((p) => p.family === "assistant" && !isAi(p)).map(one) },
    { key: "ais", label: "AIs", kids: people.filter((p) => p.family === "assistant" && isAi(p)).map(one) },
  ];
  return groups.filter((g) => g.kids.length);
}

/** A records world from the flat # list (name, type, sealed), for a screen that has no store (the sample build): one object per type label, a field sealed for each count. @param {readonly { name: string, type: string, sealed: number, urn?: string }[]} records */
export function worldOfPicks(records) {
  /** @type {Record<string, any[]>} */ const byType = {};
  for (const r of records) (byType[r.type] ??= []).push({ urn: r.urn ?? `sample/${r.type}/${r.name}`, data: { name: r.name, ...(r.sealed ? { secret: r.sealed } : {}) } });
  return { types: Object.keys(byType).map((t) => ({ name: t, label: t, fields: [{ name: "secret", kind: "sealed" }] })), byType };
}

/** The folder names the Drive showed for each file's path (its words, "Okafor estate / files"), by the folder's own path; and the paths. @param {readonly { id: string, path: string }[]} files @returns {{ paths: { path: string }[], names: Record<string, string> }} */
export function filesOf(files) {
  /** @type {Record<string, string>} */ const names = {};
  for (const f of files) {
    const segs = f.id.split("/").slice(0, -1);
    const words = String(f.path || "").split(" / ");
    if (words.length === segs.length) segs.forEach((s, i) => { const key = segs.slice(0, i + 1).join("/"); if (words[i] && words[i] !== s) names[key] = words[i]; });
  }
  return { paths: files.map((f) => ({ path: f.id })), names };
}
