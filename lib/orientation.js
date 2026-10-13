// @ts-check
// orientation: the short, fixed block a Vyre session is told at its start, about the few things the CLIs do not know on their own. Claude Code reads CLAUDE.md and Codex reads AGENTS.md in the folder
// a session runs in, so a session in a project's folder (or an agent's) already gets its instructions natively; this teaches only WHERE the rest is and what comes first when they disagree.
//
// It is built from the session's facts and carries PATHS ONLY, never a file's contents, so it stays small and cannot go stale. Four cases:
//   a plain session in a project     { project }
//   an agent with no project         { agent }
//   an agent working in a project    { agent, project }
//   a plain chat with no project     {}  -> nothing extra (empty string)

/** @typedef {{ name: string, dir: string, instructions?: boolean, context?: boolean }} Place  a project (its folder); the two flags say whether its AGENTS.md / context/ exist (default: they do) */
/** @typedef {{ name: string, dir: string, instructions?: boolean, context?: boolean }} AgentPlace  an agent (its folder), the same flags */

/**
 * @param {{ project?: Place | null, agent?: AgentPlace | null, filesTool?: string }} f
 * @returns {string}
 */
export function orientation({ project, agent, filesTool = "the Vyre Files tools (files_*)" }) {
  if (!project && !agent) return "";
  const out = ["Vyre orientation (paths only; read the files, they are the truth):"];
  const says = (/** @type {Place} */ p, /** @type {string} */ whose) => [p.instructions === false ? "" : `${whose} instructions: ${p.dir}/AGENTS.md${whose === "The project's" ? " (CLAUDE.md is the same)" : ""}.`, p.context === false ? "" : `${whose === "Your" ? "Your" : "Its"} context: ${p.dir}/context/.`].filter(Boolean).join(" ");
  if (agent) out.push(`You are the agent "${agent.name}". ${says(agent, "Your")} Your own notes: ${agent.dir}/memory/.`.replace("  ", " "));
  if (project) out.push(`You are working in the project "${project.name}" (folder ${project.dir}). ${says(project, "The project's")}`.trimEnd());
  const anyContext = (agent && agent.context !== false) || (project && project.context !== false);
  if (anyContext) out.push(`In a context/ folder a .md file is a note, and a .link file holds a path in Vyre Files: open the place it names with ${filesTool}.`);
  out.push(agent && project
    ? "When they disagree: the person's message first, then your own instructions for how you work, then the project's instructions for the work itself, then the Space's defaults."
    : agent ? "When they disagree: the person's message first, then your instructions, then the Space's defaults."
    : "When they disagree: the person's message first, then the project's instructions, then the Space's defaults.");
  return out.join("\n");
}
