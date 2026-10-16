// @ts-check
// A team member's own skills (0.3.3 G03), the operations behind the member door's skills rows (core/work/member-tools.js MEMBER_TOOLS, served by skills.serve / skills.serve-write in core/skills/index.js). The door
// has already taken the chain's one person hop and refused a non-member; these run under that person and the library's own rules, once:
//   - her personal skill is drafted for her and approved by her alone (library: a personal skill is approved by its person);
//   - a draft at the space, agent or project level stays a draft until that level's owner (or an admin) approves it, so approve refuses her there in the library's own words;
//   - list shows her Vyre's own skills, the Space's approved skills and HER personal ones, never another person's personal skill (the owner's included);
//   - only `kind: "skill"`: a plugin can carry code that runs in sessions, so a member's plugin is refused with words (the owner or an admin adds it).
// The library of this build lives in the home Space; a second hosted Space has none to speak to, so it says so.

import { KernelError } from "../../kernel/core/errors.js";
import { LIMITS } from "../../lib/skill-library.js";

/** The most drafts waiting for a yes that one member may have across all levels: the owner's approval list is not hers to fill. */
export const MAX_PENDING_DRAFTS = 50;

/**
 * @param {{ library: any, entriesOf: (items: any[]) => any[], shown: (s: any) => any, vyreSkills: () => any[], browse?: (person: string, chain: any, input: any) => Promise<any> }} o
 */
export function createMemberOps(o) {
  /** What she may use: Vyre's own, the Space's approved skills and her own personal ones. @param {string} person */
  const usable = async (person) => {
    const items = await o.library.approved({ person, agent: null, projects: [], allAgents: false });
    const seen = new Set();
    return [...o.vyreSkills(), ...o.entriesOf(items)].filter(s => (seen.has(s.id) ? false : (seen.add(s.id), true)));
  };
  const clean = (/** @type {any} */ input) => (input && typeof input === "object" && !Array.isArray(input) ? { ...input } : {});
  /** @type {any} */
  const ops = {};
  ops.browse = async (/** @type {string} */ p, /** @type {any} */ chain, /** @type {any} */ input) => {
    if (!o.browse) throw new KernelError("unavailable", "the skill library is not wired on this server");
    const b = await o.browse(p, chain, clean(input));
    const allow = new Set((await usable(p)).map((/** @type {any} */ s) => s.id));
    return { ...b, skills: (b.skills || []).filter((/** @type {any} */ s) => allow.has(s.id)) };
  };
  ops.list = async (/** @type {string} */ p, /** @type {any} */ chain, /** @type {any} */ input) => {
      if (o.browse) {
        const b = await ops.browse(p, chain, input);
        const skills = (b.skills || []).map((/** @type {any} */ s) => o.shown(s));
        return { skills, total: skills.length, drafts: b.drafts, role: b.role };
      }
      const i = clean(input);
      const l = (await usable(p)).filter(s => !i.level || s.level === i.level);
      return { skills: l.slice(0, 200).map(o.shown), total: l.length };
  };
  ops.get = async (/** @type {string} */ p, /** @type {any} */ _chain, /** @type {any} */ input) => {
      const id = String(clean(input).id || "");
      const s = (await usable(p)).find(x => x.id === id);
      if (!s) throw new KernelError("not_found", `No skill "${id.slice(0, 80)}" that you may use. skills.list shows the ones you may.`);
      return { ...o.shown(s), text: s.text };
  };
  ops.draft = async (/** @type {string} */ p, /** @type {any} */ chain, /** @type {any} */ input) => {
      const i = clean(input);
      if (i.kind === "plugin") throw new KernelError("not_allowed", "A plugin can carry code that runs in sessions, so a member cannot add one. Ask the owner or an admin to add it.");
      if (typeof i.body === "string" && Buffer.byteLength(i.body) > LIMITS.body) throw new KernelError("bad_input", `A skill is at most ${Math.round(LIMITS.body / 1024)} KB. Make it shorter.`);
      // she drafts for herself or for the whole Space; an agent's or a project's skill only when that agent or project is hers (the owner's approval list is not hers to fill with names she does not own)
      if (i.level === "agent" || i.level === "project") {
        const owner = await o.library.ownerOfLevel(String(i.level), String(i.scope ?? ""));
        if (!owner || owner !== p) throw new KernelError("not_allowed", `Only the ${i.level}'s owner drafts a skill for it. Ask the owner, or draft a personal skill for yourself.`);
      }
      const mine = (await o.library.versions({ state: "draft" })).filter((/** @type {any} */ v) => v.proposer === `person:${p}`).length;
      if (mine >= MAX_PENDING_DRAFTS) throw new KernelError("too_many", `You have ${MAX_PENDING_DRAFTS} drafts waiting for a yes. Ask the owner to approve or clear some, then draft again.`);
      return o.library.draft(chain, { name: i.name, level: i.level, scope: i.scope, kind: "skill", body: i.body, note: i.note });
  };
  ops.approve = async (/** @type {string} */ _p, /** @type {any} */ chain, /** @type {any} */ input) => { const i = clean(input); return o.library.approve(chain, { name: i.name, level: i.level, scope: i.scope, version: i.version, ...(i.ack ? { ack: i.ack } : {}) }); };
  ops.decline = async (/** @type {string} */ _p, /** @type {any} */ chain, /** @type {any} */ input) => { const i = clean(input); return o.library.decline(chain, { name: i.name, level: i.level, scope: i.scope, version: i.version }); };
  ops.rollback = async (/** @type {string} */ _p, /** @type {any} */ chain, /** @type {any} */ input) => { const i = clean(input); return o.library.rollback(chain, { name: i.name, level: i.level, scope: i.scope, to: i.to, ...(i.ack ? { ack: i.ack } : {}) }); };
  ops.versions = async (/** @type {string} */ p, /** @type {any} */ _chain, /** @type {any} */ input) => {
      const i = clean(input);
      // only what she may know of: her own personal versions, and the Space's that are approved or retired; a draft is shown only to the person who proposed it (the owner and admins have their own approval queue)
      const all = await o.library.versions({ name: i.name, level: i.level, scope: i.scope, state: i.state });
      return { versions: all.filter((/** @type {any} */ v) => (v.level === "personal" && v.scope === p) || (v.level === "space" && (v.state !== "draft" || v.proposer === `person:${p}`))) };
  };
  return Object.freeze(ops);
}
