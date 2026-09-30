// @ts-check
// migrate: the Mac pieces of the 0.1.1 -> 0.2 hop (team/0.2/PLAN.md R6, plans/capsule-pro.md
// "From 0.1.1"). launch's install line runs this, with the bundled node, as its very first step
// on a Mac. It does not itself install anything new: it only clears the way, so the 0.2 app's own
// install steps land clean.
//
// What 0.1.1 leaves on a Mac, and where (verified in this checkout):
//   - an ad hoc Capsule at <home>/capsule/Vyre.app, bundle id sh.vyre.capsule
//     (core/cli/commands/capsule-native.js appPath/BUNDLE_ID);
//   - the npm global `vyre` (docs/get-started/install.md: `npm install -g .../vyre.tgz`,
//     package.json "name": "vyre", bin.vyre);
//   - a local vyred with its own home (default ~/.vyre, or $VYRE_HOME): its pidfile at
//     <home>/vyred.pid, holding just the pid as text (core/daemon/index.js writeFileSync(p.pid,
//     String(process.pid))), and its socket at <home>/vyred.sock (core/config paths());
//   - the Capsule's presence key: a Secure Enclave handle in the login keychain (service
//     "sh.vyre.capsule.presence", local/capsule/native/Sources/Host/Presence.swift
//     KeychainKeyStore), enrolled as <home>/capsule/presence.json {id, publicKey}
//     (CapsulePresence.enroll/Enrolled);
//   - local state worth keeping: clipboard history at <home>/capsule/clips.json (ClipStore,
//     Sources/Providers/ClipStore.swift, wired in Sources/Agent/AgentWiring.swift), frecency at
//     <home>/capsule/frecency.json (Sources/Core/Frecency.swift, wired in Host/CapsuleModel.swift),
//     watched threads at <home>/capsule/watches.json (Sources/Vyred/Watches.swift, same wiring),
//     and snippets at <home>/capsule/snippets.json (Sources/Core/Snippets.swift; this one is a
//     hand-edited file the model only parses -- 0.1.1 never wired a default path into the running
//     Capsule, so this is the path its own test fixture uses, carried over on a best-effort basis:
//     copied if present, never invented if absent), and the general config at <home>/config.json
//     (core/config/index.js paths().config).
//
// detect() only reads. plan() only decides, from detect()'s report. apply() is the only place
// with a side effect, and every one goes through the deps object (fs, kill, spawnSync, now), so
// tests run against fakes in temp homes and never touch a real Mac, a real keychain or a real
// process. Idempotent: once the old home is renamed away, a second detect() on the same oldHome
// finds nothing there, plan() is empty, and apply() says so without touching anything.

import fs from "node:fs";
import path from "node:path";
import { spawnSync as nodeSpawnSync } from "node:child_process";

export const OLD_BUNDLE_ID = "sh.vyre.capsule";
export const NPM_PACKAGE = "vyre";

// ---------------------------------------------------------------- paths

/**
 * The files under one Vyre home that this hop cares about. Same shape for the old home (what it
 * reads) and the new one (what it writes into), because the layout does not change.
 * @param {string} home
 */
export function capsuleFiles(home) {
  const dir = path.join(home, "capsule");
  return {
    dir,
    app: path.join(dir, "Vyre.app"),
    presence: path.join(dir, "presence.json"),
    clips: path.join(dir, "clips.json"),
    frecency: path.join(dir, "frecency.json"),
    watches: path.join(dir, "watches.json"),
    snippets: path.join(dir, "snippets.json"),
  };
}

/** State files kept across the hop: {key, from, to} pairs, `key` naming what each one is. @param {string} home */
export function stateFiles(home) {
  const cap = capsuleFiles(home);
  return {
    clips: cap.clips,
    frecency: cap.frecency,
    watches: cap.watches,
    snippets: cap.snippets,
    config: path.join(home, "config.json"),
  };
}

/** Where the new node reads/writes the old key id it still needs to retire. @param {string} newHome */
export function markerFile(newHome) { return path.join(newHome, "capsule", "migrated-0.1.1.json"); }

const PID_FILE = home => path.join(home, "vyred.pid");

// ---------------------------------------------------------------- small, real-world defaults

