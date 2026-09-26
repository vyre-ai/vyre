// @ts-check
// `vyre capsule`: open the Capsule on this Mac, or build it.
//
//   vyre capsule            open it (starting vyred and the app when they are not running)
//   vyre capsule --dev      run it from source in this terminal, with its log here; ctrl-C quits
//   vyre capsule build      build the Swift helpers; --app also packages Vyre.app
//   vyre capsule install    download the packaged app into ~/Applications (capsule-install.js)
//
// The trap this command exists to close: a packaged Electron app runs app.asar, so an edit to
// the source does nothing until the app is packaged again, and nothing says so. The prototype
// lost an afternoon to it, and twelve days to a packaged build that was older than its source.
// So a package records a hash of the source it was made from, and `vyre capsule` runs the
// package only when that hash still matches. Otherwise it runs the source and says why.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import * as config from "../../config/index.js";
import { REPO } from "../../daemon/index.js";
import { ensureUp } from "../daemonctl.js";
import { out, dim, signal, beacon } from "../style.js";
import { usage } from "../kit.js";

export const CAPSULE = path.join(REPO, "local", "capsule");
const DIST = path.join(CAPSULE, "dist");
const APP = path.join(DIST, "Vyre-darwin-" + process.arch, "Vyre.app");
/** Where a downloaded Vyre.app is put. It carries its own helpers and has no source to compare. */
export const INSTALLED = ["/Applications/Vyre.app", path.join(process.env.HOME || "", "Applications", "Vyre.app")];

/** The Electron binary installed for the Capsule, or null. Never the root package's. */
export function electron(dir = CAPSULE) {
  try { return String(createRequire(path.join(dir, "package.json"))("electron")); } catch { return null; }
}

/** A hash of everything that goes into the app, so a package can say what source it was made from. */
export function sourceHash(dir = CAPSULE) {
  const h = crypto.createHash("sha256");
  const walk = d => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (!e.name.endsWith(".test.js")) { h.update(path.relative(dir, p)); h.update(fs.readFileSync(p)); }
    }
  };
  for (const sub of ["app", "lib"]) if (fs.existsSync(path.join(dir, sub))) walk(path.join(dir, sub));
  h.update(fs.readFileSync(path.join(dir, "package.json")));
  return h.digest("hex").slice(0, 16);
}

/** Is there a package, and was it made from the source as it is now? */
export function packaged(dir = CAPSULE, app = APP) {
  const bin = path.join(app, "Contents", "MacOS", "Vyre");
  if (!fs.existsSync(bin)) return { bin: null, fresh: false };
  let stamp = null;
  try { stamp = JSON.parse(fs.readFileSync(path.join(path.dirname(app), "stamp.json"), "utf8")).source; } catch {}
  return { bin, fresh: stamp === sourceHash(dir) };
}

/** An installed Vyre.app, or null. */
export function installed(list = INSTALLED) {
  for (const app of list) { const bin = path.join(app, "Contents", "MacOS", "Vyre"); if (fs.existsSync(bin)) return bin; }
  return null;
}

/**
 * What the app is told: where vyred is, and, for the source or a dist build, where its helpers
 * are. An installed app uses the helpers in its own Resources, which is what macOS granted.
 */
function env({ own = false } = {}) {
  const e = { ...process.env, VYRE_SOCKET: config.paths().socket };
  if (!own) e.VYRE_CAPSULE_BIN = path.join(CAPSULE, "bin");
  return e;
}

function helpersBuilt() { return fs.existsSync(path.join(CAPSULE, "bin", "hotkey")); }

