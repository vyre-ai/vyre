// @ts-check
// sessions: this machine's settings for the sessions Vyre starts (ADR 0030), with the defaults
// the user approved. `sessions` in config.json overrides any of them:
//
//   driver        "sdk" (the Claude Agent SDK) or "cli" (core/switchboard/runner.js)
//   auth          "login" (Claude Code's own sign-in on this machine), "setup-token" (the vault's
//                 claude-setup-token) or "api-key" (the vault's anthropic-api-key). The box
//                 defaults to the setup token, the Mac to the login. An API key in the vault is
//                 the fallback when the subscription's limit is reached.
//   claude        "bundled" (the Claude Code the SDK ships; the box), "installed" (the `claude`
//                 on PATH; the Mac, so owned and terminal sessions run the same version) or a path
//   idle_minutes  a session nobody is using is closed after this long, and resumed on the next
//                 message (0: never)
//   max_live      at most this many session processes at once (0: no cap; the box: 6)
//   install       install the SDK on first use (true)
//   subreaper     spawn sessions under `tini -s` (true: where it is installed; false; or a path)
//   uid, gid      run sessions as this user (the box's session user; set by the box image)
// VYRE_SESSIONS_DRIVER overrides `driver`, for a test run of the whole suite on either one.

import fs from "node:fs";
import path from "node:path";
import { bundledBinary } from "./sdk.js";

/** The vault items the Claude credentials live in (as core/onboard stores them). */
export const CREDENTIALS = { "setup-token": "claude-setup-token", "api-key": "anthropic-api-key" };

/**
 * @param {any} config the loaded config (role, sessions)
 * @returns {{ driver: "sdk"|"cli", auth: "login"|"setup-token"|"api-key", claude: string, idle_minutes: number, max_live: number, install: boolean, dir: string|null,
 *   subreaper: boolean|string, uid?: number, gid?: number }}
 */
export function sessionsConfig(config) {
  const box = !config || config.role !== "local";
  const s = (config && config.sessions) || {};
  const num = (v, d) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : d);
  const env = process.env.VYRE_SESSIONS_DRIVER;
  const driver = env === "sdk" || env === "cli" ? env : s.driver === "sdk" ? "sdk" : s.driver === "cli" ? "cli" : "cli";
  return {
    driver,
    auth: ["login", "setup-token", "api-key"].includes(s.auth) ? s.auth : box ? "setup-token" : "login",
    claude: typeof s.claude === "string" && s.claude ? s.claude : box ? "bundled" : "installed",
    idle_minutes: num(s.idle_minutes, 10),
    max_live: num(s.max_live, box ? 6 : 0),
    install: s.install !== false,
    dir: typeof s.dir === "string" && s.dir ? s.dir : process.env.VYRE_SESSIONS_SDK_DIR || null,
    // true or absent: tini where there is one (the box); false: none; a path: that one.
    subreaper: s.subreaper === false ? false : typeof s.subreaper === "string" ? s.subreaper : true,
    ...(typeof s.uid === "number" ? { uid: s.uid, ...(typeof s.gid === "number" ? { gid: s.gid } : {}) } : {}),
  };
}

/** Where the SDK is installed: <home>/sessions-sdk unless config or VYRE_SESSIONS_SDK_DIR says. */
export const sdkDir = (/** @type {string} */ root, /** @type {{ dir: string|null }} */ cfg) => cfg.dir || path.join(root, "sessions-sdk");

/** `claude` on PATH, as an absolute path, or null. */
function onPath() {
  for (const d of String(process.env.PATH || "").split(path.delimiter)) {
    const f = path.join(d, "claude");
    try { fs.accessSync(f, fs.constants.X_OK); return f; } catch {}
  }
  return null;
}

/**
 * The Claude Code the SDK runs: null for its bundled one, else a path. "bundled" with no bundled
 * binary installed falls back to the installed one.
 * @param {string} dir @param {{ claude: string }} cfg
 */
export function claudeBin(dir, cfg) {
  if (cfg.claude === "bundled") return bundledBinary(dir) ? null : onPath();
  if (cfg.claude === "installed") return onPath();
  return cfg.claude;
}
