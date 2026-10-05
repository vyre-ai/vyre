// @ts-check
// Claude Code's hook protocol (the Claude adapter's part of core/sessions/drivers): what a hook is called with on stdin, and what it must print for Claude to act on it. The Harness hook
// (harness/hooks/hook.js) speaks only the neutral shapes below; a provider update that changes a hook shape changes this file and nothing else.

/** The hook events Vyre installs, by what each one is for. */
export const EVENTS = Object.freeze({ brief: "SessionStart", enrich: "UserPromptSubmit", rules: "PreToolUse", learn: "PostToolUse", fail: "PostToolUseFailure", stop: "Stop", end: "SessionEnd" });

/** @param {string} piece */
export const knows = piece => Object.prototype.hasOwnProperty.call(EVENTS, piece);

/**
 * What a hook was called with, as neutral fields: the session, the folder, the turn, the prompt, the transcript file, the tool call and how a stop or a failure came about. A field a later release drops
 * is simply absent.
 * @param {Record<string, any>} h the JSON the provider wrote to the hook's stdin
 */
export function hookIn(h) {
  const o = h && typeof h === "object" ? h : {};
  return {
    session: o.session_id, cwd: o.cwd, turn: o.prompt_id, source: o.source,
    prompt: String(o.prompt || ""), transcript: typeof o.transcript_path === "string" ? o.transcript_path : undefined,
    tool: { name: String(o.tool_name || ""), input: o.tool_input || {}, id: typeof o.tool_use_id === "string" ? o.tool_use_id : undefined },
    error: typeof o.error === "string" ? o.error : undefined, interrupted: o.is_interrupt === true,
    reason: typeof o.reason === "string" ? o.reason : undefined,
    lastText: typeof o.last_assistant_message === "string" ? o.last_assistant_message : undefined, stopActive: Boolean(o.stop_hook_active),
  };
}

/**
 * What the hook prints for this provider, or null for nothing. kind is the piece (brief, enrich, rules, stop); d is { context, notice, decision, reason }: context is text to add to what the model reads,
 * notice a line for the person (not the model), decision "allow" | "deny" | "ask" for a tool call, or "block" at a stop (the reason goes to the model, which continues).
 * @param {string} kind @param {{ context?: string, notice?: string, decision?: string, reason?: string }} d
 * @returns {string|null}
 */
export function hookOut(kind, d) {
  const hookEventName = /** @type {Record<string, string>} */ (EVENTS)[kind];
  if (kind === "brief") return d.context ? JSON.stringify({ hookSpecificOutput: { hookEventName, additionalContext: d.context } }) : null;
  if (kind === "enrich") return d.context || d.notice ? JSON.stringify({ ...(d.notice ? { systemMessage: d.notice } : {}), ...(d.context ? { hookSpecificOutput: { hookEventName, additionalContext: d.context } } : {}) }) : null;
  if (kind === "rules") return d.decision ? JSON.stringify({ hookSpecificOutput: { hookEventName, permissionDecision: d.decision, permissionDecisionReason: d.reason || "Vyre security floor" } }) : null;
  // Stop's answer is top level, not hookSpecificOutput.
  if (kind === "stop") return d.decision === "block" ? JSON.stringify({ decision: "block", reason: d.reason }) : null;
  return null;
}