async function open(flags) {
  if (process.platform !== "darwin") { out("  The Capsule runs on macOS. On this machine, use vyre or the Deck."); return 1; }
  const up = await ensureUp();
  if (!up.ok) out(dim("  vyred did not start; the Capsule will open and say it is offline."));
  const e = electron();
  if (!helpersBuilt()) out(dim("  The double-Control helper is not built yet: vyre capsule build"));
  const args = [...(flags.hidden ? ["--hidden"] : [])];

  if (flags.dev) {
    if (!e) return missingElectron();
    out(`  Capsule ${signal("from source")} ${dim("· " + path.relative(process.cwd(), CAPSULE) + " · ctrl-C quits")}`);
    const child = spawn(e, [CAPSULE, ...args], { stdio: "inherit", env: { ...env(), VYRE_CAPSULE_LOG: "1" } });
    const quit = () => { try { child.kill("SIGTERM"); } catch {} };
    process.on("SIGINT", quit); process.on("SIGTERM", quit);
    return await new Promise(r => child.on("exit", code => r(code ?? 0)));
  }

  const pkg = packaged();
  const inst = installed();
  let bin = null, argv = args, own = false;
  if (pkg.bin && pkg.fresh) bin = pkg.bin;
  // No dist build of this source: a Vyre.app the user installed (the download) is the Capsule.
  else if (inst && !(pkg.bin && e)) { bin = inst; own = true; }
  else if (e) {
    if (pkg.bin) out(dim("  The packaged app is older than its source, so this runs the source. vyre capsule build --app repackages it."));
    bin = e; argv = [CAPSULE, ...args];
  } else if (pkg.bin) {
    out(beacon("  The packaged app is older than its source") + dim(", and Electron is not installed to run the source. Running the package."));
    bin = pkg.bin;
  }
  if (!bin) return missingElectron();
  const log = path.join(config.paths().logs, "capsule.out");
  const fd = fs.openSync(log, "a");
  // Detached: the Capsule lives in the menu bar and outlasts this terminal. If one is already
  // running, this second launch tells it to show itself and exits.
  const child = spawn(bin, argv, { detached: true, stdio: ["ignore", fd, fd], env: env({ own }) });
  child.unref();
  out(`  Capsule ${signal("open")} ${dim("· press Control twice anywhere · log " + log)}`);
  return 0;
}

function missingElectron() {
  out(`  Electron is not installed for the Capsule. ${dim("vyre capsule build")} installs it into local/capsule.`);
  return 1;
}

async function build(flags) {
  if (process.platform !== "darwin") { out("  The Capsule builds on macOS only."); return 1; }
  if (!electron()) {
    out(dim("  installing the Capsule's Electron (a devDependency of local/capsule only)"));
    const r = spawnSync("npm", ["install", "--no-audit", "--no-fund"], { cwd: CAPSULE, stdio: "inherit" });
    if (r.status !== 0) return 1;
  }
  const r = spawnSync("sh", [path.join(CAPSULE, "build.sh")], { stdio: "inherit" });
  if (r.status !== 0) return r.status || 1;
  if (!flags.app) { out(dim("  helpers built. vyre capsule build --app also packages Vyre.app")); return 0; }
  let packager;
  try { packager = (await import(pathToFileURL(createRequire(path.join(CAPSULE, "package.json")).resolve("@electron/packager")).href)).packager; }
  catch { out("  @electron/packager is not installed in local/capsule (npm install there)."); return 1; }
  const source = sourceHash();
  const [made] = await packager({
    dir: CAPSULE, name: "Vyre", out: DIST, overwrite: true, platform: "darwin", arch: process.arch, appBundleId: "run.vyre.capsule",
    // Only what the app runs. The helpers ride along as resources, outside app.asar, because an
    // executable cannot be run from inside an archive.
    ignore: [/^\/(dist|swift|bin)(\/|$)/, /\.test\.js$/, /^\/build\.sh$/, /^\/module\.json$/, /^\/index\.js$/],
    extraResource: [path.join(CAPSULE, "bin")],
    asar: true, prune: true, quiet: true,
    // Contacts: the helper's ask is credited to this app, and macOS refuses it without a reason.
    extendInfo: { LSUIElement: true, NSContactsUsageDescription: "Vyre's Capsule shows matching contacts as you type. They stay on this Mac." },
  });
  const app = path.join(made, "Vyre.app");
  const signed = sign(app);
  if (!signed.ok) { out(beacon("  Vyre.app did not sign") + dim(" · " + signed.message)); return 1; }
  fs.writeFileSync(path.join(made, "stamp.json"), JSON.stringify({ source, at: new Date().toISOString() }) + "\n");
  out(`  packaged ${app} ${dim("· source " + source + " · signed ad hoc, verified")}`);
  return 0;
}

