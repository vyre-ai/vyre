// @ts-check
// sessions: this machine's settings for the sessions Vyre starts (ADR 0030), with the defaults
// the user approved. `sessions` in config.json overrides any of them:
//
//   driver        "sdk" (the Claude Agent SDK; the default) or "cli" (core/switchboard/runner.js)
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

/**
 * What each kind of session runs on (the user's decision, 27 Sep): Opus for real work, a fast,
 * cheap model for quick answers and background jobs. `sessions.models` in config.json overrides a
 * purpose; sessions.models.set overrides a purpose or a project from a surface; an agent's own
 * model and a launch's explicit model win over both.
 */
export const DEFAULT_MODELS = { chat: "opus", agent: "opus", project: "opus", teammate: "opus", capsule: "haiku", job: "haiku", memory: "haiku", planner: "haiku", learn: "haiku", helper: "haiku" };
export const PURPOSES = Object.keys(DEFAULT_MODELS);

/** The model for a purpose from config and the defaults. @param {any} config @param {string} purpose */
export function configModel(config, purpose) {
  const m = config && config.sessions && config.sessions.models;
  const v = m && typeof m[purpose] === "string" && m[purpose] ? m[purpose] : null;
  return v || /** @type {any} */ (DEFAULT_MODELS)[purpose] || DEFAULT_MODELS.chat;
}

/** The vault items the Claude credentials live in (as core/onboard stores them). */
export const CREDENTIALS = { "setup-token": "claude-setup-token", "api-key": "anthropic-api-key" };

/**
 * @param {any} config the loaded config (role, sessions)
 * @returns {{ driver: "sdk"|"cli", auth: "login"|"setup-token"|"api-key", claude: string, idle_minutes: number, start_timeout_s: number, max_live: number, install: boolean, dir: string|null,
 *   subreaper: boolean|string, spawner: "on"|"off", thread_socket: "auto"|"on"|"off", uid?: number, gid?: number }}
 */
export function sessionsConfig(config) {
  const box = !config || config.role !== "local";
  const s = (config && config.sessions) || {};
  const num = (v, d) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : d);
  const env = process.env.VYRE_SESSIONS_DRIVER;
  // The Agent SDK is the default (ADR 0030, flipped once the full suite passed on it); the CLI
  // runner stays as the fallback while the SDK is not installed yet, and by choice with "cli".
  const driver = env === "sdk" || env === "cli" ? env : s.driver === "cli" ? "cli" : "sdk";
  return {
    driver,
    auth: ["login", "setup-token", "api-key"].includes(s.auth) ? s.auth : box ? "setup-token" : "login",
    claude: typeof s.claude === "string" && s.claude ? s.claude : box ? "bundled" : "installed",
    idle_minutes: num(s.idle_minutes, 10),
    // a session whose agent says nothing within this long fails instead of sitting in "starting" (0 or absent: 90)
    start_timeout_s: num(s.start_timeout_s, 90),
    max_live: num(s.max_live, box ? 6 : 0),
    install: s.install !== false,
    dir: typeof s.dir === "string" && s.dir ? s.dir : process.env.VYRE_SESSIONS_SDK_DIR || null,
    // true or absent: tini where there is one (the box); false: none; a path: that one.
    subreaper: s.subreaper === false ? false : typeof s.subreaper === "string" ? s.subreaper : true,
    // "on": sessions start through the box's spawner as uid vyre-agent (ADR 0032 part 3), where
    // there is one (Linux, its socket there): on by default on a box now that each session has
    // its own socket to vyred (thread_socket); off on a Mac. VYRE_SESSIONS_SPAWNER wins.
    spawner: ["on", "off"].includes(String(process.env.VYRE_SESSIONS_SPAWNER)) ? String(process.env.VYRE_SESSIONS_SPAWNER) : s.spawner === "on" || s.spawner === "off" ? s.spawner : box ? "on" : "off",
    // One socket per session (ADR 0030 phase 3, option A; core/daemon/threadsock.js): "auto" opens
    // one when the session runs through the spawner (it cannot open vyred's own); "on" always;
    // "off" never. VYRE_SESSIONS_THREAD_SOCKET wins.
    thread_socket: ["auto", "on", "off"].includes(String(process.env.VYRE_SESSIONS_THREAD_SOCKET)) ? String(process.env.VYRE_SESSIONS_THREAD_SOCKET)
      : ["on", "off"].includes(s.thread_socket) ? s.thread_socket : "auto",
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

/** The plugin layout the skill library lays down (a provider fact, kept with the drivers). */
export { PLUGIN_LAYOUT } from "./drivers/plugin-layout.js";
