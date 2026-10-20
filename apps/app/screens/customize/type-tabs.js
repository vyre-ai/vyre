// @ts-check
// A type's Access and History tabs, in words. Pure. Access reads the roles (roles.list, roles.get) for what each does with this type; History reads the space's log (records.events) for anyone, and the audit
// (records.audit, owners and admins) for the values before and after.

import { plainError } from "../../src/real/error-note.js";

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

/** The people who hold a role-type's roles (records.holders rows), as the record each names, with its name when the screen knows it (never the raw id). @param {{ holder?: string, stage?: string }[]} rows @param {(urn: string) => string | undefined} [nameOf] */
export const holderRows = (rows, nameOf) => (rows || []).filter((r) => r && r.holder).map((r) => ({ urn: String(r.holder), id: String(r.holder).split("/").pop() || "", name: (nameOf && nameOf(String(r.holder))) || "A record you cannot open", stage: r.stage || "" }));

/**
 * A record as someone sees it (records.sees-as), as rows a person reads: the type's field labels in the type's order, a link as the linked record's name, a sealed value as "Sealed", nothing as "Empty".
 * Keys the type does not define (the store's own bookkeeping) are left out. @param {{ fields?: { name: string, label?: string }[] } | undefined} def @param {Record<string, unknown> | null | undefined} data
 * @param {(urn: string) => string | undefined} [nameOf]
 */
export function seenRows(def, data, nameOf) {
  if (!data || typeof data !== "object") return [];
  /** @type {(v: any) => string} */
  const word = (v) => {
    if (v === null || v === undefined || v === "") return "Empty";
    if (typeof v === "boolean") return v ? "Yes" : "No";
    if (typeof v === "string") return /\{\{field:/.test(v) ? "Sealed" : v;
    if (typeof v === "number") return String(v);
    if (Array.isArray(v)) return v.length ? v.map(word).join(", ") : "Empty";
    if (typeof v === "object" && typeof v.urn === "string") return (nameOf && nameOf(v.urn)) || "A linked record";
    if (typeof v === "object" && typeof v.ref === "string") return "Sealed";
    if (typeof v === "object" && "amount" in v) return [v.amount, v.currency].filter((x) => x !== undefined && x !== null).join(" ");
    return "A value";
  };
  return ((def && def.fields) || []).filter((f) => Object.prototype.hasOwnProperty.call(data, f.name) && f.name !== "extra").map((f) => ({ key: f.name, label: String(f.label || f.name), value: word(/** @type {any} */ (data)[f.name]) }));
}

/** The words for a refused or missing call on these tabs. @param {string} [code] @param {string} [message] */
export function tabRefusal(code, message = "") {
  if (code === "not_allowed") return "Only an owner or an admin sees this.";
  if (code === "no_such_tool" || code === "unknown_tool") return "This server cannot show that yet. It will once it is updated.";
  return plainError({ code, message }, "That did not load.");
}

/**
 * The log's events for one type, newest first, one line each, for a person who cannot open the audit. An event is "<type>.<verb>" on a subject address. A person is named, or is "Someone", never an id.
 * @param {{ seq: number, time: number, type: string, subject?: string, actor?: string }[]} events @param {string} type @param {(id: string) => string | undefined} [nameOf] @param {string} [noun] the type's own word ("person")
 */
export function eventLines(events, type, nameOf, noun) {
  const VERB = /** @type {Record<string, string>} */ ({ created: "made", updated: "changed", removed: "removed", restored: "brought back" });
  return (events || [])
    .filter((e) => e && typeof e.type === "string" && e.type.startsWith(`${type}.`) && VERB[e.type.slice(type.length + 1)])
    .map((e) => {
      const id = String(e.actor || "").replace(/^person:/, "").split("@")[0];
      const who = (nameOf && nameOf(id)) || "Someone";
      return { seq: e.seq, time: e.time, title: `${who} ${VERB[e.type.slice(type.length + 1)]} a ${noun || type.replace(/-/g, " ")}`, record: e.subject || "" };
    })
    .sort((a, b) => b.seq - a.seq);
}
