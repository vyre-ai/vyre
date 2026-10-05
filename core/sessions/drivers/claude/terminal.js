// @ts-check
// Claude Code in the person's own terminal (the Claude adapter's part): how a session is started with a given id, which transcript file is a session's own, where Claude keeps its transcripts, and how
// full its window is. `vyre roll` and the Harness ask these in neutral words; only this folder knows the flags and file names.
import path from "node:path";
import { claudeHome, transcriptFolders } from "../../../config/index.js";
import { meterOf, wantsMillion } from "./usage.js";

/** The command that starts a fresh session under a given id (shown to the person). @param {string} session */
export const startHint = session => `claude --session-id ${session}`;
/** The same, with the seed read from a file. @param {string} session @param {string} file */
export const startCommand = (session, file) => `${startHint(session)} "$(cat ${file})"`;
/** The arguments that start a session under a given id with a first message. @param {string} session @param {string} message */
export const startArgs = (session, message) => ["--session-id", session, message];

/** Whether this file is the transcript of that session (Claude names a transcript by its session id). @param {unknown} transcript @param {unknown} session */
export const isOwnTranscript = (transcript, session) => typeof transcript === "string" && transcript.endsWith(".jsonl") && path.basename(transcript, ".jsonl") === String(session);

/** The folders Claude keeps transcripts in, from the configured list. @param {any[]} configured @param {string} root */
export const transcriptRoots = (configured, root) => transcriptFolders(configured || [], root || "");

/** How full this session's window is, by its transcript: { used, window, share, model } or null. @param {string} transcript @param {string|undefined} root */
export const windowShare = (transcript, root) => meterOf(transcript, { million: wantsMillion(claudeHome(root)) });

/** Where Vyre keeps its own copy of a non-Claude thread's conversation, laid out the way Claude Code lays out a transcript so Recall reads it unchanged (goes when Recall reads every provider through the adapter). @param {string} root @param {string} cwd @param {string} name */
export const copyFile = (root, cwd, name) => path.join(root, "mirror", String(cwd || "").replace(/[^A-Za-z0-9]/g, "-"), `${name}.jsonl`);

/** The transcript file of a session by its id, under the configured folders, or null. */
export { findSession as findTranscript } from "../../../switchboard/adopt.js";
