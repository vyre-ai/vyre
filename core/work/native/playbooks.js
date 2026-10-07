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
    // records' playbook type: `name`, `applies_to` (one text: "<type>" or "<type>:<stage>"), `body`, `kit`. A playbook that names neither applies nowhere.
    const [aType, aStage] = String(r.data.applies_to || "").split(":").map(x => x.trim());
    if (!aType) continue;
    if (aType !== type) continue;
    if (aStage && aStage !== stage) continue;
    // Not reviewed: it came with a Kit (`kit` is set) and no one has edited it since (its version is still 1), or the kernel says it was changed outside the gateway.
    // The kernel does not yet label a record by who wrote it, so version and `kit` are the signal (a platform gap: a last-writer label).
    const reviewed = !(r.labels && r.labels.trust === "external") && !(r.data.kit && Number(r.version) <= 1);
    const labels = reviewed ? r.labels : { ...(r.labels || externalLabels(chain.space)), trust: "external" };
    hits.push({ urn: r.urn, title: clean(r.data.name, 60), version: Number(r.version) || 1, reviewed, text: clean(r.data.body, PLAYBOOK_CHARS), labels, specific: Boolean(aStage) });
  }
  hits.sort((a, b) => Number(b.specific) - Number(a.specific) || a.title.localeCompare(b.title) || a.urn.localeCompare(b.urn));
  return hits.slice(0, PLAYBOOK_MAX);
}
