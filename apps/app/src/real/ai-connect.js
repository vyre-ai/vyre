// @ts-check
// Connect an AI account (the owner's own, from their device): the home starts the provider's sign-in, the person finishes it in a browser and brings back a code, the home keeps the
// credential in the vault. Today the tool is onboard.claude (Claude's setup token or an API key); launch's final shapes will replace the names here and nothing else. Pure: no calls.

/** @typedef {"not_connected" | "blocked" | "waiting" | "connected" | "failed"} AiState */

/**
 * The state to show for Claude, from onboard.status's `claude` and what this screen is doing.
 * @param {{ state?: string, why?: string | null, signedIn?: boolean, via?: string | null, installed?: boolean } | null | undefined} claude
 * @param {{ waiting?: boolean, failed?: string }} [local]
 * @returns {{ state: AiState, line: string }}
 */
export function claudeState(claude, local = {}) {
  if (local.failed) return { state: "failed", line: local.failed };
  if (claude?.signedIn || claude?.state === "done") return { state: "connected", line: claude?.via === "api-key" ? "Connected with an API key" : "Connected with your Claude subscription" };
  if (local.waiting) return { state: "waiting", line: "Waiting for you to finish signing in in the browser." };
  if (claude?.state === "blocked") return { state: "blocked", line: claude.why || "Claude cannot be connected on this machine yet." };
  return { state: "not_connected", line: "Not connected. Your assistant has no AI account yet." };
}

/** Claude's part of onboard.status: data.detail.claude (launch 4c686d70c), or data.claude from an earlier box. @param {any} status */
export const claudeOf = (status) => status?.detail?.claude ?? status?.claude ?? null;

/** The input of onboard.claude for each move. */
export const startInput = () => ({ mode: "setup-token" });
/** @param {string} code */
export const codeInput = (code) => ({ mode: "setup-token", code: code.trim() });
/** @param {string} key */
export const keyInput = (key) => ({ mode: "api-key", key: key.trim() });

/** Is this a sign-in link the person may open? Only https, never anything else. @param {unknown} url */
export const safeLink = (url) => { try { const u = new URL(String(url)); return u.protocol === "https:" ? u.toString() : null; } catch { return null; } };

/** @param {string | undefined} code @param {string} message */
export function aiRefusal(code, message) {
  if (code === "not_allowed" || code === "denied") return "Only the owner connects an AI account.";
  if (code === "pair_first") return "Pair this server to your Vyre app first. Then connect an AI account.";
  if (code === "presence_required" || code === "needs_presence") return "That needs you. Approve on this device, then try again.";
  return message || "The AI account did not connect.";
}

/** What the assistant says while no account is connected, and where to connect one. */
export const NO_ACCOUNT_SAY = "I have no AI account yet. Connect one in Settings, AI accounts.";