/** Read a pidfile written as bare digits (core/daemon/index.js's own format). @param {any} f @param {string} file */
function readPid(f, file) {
  try {
    const n = Number(String(f.readFileSync(file, "utf8")).trim());
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch { return null; }
}

/**
 * Is `pid` alive, and (when we can tell) a vyre process -- never trust a bare pid alone, since a
 * pidfile can outlive the process and the number can be reused by something unrelated. Mirrors
 * core/daemon/lock.js's own check; kept as its own small copy rather than an import, so this
 * module stays a self-contained leaf with no cross-part edge to add to the boundary allowlist.
 * @param {number} pid
 */
export function pidLooksLikeVyre(pid) {
  try { process.kill(pid, 0); } catch (e) { if (/** @type {any} */ (e).code !== "EPERM") return false; }
  const r = nodeSpawnSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8", timeout: 2000 });
  const cmd = String(r.stdout || "").trim();
  return !cmd || /vyre/i.test(cmd);
}

/**
 * pids of processes whose full command line names this exact executable path -- the Capsule
 * inside its own bundle, never a broad name match. `pgrep -f` matches anywhere in the command
 * line, so each hit is checked again with `ps -o comm=` for that exact path before it is trusted.
 * @param {string} execPath
 */
export function pidsAtExactPath(execPath) {
  const g = nodeSpawnSync("pgrep", ["-f", execPath], { encoding: "utf8" });
  const pids = String(g.stdout || "").split("\n").map(s => Number(s.trim())).filter(n => Number.isInteger(n) && n > 0);
  return pids.filter(pid => {
    const r = nodeSpawnSync("ps", ["-p", String(pid), "-o", "comm="], { encoding: "utf8" });
    return String(r.stdout || "").trim() === execPath;
  });
}

/** The npm global `vyre` package's folder, or null. Real implementation; tests inject their own. */
export function npmGlobalVyrePath() {
  const r = nodeSpawnSync("npm", ["root", "-g"], { encoding: "utf8" });
  if (r.status !== 0) return null;
  const root = String(r.stdout || "").trim();
  if (!root) return null;
  const p = path.join(root, NPM_PACKAGE);
  try { return fs.existsSync(p) ? p : null; } catch { return null; }
}

// ---------------------------------------------------------------- detect

/**
 * A plain, JSON-safe report of what is on this Mac from 0.1.1, touching nothing. Every real-world
 * lookup is injectable so a test never shells out or reads a real home.
 * @param {{
 *   oldHome: string, newHome: string,
 *   fs?: Pick<typeof fs, "existsSync"|"readFileSync">,
 *   isAlive?: (pid: number) => boolean,
 *   findCapsulePids?: (execPath: string) => number[],
 *   npmGlobalVyre?: () => string|null,
 * }} o
 */
export function detect({ oldHome, newHome, fs: f = fs, isAlive = pidLooksLikeVyre, findCapsulePids = pidsAtExactPath, npmGlobalVyre = npmGlobalVyrePath }) {
  const exists = p => { try { return f.existsSync(p); } catch { return false; } };
  const readJSON = p => { try { return JSON.parse(String(f.readFileSync(p, "utf8"))); } catch { return null; } };

  const cap = capsuleFiles(oldHome);
  const capsuleBin = path.join(cap.app, "Contents", "MacOS", "Vyre");
  const appPresent = exists(capsuleBin);
  const capsulePids = appPresent ? findCapsulePids(capsuleBin) : [];

  const pidFile = PID_FILE(oldHome);
  const pid = exists(pidFile) ? readPid(f, pidFile) : null;

  const npmPath = npmGlobalVyre();

  const state = {};
  for (const [key, file] of Object.entries(stateFiles(oldHome))) state[key] = exists(file) ? file : null;

  return {
    oldHome, newHome,
    homePresent: exists(oldHome) || exists(cap.dir) || exists(pidFile),
    app: { present: appPresent, path: cap.app, bin: capsuleBin, pids: capsulePids },
    vyred: { present: exists(pidFile), path: pidFile, pid, alive: pid != null && isAlive(pid) },
    presence: { present: exists(cap.presence), path: cap.presence, enrolled: exists(cap.presence) ? readJSON(cap.presence) : null },
    npm: { present: Boolean(npmPath), path: npmPath },
    state,
  };
}

// ---------------------------------------------------------------- plan

/**
 * The ordered steps a detect() report calls for. Nothing here is executed; apply() is. Order
 * matters: stop running things before anything is moved or removed, copy state before the old
 * home is renamed away, rename before the app inside it is deleted (the app is removed from
 * inside the renamed backup folder, not from the live path), and npm last.
 * @param {ReturnType<typeof detect>} report
 */
export function plan(report) {
  /** @type {Array<{id: string, [k: string]: any}>} */
  const steps = [];
  if (!report.homePresent && !report.npm.present) return { steps };

  if (report.vyred.alive) steps.push({ id: "stop-vyred", pid: report.vyred.pid });
  if (report.app.pids.length) steps.push({ id: "stop-capsule", pids: report.app.pids });

  const toCopy = Object.entries(report.state).filter(([, from]) => from);
  if (toCopy.length) steps.push({ id: "copy-state", files: toCopy.map(([key, from]) => ({ key, from })) });

  if (report.presence.present && report.presence.enrolled && report.presence.enrolled.id) {
    steps.push({ id: "write-old-key-marker", oldKeyId: report.presence.enrolled.id, oldPublicKey: report.presence.enrolled.publicKey || null });
  }

  if (report.homePresent && report.oldHome !== report.newHome) steps.push({ id: "rename-old-home" });
  if (report.app.present) steps.push({ id: "remove-old-app" });
  if (report.npm.present) steps.push({ id: "npm-uninstall-global", path: report.npm.path });

  return { steps };
}

// ---------------------------------------------------------------- apply

/**
 * Run a plan's steps in order. Every side effect goes through `deps`, so a test's fakes see and
 * control every one of them. A failed step stops the run (later steps assume earlier ones landed)
 * but never throws: the caller gets back what happened and can decide what to tell the person.
 * @param {ReturnType<typeof plan>} p
 * @param {{
 *   oldHome: string, newHome: string,
 *   fs?: Pick<typeof fs, "existsSync"|"readFileSync"|"writeFileSync"|"mkdirSync"|"copyFileSync"|"renameSync"|"rmSync">,
 *   kill?: (pid: number, signal: NodeJS.Signals) => void,
 *   spawnSync?: typeof nodeSpawnSync,
 *   now?: () => string,
 *   waitForExit?: (pids: number[]) => Promise<void>,
 * }} deps
 */
export async function apply(p, deps) {
  const { oldHome, newHome } = deps;
  const f = deps.fs || fs;
  const kill = deps.kill || ((pid, sig) => process.kill(pid, sig));
  const spawn = deps.spawnSync || nodeSpawnSync;
  const now = deps.now || (() => new Date().toISOString());
  const waitForExit = deps.waitForExit || defaultWaitForExit;

  const done = [];
  let ok = true;
  let removedKeyId = null;

  const record = async (id, fn) => {
    if (!ok) { done.push({ id, ok: false, skipped: true }); return; }
    try { const detail = await fn(); done.push({ id, ok: true, detail: detail === undefined ? null : detail }); }
    catch (e) { ok = false; done.push({ id, ok: false, error: String(e && e.message || e) }); }
  };

  for (const step of p.steps) {
    if (step.id === "stop-vyred") {
      await record("stop-vyred", async () => {
        try { kill(step.pid, "SIGTERM"); } catch (e) { if (/** @type {any} */ (e).code !== "ESRCH") throw e; }
        await waitForExit([step.pid]);
        return { pid: step.pid };
      });
    } else if (step.id === "stop-capsule") {
      await record("stop-capsule", async () => {
        for (const pid of step.pids) { try { kill(pid, "SIGTERM"); } catch (e) { if (/** @type {any} */ (e).code !== "ESRCH") throw e; } }
        await waitForExit(step.pids);
        return { pids: step.pids };
      });
    } else if (step.id === "copy-state") {
      await record("copy-state", () => {
        const targets = stateFiles(newHome);
        f.mkdirSync(path.dirname(targets.clips), { recursive: true });
        f.mkdirSync(path.dirname(targets.config), { recursive: true });
        const copied = [], kept = [];
        for (const { key, from } of step.files) {
          const to = targets[key];
          if (f.existsSync(to)) { kept.push(key); continue; } // never clobber state the new node already has
          f.mkdirSync(path.dirname(to), { recursive: true });
          f.copyFileSync(from, to);
          copied.push(key);
        }
        return { copied, kept };
      });
    } else if (step.id === "write-old-key-marker") {
      await record("write-old-key-marker", () => {
        const file = markerFile(newHome);
        f.mkdirSync(path.dirname(file), { recursive: true });
        f.writeFileSync(file, JSON.stringify({ oldKeyId: step.oldKeyId, oldPublicKey: step.oldPublicKey, at: now() }) + "\n");
        removedKeyId = step.oldKeyId;
        return { file, oldKeyId: step.oldKeyId };
      });
    } else if (step.id === "rename-old-home") {
      await record("rename-old-home", () => {
        const to = oldHome + "-0.1.1";
        if (f.existsSync(to)) throw new Error(`${to} already exists; not overwriting a previous backup`);
        f.renameSync(oldHome, to);
        return { to };
      });
    } else if (step.id === "remove-old-app") {
      await record("remove-old-app", () => {
        // If the home was just renamed, the app now lives under the backup folder; either way,
        // only the app bundle is removed, never the rest of the (kept) backup folder.
        const renamed = capsuleFiles(oldHome + "-0.1.1").app;
        const live = capsuleFiles(oldHome).app;
        const target = f.existsSync(renamed) ? renamed : live;
        if (f.existsSync(target)) f.rmSync(target, { recursive: true, force: true });
        return { removed: target };
      });
    } else if (step.id === "npm-uninstall-global") {
      await record("npm-uninstall-global", () => {
        const r = spawn("npm", ["uninstall", "-g", NPM_PACKAGE], { encoding: "utf8" });
        if (r.status !== 0) throw new Error(`npm uninstall -g ${NPM_PACKAGE} exited ${r.status}: ${String(r.stderr || "").trim().slice(0, 300)}`);
        return { path: step.path };
      });
    } else {
      await record(step.id, () => { throw new Error(`migrate: unknown step "${step.id}"`); });
    }
  }

  return { ok, steps: done, removedKeyId };
}

/** Poll (briefly) for pids to disappear; a SIGTERM is not instant. Real timing, fakes skip it. @param {number[]} pids */
async function defaultWaitForExit(pids) {
  for (let i = 0; i < 20; i++) {
    if (!pids.some(pid => pidLooksLikeVyre(pid))) return;
    await new Promise(r => setTimeout(r, 100));
  }
}

// ---------------------------------------------------------------- summary and the one-call entry

/** One line for the installer to show. @param {ReturnType<typeof apply>} result @param {ReturnType<typeof plan>} p */
export function summarize(result, p) {
  if (!p.steps.length) return "0.1.1: nothing to migrate.";
  const failed = result.steps.find(s => !s.ok && !s.skipped);
  if (failed) return `0.1.1 migration stopped at "${failed.id}": ${failed.error || "failed"}.`;
  const did = result.steps.filter(s => s.ok).map(s => s.id);
  const parts = [];
  if (did.includes("stop-vyred") || did.includes("stop-capsule")) parts.push("stopped the old Capsule and vyred");
  const copy = result.steps.find(s => s.id === "copy-state");
  if (copy && copy.detail && copy.detail.copied.length) parts.push(`carried over ${copy.detail.copied.join(", ")}`);
  if (did.includes("rename-old-home")) parts.push("kept the old home as ~/.vyre-0.1.1");
  if (did.includes("remove-old-app") || did.includes("npm-uninstall-global")) parts.push("removed the old app and the npm-installed vyre");
  return parts.length ? `0.1.1 migrated: ${parts.join("; ")}.` : "0.1.1: nothing to migrate.";
}

/**
 * detect -> plan -> apply -> summarize, for the CLI (and anyone else) to call in one step.
 * @param {{oldHome: string, newHome: string} & Parameters<typeof detect>[0] & Partial<Parameters<typeof apply>[1]>} o
 */
export async function run(o) {
  const report = detect(o);
  const p = plan(report);
  const result = await apply(p, { oldHome: o.oldHome, newHome: o.newHome, fs: o.fs, kill: o.kill, spawnSync: o.spawnSync, now: o.now, waitForExit: o.waitForExit });
  return { report, plan: p, result, summary: summarize(result, p) };
}
