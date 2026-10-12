// @ts-check
// A member's Skills screen: what the team's door serves for skills (core/work/member-tools.js skills.list / get / draft / approve; core/skills/member-ops.js): the Space's approved skills and Vyre's, and her own personal
// ones, never another person's; a draft at the Space's level waits for the owner or an admin, her personal one she approves herself. Nothing wider. Pure: SkillsScreen draws it.

const SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** skills.list's answer split by whose they are. @param {unknown} d @returns {{ mine: any[], space: any[], vyre: any[] }} */
export function skillsView(d) {
  const rows = /** @type {any[]} */ (d && typeof d === "object" && Array.isArray(/** @type {any} */ (d).skills) ? /** @type {any} */ (d).skills : []);
  const pick = (/** @type {string} */ level) => rows.filter((r) => r && r.level === level).map((r) => ({ id: String(r.id), name: String(r.name), level, description: String(r.description || "") }));
  return { mine: pick("personal"), space: pick("space"), vyre: pick("vyre") };
}

/** The SKILL.md a proposal is written as (name and description in its front matter). @param {{ name: string, description: string, instructions: string }} p */
export const bodyOf = (p) => `---\nname: ${p.name}\ndescription: ${p.description}\n---\n${p.instructions.trim()}\n`;

/** Is this proposal ready to send? The draft's input, or { error } in words. @param {{ name: string, description: string, instructions: string, level: "space" | "personal" }} p */
export function checkProposal(p) {
  const name = p.name.trim(), description = p.description.trim().replace(/\s+/g, " ");
  if (!SLUG.test(name)) return { error: "A skill's name is letters, numbers, dots, dashes and underscores (up to 64), starting with a letter or number, with no spaces. Rename it and try again." };
  if (!description) return { error: "Say in one line what the skill is for: an assistant reads that to decide when to use it." };
  if (!p.instructions.trim()) return { error: "Write the instructions: what an assistant should do when it uses this skill." };
  return { input: { name, level: p.level, kind: "skill", body: bodyOf({ name, description, instructions: p.instructions }) } };
}

/** What happens next, in words. @param {"space" | "personal"} level @param {string} name */
export const nextWords = (level, name) => level === "space"
  ? `Sent. A draft of ${name} waits for the owner or an admin to approve it. Nothing changes for the team until they do.`
  : `${name} is yours now. It is in your skills, and your assistant can use it in your own turns.`;

/** What the screen says above each list. */
export const SPACE_WORDS = "The team's skills: the ones its owner approved, and Vyre's own. You can propose one; the owner or an admin approves it.";
export const MINE_WORDS = "Your own skills. Only you and your assistant use them.";
