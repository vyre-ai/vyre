// @ts-check
// credential-env: the environment variables a session's model key can ride in, in ONE place. The Switchboard (accountEnv) puts an account's key in the variable its provider's CLI reads, and spawn.js removes
// every one of them from an environment it must not carry onward (a terminal shell, the lender's copy, the sandbox spawner's copy). A new provider is added here and both follow; a variable named only in one
// place would be a key left in an environment.

/** The variable each provider's CLI reads for an account of that kind. */
export const ACCOUNT_ENV = /** @type {Readonly<Record<string, Readonly<Record<string, string>>>>} */ (Object.freeze({
  claude: Object.freeze({ "setup-token": "CLAUDE_CODE_OAUTH_TOKEN", "api-key": "ANTHROPIC_API_KEY" }),
  codex: Object.freeze({ "api-key": "OPENAI_API_KEY" }),
  grok: Object.freeze({ "api-key": "XAI_API_KEY" }),
  openrouter: Object.freeze({ "api-key": "OPENROUTER_API_KEY" }),
  "openai-compatible": Object.freeze({ "api-key": "OPENAI_COMPAT_API_KEY" }),
}));

/** Every variable that can hold a model key: the accounts' variables, and Claude Code's older name for an API key. (A variable that only NAMES a descriptor ends in FILE_DESCRIPTOR and is matched by suffix.) */
export const CREDENTIAL_VARS = Object.freeze([...new Set([...Object.values(ACCOUNT_ENV).flatMap(o => Object.values(o)), "CLAUDE_CODE_API_KEY"])]);
