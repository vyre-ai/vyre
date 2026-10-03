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

/** What a person calls each kind of item, in the words of a Touch ID prompt (never the internal kind name). */
const KIND_WORDS = /** @type {Record<string, string>} */ ({
  login: "login", authenticator: "login code", passkey: "passkey", card: "card", address: "address", identity: "ID", note: "note",
  "api-key": "key", pat: "key", oauth: "key", cloud: "key", "db-url": "database address", secret: "key", "env-set": "set of settings", "ssh-key": "key",
  cert: "certificate", "recovery-codes": "set of recovery codes", wifi: "Wi-Fi password", license: "license key", file: "file", "api-credential": "key", "provider-token": "sign-in token",
});
export const kindWord = /** @param {string} kind */ kind => KIND_WORDS[kind] || "item";

/** The prompt for saving an item: plain words, the person's vault. @param {{ name: string, kind?: string, replacing: boolean }} o */
export function putPrompt({ name, kind = "secret", replacing }) {
  const w = kindWord(kind), q = `"${String(name).replace(/"/g, "'")}"`;
  return replacing ? `Replace the ${w} ${q} in your vault` : `Add a${/^[aeiou]/i.test(w) ? "n" : ""} ${w} ${q} to your vault`;
}
