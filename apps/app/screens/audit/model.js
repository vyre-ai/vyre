// @ts-check
// The audit's words: one plain line for a change (who did what to which record) and one line per field that changed, with the value before and after. Pure. A sealed value is never in the log, only its
// placeholder, and this shows it as "sealed" so the screen cannot show more than the log holds.

/** @typedef {{ seq: number, time: number, who: string, via?: string, verb: string, type: string, record: string, version?: number, changed: string[], before: any, after: any }} Change */

/** "person:per_x" -> the name the Space knows, else a short form. @param {string} who @param {(id: string) => string | undefined} [nameOf] */
export const whoName = (who, nameOf) => {
  const id = String(who).replace(/^person:/, "");
  return (nameOf && nameOf(id)) || (String(who).startsWith("person:") ? `Person ${id.slice(-6)}` : String(who).replace(/^[a-z]+:/, ""));
};

/** One value as a short line. A sealed placeholder (an object with `sealed`) reads "sealed". @param {any} v */
export function shown(v) {
  if (v === undefined || v === null || v === "") return "empty";
  if (typeof v === "object" && !Array.isArray(v) && ("sealed" in v || "ref" in v)) return "sealed";
  if (Array.isArray(v)) return v.length ? v.map(shown).join(", ") : "empty";
  if (typeof v === "object") return v.urn ? String(v.urn).replace(/^.*\//, "") : v.amount !== undefined ? `${v.amount} ${v.currency || ""}`.trim() : JSON.stringify(v).slice(0, 60);
  return String(v).slice(0, 80);
}

/** @param {Change} c @param {(id: string) => string | undefined} [nameOf] */
export function line(c, nameOf) {
  const who = whoName(c.who, nameOf) + (c.via === "assistant" ? " (through the assistant)" : "");
  const verb = c.verb === "created" ? "made" : c.verb === "removed" ? "removed" : c.verb === "restored" ? "brought back" : "changed";
  return `${who} ${verb} a ${c.type.replace(/-/g, " ")}`;
}

/** The field lines of a change: "age: 40 to 41". @param {Change} c */
export function fieldLines(c) {
  return (c.changed || []).map((f) => (c.verb === "created" ? `${f}: ${shown(c.after && c.after[f])}` : `${f}: ${shown(c.before && c.before[f])} to ${shown(c.after && c.after[f])}`));
}

/** The filters a person typed, as the call's input (blank ones left out). @param {{ person?: string, project?: string, type?: string, record?: string }} f */
export const inputOf = (f) => Object.fromEntries(Object.entries(f).map(([k, v]) => [k, String(v || "").trim()]).filter(([, v]) => v));

/** Why a call was refused, in words. @param {string} [code] @param {string} [message] */
export const refusal = (code, message) => (code === "not_allowed" ? "Only an owner or an admin opens the audit." : message || "The audit did not load.");
