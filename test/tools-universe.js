// @ts-check
// The tools an agent may use, as the registry of a real in-process vyred lists them for a Vyre agent ("mcp:agent:kit"), cut the way harness/mcp/server.js cuts it: no hook or internal tools, none of the
// person's own or human-only ones. Shared by the token budget, the find-quality and the tools-text-names tests. (An earlier version estimated this from the manifests and counted about twice as many tools as
// an agent is really offered; the registry is the truth.)
import { harvest } from "../scripts/lib/docs/reference.js";
import { callerAllowed } from "../core/modules/index.js";
import { start } from "../core/daemon/index.js";
import { PERSON_ONLY, HUMAN_ONLY } from "../core/presence/index.js";
import { catalogOf } from "../harness/mcp/core-tools.js";
import { tempHome, present } from "./helpers.js";
import fs from "node:fs";
import path from "node:path";

process.env.VYRE_SEAL_DEV ??= "1";

/** @type {Promise<{ name: string, description: string, input: any }[]> | null} */ let cached = null;

/** @param {any} t a test context (for the temporary home) @returns {Promise<{ name: string, description: string, input: any }[]>} */
export function agentTools(t) {
  return (cached ||= (async () => {
    const root = fs.realpathSync(tempHome(t));
    fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ vault: { keystore: "file" }, recall: { every: 0, vectors: false } }));
    const d = await start({ root, log: () => {}, presence: present });
    try {
      return d.registry.listTools("mcp:agent:kit").filter((/** @type {any} */ x) => !x.name.startsWith("harness.") && !PERSON_ONLY.has(x.name) && !HUMAN_ONLY.has(x.name))
        .map((/** @type {any} */ x) => ({ name: x.name, description: String(x.description || ""), input: x.input }));
    } finally { await d.stop(); }
  })());
}

/** The catalog an agent has: module tools plus the memory aliases. @param {any} t */
export const agentCatalog = async (t) => catalogOf(await agentTools(t));

/**
 * Every tool name an agent could be told to call, from the manifests (the docs reference's harvest): deliberately broader than what the registry lists for an agent, so a text that names a tool an
 * agent happens not to be offered is still caught. Used only by tools-text-names.test.js, which needs no daemon.
 * @returns {ReturnType<typeof catalogOf>}
 */
export function broadCatalog() {
  const h = harvest();
  /** @type {Map<string, any>} */ const by = new Map();
  for (const role of /** @type {const} */ (["box", "local"])) for (const v of Object.values(/** @type {any} */ (h)[role])) for (const x of /** @type {any} */ (v).tools || []) if (!by.has(x.name)) by.set(x.name, x);
  return catalogOf([...by.values()].filter((x) => !x.internal && !x.hook && !x.name.startsWith("harness.") && !PERSON_ONLY.has(x.name) && !HUMAN_ONLY.has(x.name) && callerAllowed(x.callers, "mcp", x.name))
    .map((x) => ({ name: x.name, description: String(x.description || ""), input: x.input })));
}
