// @ts-check
// Where Claude Code keeps a session's transcript, so the rest of the product asks here and never spells the layout (test/provider-adapters.test.js): <projects folder>/<the folder's path with every
// character that is not a letter or digit made a dash>/<session id>.jsonl.
import path from "node:path";
import { findSession } from "../../switchboard/adopt.js";

/** @param {string} root the provider's projects folder @param {string} cwd the folder the session works in @param {string} session @returns {string} */
export const claudeTranscriptFile = (root, cwd, session) => path.join(root, String(cwd).replace(/[^A-Za-z0-9]/g, "-"), `${session}.jsonl`);

/**
 * Where a session's transcript is (the file that exists, wherever it sits) or will be (a new one under the first projects folder).
 * @param {string[]} folders the provider's projects folders @param {string} cwd @param {string} session @returns {{ file: string, root: string } | null}
 */
export function claudeTranscriptPlace(folders, cwd, session) {
  const known = findSession(folders, session);
  if (known) return { file: known.file, root: path.dirname(path.dirname(known.file)) };
  if (!folders[0] || !cwd) return null;
  return { file: claudeTranscriptFile(folders[0], cwd, session), root: folders[0] };
}

/** Where the provider keeps a session's transcript INSIDE a runner's workspace (the agent's home is `<work>/home`), for the folder `cwd` the session sees. @param {string} work @param {string} cwd @param {string} session @returns {string} */
export const claudeWorkTranscript = (work, cwd, session) => claudeTranscriptFile(path.join(work, "home", ".claude", "projects"), cwd, session);
