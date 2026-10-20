// @ts-check
// Roles on a record: the rows of records.roles ({ role, holder, stage?, current, record }) as the chips a person reads under the title: "Lead · Talking", "Client · Active", and what ended kept last and quiet.

/** "Lead", or "Lead · Talking" when the role has a stage. @param {{ role?: string, stage?: unknown }} r */
export const roleLabel = (r) => [String(r && r.role || "Role").replace(/^./, (c) => c.toUpperCase()), r && r.stage !== undefined && r.stage !== null && r.stage !== "" ? String(r.stage) : ""].filter(Boolean).join(" · ");

/** The chips in order: current roles first (as the tool returns them), ended ones after, each marked. @param {any[]} rows @returns {{ key: string, label: string, urn: string, ended: boolean, tone: "lead" | "client" | "partner" | "vendor" | "plain" }[]} */
export function roleChips(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const chip = (/** @type {any} */ r) => {
    const base = String(r && r.role || "").toLowerCase();
    /** @type {"lead" | "client" | "partner" | "vendor" | "plain"} */
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

/**
 * The role chips of every holder on a table: `kinds` is records.roles.summary with no urn ({ role, label, color }), `byRole` the rows of records.holders for each role ({ holder, stage, current }). A map from the holder's
 * urn to its chips, current roles first. A holder with no role has no entry.
 * @param {any[]} kinds @param {Record<string, any[]>} byRole @returns {Record<string, { label: string, tone: string, ended: boolean }[]>}
 */
export function chipsByHolder(kinds, byRole) {
  /** @type {Record<string, { label: string, tone: string, ended: boolean }[]>} */ const out = {};
  for (const k of Array.isArray(kinds) ? kinds : []) {
    for (const r of (byRole && byRole[k.role]) || []) {
      if (!r || !r.holder) continue;
      (out[r.holder] = out[r.holder] || []).push({ label: [String(k.label || k.role), r.stage ? String(r.stage) : ""].filter(Boolean).join(" · "), tone: toneOfColour(k.color), ended: !r.current });
    }
  }
  for (const h of Object.keys(out)) out[h].sort((a, b) => Number(a.ended) - Number(b.ended));
  return out;
}

/**
 * The roles "+ Role" offers a record: the Space's role kinds (records.roles.summary with no urn) that a record of this type can hold (`holder`, the type the role links to; a box that does not say is taken at
 * its word), that it does not hold now, and each label once: when two kinds read the same (a Kit's own Lead beside the Space's), the Space's own role (role-*) is the one offered.
 * @param {{ role: string, label: string, holder?: string | null }[]} kinds @param {Set<string> | string[]} held the roles it holds now @param {string} holderType "contact" or "organization"
 */
export function freeRoles(kinds, held, holderType) {
  const have = new Set(held);
  const fits = (Array.isArray(kinds) ? kinds : []).filter((k) => k && !have.has(k.role) && (!k.holder || k.holder === holderType));
  const byLabel = new Map();
  for (const k of fits) {
    const key = String(k.label || k.role).toLowerCase();
    const was = byLabel.get(key);
    if (!was || (!String(was.role).startsWith("role-") && String(k.role).startsWith("role-"))) byLabel.set(key, k);
  }
  // a label the record already holds under another kind is not offered again
  const heldLabels = new Set((Array.isArray(kinds) ? kinds : []).filter((k) => k && have.has(k.role)).map((k) => String(k.label || k.role).toLowerCase()));
  return [...byLabel.values()].filter((k) => !heldLabels.has(String(k.label || k.role).toLowerCase()));
}
