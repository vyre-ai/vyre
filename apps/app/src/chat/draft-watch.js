// @ts-check
// "Turn this into a Flow" ends in a draft the person opens and says yes to. The assistant makes the draft (flows.from-chat) in its own turn, so the chat watches the Flows list for the one that is new since the tap:
// the first Flow whose id was not there before. Pure; FlowDraftNote.tsx polls and draws.

/**
 * The Flows a person has, drafts included, from records.list of the Flow definitions (a draft is not in flows.list until it is approved): one row per Flow, newest definition's words.
 * @param {any} answer records.list's answer ({ rows } or the rows) @returns {{ id: string, label: string }[]}
 */
export function flowsFrom(answer) {
  const rows = Array.isArray(answer) ? answer : answer && Array.isArray(answer.rows) ? answer.rows : [];
  /** @type {Map<string, { id: string, label: string }>} */ const by = new Map();
  for (const r of rows) {
    const d = r && r.data;
    if (!d || typeof d.flow_id !== "string") continue;
    let label = "";
    try { label = String(JSON.parse(String(d.body || "{}")).label || ""); } catch { label = ""; }
    by.set(d.flow_id, { id: d.flow_id, label: label || String(d.name || "") });
  }
  return [...by.values()];
}

/** The Flow made since the tap, or null: the first row whose id is not in `before`. @param {readonly string[]} before @param {readonly { id: string, label?: string, name?: string, status?: string }[]} rows @returns {{ id: string, title: string } | null} */
export function newDraft(before, rows) {
  const had = new Set(before);
  const hit = (rows || []).find((r) => r && typeof r.id === "string" && !had.has(r.id));
  return hit ? { id: hit.id, title: String(hit.label || hit.name || "A new Flow").trim() } : null;
}

/** The words while it is being made, when it is ready, and when nothing came of it. @param {{ kind: "making" } | { kind: "ready", title: string } | { kind: "none" }} s */
export function draftWords(s) {
  if (s.kind === "making") return "Making the Flow draft. Nothing runs until you say yes.";
  if (s.kind === "ready") return `Draft ready: ${s.title}. Open it to read the steps and say yes.`;
  return "No Flow was made. The assistant may have asked you something first.";
}
