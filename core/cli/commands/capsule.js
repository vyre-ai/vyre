// @ts-check
// `vyre capsule`: open Lumen on this Mac, or build it.
//
//   vyre capsule            open it (starting vyred and the app when they are not running). The
//                           Capsule is the native app (local/capsule/native, Swift, ADR 0017),
//                           built here on first run and again when its source changes
//                           (capsule-native.js). --hidden starts it in the menu bar only.
//   vyre capsule install    build it on this Mac now, without opening it. Nothing is downloaded:
//                           the app is built here, from this package. `vyre capsule build` is
//                           the same command.
//
// --json prints { opened, app, built, hidden } for open and { built, app } for install, and a
// refusal as {"error":{code,message,next?}}: not_mac, no_dialogs, no_source, build_failed,
// open_failed. Under --view the one-time signing question is never asked (no terminal to ask on).

import path from "node:path";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import * as config from "../../config/index.js";
import { dialogsAllowed } from "../../config/dialogs.js";
import { REPO } from "../../daemon/index.js";
import { ensureUp } from "../daemonctl.js";
import { out, dim, signal, beacon } from "../style.js";
import * as native from "./capsule-native.js";
import { usage, json, emit, fail, viewing } from "../kit.js";

export const CAPSULE = path.join(REPO, "local", "capsule");
export const NATIVE = path.join(CAPSULE, "native");

/** Whether Lumen can run here: a Mac, and the native app's source to build it from. */
export function nativeAvailable({ platform = process.platform, dir = NATIVE } = {}) {
  return platform === "darwin" && fs.existsSync(path.join(dir, "build.sh"));
}

/** Every verb run() handles, for `vyre commands --json`; run() refuses any other word. */
export const VERBS = [
  { verb: "open", summary: "open Lumen, building it first when its source changed (the default)", usage: "[--hidden] [--json]" },
  { verb: "install", aliases: ["build"], summary: "build Lumen on this Mac now, without opening it; nothing is downloaded", usage: "[--json]" },
];

const NOT_MAC = "Lumen runs on macOS. On this machine, use vyre or the Deck.";

/** A line a person reads; nothing under --json, where stdout holds only the answer. @param {string} line */
const say = line => { if (!json()) out(line); };

/** A refusal: words for a person, the error object under --json. Exit 1. */
const refuse = (/** @type {string} */ code, /** @type {string} */ message, /** @type {string} */ shown = message, /** @type {string} */ next = "") => {
  if (json()) return fail(message, { code, ...(next ? { next } : {}) });
  out(shown);
  return 1;
};

async function open(flags) {
  if (process.platform !== "darwin") return refuse("not_mac", NOT_MAC, "  " + NOT_MAC);
  if (!dialogsAllowed()) return refuse("no_dialogs", "Lumen does not open under tests (VYRE_TEST_DIALOGS=1 to allow it).", "  Lumen does not open under tests (VYRE_TEST_DIALOGS=1 to allow it).");
  if (!nativeAvailable()) return refuse("no_source", "Lumen's source is missing from this package", beacon("  Lumen's source is missing from this package") + dim(` · ${path.relative(process.cwd(), NATIVE) || NATIVE}`));
  const up = await ensureUp();
  if (!up.ok) say(dim("  vyred did not start; Lumen will open and say it is offline."));
  return openNative(flags);
}

/** The signing question, once, on a terminal; never under --view, where no one can answer it. */
const identityOffer = (/** @type {string} */ home) => native.offerIdentity({ home, ask: askYesNo, ...(viewing() || json() ? { tty: false } : {}) });

/**
 * `vyre capsule install`: the local build, and nothing downloaded. It was a zip from vyre.run;
 * now the app is built here with swiftc (capsule-native.js), so install means build now.
 */
async function installNative() {
  if (process.platform !== "darwin") return refuse("not_mac", NOT_MAC, "  " + NOT_MAC);
  say(dim("  vyre capsule install builds Lumen on this Mac; nothing is downloaded."));
  const home = config.paths().root;
  const said = await identityOffer(home);
  if (said) say(dim("  " + said));
  const b = native.ensureBuilt({ dir: NATIVE, home, say: s => say(dim("  " + s)) });
  if (!b.ok) return refuse("build_failed", b.message, beacon("  " + b.message));
  if (json()) return emit({ built: Boolean(b.built), app: b.app });
  out(`  Lumen ${signal(b.built ? "built" : "up to date")} ${dim("· " + b.app + " · vyre capsule opens it")}`);
  return 0;
}

/** The native Capsule: build it if it is missing or stale, then launch it (or show it). */
async function openNative(flags) {
  const home = config.paths().root;
  const said = await identityOffer(home);
  if (said) say(dim("  " + said));
  const b = native.ensureBuilt({ dir: NATIVE, home, say: s => say(dim("  " + s)) });
  if (!b.ok) return refuse("build_failed", b.message, beacon("  " + b.message));
  if (b.built) say(dim(`  ${b.message}`));
  const env = { VYRE_SOCKET: config.paths().socket, VYRE_HOME: home, ...(flags.hidden ? {} : { VYRE_CAPSULE_OPEN: "1" }) };
  const r = spawnSync("open", native.launchArgs(b.app, env), { encoding: "utf8" });
  if (r.status !== 0) return refuse("open_failed", `Lumen did not open: ${String(r.stderr || "").trim()}`, beacon("  Lumen did not open: ") + dim(String(r.stderr || "").trim()));
  if (json()) return emit({ opened: true, app: b.app, built: Boolean(b.built), hidden: Boolean(flags.hidden) });
  out(`  Lumen ${signal("open")} ${dim("· ⌥Space, or Control twice once it is allowed · " + b.app)}`);
  return 0;
}

/** A y/N on this terminal; null when there is none. @param {string} question */
async function askYesNo(question) {
  if (!process.stdin.isTTY || viewing()) return null;
  const rl = (await import("node:readline/promises")).createInterface({ input: process.stdin, output: process.stdout });
  try { return /^y(es)?$/i.test((await rl.question(`  ${question} [y/N] `)).trim()); }
  finally { rl.close(); }
}

export default {
  name: "capsule", order: 30, usage: "vyre capsule [open [--hidden] | install | build] [--json]", summary: "the Mac command bar: Control twice, anywhere",
  verbs: VERBS,
  /** @param {string[]} args */
  async run(args) {
    const flags = { hidden: args.includes("--hidden") };
    const verb = args.find(a => !a.startsWith("--"));
    if (verb === "install" || verb === "build") return installNative();
    // A mistyped word ("biuld") used to open Lumen; now it says so.
    if (verb && verb !== "open") return usage(`vyre capsule ${verb}: not a subcommand`, "vyre capsule, vyre capsule open or vyre capsule install");
    return open(flags);
  },
};
