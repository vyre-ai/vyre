// The AI providers Vyre drives, as one list a surface can read (FOUNDATION A5: one owner per fact). Pure data with no imports; lib/skill-library.js re-exports it.
export const AIS = Object.freeze(["claude", "codex", "grok"]);
// Key accounts are HTTP, not a CLI harness. OpenCode is one key; Go is a flag on that account, not a second id.
export const KEY_ACCOUNTS = Object.freeze(["openrouter", "openai-compatible", "opencode"]);
