// @ts-check
// Where each harness reads a skill (R031-86), relative to the folder it works in or its home: a provider fact, so it lives with the drivers. lib/skill-adapters.js takes this table as an argument.
// Only what is known is listed; a harness not here gets a skill as instructions (render).

/** @type {Record<string, { dir: string, file: string }>} */
export const SKILL_HOMES = Object.freeze({
  claude: { dir: ".claude/skills", file: "SKILL.md" },
  codex: { dir: ".codex/skills", file: "SKILL.md" },
});
