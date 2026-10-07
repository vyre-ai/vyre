// @ts-check
// Claude Code on a computer (the plugin grant, core/pluginagent): the card that asks, the row that lets it ask again, and the row that takes its reach away. Pure: Node tests it.
// Reads pluginagent.status -> { granted, agent?, computer?, declined? } and pluginagent.pending -> [{ id, computer, asked_at }]. The words are ours, never the server's.

export const ALLOW = "Allow";
export const DONT_ALLOW = "Don't allow";
export const ASK_AGAIN = "Let Claude Code ask again";

/** @param {string} computer */
export const askTitle = (computer) => `Let Claude Code on ${computer} read your memory and your projects' sessions?`;
export const ASK_CAPTION = "It can read and suggest. It never acts as you. If you do nothing, this ends in 24 hours and Claude Code waits 7 days to ask again.";

/** What Access shows for Claude Code: the open asks, then at most one standing row. @param {any} status @param {any} pending */
export function pluginView(status, pending) {
  const asks = (Array.isArray(pending) ? pending : []).filter((/** @type {any} */ a) => a && a.id).map((/** @type {any} */ a) => ({ id: String(a.id), computer: String(a.computer || "this computer") }));
  /** @type {null | { kind: "granted", computer: string } | { kind: "declined" }} */
  let row = null;
  if (status && status.granted === true) row = { kind: "granted", computer: String(status.computer || "this computer") };
  else if (status && status.declined === true) row = { kind: "declined" };
  return { asks: status && status.granted === true ? [] : asks, row };
}

export const grantedLine = "Reads your memory and the chats of your projects. It suggests new memories and you approve them.";
export const declinedTitle = "Claude Code is not asking";
export const declinedLine = "It asks once more the next time it runs. You still approve it.";
export const removeLabel = "Remove Claude Code";

/** @param {string} computer */
export const allowedToast = (computer) => `Claude Code on ${computer} can read your memory and sessions.`;
export const declinedToast = "Claude Code will not ask again. You can let it ask again in Access.";
export const askAgainToast = "Claude Code can ask again.";
/** @param {string} computer */
export const removedToast = (computer) => `Claude Code on ${computer} no longer has access. It will not ask again until you let it.`;

/** The words for a refused Allow, Don't allow or Remove. @param {string | undefined} code */
export function pluginRefusal(code) {
  if (code === "expired") return "That ask ran out. Claude Code asks again on its own.";
  if (code === "conflict") return "Claude Code is already set up on this computer.";
  if (code === "not_found") return "That ask is no longer there.";
  if (code === "denied" || code === "not_allowed" || code === "forbidden") return "Only the owner can do this.";
  return "That did not work. Nothing was changed.";
}
