// @ts-check
// Type-level edits for the Records setup screens, on the kernel's own field definitions.

/** Replace a field (by its old name) or append it. @param {any[]} fields @param {any} field @param {string} [oldName] */
export const putField = (fields, field, oldName) => (oldName && fields.some((f) => f.name === oldName) ? fields.map((f) => (f.name === oldName ? field : f)) : [...fields, field]);

/** Swap a field with the nearest field of the same group in that direction; at the edge of its group nothing moves. @param {any[]} fields @param {string} name @param {-1 | 1} dir */
export function moveField(fields, name, dir) {
  const i = fields.findIndex((f) => f.name === name);
  if (i < 0) return fields;
  const g = fields[i].group ?? "";
  for (let j = i + dir; j >= 0 && j < fields.length; j += dir) {
    if ((fields[j].group ?? "") !== g) continue;
    const n = [...fields];
    [n[i], n[j]] = [n[j], n[i]];
    return n;
  }
  return fields;
}

/** The group each row says, written onto the stored fields. @param {any[]} fields @param {{ name: string, group?: string }[]} rows */
export function regroup(fields, rows) {
  return fields.map((f) => {
    const g = rows.find((r) => r.name === f.name)?.group;
    const { group: _old, ...rest } = f;
    return g ? { ...rest, group: g } : rest;
  });
}

/** A stored rule back into the pick that built it; any other Expression is null (the screen shows it as written). @param {string} expr @returns {{ field: string, op: "is" | "is_not" | "filled", value?: string } | null} */
export function parseRule(expr) {
  const e = (expr ?? "").trim();
  let m = /^not empty\(([a-z0-9_]+)\)$/.exec(e);
  if (m) return { field: m[1], op: "filled" };
  m = /^([a-z0-9_]+) (==|!=) ("(?:[^"\\]|\\.)*")$/.exec(e);
  if (m) { try { return { field: m[1], op: m[2] === "==" ? "is" : "is_not", value: JSON.parse(m[3]) }; } catch { return null; } }
  return null;
}
