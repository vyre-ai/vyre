// @ts-check
// The public address the gate serves this box on (or null) is told to every module that puts it in a link or a token. Each tool checks the caller itself (module:wink alone); one that is absent or
// refuses never stops the others.

/** Every tool that takes the public base, in the order they were added: share links, the Vault MCP passes, the outside agents' tokens. */
export const BASE_TOOLS = Object.freeze(["artifacts.public.base", "vault.mcp.base", "outside.mcp.base"]);

/** @param {(tool: string, input: any) => any} call @param {string | null} base */
export function tellIngressBase(call, base) {
  for (const tool of BASE_TOOLS) {
    try { Promise.resolve(call(tool, { base })).catch(() => {}); } catch { /* a module that is not there */ }
  }
}
