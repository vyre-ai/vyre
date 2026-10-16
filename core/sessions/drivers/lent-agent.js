// @ts-check
// Where each agent provider keeps state for lent sessions and server failover (Claude, Codex, Grok, and any registered process agent). One table so runner, switchboard and resume paths stay aligned.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { list as codexRollouts } from "../../import/formats/codex.js";
import { AGENTS } from "../../../lib/agent-sandbox.js";

/** Providers that run as a process on the lender (AGENTS table); in-process chat providers are never lent. */
export const LENT_PROCESS_PROVIDERS = Object.freeze(Object.keys(AGENTS));

/** @param {string | null | undefined} provider */
export function lentProcessProvider(provider) {
  const p = provider || "claude";
  return LENT_PROCESS_PROVIDERS.includes(p) ? p : null;
}

const slug = (/** @type {string} */ cwd) => String(cwd || "").replace(/[^A-Za-z0-9]/g, "-") || "-";
/** Grok session folders under `.grok/sessions/`: short paths use encodeURIComponent(cwd); long ones use a stable hash so mkdir never hits ENAMETOOLONG. */
export const grokCwdKey = (/** @type {string} */ cwd) => {
  const s = String(cwd || "/");
  const enc = encodeURIComponent(s);
  return enc.length <= 120 ? enc : `h-${crypto.createHash("sha256").update(s).digest("hex").slice(0, 32)}`;
};
/** Manifest path for a Grok session transcript under `agent/grok/`. @param {string} cwd @param {string} sessionId */
export const grokSessionRemote = (cwd, sessionId) => `agent/grok/sessions/${grokCwdKey(cwd)}/${sessionId}/vyre-resume.jsonl`;
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SESSION_LENT = /^[A-Za-z0-9_-]{1,100}$/;

/** Sync roots for a lent session checkpoint manifest (under the workspace mount). @param {string | null | undefined} provider */
export function syncRootsFor(provider) {
  const p = lentProcessProvider(provider) || "claude";
  if (p === "codex") return [{ dir: "home/.codex", remote: "agent/codex" }];
  if (p === "grok") return [{ dir: "home/.grok", remote: "agent/grok" }];
  return [{ dir: "home/.claude", remote: "agent/claude" }];
}

/** Default sync roots when provider is unknown (legacy). */
export const DEFAULT_SYNC_ROOTS = syncRootsFor("claude");

/**
 * Whether a manifest path under an agent remote may be restored into the workspace.
 * @param {string} provider
 * @param {string} rel path under agent/<provider>/
 */
export function restorableAgentRel(provider, rel) {
  const p = lentProcessProvider(provider) || "claude";
  if (p === "claude") return /^projects\/[^/]+\/[A-Za-z0-9_-]{1,100}\.jsonl$/.test(rel);
  if (p === "codex") return /^sessions\/\d{4}\/\d{2}\/\d{2}\/rollout-[A-Za-z0-9._:-]+\.jsonl$/.test(rel);
  if (p === "grok") return /^sessions\/[^/]+\/[^/]+\/vyre-resume\.jsonl$/.test(rel) || /^sessions\/[^/]+\/[^/]+\/.+\.jsonl$/.test(rel);
  return false;
}

/** Regex to find the provider's own session file in a checkpoint manifest (resume-lent). @param {string} provider @param {string} native @param {string} session */
export function manifestSessionFilePattern(provider, native, session) {
  const ids = [native, session].filter(x => typeof x === "string" && SESSION_LENT.test(x));
  const alt = ids.length ? ids.join("|") : "-";
  const p = lentProcessProvider(provider) || "claude";
  if (p === "codex") return new RegExp(`^agent/codex/sessions/\\d{4}/\\d{2}/\\d{2}/rollout-[A-Za-z0-9._:-]*(${alt})[A-Za-z0-9._:-]*\\.jsonl$`, "i");
  if (p === "grok") return new RegExp(`^agent/grok/sessions/[^/]+/(${alt})/[^/]+\\.jsonl$`, "i");
  return new RegExp(`^agent/claude/projects/[^/]+/(${alt})\\.jsonl$`);
}