// ------------------------------------------------------------------ signing

/** The helpers in Contents/Resources/bin, and the identity each keeps once inside the app. */
export const HELPERS = { hotkey: "run.vyre.hotkey", "vyre-launcher": "run.vyre.launcher", local: "run.vyre.local" };

/**
 * The codesign runs that make a packaged Vyre.app whole, inside out. After packager the app
 * carries only Electron's linker signature, which seals no resources, so `codesign --verify
 * --deep --strict` fails and a quarantined download opens as "Vyre is damaged".
 *
 * Each nested bundle in Frameworks is signed with --deep (they are Electron's and carry their own
 * bundle ids). The helpers are signed one by one with their own identifier, never with --deep
 * from above, which would leave them without one. `local` keeps the Info.plist linked into it
 * (its NSContactsUsageDescription): codesign binds an embedded plist and does not replace it.
 * The outer bundle is signed last and without --deep, so it seals what is already signed; its
 * identifier comes from CFBundleIdentifier (run.vyre.capsule).
 *
 * Input Monitoring: the hotkey helper is a child of Vyre.app and does not disclaim
 * responsibility, so macOS (TCC) holds Vyre.app responsible and the grant attaches to Vyre.app,
 * not to the helper. Re-signing the helper does not move it. An ad-hoc signature is a cdhash,
 * though, so a rebuilt Vyre.app is a new identity and macOS may ask again after each build.
 * @param {string} app
 * @returns {string[][]}
 */
export function signing(app) {
  const runs = [];
  const fw = path.join(app, "Contents", "Frameworks");
  if (fs.existsSync(fw)) for (const n of fs.readdirSync(fw).sort()) {
    if (n.endsWith(".framework") || n.endsWith(".app")) runs.push(["--force", "--deep", "--sign", "-", path.join(fw, n)]);
  }
  const bin = path.join(app, "Contents", "Resources", "bin");
  for (const [n, id] of Object.entries(HELPERS)) {
    const p = path.join(bin, n);
    if (fs.existsSync(p)) runs.push(["--force", "--sign", "-", "--identifier", id, p]);
  }
  runs.push(["--force", "--sign", "-", app]);
  return runs;
}

/** Sign the app ad hoc, then prove it: a build whose signature does not verify is a failed build. */
export function sign(app, run = (/** @type {string[]} */ a) => spawnSync("codesign", a, { encoding: "utf8" })) {
  for (const a of signing(app)) {
    const r = run(a);
    if (r.status !== 0) return { ok: false, message: `codesign ${a.slice(0, -1).join(" ")} ${path.basename(a[a.length - 1])}: ${String(r.stderr || "").trim()}` };
  }
  const v = run(["--verify", "--deep", "--strict", app]);
  if (v.status !== 0) return { ok: false, message: "codesign --verify --deep --strict: " + String(v.stderr || "").trim() };
  return { ok: true, message: "signed and verified" };
}

export default {
  name: "capsule", order: 30, usage: "vyre capsule [--dev] | build [--app] | install", summary: "the Mac command bar: Control twice, anywhere",
  /** @param {string[]} args */
  async run(args) {
    const flags = { dev: args.includes("--dev"), hidden: args.includes("--hidden"), app: args.includes("--app") };
    if (args[0] === "build") return build(flags);
    if (args[0] === "install") return (await import("./capsule-install.js")).install(args.slice(1));
    // A mistyped word ("biuld") used to open the Capsule; now it says so.
    if (args[0] && !args[0].startsWith("--")) return usage(`vyre capsule ${args[0]}: not a subcommand`, "vyre capsule, vyre capsule build [--app] or vyre capsule install");
    return open(flags);
  },
};
