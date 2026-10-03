// @ts-check
// Kit playbooks (DESIGN-native-assistant, "How Kits teach it"): a short note for the assistant on how this firm does a thing, a record of type
// `playbook` like any definition, edited by admins and @Engineer with no special path. It is loaded only where it applies, at most two, capped,
// and it is `external` until a person reviewed it (R6-10): the situation quotes it as data with its title and version, never as an instruction.

import { externalLabels } from "../../../lib/labels.js";
import { clean } from "./text.js";

export const PLAYBOOK_CHARS = 600; // about 150 tokens
export const PLAYBOOK_MAX = 2;

/**
 * The playbooks that apply to a record type and stage: stage-specific first, then type-wide. A playbook that names neither applies nowhere.
 * @param {any} kernel @param {any} chain @param {{ type?: string, stage?: string }} where
 * @returns {Promise<{ urn: string, title: string, version: number, reviewed: boolean, text: string, labels: any, specific: boolean }[]>}
 */
export async function playbooksFor(kernel, chain, { type, stage }) {
  const page = await kernel.records.query(chain, "playbook", { page: { limit: 200 } }).then((/** @type {any} */ r) => r.rows).catch(() => []);
  const hits = [];
  for (const r of page) {
    const a = r.data.applies_to || {};
    if (!a.type && !a.stage) continue;
    if (a.type && a.type !== type) continue;
    if (a.stage && a.stage !== stage) continue;
    // Not reviewed means a Kit or a model wrote it: external, whatever the record's own label says.
    const reviewed = r.data.reviewed === true;
    const labels = reviewed ? r.labels : { ...(r.labels || externalLabels(chain.space)), trust: "external" };
    hits.push({ urn: r.urn, title: clean(r.data.title, 60), version: Number(r.data.version) || 1, reviewed, text: clean(r.data.body, PLAYBOOK_CHARS), labels, specific: Boolean(a.stage) });
  }
  hits.sort((a, b) => Number(b.specific) - Number(a.specific) || a.title.localeCompare(b.title) || a.urn.localeCompare(b.urn));
  return hits.slice(0, PLAYBOOK_MAX);
}
