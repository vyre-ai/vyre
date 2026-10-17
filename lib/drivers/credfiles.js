// @ts-check
// credfiles: names of files a coding agent keeps its sign-in in. They never leave the computer the session runs on: not into a checkpoint, not into the Space's store,
// where the server and its owner could read them. Claude Code keeps its own login and the OAuth tokens of the MCP servers a person signed in to in `.credentials.json`
// (and static MCP headers in `.claude.json`); Codex keeps its login in `auth.json`. No imports: the workspace reader (reader.js) runs this inside the session's sandbox.

const NAMES = new Set([".credentials.json", ".claude.json", "auth.json", ".oauth_token", ".api_key", ".session_ingress_token"]);

/** Whether a path in the agent's home folder is a credential file: by its last name, any case, with any backup or temp suffix (`.credentials.json.bak`, `.credentials.tmp-1`). @param {string} rel */
export function isCredentialFile(rel) {
  const name = String(rel).split(/[\\/]/).pop()?.toLowerCase() ?? "";
  if (NAMES.has(name)) return true;
  return name.startsWith(".credentials.") || /^\.claude\.json[.~-]/.test(name);
}
