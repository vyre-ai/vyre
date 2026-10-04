// @ts-check
// Invite someone on the real box: the pure half. What spaces.invites.create is sent, what its answer and the invites list say in words.

import { ROLES, assignable } from "../spaces/roles.js";

const DAY = 86_400_000;
/** How long a temp invite's access lasts once they join. */
export const TEMP_DAYS = [["7", "1 week"], ["30", "30 days"], ["90", "3 months"]];

/** The roles the person may invite as, with the box's one-line meaning. @param {string} role */
export const invitable = (role) => ROLES.filter((r) => assignable(/** @type {any} */ (role)).includes(r.id));

/** The input of spaces.invites.create. A temp invite ends: `days` from `now`. @param {{ space: string, role: string, to?: string, anyone?: boolean, days?: number, now?: number }} o */
export function createInput(o) {
  const to = (o.to ?? "").trim().replace(/^@/, "");
  // A link anyone can use is a bearer: naming the person is the default, and "anyone with the link" has to be chosen (JL-2).
  if (!to && !o.anyone) throw new Error("name_required");
  return { space: o.space, role: o.role, ...(to ? { to } : {}), ...(o.role === "temp" ? { expires: (o.now ?? Date.now()) + (o.days ?? 7) * DAY } : {}) };
}

/** What a made invite says: the link to send, how long it lasts, and whether the inviter must confirm words before it works. @param {any} r */
export function madeNote(r) {
  const until = Number(r?.valid_until);
  const when = until ? new Date(until).toLocaleDateString([], { day: "numeric", month: "short" }) : "";
  return { code: typeof r?.code === "string" && r.code ? r.code : null, codeExpires: Number(r?.code_expires) || null, codeOffer: typeof r?.code_offer === "string" && r.code_offer ? r.code_offer : null, link: String(r?.link ?? ""), id: String(r?.id ?? ""), needsConfirm: r?.needs_confirm === true, line: when ? `Good until ${when}. The link works once for one person.` : "The link works once for one person." };
}

/**
 * "Email it": a mailto the person's own mail app opens (or the share sheet's text on a phone). Vyre sends nothing itself.
 * @param {string} space @param {string} link
 */
export function emailIt(space, link) {
  const subject = `Join ${space} on Vyre`;
  const body = `You are invited to ${space} on Vyre. Open this link on your phone to see who invited you and join:\n\n${link}`;
  return { subject, body, mailto: `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}` };
}

/** One row of spaces.invites.list as a line, whatever fields the box gives it (never the link). @param {any} i */
export function inviteRow(i) {
  const role = String(i?.role ?? "member");
  const until = Number(i?.valid_until ?? i?.expires);
  const status = String(i?.status ?? "open");
  const who = String(i?.joined_by_label ?? i?.accepted_by_label ?? i?.joined_by ?? "");
  const device = String(i?.joined_device ?? i?.device_label ?? "");
  return { who, device, id: String(i?.id ?? ""), title: `${role[0].toUpperCase()}${role.slice(1)} invite${i?.to_label ? ` for ${i.to_label}` : ""}`, sub: [status === "open" || status === "pending" ? "" : status, until ? `until ${new Date(until).toLocaleDateString([], { day: "numeric", month: "short" })}` : ""].filter(Boolean).join(" · "), open: status === "open" || status === "pending" || status === "waiting_confirm" || status === "needs_confirm" };
}

/** The words for a refused invite call. @param {string | undefined} code @param {string} message */
export function inviteRefusal(code, message, owner = "") {
  if (code === "not_allowed" || code === "denied") return "Only an owner or admin can invite people to this space.";
  if (code === "presence_required") return "That needs you. Approve on this device, then try again.";
  if (code === "not_found") return "That invite is already gone.";
  // A space that lives on one person's computer (windows, work/spaces): the inviter cannot make a link; an invitee cannot reach it.
  if (code === "this_computer") return "This space lives on this computer, so other people cannot join it. To invite people, make a space on your server.";
  if (code === "unreachable") return `This space lives on ${owner ? `${owner}'s` : "its owner's"} computer and cannot be reached from here. Ask them to invite you to a space on their server.`;
  return message || "The invite did not go through.";
}

/** The inviter's side after someone joins: who, and from which device. @param {{ who: string, device: string }} r */
export const joinedLine = (r) => (r.who ? `Joined by ${r.who}${r.device ? ` from ${r.device}` : ""}.` : "");

/** The live servers in wink.access (person surfaces): rows of kind "server" that are not removed. No row means the person has paired no server yet. @param {any} access */
export const liveServers = (access) => (Array.isArray(access?.devices) ? access.devices.filter((/** @type {any} */ d) => d && d.kind === "server" && !d.removed) : []);
