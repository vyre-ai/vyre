// @ts-check
// Invite someone on the real box: the pure half. What spaces.invites.create is sent, what its answer and the invites list say in words.

import { ROLES, assignable } from "../spaces/roles.js";

const DAY = 86_400_000;
/** How long a temp invite's access lasts once they join. */
export const TEMP_DAYS = [["7", "1 week"], ["30", "30 days"], ["90", "3 months"]];

/** The roles the person may invite as, with the box's one-line meaning. @param {string} role */
export const invitable = (role) => ROLES.filter((r) => assignable(/** @type {any} */ (role)).includes(r.id));

/** The input of spaces.invites.create. A temp invite ends: `days` from `now`. @param {{ space: string, role: string, to?: string, days?: number, now?: number }} o */
export function createInput(o) {
  const to = (o.to ?? "").trim().replace(/^@/, "");
  return { space: o.space, role: o.role, ...(to ? { to } : {}), ...(o.role === "temp" ? { expires: (o.now ?? Date.now()) + (o.days ?? 7) * DAY } : {}) };
}

/** What a made invite says: the link to send, how long it lasts, and whether the inviter must confirm words before it works. @param {any} r */
export function madeNote(r) {
  const until = Number(r?.valid_until);
  const when = until ? new Date(until).toLocaleDateString([], { day: "numeric", month: "short" }) : "";
  return { link: String(r?.link ?? ""), id: String(r?.id ?? ""), needsConfirm: r?.needs_confirm === true, line: when ? `Good until ${when}. The link works once for one person.` : "The link works once for one person." };
}

/** One row of spaces.invites.list as a line, whatever fields the box gives it (never the link). @param {any} i */
export function inviteRow(i) {
  const role = String(i?.role ?? "member");
  const until = Number(i?.valid_until ?? i?.expires);
  const status = String(i?.status ?? "open");
  return { id: String(i?.id ?? ""), title: `${role[0].toUpperCase()}${role.slice(1)} invite${i?.to_label ? ` for ${i.to_label}` : ""}`, sub: [status === "open" || status === "pending" ? "" : status, until ? `until ${new Date(until).toLocaleDateString([], { day: "numeric", month: "short" })}` : ""].filter(Boolean).join(" · "), open: status === "open" || status === "pending" || status === "waiting_confirm" || status === "needs_confirm" };
}

/** The words for a refused invite call. @param {string | undefined} code @param {string} message */
export function inviteRefusal(code, message) {
  if (code === "not_allowed" || code === "denied") return "Only an owner or admin can invite people to this space.";
  if (code === "presence_required") return "That needs you. Approve with Face ID or your fingerprint, then try again.";
  if (code === "not_found") return "That invite is already gone.";
  return message || "The invite did not go through.";
}
