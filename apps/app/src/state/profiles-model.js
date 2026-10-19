// @ts-check
// A person's profile in a Space: their look there and a line or two about them, kept as a `member-profile` record in that Space (records/core-types.js MEMBER_PROFILE). Only the person writes their own
// (kernel/gateway/ownership.js); everyone in the Space reads it. Pure: turning the records into profiles, checking what a person typed, and the one write a save makes.

export const PROFILE_TYPE = "member-profile";
/** A look seed from the look picker (ui/chat/agent-look.js): shape, colour, then the character parts. */
export const LOOK = /^s[0-7]~c(?:1[0-5]|[0-9])(?:~[emtbh]\d)*$/;
export const ABOUT_MAX = 280;

/** @typedef {{ id: string, version: number, person: string, name: string, about: string, look: string, at: number }} Profile */

/**
 * The profiles in a records.list answer, one per person: where a person has two rows (two devices saved at once), the one saved last.
 * @param {any} answer @returns {Record<string, Profile>}
 */
export function profilesOf(answer) {
  const rows = Array.isArray(answer) ? answer : Array.isArray(answer?.rows) ? answer.rows : [];
  /** @type {Record<string, Profile>} */ const out = {};
  for (const r of rows) {
    const d = r && typeof r === "object" && r.data && typeof r.data === "object" ? r.data : null;
    const person = d && typeof d.person === "string" ? d.person.trim() : "";
    if (!person || typeof r.id !== "string" || r.deleted_at) continue;
    const p = { id: r.id, version: Number(r.version) || 0, person, name: typeof d.name === "string" ? d.name.trim().slice(0, 60) : "", about: typeof d.about === "string" ? d.about.trim().slice(0, ABOUT_MAX) : "", look: typeof d.look === "string" && LOOK.test(d.look) ? d.look : "", at: Number(r.updated_at) || 0 };
    if (!out[person] || out[person].at <= p.at) out[person] = p;
  }
  return out;
}

/** The person's profiles by name, lower case, for a face drawn with only a name (a chat message, a header). A name two people share is left out, so nobody is drawn as someone else. @param {Record<string, Profile>} byPerson */
export function looksByName(byPerson) {
  /** @type {Record<string, string>} */ const out = {};
  /** @type {Set<string>} */ const twice = new Set();
  for (const p of Object.values(byPerson)) {
    const k = p.name.toLowerCase();
    if (!k || !p.look) continue;
    if (k in out) twice.add(k); else out[k] = p.look;
  }
  for (const k of twice) delete out[k];
  return out;
}

/** What is wrong with an About me text, or "" when it is fine. @param {string} v */
export function aboutProblem(v) {
  const t = String(v ?? "");
  if (t.trim().length > ABOUT_MAX) return `Keep it to ${ABOUT_MAX} characters. It is ${t.trim().length} now.`;
  if (/[\u0000-\u0009\u000b-\u001f]/.test(t)) return "Take out the special characters.";
  return "";
}

/**
 * The one write a save makes: a new record when the person has none in this Space, else only the fields that changed (null when nothing did).
 * @param {Profile | null | undefined} cur @param {string} person @param {{ name?: string, about?: string, look?: string }} next @param {string} space
 * @returns {null | { tool: "records.create", input: { type: string, space: string, data: Record<string, string> } } | { tool: "records.update", input: { urn: string, patch: Record<string, string>, base_version: number } }}
 */
export function profileWrite(cur, person, next, space) {
  /** @type {Record<string, string>} */ const want = {};
  if (next.name !== undefined) want.name = String(next.name).trim().slice(0, 60);
  if (next.about !== undefined) want.about = String(next.about).trim().slice(0, ABOUT_MAX);
  if (next.look !== undefined) want.look = LOOK.test(String(next.look)) ? String(next.look) : "";
  if (!cur) return { tool: "records.create", input: { type: PROFILE_TYPE, space, data: { person, ...want } } };
  /** @type {Record<string, string>} */ const patch = {};
  for (const [k, v] of Object.entries(want)) if (/** @type {any} */ (cur)[k] !== v) patch[k] = v;
  if (!Object.keys(patch).length) return null;
  return { tool: "records.update", input: { urn: `vyre://${space}/${PROFILE_TYPE}/${cur.id}`, patch, base_version: cur.version } };
}
