// @ts-check
// The Claude Agent SDK, installed on first use (ADR 0030).
//
// It is NOT an npm dependency of vyre, for the same reason the search model is not
// (core/recall/embed.js): the SDK bundles its own Claude Code, a native binary of about 230 MB,
// as a platform-specific optional dependency, and `npm i -g vyre` must stay a few MB. The SDK
// goes into <VYRE_HOME>/sessions-sdk instead, pinned. With `bundled` false (the Mac, which uses
// the Claude Code the person installed) the binary is left out and the SDK is about 25 MB.
//
// Until it is installed, Vyre-owned sessions run on the CLI runner (core/switchboard/runner.js),
// which speaks the same protocol, so nothing waits on a download.

import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { pathToFileURL } from "node:url";

export const PACKAGE = "@anthropic-ai/claude-agent-sdk";
/** Pinned: the SDK is pre-1.0 and changes weekly. A bump runs the switchboard suite on the SDK first. */
export const VERSION = "0.3.283";
/** Roughly what the install downloads, said to the person before it starts. */
export const DOWNLOAD_MB = { sdk: 25, bundled: 230 };

/** The SDK's entry file in `dir`, or null. */
function entry(/** @type {string} */ dir) {
  const pkg = path.join(dir, "node_modules", ...PACKAGE.split("/"), "package.json");
  try {
    const p = JSON.parse(fs.readFileSync(pkg, "utf8"));
    const main = (p.exports && p.exports["."] && (p.exports["."].default || p.exports["."].import)) || p.main || "sdk.mjs";
    const file = path.join(path.dirname(pkg), typeof main === "string" ? main : "sdk.mjs");
    return fs.existsSync(file) ? { file, version: String(p.version) } : null;
  } catch { return null; }
}

/** Is the pinned SDK installed in `dir`? And its bundled Claude Code, when `bundled`? */
export function installed(/** @type {string} */ dir, { bundled = false } = {}) {
  const e = entry(dir);
  if (!e || e.version !== VERSION) return false;
  return !bundled || Boolean(bundledBinary(dir));
}

/** The Claude Code binary the SDK bundles for this platform, when it was installed. */
export function bundledBinary(/** @type {string} */ dir) {
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  const plat = process.platform === "darwin" ? "darwin" : process.platform === "win32" ? "win32" : "linux";
  const names = [`${plat}-${arch}`, ...(plat === "linux" ? [`${plat}-${arch}-musl`] : [])];
  for (const n of names) {
    const bin = path.join(dir, "node_modules", "@anthropic-ai", `claude-agent-sdk-${n}`, plat === "win32" ? "claude.exe" : "claude");
    if (fs.existsSync(bin)) return bin;
  }
  return null;
}

/** npm next to this node when there is one (npm i -g vyre put it there), else the one on PATH. */
function npmBin() {
  const near = path.join(path.dirname(process.execPath), process.platform === "win32" ? "npm.cmd" : "npm");
  return fs.existsSync(near) ? near : "npm";
}

/** @type {Map<string, Promise<{ why?: string }>>} */
const installing = new Map();

/**
 * Install the pinned SDK into `dir`. Resolves to {} or { why }, never throws. One install at a
 * time per dir; a half-finished install is removed so the next try starts clean.
 * @param {string} dir @param {{ bundled?: boolean, npm?: string, timeout?: number }} [opts]
 */
export function install(dir, { bundled = false, npm = npmBin(), timeout = 15 * 60_000 } = {}) {
  const key = path.resolve(dir);
  const running = installing.get(key);
  if (running) return running;
  const p = (async () => {
    if (installed(dir, { bundled })) return {};
    fs.mkdirSync(dir, { recursive: true });
    const pkg = path.join(dir, "package.json");
    if (!fs.existsSync(pkg)) fs.writeFileSync(pkg, JSON.stringify({ name: "vyre-sessions-sdk", private: true, type: "module",
      description: "The Claude Agent SDK Vyre runs its sessions on, installed by vyre on first use." }, null, 2) + "\n");
    const args = ["install", "--no-audit", "--no-fund", "--omit=dev", "--no-package-lock", "--loglevel=error",
      ...(bundled ? [] : ["--omit=optional"]), `${PACKAGE}@${VERSION}`];
    const err = await new Promise(resolve => {
      execFile(npm, args, { cwd: dir, timeout, maxBuffer: 4 << 20, env: { ...process.env, npm_config_update_notifier: "false" } },
        e => resolve(e ? e.message : null));
    });
    if (err || !installed(dir, { bundled })) {
      if (!installed(dir)) fs.rmSync(path.join(dir, "node_modules"), { recursive: true, force: true });
      return { why: `the Claude Agent SDK did not install (${String(err || "npm installed nothing").slice(0, 160)})` };
    }
    return {};
  })().finally(() => installing.delete(key));
  installing.set(key, p);
  return p;
}

/** @type {Map<string, Promise<any>>} */
const loaded = new Map();

/**
 * The SDK module from `dir`, or null when it is not installed there. Loaded once per dir.
 * @param {string} dir
 */
export async function load(dir) {
  const e = entry(dir);
  if (!e || e.version !== VERSION) return null;
  let p = loaded.get(e.file);
  if (!p) { p = import(pathToFileURL(e.file).href).catch(() => null); loaded.set(e.file, p); }
  return p;
}
