// @ts-check
// style (docs/adr/0037-style.md): a house writing voice for every Vyre-owned session, main,
// teammate, subagent and job alike, injected next to team.project-append at session start.
//
// Reuses core/team's project-append shape rather than inventing a second injection mechanism:
// one tool composes a system-prompt string; a person-only setting turns it off. Unlike
// team.default, storage is not a table of our own: style.enabled and style.rules are ordinary
// core/settings declarations (account default, project override), so settings.get/settings.set
// already give a person on/off plus a free-text box, with no new code here for that half.
//
// Not this module's job: the em-dash display-side normaliser and the pattern list themselves
// live in lib/plain-prose.js (team-lead's call: a lib, not this module, so the Deck, the
// Capsule's web views and core can all import them with no module dependency). This module owns
// only the append text (style.append) and serves the pattern list over the wire for a caller
// that cannot import a file (style.patterns).

import { PATTERNS } from "../../lib/plain-prose.js";

/** A project slug, the same charset core/team and core/projects use. */
const SLUG = /^[a-z][a-z0-9-]{0,63}$/;
/** style.rules' own cap (team-lead: "cap the length"), well under core/settings' generic 4000-character string limit. */
const RULES_MAX = 500;

/**
 * The fixed house-voice block every session gets, in Vyre's own words (sourced from
 * stop-slop/SKILL.md, not copied from it), kept short since it rides every turn: about 150
 * words, and it follows its own rules (no em dash, no reflex triad). Never edited by a person;
 * their own addition is style.rules, appended separately and capped independently.
 */
export const HOUSE_VOICE = `Write in Vyre's house voice, in every reply, note and commit message you draft:
- Never use an em dash. Use a comma, a colon, or a period instead.
- Skip throat-clearing openers ("Here's the thing", "It turns out") and empty emphasis ("Let that sink in", "Full stop").
- Skip "It's not X, it's Y" framing. State Y directly.
- Don't reach for a three-item list out of reflex. Two items are often enough.
- Say "use" not "leverage", "explain" not "delve into": plain words over business ones.
- Don't open with agreement or praise ("You're absolutely right"). Answer the question.
- Don't close with an unrequested offer ("Let me know if you'd like..."). Stop when you're done.
- Don't restate the question, and don't summarise what you just did twice.
- Apologise once, if at all, then move on. State one qualification, not a stack of hedges.
Write plain, specific, active sentences that name who does what.`;

/** @type {{ start(ctx: any): Promise<{ stop(): Promise<void> }> }} */
export default {
  async start(ctx) {
    /** Tool results unwrapped; an error becomes a throw with its message. */
    const use = async (tool, input) => { const r = await ctx.call(tool, input); if (r.error) throw new Error(r.error.message); return r.data; };

    ctx.tool("style.append", {
      description: "The house-voice block a session should get in its system prompt, next to team.project-append (docs/adr/0037-style.md): the fixed rules plus the person's own free-text addition, or null when the person has turned style off for this project (or, with no override, for the account). {project?} -> {text}.",
      input: { type: "object", properties: { project: { type: "string" } } },
      // Same reasoning as team.project-append's reviewer LOW fix: no ownership check on the
      // project input, so only a person's own surface or sessions calling as itself ("module")
      // may reach it, never an arbitrary session or teammate scoped to a different project.
      callers: ["module", "cli", "local", "deck", "capsule"],
      run: async i => {
        const project = i.project == null ? undefined : String(i.project);
        if (project !== undefined && !SLUG.test(project)) throw Object.assign(new Error("project must be a project slug"), { code: "bad_input" });
        const [enabled, rules] = await Promise.all([
          use("settings.get", { key: "style.enabled", ...(project ? { project } : {}) }),
          use("settings.get", { key: "style.rules", ...(project ? { project } : {}) }),
        ]);
        if (enabled.value === false) return { project: project ?? null, text: null };
        const own = rules.value ? String(rules.value).trim() : "";
        return { project: project ?? null, text: own ? `${HOUSE_VOICE}\n\n${own}` : HOUSE_VOICE };
      },
    });

    ctx.tool("style.patterns", {
      description: "The banned-pattern list as data (id, label, a regex source and flags), for a surface's own lint (docs/adr/0037-style.md item 4) to match a finished message against, without re-implementing the list (lib/plain-prose.js's own copy). No callers restriction: this is a fixed list, not project data.",
      input: { type: "object", properties: {} },
      run: async () => ({ patterns: PATTERNS }),
    });

    ctx.tool("style.rules.check", {
      description: "core/settings' own check for style.rules (module.json's check.tool): only a length cap, since the type checker already refuses non-strings. Never called directly; settings.set/settings.write call it before a person's edit takes effect.",
      internal: true,
      input: { type: "object", required: ["key", "value"], properties: { key: { type: "string" }, value: {}, level: { type: "string" }, project: { type: "string" } } },
      run: async i => {
        const v = i.value == null ? "" : String(i.value);
        if (v.length > RULES_MAX) return { ok: false, message: `your own writing rules are capped at ${RULES_MAX} characters (this is ${v.length})` };
        return { ok: true };
      },
    });

    return { async stop() {} };
  },
};
