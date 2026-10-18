// @ts-check
// "Add a column" on a table: a name and a kind, saved at once. A simple kind is a fast field (records.field.add); a link to another type is records.link.add, which makes the twin on the other type too.

export const COLUMN_KINDS = [["text", "Text"], ["number", "Number"], ["date", "Date"], ["choice", "Pick one"], ["boolean", "Yes or no"], ["link", "Link to another type"]];

/** The tool and input for a column, or the plain problem. @param {string} type @param {{ label: string, kind: string, options?: string, to?: string, many?: boolean }} d @returns {{ tool: string, input: Record<string, any> } | { problem: string }} */
export function columnCall(type, d) {
  const label = String(d.label || "").trim();
  if (!label) return { problem: "Name the column." };
  if (d.kind === "link") {
    if (!d.to) return { problem: "Pick the type it links to." };
    return { tool: "records.link.add", input: { type, label, to: d.to, ...(d.many ? { many: true } : {}) } };
  }
  if (!COLUMN_KINDS.some(([k]) => k === d.kind)) return { problem: "Pick a kind." };
  if (d.kind === "choice") {
    const options = String(d.options || "").split(",").map((o) => o.trim()).filter(Boolean);
    if (options.length < 2) return { problem: "A pick-one column needs at least two options, separated by commas." };
    return { tool: "records.field.add", input: { type, label, kind: "choice", options } };
  }
  return { tool: "records.field.add", input: { type, label, kind: d.kind } };
}

/** The name of the field a call made, when the answer says: { field: { name } } or { name }. @param {any} data */
export const madeName = (data) => (data && (data.field && data.field.name || data.name)) || undefined;
