// @ts-check
// Invite someone to a team space that lives on this person's server, from the app that holds their name. The server holds no identity (the name's key is in this app), so its spaces tools cannot act for the
// person; the Space's own kernel on the server can, and this device is its owner's paired device. Each act is one remote kernel call (src/real/kernel-wire.js) that the home answers with a one-use challenge, which
// the person's key signs: grants.invites.create / confirm / revoke / list. The link is made here, from the space's verified record: its id and the version of its list it was made for, and the fingerprint of its root key.
import { resolveSpace, spaceFingerprint } from "./join-team.js";
import { b64url } from "../../modules/vyre-signer/presence-proof.js";

const refuse = (/** @type {string} */ code, /** @type {string} */ message) => Object.assign(new Error(message), { code });
const DAY = 24 * 60 * 60 * 1000;
const enc = new TextEncoder();

/**
 * @typedef {{ call(call: string, args?: any[]): Promise<any> }} Wire
 * @typedef {{ wire: Wire, fetch: typeof fetch, base: string, now?: () => number }} InviteDeps
 */

/** A person's id from a name or an id, as the directory knows it. @param {InviteDeps} d @param {string} who */
async function personRef(d, who) {
  const t = String(who).trim().toLowerCase().replace(/\.vyre\.run$/, "");
  if (/^per_[a-z2-7]{26}$/.test(t)) return t;
  let res;
  try { res = await d.fetch(`${d.base.replace(/\/+$/, "")}/v1/ids/resolve?name=${encodeURIComponent(t)}`, { headers: { accept: "application/json" } }); } catch { throw refuse("unreachable", "Cannot reach the names directory right now."); }
  const json = /** @type {any} */ (await res.json().catch(() => null));
  if (!res.ok || !json || !json.data || json.data.kind !== "person" || typeof json.data.id !== "string") throw refuse("not_found", `Nobody is named ${t}.`);
  return json.data.id;
}

/**
 * Make an invite link. `space` is the id the home knows the space by, `name` its label (`harlow`).
 * @param {InviteDeps} d @param {{ space: string, name: string, role: string, scope?: string[], expires?: number, to?: string, ttlDays?: number }} i
 * @returns {Promise<{ id: string, link: string, token: string, needs_confirm: boolean, valid_until: number | null }>}
 */
export async function createTeamInvite(d, i) {
  const label = String(i.name).replace(/\.vyre\.run$/, "");
  const body = { role: i.role, ...(i.scope ? { scope: i.scope } : {}), ...(i.expires ? { expires: i.expires } : {}), ...(i.to ? { invitee: await personRef(d, i.to) } : {}), ...(i.ttlDays ? { valid_ms: Number(i.ttlDays) * DAY } : {}) };
  const rec = await d.wire.call("grants.invites.create", [body]);
  // What a link carries so the joiner starts pinned: the space's list as it stands now and the fingerprint of its root key.
  const space = await resolveSpace({ fetch: d.fetch, base: d.base, ...(d.now ? { now: d.now } : {}) }, label, null);
  const rootPublic = String(space.payload.rootPublic || "");
  if (!rootPublic) throw refuse("wrong_space", "The space's record has no root key, so no link was made.");
  const token = `${rec.id}.${b64url(enc.encode(JSON.stringify({ chain: space.pin, rk: spaceFingerprint(space.id, rootPublic) })))}`;
  return { id: rec.id, link: `https://${label}.vyre.run/join/${token}`, token, needs_confirm: rec.needs_confirm === true, valid_until: rec.valid_until ?? null };
}

/** The invites this person may see, as the home lists them (never a link or a hash). @param {InviteDeps} d */
export async function listTeamInvites(d) {
  const rows = await d.wire.call("grants.invites.list", []);
  return Array.isArray(rows) ? rows : [];
}
/** The inviter confirms the words the invitee reads to them (an admin or owner invite waits for this). @param {InviteDeps} d @param {string} id @param {string} words */
export const confirmTeamInvite = (d, id, words) => d.wire.call("grants.invites.confirm", [String(id), { words: String(words) }]);
/** Cancel an invite so its link stops working. @param {InviteDeps} d @param {string} id */
export const revokeTeamInvite = (d, id) => d.wire.call("grants.invites.revoke", [String(id)]);
