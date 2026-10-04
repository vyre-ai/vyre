// @ts-check
// Connect an AI account (the owner's own, from their device): the home starts the provider's sign-in, the person finishes it in a browser and brings back a code, the home keeps the
// credential in the vault. Today the tool is onboard.claude (Claude's setup token or an API key); launch's final shapes will replace the names here and nothing else. Pure: no calls.

/** @typedef {"not_connected" | "blocked" | "waiting" | "connected" | "failed" | "pair_first" | "on_phone"} AiState */

/**
 * The state to show for Claude, from onboard.status's `claude` and what this screen is doing.
 * @param {{ state?: string, why?: string | null, signedIn?: boolean, via?: string | null, installed?: boolean } | null | undefined} claude
 * @param {{ waiting?: boolean, failed?: string, pairFirst?: boolean, onPhone?: boolean }} [local]
 * @returns {{ state: AiState, line: string }}
 */
export function claudeState(claude, local = {}) {
  const connected = Boolean(claude?.signedIn || claude?.state === "done");
  // Not connected yet: a server with no owner says to pair first (no sign-in button, no error after a tap); a browser cannot give the owner's presence, so it says to do it on the phone.
  if (!connected && local.pairFirst) return { state: "pair_first", line: "Pair this server to your Vyre app first. Then connect an AI account." };
  if (!connected && local.onPhone) return { state: "on_phone", line: "Connect it in Vyre on your phone." };
  if (local.failed) return { state: "failed", line: local.failed };
  if (claude?.signedIn || claude?.state === "done") return { state: "connected", line: claude?.via === "api-key" ? "Connected with your API key. Your assistants use it, up to the budget you set." : "Connected with your Claude subscription. Your assistants use it, up to the budget you set." };
  if (local.waiting) return { state: "waiting", line: "Waiting for you to finish signing in, in your browser. Paste the code it shows below." };
  if (claude?.state === "blocked") return { state: "blocked", line: claude.why || "Claude cannot be connected on your home yet." };
  return { state: "not_connected", line: "Your assistant has no AI account yet. Sign in to Claude to give it one." };
}

/** Claude's part of onboard.status: data.detail.claude (launch 4c686d70c), or data.claude from an earlier box. @param {any} status */
export const claudeOf = (status) => status?.detail?.claude ?? status?.claude ?? null;

/** The input of onboard.claude for each move. */
export const startInput = () => ({ mode: "setup-token" });
/** @param {string} code */
export const codeInput = (code) => ({ mode: "setup-token", code: code.trim() });
/** @param {string} key */
export const keyInput = (key) => ({ mode: "api-key", key: key.trim() });

/** Disconnect: removes the sign-in from the vault (person-only, with presence like connect). */
export const disconnectInput = () => ({ mode: "disconnect" });
export const DISCONNECT_NOTE = "Assistants on Claude stop and ask you. Your Claude account itself is not touched.";

/** Is this a sign-in link the person may open? Only https, never anything else. @param {unknown} url */
export const safeLink = (url) => { try { const u = new URL(String(url)); return u.protocol === "https:" ? u.toString() : null; } catch { return null; } };

/** @param {string | undefined} code @param {string} message */
export function aiRefusal(code, message) {
  if (code === "not_allowed" || code === "denied") return "Only the owner of this space connects an AI account. Ask them to do it.";
  if (code === "pair_first") return "Pair this server to your Vyre app first. Then connect an AI account.";
  if (code === "presence_required" || code === "needs_presence") return "That needs you. Approve on this device, then try again.";
  if (code === "expired" || code === "timeout") return "The sign-in ran out of time. Nothing was connected. Start over.";
  if (code === "bad_code" || code === "invalid_code") return "That code did not work. Copy it again from the Claude page and paste it here. Nothing was connected.";
  if (code === "offline") return "Your home did not answer, so nothing was saved. Try again.";
  return message || "Claude did not connect. Nothing was saved. Try again.";
}

/** What the assistant says while no account is connected, and where to connect one. */
export const NO_ACCOUNT_SAY = "I have no AI account yet. Connect one in Settings, AI accounts.";
