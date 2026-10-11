// @ts-check
// A team member's own skills (0.3.3 G03), the operations behind the member door's skills rows (core/work/member-tools.js MEMBER_TOOLS, served by skills.serve / skills.serve-write in core/skills/index.js). The door
// has already taken the chain's one person hop and refused a non-member; these run under that person and the library's own rules, once:
//   - her personal skill is drafted for her and approved by her alone (library: a personal skill is approved by its person);
//   - a draft at the space, agent or project level stays a draft until that level's owner (or an admin) approves it, so approve refuses her there in the library's own words;
//   - list shows her Vyre's own skills, the Space's approved skills and HER personal ones, never another person's personal skill (the owner's included);
//   - only `kind: "skill"`: a plugin can carry code that runs in sessions, so a member's plugin is refused with words (the owner or an admin adds it).
// The library of this build lives in the home Space; a second hosted Space has none to speak to, so it says so.

import { KernelError } from "../../kernel/core/errors.js";

/**
 * @param {{ library: any, entriesOf: (items: any[]) => any[], shown: (s: any) => any, vyreSkills: () => any[] }} o
 */
export function createMemberOps(o) {
  /** What she may use: Vyre's own, the Space's approved skills and her own personal ones. @param {string} person */
  const usable = async (person) => {
    const items = await o.library.approved({ person, agent: null, projects: [], allAgents: false });
    const seen = new Set();
    return [...o.vyreSkills(), ...o.entriesOf(items)].filter(s => (seen.has(s.id) ? false : (seen.add(s.id), true)));
  };
  const clean = (/** @type {any} */ input) => (input && typeof input === "object" && !Array.isArray(input) ? { ...input } : {});
  return Object.freeze({
    list: async (/** @type {string} */ p, /** @type {any} */ _chain, /** @type {any} */ input) => { const i = clean(input); const l = (await usable(p)).filter(s => !i.level || s.level === i.level); return { skills: l.slice(0, 200).map(o.shown), total: l.length }; },
    get: async (/** @type {string} */ p, /** @type {any} */ _chain, /** @type {any} */ input) => {
      const id = String(clean(input).id || "");
      const s = (await usable(p)).find(x => x.id === id);
      if (!s) throw new KernelError("not_found", `No skill "${id.slice(0, 80)}" that you may use. skills.list shows the ones you may.`);
      return { ...o.shown(s), text: s.text };
    },
    draft: async (/** @type {string} */ _p, /** @type {any} */ chain, /** @type {any} */ input) => {
      const i = clean(input);
      if (i.kind === "plugin") throw new KernelError("not_allowed", "A plugin can carry code that runs in sessions, so a member cannot add one. Ask the owner or an admin to add it.");
      return o.library.draft(chain, { name: i.name, level: i.level, scope: i.scope, kind: "skill", body: i.body, note: i.note });
    },
    approve: async (/** @type {string} */ _p, /** @type {any} */ chain, /** @type {any} */ input) => { const i = clean(input); return o.library.approve(chain, { name: i.name, level: i.level, scope: i.scope, version: i.version }); },
    versions: async (/** @type {string} */ p, /** @type {any} */ _chain, /** @type {any} */ input) => {
      const i = clean(input);
      // only what she may know of: her own personal versions, and the Space's (a member's draft there is hers to follow)
      const all = await o.library.versions({ name: i.name, level: i.level, scope: i.scope, state: i.state });
      return { versions: all.filter((/** @type {any} */ v) => (v.level === "personal" && v.scope === p) || v.level === "space") };
    },
  });
}
