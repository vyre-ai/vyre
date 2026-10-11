// @ts-check
// A team member's own skills on the team's server (0.3.3 G03, the member session door): list, get, draft, approve and versions as a SERVICE of that remote server (`services.skills`, kernel/remote/wire.js
// CALLS.skills), the chat-service pattern. A member reaches the server only through the Space's kernel, never through a registry tool; every method is `(chain, input)` with the chain the home's own Surfaces
// door minted from what the transport proved: the person is the chain's one person hop, and the member's skill rights are the library's own rules, once:
//   - her personal skill is drafted for her and approved by her alone (library: a personal skill is approved by its person);
//   - a draft at the space, agent or project level stays a draft until that level's owner (or an admin) approves it, so approve refuses her there in the library's own words;
//   - list shows her the Space's approved skills, Vyre's own, and HER personal ones, never another person's personal skill (the owner's included);
//   - only `kind: "skill"`: a plugin can carry code that runs in sessions, so a member's plugin is refused with words (the owner or an admin adds it).
// The library of this build lives in the home Space; a second hosted Space has none to speak to, so it says so.

import { KernelError } from "../../kernel/core/errors.js";

/**
 * @param {{ space: string, kernel: any, library: any, entriesOf: (items: any[]) => any[], shown: (s: any) => any, vyreSkills: () => any[], homeSpace: () => string }} o
 */
export function createMemberSkills(o) {
  const who = (/** @type {any} */ chain) => {
    const h = chain && Array.isArray(chain.hops) ? chain.hops : [];
    if (chain?.space !== o.space || chain.viewer === true || chain.delegated === true || h.length !== 1 || !h[0].actor || h[0].actor.kind !== "person") throw new KernelError("not_found", "not found");
    return String(h[0].actor.id);
  };
  const isMember = (/** @type {string} */ person) => {
    try { const r = o.kernel?.gateway?.members?.roleOf({ kind: "person", id: person, space: o.space }); return typeof r === "string" && r !== ""; } catch { return false; }
  };
  const start = (/** @type {any} */ chain) => {
    const person = who(chain);
    if (!isMember(person)) throw new KernelError("not_found", "not found");
    if (o.space !== o.homeSpace()) throw new KernelError("not_allowed", "Skills for members are kept in this server's own Space; this Space has no skill library of its own. Ask the owner.");
    return person;
  };
  const clean = (/** @type {any} */ input) => (input && typeof input === "object" && !Array.isArray(input) ? { ...input } : {});
  const wrap = async (/** @type {() => Promise<any>} */ f) => {
    try { return await f(); }
    catch (e) {
      const code = /** @type {any} */ (e)?.code, msg = String(/** @type {any} */ (e)?.message || "that did not work");
      if (e instanceof KernelError) throw e;
      throw new KernelError(/** @type {any} */ (code === "not_allowed" || code === "denied" ? "not_allowed" : code === "not_found" ? "not_found" : "bad_input"), msg);
    }
  };
  /** What she may use: Vyre's own, the Space's approved skills and her own personal ones. @param {string} person */
  const usable = async (person) => {
    const items = await o.library.approved({ person, agent: null, projects: [], allAgents: false });
    const seen = new Set();
    return [...o.vyreSkills(), ...o.entriesOf(items)].filter(s => (seen.has(s.id) ? false : (seen.add(s.id), true)));
  };
  return Object.freeze({
    list: async (/** @type {any} */ chain, /** @type {any} */ input) => wrap(async () => { const p = start(chain), i = clean(input); const l = (await usable(p)).filter(s => !i.level || s.level === i.level); return { skills: l.slice(0, 200).map(o.shown), total: l.length }; }),
    get: async (/** @type {any} */ chain, /** @type {any} */ input) => wrap(async () => {
      const p = start(chain), id = String(clean(input).id || "");
      const s = (await usable(p)).find(x => x.id === id);
      if (!s) throw new KernelError("not_found", `No skill "${id.slice(0, 80)}" that you may use. skills.list shows the ones you may.`);
      return { ...o.shown(s), text: s.text };
    }),
    draft: async (/** @type {any} */ chain, /** @type {any} */ input) => wrap(async () => {
      start(chain);
      const i = clean(input);
      if (i.kind === "plugin") throw new KernelError("not_allowed", "A plugin can carry code that runs in sessions, so a member cannot add one. Ask the owner or an admin to add it.");
      return o.library.draft(chain, { name: i.name, level: i.level, scope: i.scope, kind: "skill", body: i.body, note: i.note });
    }),
    approve: async (/** @type {any} */ chain, /** @type {any} */ input) => wrap(async () => {
      start(chain);
      const i = clean(input);
      return o.library.approve(chain, { name: i.name, level: i.level, scope: i.scope, version: i.version });
    }),
    versions: async (/** @type {any} */ chain, /** @type {any} */ input) => wrap(async () => {
      const p = start(chain), i = clean(input);
      // only what she may know of: her own personal versions, and the Space's (a member's draft there is hers to follow)
      const all = await o.library.versions({ name: i.name, level: i.level, scope: i.scope, state: i.state });
      return { versions: all.filter((/** @type {any} */ v) => (v.level === "personal" && v.scope === p) || v.level === "space") };
    }),
  });
}
