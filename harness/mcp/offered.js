// @ts-check
// Which registry tools the MCP server offers. Person-only names stay out, except a surface tool
// the person approves with one tap (needsYou) or a surface read the screens already use.
import { PERSON_ONLY, HUMAN_ONLY } from "../../core/presence/index.js";

const DRIVES = /^(threads|agents)\./;

/**
 * @param {{ name: string, needsYou?: boolean, surface?: boolean }} t
 * @param {NodeJS.ProcessEnv} [env]
 */
export function offeredTool(t, env = process.env) {
  const agent = env.VYRE_AGENT;
  return !t.name.startsWith("harness.") && !HUMAN_ONLY.has(t.name)
    && (!PERSON_ONLY.has(t.name) || Boolean(t.needsYou) || Boolean(t.surface))
    && !(agent && env.VYRE_AGENT_KIND !== "assistant" && DRIVES.test(t.name));
}
