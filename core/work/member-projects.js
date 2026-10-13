// @ts-check
// A team member starts her own projects on the team's server (0.3.3, the owner's rule: a member starts her own projects, blank or from an installed template). The operations behind the member door's `work` rows
// (core/work/member-tools.js MEMBER_TOOLS, served by work.serve / work.serve-write in core/work/index.js). The door has already taken the chain's one person hop and refused a non-member; these run under HER chain:
//   - the project record is made by her, in the team's Space, and she is its owner (the hub's ownerOf: the chain's first hop);
//   - a template is READ as the work module (the `project-template` record type is closed to members), but what it makes is made under her own chain;
//   - she picks a LIVE version of an INSTALLED template: a draft, a pinned version, a client record and a repository are not hers to name here (each row lists its input keys; any other key is refused in words);
//   - installing a library template, writing, testing or putting a template live stay the owner's and an admin's.

import { KernelError } from "../../kernel/core/errors.js";

/** How many live projects one member keeps of her own. */
export const MAX_LIVE = 50;

/** The keys each call takes; a key not here is refused with words (a member cannot name a template version, a client or a repository through the door). */
export const KEYS = Object.freeze({ "create-project": ["name", "slug"], "start-project": ["template", "name", "slug"], templates: [] });

/**
 * @param {{ cap?: number, liveOf: (person: string) => Promise<number>, templates: { list(chain: any, i?: any): Promise<any>, start(chain: any, i: any, o?: any): Promise<any> }, hub: () => any, reader: () => { service: any, read: any } }} o
 */
export function createMemberProjects(o) {
  const cap = o.cap ?? MAX_LIVE;
  /** A member keeps at most `cap` live projects of her own (each makes a Drive folder marker and an adopted row). @param {any} chain */
  const underCap = async (chain) => {
    const n = await o.liveOf(String(chain.hops[0].actor.id));
    if (n >= cap) throw new KernelError("not_allowed", `You already have ${cap} live projects here. Archive one you are done with, or ask the owner.`);
  };
  /** @param {string} call @param {any} input */
  const clean = (call, input) => {
    const i = input && typeof input === "object" && !Array.isArray(input) ? { ...input } : {};
    const allowed = /** @type {string[]} */ (/** @type {any} */ (KEYS)[call]);
    for (const k of Object.keys(i)) if (!allowed.includes(k)) throw new KernelError("bad_input", `${k} is not something a member names here; ${allowed.length ? `this takes ${allowed.join(", ")}` : "this takes nothing"}. Ask the owner or an admin if you need it.`);
    return i;
  };
  return Object.freeze({
    /** The installed templates she can start from: live ones only, by name (no body, no draft). */
    templates: async (/** @type {any} */ _chain, /** @type {any} */ input) => {
      clean("templates", input);
      const r = await o.templates.list(o.reader().read, {});
      return { templates: (r.templates || []).filter((/** @type {any} */ t) => t.live !== null).map((/** @type {any} */ t) => ({ template: t.template, name: t.name, live: t.live, tags: t.tags, ...(t.noun ? { noun: t.noun } : {}) })) };
    },
    "create-project": async (/** @type {any} */ chain, /** @type {any} */ input) => {
      const i = clean("create-project", input);
      await underCap(chain);
      const rec = await o.hub().createProject(chain, { name: i.name, slug: i.slug, markerBy: o.reader().service });
      return { project: rec.urn, slug: rec.data.slug, drive_path: rec.data.drive_path, memory_scope: rec.data.memory_scope };
    },
    "start-project": async (/** @type {any} */ chain, /** @type {any} */ input) => {
      const i = clean("start-project", input);
      await underCap(chain);
      return o.templates.start(chain, { template: i.template, name: i.name, slug: i.slug }, { read: o.reader().read, markerBy: o.reader().service });
    },
  });
}
