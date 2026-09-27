// @ts-check
// `vyre capsule`: open the Capsule on this Mac, or build it.
//
//   vyre capsule            open it (starting vyred and the app when they are not running). The
//                           Capsule is the native app (local/capsule/native, Swift, ADR 0017),
//                           built here on first run and again when its source changes
//                           (capsule-native.js). --hidden starts it in the menu bar only.
//   vyre capsule install    build it on this Mac now, without opening it. Nothing is downloaded:
//                           the app is built here, from this package. `vyre capsule build` is
//                           the same command.

import path from "node:path";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import * as config from "../../config/index.js";
import { dialogsAllowed } from "../../config/dialogs.js";
import { REPO } from "../../daemon/index.js";
import { ensureUp } from "../daemonctl.js";
import { out, dim, signal, beacon } from "../style.js";
import * as native from "./capsule-native.js";
import { usage } from "../kit.js";

export const CAPSULE = path.join(REPO, "local", "capsule");
export const NATIVE = path.join(CAPSULE, "native");

/** Whether the Capsule can run here: a Mac, and the native app's source to build it from. */
export function nativeAvailable({ platform = process.platform, dir = NATIVE } = {}) {
  return platform === "darwin" && fs.existsSync(path.join(dir, "build.sh"));
}

async function open(flags) {
  if (process.platform !== "darwin") { out("  The Capsule runs on macOS. On this machine, use vyre or the Deck."); return 1; }
  if (!dialogsAllowed()) { out("  The Capsule does not open under tests (VYRE_TEST_DIALOGS=1 to allow it)."); return 1; }
  if (!nativeAvailable()) { out(beacon("  The Capsule's source is missing from this package") + dim(` · ${path.relative(process.cwd(), NATIVE) || NATIVE}`)); return 1; }
  const up = await ensureUp();
  if (!up.ok) out(dim("  vyred did not start; the Capsule will open and say it is offline."));
  return openNative(flags);
}

/**
 * `vyre capsule install`: the local build, and nothing downloaded. It was a zip from vyre.run;
 * now the app is built here with swiftc (capsule-native.js), so install means build now.
 */
async function installNative() {
  if (process.platform !== "darwin") { out("  The Capsule runs on macOS. On this machine, use vyre or the Deck."); return 1; }
  out(dim("  vyre capsule install builds the Capsule on this Mac; nothing is downloaded."));
  const home = config.paths().root;
  const said = await native.offerIdentity({ home, ask: askYesNo });
  if (said) out(dim("  " + said));
  const b = native.ensureBuilt({ dir: NATIVE, home, say: s => out(dim("  " + s)) });
  if (!b.ok) { out(beacon("  " + b.message)); return 1; }
  out(`  Capsule ${signal(b.built ? "built" : "up to date")} ${dim("· " + b.app + " · vyre capsule opens it")}`);
  return 0;
}

/** The native Capsule: build it if it is missing or stale, then launch it (or show it). */
async function openNative(flags) {
  const home = config.paths().root;
  const said = await native.offerIdentity({ home, ask: askYesNo });
  if (said) out(dim("  " + said));
  const b = native.ensureBuilt({ dir: NATIVE, home, say: s => out(dim("  " + s)) });
  if (!b.ok) { out(beacon("  " + b.message)); return 1; }
  if (b.built) out(dim(`  ${b.message}`));
  const env = { VYRE_SOCKET: config.paths().socket, VYRE_HOME: home, ...(flags.hidden ? {} : { VYRE_CAPSULE_OPEN: "1" }) };
  const r = spawnSync("open", native.launchArgs(b.app, env), { encoding: "utf8" });
  if (r.status !== 0) { out(beacon("  The Capsule did not open: ") + dim(String(r.stderr || "").trim())); return 1; }
  out(`  Capsule ${signal("open")} ${dim("· ⌥Space, or Control twice once it is allowed · " + b.app)}`);
  return 0;
}

/** A y/N on this terminal; null when there is none. @param {string} question */
async function askYesNo(question) {
  if (!process.stdin.isTTY) return null;
  const rl = (await import("node:readline/promises")).createInterface({ input: process.stdin, output: process.stdout });
  try { return /^y(es)?$/i.test((await rl.question(`  ${question} [y/N] `)).trim()); }
  finally { rl.close(); }
}

export default {
  name: "capsule", order: 30, usage: "vyre capsule [--hidden] | install", summary: "the Mac command bar: Control twice, anywhere",
  /** @param {string[]} args */
  async run(args) {
    const flags = { hidden: args.includes("--hidden") };
    if (args[0] === "install" || args[0] === "build") return installNative();
    // A mistyped word ("biuld") used to open the Capsule; now it says so.
    if (args[0] && !args[0].startsWith("--")) return usage(`vyre capsule ${args[0]}: not a subcommand`, "vyre capsule or vyre capsule install");
    return open(flags);
  },
};
