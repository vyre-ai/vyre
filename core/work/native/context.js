// @ts-check
// What an agent doing a task knows about the record's world (DESIGN-tasks idea 1): the records it links to (the client, the contact, the matter's parties), the records that link to it, the recent
// communications with the people on it, and what happened to it lately. Everything is read through the gateway under the AGENT'S OWN chain, so it sees only what it may, and a sealed field is the
// placeholder it always is. Text a member or an outsider wrote (a message's excerpt) goes only into the quoted data block, never into a line the model might follow.
//
//   const c = await recordContext(kernel, chain, rec, { space });   // { sections: [{ key, head, items }], quoted: [], urns, inputs }
//
// It reads relations by their link fields (`records.linked` is the reverse of a link field), so the named relations Windows builds on Twenty are reached the same way as any link.

import { modelView, isSealedValue, sealedText } from "../../../lib/sealed.js";
import { clean } from "./text.js";

const COMM = "communication", PART = "participant";
const URN = /^vyre:\/\/([^/]+)\/([^/]+)\/([^/]+)$/;
/** @param {any} v @returns {string[]} urns a field value points at */
const refsIn = v => (Array.isArray(v) ? v.flatMap(refsIn) : v && typeof v === "object" && typeof v.urn === "string" ? [v.urn] : []);
const when = (/** @type {any} */ v) => { const t = typeof v === "number" ? v : Date.parse(String(v)); return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : ""; };

/** A record as one short line: its type, its name or title, its stage, and a few plain fields; a sealed field is its placeholder. @param {any} r */
function brief(r) {
  const view = modelView(r.data || {});
  const name = view.name || view.title || view.subject || r.id;
  const parts = [];
  for (const [k, v] of Object.entries(view)) {
    if (["name", "title", "subject", "stage", "body", "excerpt"].includes(k) || parts.length >= 4) continue;
    if (isSealedValue(r.data[k])) parts.push(sealedText(k, r.data[k]));
    else if (typeof v === "string" && v) parts.push(`${k}: ${clean(v, 40)}`);
    else if (typeof v === "number") parts.push(`${k}: ${v}`);
  }
  return `${clean(r.type, 30)} ${clean(typeof name === "string" ? name : r.id, 60)}${typeof view.stage === "string" ? ` (stage: ${clean(view.stage, 30)})` : ""}${parts.length ? `: ${parts.join("; ")}` : ""}`;
}

/**
 * @param {any} kernel the kernel handle (records.get, records.linked, events.read when it has them) @param {any} chain the agent's chain @param {any} rec the focus record
 * @param {{ space: string, maxLinked?: number, maxComms?: number, maxHistory?: number }} o
 */
export async function recordContext(kernel, chain, rec, { space, maxLinked = 8, maxComms = 6, maxHistory = 6, memory = null }) {
  /** @type {{ key: string, head: string, items: string[] }[]} */ const sections = [];
  /** @type {string[]} */ const quoted = [], urns = [];
  /** @type {any[]} */ const inputs = [];
  const get = async (/** @type {string} */ u) => { const m = URN.exec(u); if (!m || m[1] !== space) return null; try { return await kernel.records.get(chain, m[2], m[3]); } catch { return null; } };
  const linked = async (/** @type {string} */ u, /** @type {any} */ opts) => { try { return kernel.records.linked ? (await kernel.records.linked(chain, u, opts)).rows : []; } catch { return []; } };

  // The records this one points at (the client, the contact, the parties)
  const fwd = [...new Set(Object.values(rec.data || {}).flatMap(refsIn))].slice(0, maxLinked);
  /** @type {any[]} */ const fwdRecs = [];
  for (const u of fwd) { const r = await get(u); if (r) { fwdRecs.push(r); urns.push(u); inputs.push(r.labels); } }
  if (fwdRecs.length) sections.push({ key: "linked", head: "Linked records:", items: fwdRecs.map(brief) });

  // The records that point at it (tasks of the matter, documents, parties), the communication kinds aside
  const back = (await linked(rec.urn, { limit: 30 })).filter((/** @type {any} */ x) => x.type !== COMM && x.type !== PART && x.type !== "team-member");
  const seen = new Set(urns);
  const backItems = [];
  for (const x of back) { const r = x.record; if (!r || seen.has(r.urn)) continue; seen.add(r.urn); urns.push(r.urn); inputs.push(r.labels); backItems.push(`${brief(r)} (${clean(x.field, 30)})`); if (backItems.length >= maxLinked) break; }
  if (backItems.length) sections.push({ key: "backlinks", head: "Linked to it:", items: backItems });

  // Recent communications: those that concern the record, and those with the contacts on it (through the participant records)
  /** @type {Map<string, any>} */ const comms = new Map();
  for (const x of await linked(rec.urn, { type: COMM, limit: 30 })) if (x.record) comms.set(x.record.urn, x.record);
  for (const c of fwdRecs.filter(r => r.type === "contact" || r.type === "organization").slice(0, 3)) {
    for (const p of await linked(c.urn, { type: PART, limit: 30 })) {
      const cu = p.record && p.record.data && p.record.data.communication && p.record.data.communication.urn;
      if (cu && !comms.has(cu)) { const cr = await get(cu); if (cr) comms.set(cu, cr); }
    }
  }
  const recent = [...comms.values()].sort((a, b) => String(b.data.at).localeCompare(String(a.data.at))).slice(0, maxComms);
  if (recent.length) {
    sections.push({ key: "comms", head: "Recent communications:", items: recent.map(c => {
      inputs.push(c.labels); urns.push(c.urn);
      // an excerpt is somebody else's words: quoted, never a line
      if (c.data.excerpt) quoted.push(`communication ${c.id}: ${c.data.excerpt}`);
      return `${when(c.data.at)} ${clean(c.data.direction || "", 12)} ${clean(c.data.kind || "", 12)}: ${clean(c.data.subject || "(no subject)", 80)}`.replace(/\s+/g, " ");
    }) });
  }

  // What happened to it lately (events about this record; the actor and the kind, never a value)
  try {
    const evs = kernel.events && kernel.events.read ? await kernel.events.read(chain, { subject_prefix: rec.urn, limit: 50 }) : [];
    const items = [...evs].reverse().slice(0, maxHistory).map((/** @type {any} */ e) => `${when(e.time ?? e.received_at ?? e.at)} ${clean(e.type, 40)}`.trim());
    if (items.length) sections.push({ key: "history", head: "Lately:", items });
  } catch { /* history is a nicety; the rest stands */ }

  // The project's memory: the Project record (this one, or the one it links to) names its memory scope, and what that room holds comes back as quoted data (it was written by people and models)
  if (memory) {
    const proj = rec.type === "project" ? rec : fwdRecs.find(r => r.type === "project");
    const slug = proj && proj.data && typeof proj.data.slug === "string" ? proj.data.slug : null;
    if (slug) {
      try {
        const text = await memory(slug);
        if (text) { quoted.push(`memory of project ${slug}: ${clean(text, 1500)}`); sections.push({ key: "memory", head: "Project memory:", items: [`the memory room ${slug} is quoted below`] }); }
      } catch { /* memory not running: the rest stands */ }
    }
  }
  return { sections, quoted, urns, inputs };
}
