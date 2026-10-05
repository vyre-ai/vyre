// @ts-check
// Planner, Tasks and the rest of the things that live in a space's Records need a Cloud space (the user's tier ruling, 5 Oct): a Basic personal space has no Twenty, so there is no store for them.
// The spaces module answers `spaces.tier` (internal) for a space: { tier: "basic" | "cloud", cloud: [{ id, name, label }] }, the Cloud spaces the person is in. This asks it, and when the space is Basic
// answers with a plain refusal that lists them, so the screen can offer one. A home with no spaces module, or one that does not answer, is not Basic: nothing is refused on a guess.
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
  const spaces = (Array.isArray(answer.cloud) ? answer.cloud : []).map((/** @type {any} */ s) => ({ id: String(s.id), name: s.name ?? null, label: s.label ?? null }));
  return Object.assign(new Error("Planner needs a Cloud space"), { code: "needs_cloud", detail: { tier: "basic", spaces } });
}

/** For tests: forget what was asked. */
export const forgetCloudGate = () => cache.clear();
