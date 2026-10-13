// @ts-check
// Invite someone to a team space that lives on this person's server, from the app that holds their name. The server holds no identity (the name's key is in this app), so its spaces tools cannot act for the
// person; the Space's own kernel on the server can, and this device is its owner's paired device. Each act is one remote kernel call (src/real/kernel-wire.js) that the home answers with a one-use challenge, which
// the person's key signs: grants.invites.create / confirm / revoke / list. The link is made here, from the space's verified record: its id and the version of its list it was made for, and the fingerprint of its root key.
import { resolveSpace, spaceFingerprint, fingerprintWords } from "./join-team.js";
import { sameWords, triesCounter, WORDS_REFUSED, TOO_MANY } from "../../../../lib/spaces/invite-words.js";
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
const tries = triesCounter();
/**
 * The Space's own four words are what the invitee reads out: check what the inviter typed against them, from the Space's record and root key (the four the join card shows). Wrong, empty or another Space's words
 * are refused in words and count against the invite (five spend it). Every path that confirms an invite goes through here first: the team's wire, the home's spaces tool and the phone's approval route. They show the
 * invitee is looking at this Space, not who the invitee is; the expected words are never shown to the inviter.
 * @param {InviteDeps & { words?: string[], resolveSpace?: typeof resolveSpace }} d @param {string} id @param {string} words @param {string} name the Space's label, to read its record
 */
export async function checkInviteWords(d, id, words, name) {
  if (tries.spent(String(id))) throw refuse("too_many_tries", TOO_MANY);
  const label = String(name || "").replace(/\.vyre\.run$/, "");
  const space = await (d.resolveSpace || resolveSpace)({ fetch: d.fetch, base: d.base, ...(d.now ? { now: d.now } : {}) }, label, null);
  const rootPublic = String(space.payload.rootPublic || "");
  const expected = rootPublic ? fingerprintWords(d.words, spaceFingerprint(space.id, rootPublic)) : null;
  if (!expected) throw refuse("unavailable", "This Space's words cannot be checked from here yet. Try again in a minute.");
  if (!sameWords(words, expected)) { tries.miss(String(id)); throw refuse("words_mismatch", WORDS_REFUSED); }
}
/** The invite was confirmed: its wrong-try count is cleared. @param {string} id */
export const inviteConfirmed = (id) => tries.clear(String(id));
/**
 * The inviter confirms the words the invitee reads to them (an admin or owner invite waits for this), on the team's own wire, after the words check out.
 * @param {InviteDeps & { words?: string[], resolveSpace?: typeof resolveSpace }} d @param {string} id @param {string} words @param {string} name
 */
export async function confirmTeamInvite(d, id, words, name) {
  await checkInviteWords(d, id, words, name);
  const done = await d.wire.call("grants.invites.confirm", [String(id), { words: String(words) }]);
  inviteConfirmed(id);
  return done;
}
/** Cancel an invite so its link stops working. @param {InviteDeps} d @param {string} id */
export const revokeTeamInvite = (d, id) => d.wire.call("grants.invites.revoke", [String(id)]);
