// @ts-check
// The docker-api bearer: a secret only vyred and docker-api can read, so a session sharing
// vyred's container (and so its network) cannot reach docker-api by being on the same network
// alone. Never in either process's Env (docker inspect on the vyre container, or a compromised
// session's own environment, would hand it straight over) -- a file, mode 0400, owned by
// whichever uid the two processes share.
//
// vyred owns generation (ensure, below): it is the side a person can restart safely if the file
// is ever lost. docker-api only reads (watch, below), and reads the file again when a request's
// bearer does not match what it holds, so the order the two containers start in never matters
// and a new file is picked up without restarting anything.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const BYTES = 32; // 64 hex chars, well over proxy.js's own 16-char minimum

/**
 * The bearer at `file`, generating one if it is not there yet. Not safe to call from two
 * processes at once (only vyred ever does): a plain write, not a lock, is enough for a file one
 * side owns and the other only reads.
 * @param {string} file
 */
export function ensure(file) {
  try {
    const existing = fs.readFileSync(file, "utf8").trim();
    if (existing) return existing;
  } catch (e) { if (/** @type {any} */ (e).code !== "ENOENT") throw e; }
  const token = crypto.randomBytes(BYTES).toString("hex");
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  // 0400 (owner read-only) is set after the write too: mkdir/open honour umask, and a looser
  // mode written first is still briefly on disk otherwise.
  fs.writeFileSync(file, token, { mode: 0o400 });
  fs.chmodSync(file, 0o400);
  return token;
}

/** A bearer shorter than this is no bearer (the proxy's own floor). */
export const MIN_LENGTH = 16;

/**
 * The bearer at `file` as it is now, for a reader that must never need a restart to see it: docker-api starts before vyred has written the
 * file on a fresh box, and vyred makes a new one if the file is ever lost. `current()` is the token last read (reading once if none was);
 * `refresh()` reads the file again, at most once every `minGapMs`, so a caller with a wrong bearer cannot make the proxy read the disk on
 * every request. Either answers null while there is no usable token.
 * @param {string} file
 * @param {{ minGapMs?: number, now?: () => number }} [o]
 * @returns {{ current(): string | null, refresh(): string | null }}
 */
export function watch(file, { minGapMs = 1000, now = Date.now } = {}) {
  /** @type {string | null} */
  let token = null;
  let lastRead = -Infinity;
  const load = () => {
    lastRead = now();
    try {
      const t = fs.readFileSync(file, "utf8").trim();
      token = t.length >= MIN_LENGTH ? t : null;
    } catch (e) {
      if (/** @type {any} */ (e).code !== "ENOENT") throw e;
      token = null;
    }
    return token;
  };
  const refresh = () => (now() - lastRead >= minGapMs ? load() : token);
  return { current: () => token ?? refresh(), refresh };
}

/**
 * Read the bearer docker-api's side did not generate, retrying while vyred has not written it
 * yet (a first-boot race between the two containers). Throws after `timeoutMs`, unless `patient`:
 * then, past the quick window, it keeps waiting at `slowStepMs` (a fresh install has no bearer
 * until the person sets computers up, and docker-api should sit quietly until then, not
 * crash-loop; once a minute is the light-by-default rate). `onWait` is told once when it slows.
 * @param {string} file
 * @param {{ timeoutMs?: number, stepMs?: number, patient?: boolean, slowStepMs?: number, onWait?: () => void }} [o]
 */
export async function read(file, { timeoutMs = 30_000, stepMs = 500, patient = false, slowStepMs = 60_000, onWait = () => {} } = {}) {
  const deadline = Date.now() + timeoutMs;
  let slow = false;
  for (;;) {
    try {
      const token = fs.readFileSync(file, "utf8").trim();
      if (token) return token;
    } catch (e) { if (/** @type {any} */ (e).code !== "ENOENT") throw e; }
    if (Date.now() >= deadline) {
      if (!patient) throw new Error(`${file}: no bearer after ${timeoutMs}ms -- has vyred started?`);
      if (!slow) { slow = true; onWait(); }
    }
    await new Promise(r => setTimeout(r, slow ? slowStepMs : stepMs));
  }
}