/** Claude-style find under project folders. @param {string[]} folders @param {string} id */
export function findClaudeSession(folders, id) {
  if (!SESSION_ID.test(id)) return null;
  let best = null;
  for (const folder of folders) {
    let dirs = [];
    try { dirs = fs.readdirSync(folder, { withFileTypes: true }); } catch { continue; }
    for (const d of dirs) {
      if (!d.isDirectory()) continue;
      const file = path.join(folder, d.name, `${id}.jsonl`);
      let st;
      try { st = fs.statSync(file); } catch { continue; }
      if (!best || st.size > best.size) best = { file, mtime: Math.floor(st.mtimeMs), size: st.size };
    }
  }
  return best && { file: best.file, mtime: best.mtime };
}

/** @param {string} codexHome @param {string} id */
export function findCodexSession(codexHome, id) {
  if (!SESSION_ID.test(id)) return null;
  const want = id.toLowerCase();
  const hits = codexRollouts(codexHome).filter(x => x.id === want);
  if (!hits.length) return null;
  const best = hits.sort((a, b) => b.bytes - a.bytes)[0];
  return { file: best.file, mtime: Math.floor(best.mtime) };
}

/**
 * Where a provider transcript lives on the server (or will be written).
 * @param {{ provider: string, folders: string[], cwd: string, native: string, accountHome?: string | null }} q
 * @returns {{ file: string, root: string } | null}
 */
export function serverTranscriptPlace(q) {
  const p = lentProcessProvider(q.provider);
  if (!p) return null;
  const id = String(q.native || "");
  if (p === "claude") {
    const known = findClaudeSession(q.folders, id);
    if (known) return { file: known.file, root: path.dirname(path.dirname(known.file)) };
    if (!SESSION_ID.test(id) || !q.folders[0] || !q.cwd) return null;
    return { file: path.join(q.folders[0], slug(q.cwd), `${id}.jsonl`), root: q.folders[0] };
  }
  const home = q.accountHome;
  if (!home) return null;
  if (p === "codex") {
    const known = findCodexSession(home, id);
    if (known) return { file: known.file, root: path.join(home, "sessions") };
    if (!SESSION_ID.test(id)) return null;
    const d = new Date();
    const pad = (/** @type {number} */ n) => String(n).padStart(2, "0");
    const file = path.join(home, "sessions", String(d.getUTCFullYear()), pad(d.getUTCMonth() + 1), pad(d.getUTCDate()), `rollout-${Date.now()}-${id}.jsonl`);
    return { file, root: path.join(home, "sessions") };
  }
  if (p === "grok") {
    if (!SESSION_ID.test(id) || !q.cwd) return null;
    const dir = path.join(home, ".grok", "sessions", grokCwdKey(String(q.cwd)), id);
    return { file: path.join(dir, "vyre-resume.jsonl"), root: path.join(home, ".grok", "sessions") };
  }
  return null;
}

/** Transcript file inside a runner workspace (`<work>/home/...`). @param {string} provider @param {string} work @param {string} cwd @param {string} session */
export function workTranscriptPath(provider, work, cwd, session) {
  const p = lentProcessProvider(provider) || "claude";
  const home = path.join(work, "home");
  if (p === "codex") {
    const d = new Date();
    const pad = (/** @type {number} */ n) => String(n).padStart(2, "0");
    return path.join(home, ".codex", "sessions", String(d.getUTCFullYear()), pad(d.getUTCMonth() + 1), pad(d.getUTCDate()), `rollout-${Date.now()}-${session}.jsonl`);
  }
  if (p === "grok") return path.join(home, ".grok", "sessions", grokCwdKey(String(cwd || "/")), session, "vyre-resume.jsonl");
  return path.join(home, ".claude", "projects", slug(cwd), `${session}.jsonl`);
}
