// @ts-check
// A type's Access and History tabs, in words. Pure. Access reads the roles (roles.list, roles.get) for what each does with this type; History reads the space's log (records.events) for anyone, and the audit
// (records.audit, owners and admins) for the values before and after.

const LEVEL = /** @type {Record<string, string>} */ ({ none: "No access", read: "Can read", edit: "Can edit" });

/**
 * What each role may do with one type, one line per role: the level, the fields hidden from it and how many hold the role.
 * @param {{ id: string, name: string, holders?: number, data?: { id: string, access: string, hidden?: string[] }[] }[]} roles @param {string} type
 */
export function accessRows(roles, type) {
  return roles.map((r) => {
    const d = (r.data || []).find((x) => x.id === type);
    const hidden = d && d.access !== "none" ? (d.hidden || []).length : 0;
    const holders = Number(r.holders || 0);
    return { id: r.id, name: r.name, level: LEVEL[d ? d.access : "none"] || "No access", hidden, holders, sub: [hidden ? `${hidden} ${hidden === 1 ? "field" : "fields"} hidden` : "", `${holders} ${holders === 1 ? "person" : "people"}`].filter(Boolean).join(" · ") };
  });
}

/** The people who hold a role-type's roles (records.holders rows), as the record each names. @param {{ holder?: string, stage?: string }[]} rows */
export const holderRows = (rows) => (rows || []).filter((r) => r && r.holder).map((r) => ({ urn: String(r.holder), id: String(r.holder).split("/").pop() || "", stage: r.stage || "" }));

/** The words for a refused or missing call on these tabs. @param {string} [code] @param {string} [message] */
export function tabRefusal(code, message = "") {
  if (code === "not_allowed") return "Only an owner or an admin sees this.";
  if (code === "no_such_tool" || code === "unknown_tool") return "This server cannot show that yet. It will once it is updated.";
  return message || "That did not load.";
}

/**
 * The log's events for one type, newest first, one line each, for a person who cannot open the audit. An event is "<type>.<verb>" on a subject address.
 * @param {{ seq: number, time: number, type: string, subject?: string, actor?: string }[]} events @param {string} type @param {(id: string) => string | undefined} [nameOf]
 */
export function eventLines(events, type, nameOf) {
  const VERB = /** @type {Record<string, string>} */ ({ created: "made", updated: "changed", removed: "removed", restored: "brought back" });
  return (events || [])
    .filter((e) => e && typeof e.type === "string" && e.type.startsWith(`${type}.`) && VERB[e.type.slice(type.length + 1)])
    .map((e) => {
      const id = String(e.actor || "").replace(/^person:/, "").split("@")[0];
      const who = (nameOf && nameOf(id)) || (e.actor ? `Person ${id.slice(-6)}` : "Someone");
      return { seq: e.seq, time: e.time, title: `${who} ${VERB[e.type.slice(type.length + 1)]} a ${type.replace(/-/g, " ")}`, record: e.subject || "" };
    })
    .sort((a, b) => b.seq - a.seq);
}
