// @ts-check
// The native Capsule (local/capsule/native, Swift, ADR 0015): built on this Mac the first time
// `vyre capsule` runs, and again whenever its source changes. No extra command, no Xcode project,
// no download: swiftc from the Command Line Tools, then a signature, then launch.
//
// The app is built into the Vyre home (<home>/capsule/Vyre.app), never into the npm package,
// which may be read-only and is replaced on every update. A stamp beside it records the hash of the
// source it was built from, the same guard `vyre capsule` keeps for the Electron package.
//
// Signing: with a code-signing identity named "Vyre Local" in the keychain, the app is signed
// with it, so macOS keeps Input Monitoring and Accessibility grants across rebuilds. Without one
// it is signed ad hoc (identifier sh.vyre.capsule), and macOS may ask again after a rebuild.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

export const IDENTITY = "Vyre Local";
export const BUNDLE_ID = "sh.vyre.capsule";

/** @typedef {(cmd: string, args: string[], opts?: object) => {status: number|null, stdout?: string, stderr?: string}} Runner */
/** @type {Runner} */
const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: "utf8", ...opts });

/** Where the native app is built for this home. @param {string} home */
export function appPath(home) { return path.join(home, "capsule", "Vyre.app"); }

/** A hash of the Swift sources and the build script. Tests and generated files are not part of it. @param {string} dir */
export function nativeHash(dir) {
  const h = crypto.createHash("sha256");
  const walk = (/** @type {string} */ d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else { h.update(path.relative(dir, p)); h.update(fs.readFileSync(p)); }
    }
  };
  for (const sub of ["Sources", "Resources"]) if (fs.existsSync(path.join(dir, sub))) walk(path.join(dir, sub));
  h.update(fs.readFileSync(path.join(dir, "build.sh")));
  return h.digest("hex").slice(0, 16);
}

/** Is the built app there, and was it built from the source as it is now? @param {string} dir @param {string} app */
export function state(dir, app) {
  const bin = path.join(app, "Contents", "MacOS", "Vyre");
  if (!fs.existsSync(bin)) return { bin: null, fresh: false };
  let stamp = null;
  try { stamp = JSON.parse(fs.readFileSync(path.join(path.dirname(app), "stamp.json"), "utf8")).source; } catch {}
  return { bin, fresh: stamp === nativeHash(dir) };
}

/** swiftc, or the one line that says how to get it. @param {Runner} [r] */
export function toolchain(r = run) {
  const s = r("xcrun", ["--find", "swiftc"]);
  if (s.status === 0 && String(s.stdout || "").trim()) return { ok: true, swiftc: String(s.stdout).trim() };
  return { ok: false, message: "The Capsule is built with Apple's Command Line Tools, which are not installed. Run: xcode-select --install" };
}

/** The stable signing identity if the keychain has one (read only, no prompt). @param {Runner} [r] */
export function identity(r = run) {
  const s = r("security", ["find-identity", "-v", "-p", "codesigning"]);
  return s.status === 0 && String(s.stdout || "").includes(`"${IDENTITY}"`) ? IDENTITY : null;
}

/**
 * Build the app when it is missing or older than its source. Returns {ok, bin, built, message}.
 * @param {{dir: string, home: string, runner?: Runner, say?: (s: string) => void}} o
 */
export function ensureBuilt({ dir, home, runner = run, say = () => {} }) {
  const app = appPath(home);
  const st = state(dir, app);
  if (st.bin && st.fresh) return { ok: true, bin: st.bin, app, built: false, message: "up to date" };
  const tc = toolchain(runner);
  if (!tc.ok) return { ok: false, bin: null, app, built: false, message: tc.message };
  const id = identity(runner);
  say(st.bin ? "The Capsule's source changed: rebuilding it (under a minute)." : "Building the Capsule for this Mac (once, under a minute).");
  const out = path.join(home, "capsule", "build");
  fs.mkdirSync(out, { recursive: true });
  const b = runner("sh", [path.join(dir, "build.sh"), "app"], {
    env: { ...process.env, VYRE_CAPSULE_BUILD: out, ...(id ? { VYRE_SIGN_IDENTITY: id } : {}) }, stdio: ["ignore", "pipe", "pipe"],
  });
  const made = path.join(out, "Vyre.app");
  if (b.status !== 0 || !fs.existsSync(path.join(made, "Contents", "MacOS", "Vyre"))) {
    const why = String(b.stderr || b.stdout || "").trim().split("\n").filter(l => /error:/.test(l)).slice(0, 3).join("\n") || `build.sh exited ${b.status}`;
    return { ok: false, bin: null, app, built: false, message: "The Capsule did not build:\n" + why };
  }
  const v = runner("codesign", ["--verify", "--strict", made]);
  if (v.status !== 0) return { ok: false, bin: null, app, built: false, message: "The Capsule built but its signature does not verify: " + String(v.stderr || "").trim() };
  // Swap in the new app whole, so a running Capsule's bundle is never half-written.
  fs.rmSync(app, { recursive: true, force: true });
  fs.renameSync(made, app);
  fs.writeFileSync(path.join(path.dirname(app), "stamp.json"), JSON.stringify({ source: nativeHash(dir), signed: id || "ad hoc", at: new Date().toISOString() }) + "\n");
  return { ok: true, bin: path.join(app, "Contents", "MacOS", "Vyre"), app, built: true, message: `built, signed ${id ? "as " + id : "ad hoc"}` };
}

/**
 * The `open` arguments that launch the app, or show it when it already runs (a second open is a
 * reopen, which the app answers by showing the Capsule).
 * @param {string} app @param {Record<string, string>} env
 */
export function launchArgs(app, env) {
  const args = [];
  for (const [k, v] of Object.entries(env)) args.push("--env", `${k}=${v}`);
  args.push(app);
  return args;
}
