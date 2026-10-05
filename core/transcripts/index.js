// @ts-check
// core/transcripts: the neutral door to a session's transcript. What a provider writes (Claude Code's .jsonl, its folders and line shapes) is read by that provider's adapter under core/sessions/drivers/;
// this file is where the rest of Vyre asks. Today the one adapter is Claude's.
export * from "../sessions/drivers/claude/transcripts.js";
