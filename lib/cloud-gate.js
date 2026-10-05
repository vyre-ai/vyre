// @ts-check
// Planner, Tasks, reminders, notes and to-dos need somewhere to live (the user's tier ruling, option B of 5 Oct, 04:45Z): a Cloud space (Twenty), or a Personal space whose person is a member of any Cloud
// space (the items are kept encrypted to their own key on that team's server, the personal space's store). A person with no Cloud membership at all has neither, so they are refused.
// The spaces module answers `spaces.tier` (internal) for a space: { tier: "basic" | "cloud", cloud: [{ id, name, label }] }, the Cloud spaces the person is in. This asks it. Basic with at least one
// Cloud space is let through; Basic with none is refused in plain words, and a home with no spaces module, or one that does not answer, is not Basic: nothing is refused on a guess.
// The words: "Cloud", never "Pro" or "server".
const TTL_MS = 30_000;
/** @type {Map<string, { at: number, answer: any }>} */
const cache = new Map();

/**
 * The refusal for a Basic space, or null when the work may go ahead.
 * @param {{ call: (tool: string, input: any) => Promise<any> }} ctx @param {string | undefined} space the space the call acts in (the home's own when not named)
 * @returns {Promise<(Error & { code: string, detail: any }) | null>}
 */
export async function cloudGate(ctx, space) {
  const key = String(space || "");
  const hit = cache.get(key);
  let answer = hit && Date.now() - hit.at < TTL_MS ? hit.answer : undefined;
  if (answer === undefined) {
    try { const r = await ctx.call("spaces.tier", space ? { space } : {}); answer = r && !r.error && r.data && typeof r.data === "object" ? r.data : null; } catch { answer = null; }
    cache.set(key, { at: Date.now(), answer });
  }
  if (!answer || answer.tier !== "basic") return null;
  // The space being asked about does not count as a team of its own (a home that hosts its own kernel can list itself).
  const others = (Array.isArray(answer.cloud) ? answer.cloud : []).filter((/** @type {any} */ c) => c && c.id !== space);
  answer = { ...answer, cloud: others };
  // A Personal space with a team is let through: its Planner is kept encrypted on the team's server (the personal space's own store).
  if (Array.isArray(answer.cloud) && answer.cloud.length > 0) return null;
  const spaces = (Array.isArray(answer.cloud) ? answer.cloud : []).map((/** @type {any} */ s) => ({ id: String(s.id), name: s.name ?? null, label: s.label ?? null }));
  return Object.assign(new Error("Planner needs a Cloud space: join a team or set up My Cloud"), { code: "needs_cloud", detail: { tier: "basic", spaces } });
}

/**
 * The IANA zone the space keeps (spaces.tier answers `time_zone`), or null: none set, no spaces module, or a Personal space on a device. Reads what the gate last asked, asking once when it has not.
 * @param {{ call: (tool: string, input: any) => Promise<any> }} ctx @param {string | undefined} space
 * @returns {Promise<string | null>}
 */
export async function spaceZone(ctx, space) {
  const key = String(space || "");
  if (!cache.has(key)) await cloudGate(ctx, space);
  const a = cache.get(key);
  return a && a.answer && typeof a.answer.time_zone === "string" ? a.answer.time_zone : null;
}

/** For tests: forget what was asked. */
export const forgetCloudGate = () => cache.clear();
