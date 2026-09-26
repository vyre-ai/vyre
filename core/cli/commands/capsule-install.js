// @ts-check
// `vyre capsule install`: put the packaged Capsule on this Mac (ADR 0008 section 6).
//
// Downloads Vyre-mac.zip and SHA256SUMS from the release folder, refuses the zip unless its hash
// matches the line published for it, unpacks it with ditto (which keeps the bundle's symlinks and
// signatures, as unzip may not), and moves Vyre.app into ~/Applications. Never /Applications and
// never sudo: the Capsule is the person's own app, and a second account on the Mac need not share
// it. VYRE_DOWNLOAD_BASE and VYRE_APPS_DIR point tests at a local server and a temp folder.
//
// No default export on purpose: `vyre capsule install` reaches this through capsule.js, so there
// is no separate `vyre capsule-install` command.

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import { execFileSync } from "node:child_process";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { out, dim, signal, beacon } from "../style.js";

export const ZIP = "Vyre-mac.zip";
const DEFAULT_BASE = "https://vyre.run/box";

/** The hash SHA256SUMS publishes for one file, or null. Accepts `hash  name` and `hash *name`. */
export function expected(sums, name = ZIP) {
  for (const line of String(sums).split("\n")) {
    const m = /^([0-9a-f]{64})\s+\*?(\S+)\s*$/i.exec(line.trim());
    if (m && m[2] === name) return m[1].toLowerCase();
  }
  return null;
}

/** Download a URL to a file, hashing it on the way. */
async function fetchTo(url, file) {
  const r = await fetch(url, { signal: AbortSignal.timeout(10 * 60_000) });
  if (!r.ok || !r.body) throw new Error(`${url} answered ${r.status}`);
  const h = crypto.createHash("sha256");
  const hashing = Readable.fromWeb(/** @type {any} */ (r.body));
  hashing.on("data", c => h.update(c));
  await pipeline(hashing, fs.createWriteStream(file, { mode: 0o600 }));
  return h.digest("hex");
}

/** Where Vyre.app landed inside an unpacked zip: at the top, or one folder down. */
function findApp(dir) {
  if (fs.existsSync(path.join(dir, "Vyre.app"))) return path.join(dir, "Vyre.app");
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory() && fs.existsSync(path.join(dir, e.name, "Vyre.app"))) return path.join(dir, e.name, "Vyre.app");
  }
  return null;
}

const terminal = {
  tty: Boolean(process.stdin.isTTY && process.stdout.isTTY),
  async ask(q) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try { return (await rl.question(q)).trim(); } finally { rl.close(); }
  },
};

/**
 * @param {string[]} args
 * @param {{ platform?: string, env?: NodeJS.ProcessEnv, io?: { tty: boolean, ask(q: string): Promise<string> } }} [deps]
 */
export async function install(args, deps = {}) {
  const platform = deps.platform || process.platform, env = deps.env || process.env, io = deps.io || terminal;
  if (platform !== "darwin") { out("  The Capsule is a Mac app. On this machine, use vyre or the Deck."); return 1; }
  const yes = args.includes("--yes") || args.includes("-y");
  const base = String(env.VYRE_DOWNLOAD_BASE || DEFAULT_BASE).replace(/\/$/, "");
  const apps = path.resolve(env.VYRE_APPS_DIR || path.join(os.homedir(), "Applications"));
  // The system folder needs an admin, and that is exactly what this command promises not to ask for.
  if (apps === "/Applications") { out(beacon("  vyre capsule install never writes to /Applications; it uses ~/Applications")); return 1; }
  const target = path.join(apps, "Vyre.app");

  fs.mkdirSync(apps, { recursive: true });
  // The work folder sits next to the destination, so the final move is a rename on one volume.
  const work = fs.mkdtempSync(path.join(apps, ".vyre-install-"));
  try {
    out(dim(`  downloading ${base}/${ZIP}`));
    let sums;
    try {
      const r = await fetch(`${base}/SHA256SUMS`, { signal: AbortSignal.timeout(30_000) });
      if (!r.ok) throw new Error(`answered ${r.status}`);
      sums = await r.text();
    } catch (e) { out(beacon(`  could not read ${base}/SHA256SUMS: `) + /** @type {Error} */ (e).message); return 1; }
    const want = expected(sums);
    if (!want) { out(beacon(`  SHA256SUMS has no line for ${ZIP}, so the download cannot be checked. Nothing was installed.`)); return 1; }
    const zip = path.join(work, ZIP);
    let got;
    try { got = await fetchTo(`${base}/${ZIP}`, zip); }
    catch (e) { out(beacon("  download failed: ") + /** @type {Error} */ (e).message); return 1; }
    if (got !== want) {
      out(beacon(`  ${ZIP} does not match SHA256SUMS. Nothing was installed.`));
      out(dim(`  expected ${want}\n  got      ${got}`));
      return 1;
    }
    const unpacked = path.join(work, "x");
    fs.mkdirSync(unpacked);
    try { execFileSync("/usr/bin/ditto", ["-x", "-k", zip, unpacked], { stdio: "pipe" }); }
    catch (e) { out(beacon("  could not unpack the zip: ") + String(/** @type {any} */ (e).stderr || /** @type {Error} */ (e).message).trim()); return 1; }
    const app = findApp(unpacked);
    if (!app) { out(beacon(`  ${ZIP} holds no Vyre.app. Nothing was installed.`)); return 1; }

    if (fs.existsSync(target)) {
      let replace = yes;
      if (!replace && io.tty) replace = /^y(es)?$/i.test(await io.ask(`  ${target} is already there. Replace it? [y/N] `));
      if (!replace) { out(`  kept the Vyre.app already in ${apps}${io.tty ? "" : dim(" · vyre capsule install --yes replaces it")}`); return 1; }
      // Move the old one aside first, so a failed move leaves one working app, not none.
      const old = path.join(work, "old.app");
      fs.renameSync(target, old);
      try { fs.renameSync(app, target); } catch (e) { fs.renameSync(old, target); throw e; }
    } else fs.renameSync(app, target);

    out(`  installed ${signal(target)}`);
    out(`  open it: ${signal("vyre capsule")} ${dim("(or double-click it in Finder)")}`);
    return 0;
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}
