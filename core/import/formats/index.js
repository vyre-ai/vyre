// @ts-check
// import/formats: the readers for other coding agents' sessions. Each turns a session of its own
// format into Claude Code's JSONL shape, so scrub, sync, Recall and filing by folder work unchanged.
//
//   reader = { source, list(home), head(home, file, o) -> cwd|null, convert(home, file, o) -> { id, cwd, text, turns }, headBytes }
//
// A reader lists and opens only its allowlist of transcript-shaped files (never a credential file,
// never a symlink); where each agent keeps them is agentHomes().

import os from "node:os";
import path from "node:path";
import * as codex from "../../sessions/drivers/codex/import.js";
import * as gemini from "../../sessions/drivers/gemini/import.js";
import { isRealHome } from "../../config/dialogs.js";

/** @type {Record<string, typeof codex | typeof gemini>} keyed by the source kind a scan root carries */
export const FORMATS = { "codex": codex, "gemini-cli": gemini };
/** The reader for a scan root kind, or null (Claude Code's own layout needs none). @param {string} kind */
export const formatFor = kind => (Object.hasOwn(FORMATS, kind) ? FORMATS[kind] : null);

/**
 * Where each agent keeps its sessions for the Vyre home at `root`. The person's real folders
 * (CODEX_HOME or ~/.codex, ~/.gemini) only for their own ~/.vyre and never under node --test; any
 * other home (a dev world, a demo, a temp home) reads its own <root>/codex and <root>/gemini, the
 * same rule Claude Code's folder follows.
 * @param {string} root @param {NodeJS.ProcessEnv} [env]
 * @returns {{ path: string, kind: string }[]}
 */
export function agentHomes(root, env = process.env) {
  if (!root) return [];
  const real = isRealHome(root) && !env.NODE_TEST_CONTEXT;
  const tilde = (/** @type {string} */ p) => path.resolve(p.replace(/^~(?=$|\/)/, os.homedir()));
  return [
    { kind: "codex", path: env.VYRE_CODEX_HOME ? tilde(env.VYRE_CODEX_HOME) : real ? (env.CODEX_HOME ? tilde(env.CODEX_HOME) : path.join(os.homedir(), ".codex")) : path.join(path.resolve(root), "codex") },
    { kind: "gemini-cli", path: env.VYRE_GEMINI_HOME ? tilde(env.VYRE_GEMINI_HOME) : real ? path.join(os.homedir(), ".gemini") : path.join(path.resolve(root), "gemini") },
  ];
}
