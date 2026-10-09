// @ts-check
// The tools an agent may use, from the manifests and tool definitions (the docs reference's harvest), cut the way harness/mcp/server.js cuts the registry for an "mcp" caller:
// no hook or internal tools, none of the person's own or human-only ones, and only those whose callers include mcp. Shared by the token budget and the find-quality tests.
import { harvest } from "../scripts/lib/docs/reference.js";
import { callerAllowed } from "../core/modules/index.js";
import { PERSON_ONLY, HUMAN_ONLY } from "../core/presence/index.js";
import { catalogOf } from "../harness/mcp/core-tools.js";

/** @returns {{ name: string, description: string, input: any }[]} */
export function agentTools() {
  const h = harvest();
  /** @type {Map<string, any>} */ const by = new Map();
  for (const role of /** @type {const} */ (["box", "local"])) for (const v of Object.values(/** @type {any} */ (h)[role])) for (const t of /** @type {any} */ (v).tools || []) if (!by.has(t.name)) by.set(t.name, t);
  return [...by.values()].filter((t) => !t.internal && !t.hook && !t.name.startsWith("harness.") && !PERSON_ONLY.has(t.name) && !HUMAN_ONLY.has(t.name) && callerAllowed(t.callers, "mcp", t.name))
    .map((t) => ({ name: t.name, description: String(t.description || ""), input: t.input }));
}

/** The catalog an agent has: module tools plus the memory aliases. */
export const agentCatalog = () => catalogOf(agentTools());
