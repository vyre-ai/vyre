// @ts-check
// Where each harness reads a skill (R031-86), relative to the folder it works in or its home: a provider fact, so it lives with the drivers. lib/skill-adapters.js takes this table as an argument.
// Only what is known is listed; a harness not here gets a skill as instructions (render).

// `also` lists other project folders the harness is known to read (not used for placement; a sign that one shared folder could serve several harnesses later).
//   claude  Claude Code's own.
//   codex   VERIFIED against Codex CLI 0.159.3 (`codex debug prompt-input`, no model call): a project .codex/skills/<name>/SKILL.md and a project .agents/skills/<name>/SKILL.md are both listed to the model.
//   grok    FROM DOCS, NOT RUN (counts as verified only after a real run, which waits on an xAI login). DOCUMENTED (docs.x.ai/build/features/skills-plugins-marketplaces, page dated 11 Aug 2026): ./.grok/skills/ walked up to the repo root, ~/.grok/skills/, ~/.agents/skills/ (user level),
//           any enabled plugin's skills/, and extra [skills] paths in ~/.grok/config.toml; Claude Code's .claude/skills is read too. The layout <name>/SKILL.md matches a recorded real session
//           (core/sessions/testing/real/grok/00-handshake.ndjson: ~/.grok/bundled/skills/<name>/SKILL.md). Not yet confirmed by running the CLI: the Grok Build binary is not installed on the test box.
/** @type {Record<string, { dir: string, file: string, also?: string[] }>} */
export const SKILL_HOMES = Object.freeze({
  claude: { dir: ".claude/skills", file: "SKILL.md" },
  codex: { dir: ".codex/skills", file: "SKILL.md", also: [".agents/skills"] },
  grok: { dir: ".grok/skills", file: "SKILL.md", also: [".claude/skills"] },
});
