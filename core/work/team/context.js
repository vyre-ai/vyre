// @ts-check
// What a teammate starts with (contract 9.4): its role instructions, the project and its linked records minus sealed fields, and the Kit's
// templates. Records are read through the gateway under the teammate's own chain, so a model-facing read already carries placeholders; the view is
// applied again here because a store or a caller may hand over the reference form. The text is labelled by what it drew on.

import { joinLabels, externalLabels } from "../../../lib/labels.js";
import { modelView, isSealedValue, sealedText } from "../../../lib/sealed.js";

const URN = /^vyre:\/\/([^/]+)\/([^/]+)\/([^/]+)$/;
/** @param {string} u @returns {{ space: string, type: string, id: string }|null} */
export function parseUrn(u) { const m = URN.exec(String(u)); return m ? { space: m[1], type: m[2], id: m[3] } : null; }

/** @param {any} v @returns {string[]} urns a field value points at */
const refsIn = v => (Array.isArray(v) ? v.flatMap(refsIn) : v && typeof v === "object" && typeof v.urn === "string" ? [v.urn] : []);

/** A field as one line of text: a sealed field is the placeholder, a reference is its address. @param {string} k @param {any} v */
function line(k, v) {
  if (isSealedValue(v)) return sealedText(k, v);
  if (v == null || v === "") return `${k}: (empty)`;
  if (typeof v === "string") return `${k}: ${v}`;
  return `${k}: ${JSON.stringify(v)}`;
}

/**
 * @param {any} kernel @param {any} chain the teammate's chain (the kernel built it)
 * @param {{ project: string, role?: { instructions?: { text: string, labels?: any, reviewed?: boolean }|string, name?: string }, templates?: readonly { name: string, body: string, labels?: any }[], maxLinked?: number, space: string }} o
 * @returns {Promise<{ text: string, urns: string[], labels: import("../../../lib/labels.js").Labels, skipped: string[] }>}
 */
export async function teammateContext(kernel, chain, { project, role, templates = [], maxLinked = 12, space }) {
  const p = parseUrn(project);
  if (!p) throw Object.assign(new Error("the project is a vyre:// address"), { code: "bad_input" });
  const root = await kernel.records.get(chain, p.type, p.id);
  if (!root) throw Object.assign(new Error("not found: check the project address (projects.list shows the projects you may see)"), { code: "not_found" });
  const urns = [project], skipped = [], labels = [root.labels];
  /** @type {string[]} */ const parts = [];
  const instr = typeof role?.instructions === "string" ? { text: role.instructions, labels: externalLabels(space), reviewed: false } : role?.instructions;
  if (instr && instr.text) { labels.push(instr.labels || externalLabels(space)); parts.push(`## Role${role?.name ? `: ${role.name}` : ""}${instr.reviewed ? "" : " (from a Kit, not yet reviewed)"}\n${instr.text}`); }
  const view = modelView(root.data);
  parts.push(`## Project ${project}\n${Object.entries(view).map(([k, v]) => line(k, v)).join("\n")}`);
  const links = [...new Set(Object.values(root.data).flatMap(refsIn))].slice(0, maxLinked);
  for (const u of links) {
    const q = parseUrn(u);
    if (!q || q.space !== p.space) { skipped.push(u); continue; }
    let rec = null;
    try { rec = await kernel.records.get(chain, q.type, q.id); } catch { rec = null; }
    if (!rec) { skipped.push(u); continue; }
    urns.push(u); labels.push(rec.labels);
    parts.push(`## Linked ${u}\n${Object.entries(modelView(rec.data)).map(([k, v]) => line(k, v)).join("\n")}`);
  }
  for (const t of templates) { labels.push(t.labels || externalLabels(space)); parts.push(`## Template ${t.name}\n${t.body}`); }
  return { text: parts.join("\n\n"), urns, labels: joinLabels(labels), skipped };
}
