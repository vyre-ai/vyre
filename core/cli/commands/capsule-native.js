// @ts-check
// The native Capsule (local/capsule/native, Swift, ADR 0017): built on this Mac the first time
// `vyre capsule` runs, and again whenever its source changes. No extra command, no Xcode project,
// no download: swiftc from the Command Line Tools, then a signature, then launch.
//
// The app is built into the Vyre home (<home>/capsule/Vyre.app), never into the npm package,
// which may be read-only and is replaced on every update. A stamp beside it records the hash of the
// source it was built from, so an edit to the source is never silently ignored by a stale build.
//
// Signing: with a code-signing identity named "Vyre Local" in the keychain, the app is signed
// with it, so macOS keeps Input Monitoring and Accessibility grants across rebuilds. Without one
// it is signed ad hoc (identifier sh.vyre.capsule), and macOS may ask again after a rebuild.
// `vyre capsule` offers to make that identity once, on the person's own install only (the real
// ~/.vyre, dialogs allowed, a terminal to ask on), after a plain y/N; never in a test or temp home.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { dialogsAllowed, isRealHome } from "../../config/dialogs.js";

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

/**
 * Is the built app there, and was it built from the source as it is now (and, when a signing
 * identity exists, signed with it)? @param {string} dir @param {string} app @param {string|null} [id]
 */
export function state(dir, app, id = null) {
  const bin = path.join(app, "Contents", "MacOS", "Vyre");
  if (!fs.existsSync(bin)) return { bin: null, fresh: false };
  let stamp = null;
  try { stamp = JSON.parse(fs.readFileSync(path.join(path.dirname(app), "stamp.json"), "utf8")); } catch {}
  const signedRight = !id || (stamp && stamp.signed === id);
  return { bin, fresh: Boolean(stamp) && stamp.source === nativeHash(dir) && signedRight };
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
  const id = identity(runner);
  const st = state(dir, app, id);
  if (st.bin && st.fresh) return { ok: true, bin: st.bin, app, built: false, message: "up to date" };
  const tc = toolchain(runner);
  if (!tc.ok) return { ok: false, bin: null, app, built: false, message: tc.message };
  say(st.bin ? "The Capsule changed: rebuilding it (under a minute)." : "Building the Capsule for this Mac (once, under a minute).");
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

// ------------------------------------------------------------------ the stable identity

export const IDENTITY_QUESTION = "macOS keeps the Capsule's permissions only if every build is signed the same way. " +
  "Create a local signing identity in your login keychain? macOS may ask for your password once.";
export const AD_HOC_NOTE = "Signed ad hoc: macOS may ask for the Capsule's permissions again after an update.";

/** Where the answer is kept, so the question is asked once. @param {string} home */
const answerFile = home => path.join(home, "capsule", "signing.json");

/**
 * Whether to ask: the person's own install (the real ~/.vyre), dialogs allowed, a terminal to
 * ask on, no identity yet, and not asked before.
 * @param {{home: string, env?: NodeJS.ProcessEnv, tty?: boolean, runner?: Runner, _gate?: {real: boolean, allowed: boolean}|null}} o
 */
export function shouldAsk({ home, env = process.env, tty = Boolean(process.stdin.isTTY), runner = run, _gate = null }) {
  // _gate: tests only, standing in for "this is the real ~/.vyre and dialogs are allowed".
  const own = _gate ? _gate.real : isRealHome(home), allowed = _gate ? _gate.allowed : dialogsAllowed(env);
  if (!own || !allowed || !tty) return false;
  if (fs.existsSync(answerFile(home))) return false;
  return identity(runner) === null;
}

/**
 * Make the self-signed "Vyre Local" code-signing identity in the login keychain: a key and a
 * certificate for code signing only (openssl), imported so codesign may use the key, then
 * trusted for code signing (the step macOS may ask the password for). The key never leaves the
 * keychain after this; the temp folder it was made in is removed whatever happens.
 * @param {{runner?: Runner, keychain?: string, tmp?: string}} [o]
 */
export function createIdentity({ runner = run, keychain = path.join(os.homedir(), "Library", "Keychains", "login.keychain-db"), tmp = os.tmpdir() } = {}) {
  const dir = fs.mkdtempSync(path.join(tmp, "vyre-sign-"));
  fs.chmodSync(dir, 0o700);
  const key = path.join(dir, "key.pem"), cert = path.join(dir, "cert.pem"), p12 = path.join(dir, "id.p12");
  const pass = crypto.randomBytes(18).toString("base64url");
  const steps = [
    ["/usr/bin/openssl", ["req", "-x509", "-newkey", "rsa:2048", "-sha256", "-days", "3650", "-nodes", "-keyout", key, "-out", cert,
      "-subj", `/CN=${IDENTITY}`, "-addext", "keyUsage=critical,digitalSignature", "-addext", "extendedKeyUsage=critical,codeSigning",
      "-addext", "basicConstraints=critical,CA:false"]],
    ["/usr/bin/openssl", ["pkcs12", "-export", "-inkey", key, "-in", cert, "-out", p12, "-name", IDENTITY, "-passout", `pass:${pass}`]],
    ["/usr/bin/security", ["import", p12, "-k", keychain, "-P", pass, "-T", "/usr/bin/codesign"]],
    ["/usr/bin/security", ["add-trusted-cert", "-r", "trustRoot", "-p", "codeSign", "-k", keychain, cert]],
  ];
  try {
    for (const [cmd, args] of steps) {
      const r = runner(cmd, args, { stdio: ["inherit", "pipe", "pipe"] });
      if (r.status !== 0) return { ok: false, message: `${path.basename(cmd)} ${args[0]} did not work: ${String(r.stderr || "").trim().split("\n")[0] || "exit " + r.status}` };
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return identity(runner) ? { ok: true, message: `made "${IDENTITY}" in your login keychain` } : { ok: false, message: `"${IDENTITY}" was made but codesign does not list it as valid` };
}

/**
 * Ask once and act on the answer. Returns the line to show, or null when nothing was asked.
 * @param {{home: string, ask: (q: string) => Promise<boolean|null>, env?: NodeJS.ProcessEnv, tty?: boolean, runner?: Runner, keychain?: string, tmp?: string, _gate?: {real: boolean, allowed: boolean}|null}} o
 */
export async function offerIdentity(o) {
  if (!shouldAsk(o)) return null;
  const yes = await o.ask(IDENTITY_QUESTION);
  if (yes === null) return null;
  fs.mkdirSync(path.dirname(answerFile(o.home)), { recursive: true });
  const made = yes ? createIdentity(o) : null;
  fs.writeFileSync(answerFile(o.home), JSON.stringify({ asked: new Date().toISOString(), answer: yes ? "yes" : "no", made: made ? made.ok : false }) + "\n");
  if (!yes) return AD_HOC_NOTE;
  return made && made.ok ? `Signing identity: ${made.message}.` : `${made ? made.message : ""}. ${AD_HOC_NOTE}`;
}
