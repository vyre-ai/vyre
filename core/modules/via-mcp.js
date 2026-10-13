// @ts-check
// via-mcp: the mark that says a call came in on a person's AI key and the daemon vouched the key (core/mcpconn). It is a symbol property, so JSON, an HTTP header and a plain object a caller builds cannot
// carry it; only the daemon's route calls `markViaMcp`, after `mcpconn.vouch`. The registry reads it with `isViaMcp`, strips any `viaMcp` a caller put in meta, and then sets the string `meta.viaMcp`
// (the key's id) itself, so every check downstream (the callers and presence gates, kernel/retrofit/gates.js, the import tools) reads a value only the daemon could have caused.
export const VIA_MCP = Symbol("vyre.viaMcp");
/** Set beside VIA_MCP when the vouched key is a hosted one (the public /mcp door): the registry then also holds the call to hostedKeyMay (core/modules/agent-reach.js). */
export const VIA_MCP_HOSTED = Symbol("vyre.viaMcpHosted");
/** @param {any} meta @returns {boolean} */
export const isViaMcp = meta => Boolean(meta && typeof meta === "object" && typeof meta[VIA_MCP] === "string" && meta[VIA_MCP]);
/** The daemon's route, after the key was vouched. @param {Record<string, any>} via @param {string} id */
export function markViaMcp(via, id, hosted = false) { via[VIA_MCP] = id; if (hosted) via[VIA_MCP_HOSTED] = true; return via; }
/** @param {any} meta @returns {boolean} */
export const isViaMcpHosted = meta => Boolean(meta && typeof meta === "object" && meta[VIA_MCP_HOSTED] === true);
/** The key's id on a marked call, else null. @param {any} meta @returns {string | null} */
export const viaMcpId = meta => (isViaMcp(meta) ? String(meta[VIA_MCP]) : null);
