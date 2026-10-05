// @ts-check
// meter: how full a session's window is, for the warning a person's own terminal session gets. What a provider's transcript says about usage is read by that provider's adapter
// (core/sessions/drivers/); today the one adapter is Claude's.
export * from "../sessions/drivers/claude/usage.js";
