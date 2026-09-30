// @ts-check
// The words a person sees before approving a pending grant: the module, the item, the project it is
// scoped to (or every project) and the agent that asked. Names only, never a value.

/**
 * @param {{ name: string, module: string, watcher?: string, project?: string, by?: string }} g a pending grant as vault.pending lists it
 * @param {boolean} [moves] the item is in the password-protected vault and approving moves it out
 */
export function grantPrompt(g, moves = false) {
  const asker = /^mcp:agent:(.+)$/.exec(String(g.by || ""));
  const q = /** @param {string} n */ n => `"${String(n).replace(/"/g, "'")}"`;
  return `Let ${g.module}${g.watcher ? `/${g.watcher}` : ""} use ${q(g.name)}${g.project ? ` in project ${g.project}` : " in every project"}${asker ? `, asked by agent ${asker[1]}` : ""} while you are away${moves ? "; this moves it out of your password-protected vault" : ""}`;
}
