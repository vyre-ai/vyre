// @ts-check
// Roles on a record: the rows of records.roles ({ role, holder, stage?, current, record }) as the chips a person reads under the title: "Lead · Talking", "Client · Active", and what ended kept last and quiet.

/** "Lead", or "Lead · Talking" when the role has a stage. @param {{ role?: string, stage?: unknown }} r */
export const roleLabel = (r) => [String(r && r.role || "Role").replace(/^./, (c) => c.toUpperCase()), r && r.stage !== undefined && r.stage !== null && r.stage !== "" ? String(r.stage) : ""].filter(Boolean).join(" · ");

/** The chips in order: current roles first (as the tool returns them), ended ones after, each marked. @param {any[]} rows @returns {{ key: string, label: string, urn: string, ended: boolean, tone: "lead" | "client" | "partner" | "vendor" | "plain" }[]} */
export function roleChips(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const chip = (/** @type {any} */ r) => {
    const base = String(r && r.role || "").toLowerCase();
    const tone = base === "lead" || base === "prospect" ? "lead" : base === "client" || base === "customer" ? "client" : base === "partner" ? "partner" : base === "vendor" ? "vendor" : "plain";
    return { key: String(r && r.record && r.record.urn || `${base}:${r && r.stage}`), label: roleLabel(r), urn: String(r && r.record && r.record.urn || ""), ended: !(r && r.current), tone };
  };
  return [...list.filter((r) => r && r.current).map(chip), ...list.filter((r) => r && !r.current).map(chip)];
}

/** The chip tone a type colour gets (records.type.update colours): green is good news, yellow and orange need a look, red is bad, the cool colours are accents, grey and unknown are plain. @param {unknown} colour @returns {"ok" | "warn" | "err" | "accent" | "plain"} */
export function toneOfColour(colour) {
  const c = String(colour || "").toLowerCase();
  if (c === "green") return "ok";
  if (c === "yellow" || c === "orange") return "warn";
  if (c === "red") return "err";
  if (["blue", "teal", "purple", "pink"].includes(c)) return "accent";
  return "plain";
}

/** The chips of records.roles.summary ({ role, label, stage, current, color, urn }): "Lead · Talking" in the role's colour, current first, ended last. @param {any[]} rows */
export function summaryChips(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const chip = (/** @type {any} */ r) => ({ key: String(r && (r.urn || r.id) || `${r && r.role}:${r && r.stage}`), label: [String(r && (r.label || r.role) || "Role"), r && r.stage ? String(r.stage) : ""].filter(Boolean).join(" · "), urn: String(r && r.urn || ""), ended: !(r && r.current), tone: toneOfColour(r && r.color) });
  return [...list.filter((r) => r && r.current).map(chip), ...list.filter((r) => r && !r.current).map(chip)];
}
