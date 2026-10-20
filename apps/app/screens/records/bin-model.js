// @ts-check
// The Bin and the row ticks of a records list, in words and patches. Pure.

const DAY = 86_400_000;

/** When a record went to the bin, as a short line: "Deleted today", "Deleted yesterday", "Deleted 4 days ago". @param {unknown} deletedAt ms @param {number} now ms */
export function binLine(deletedAt, now) {
  const at = Number(deletedAt);
  if (!Number.isFinite(at) || at <= 0) return "Deleted";
  const days = Math.floor((now - at) / DAY);
  return days <= 0 ? "Deleted today" : days === 1 ? "Deleted yesterday" : `Deleted ${days} days ago`;
}

/** The fields a person can set for several ticked records at once: a choice, a stage or a yes or no (one value for all); never a sealed, computed, read-only or ID field. @param {{ fields?: any[] }} def */
export function settableFields(def) {
  return ((def && def.fields) || [])
    .filter((f) => f && ["choice", "stage", "boolean"].includes(f.kind) && !f.computed && !f.read_only && !f.seal && f.name !== "ref")
    .map((f) => ({ name: String(f.name), label: String(f.label || f.name), options: f.kind === "boolean" ? ["Yes", "No"] : (f.options || []).map(String), kind: String(f.kind) }));
}

/** The patch that sets one field to one picked option. @param {{ name: string, kind: string }} field @param {string} picked */
export function patchFor(field, picked) {
  return { [field.name]: field.kind === "boolean" ? picked === "Yes" : picked };
}

/** What a run over several records says: "Set Status for 3 people", with how many did not go through. @param {{ done: number, failed: number }} n @param {string} what */
export function bulkLine(n, what) {
  return n.failed ? `${what}: ${n.done} done, ${n.failed} did not go through.` : `${what}.`;
}
