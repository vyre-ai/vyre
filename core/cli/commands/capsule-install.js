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
import { REPO } from "../../daemon/index.js";

export const ZIP = "Vyre-mac.zip";
const DEFAULT_BASE = "https://vyre.run/box";
/**
 * The zip's hash for this version, shipped inside the npm package by the release workstream.
 * SHA256SUMS comes from the same server as the zip, so on its own it only catches a broken
 * download; this pin comes from npm, so a swapped zip on the server does not match it.
 */
export const PIN = path.join(REPO, "box", "Vyre-mac.sha256");
// TODO(release): once Vyre.app is signed and notarized, also check codesign and spctl here.
// The v0.1 zip is unsigned by design.

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

/** The pinned hash from the package, null when there is none, or an Error when it is unreadable. */
export function readPin(file = PIN) {
  let text;
  try { text = fs.readFileSync(file, "utf8"); } catch (e) { return /** @type {any} */ (e).code === "ENOENT" ? null : /** @type {Error} */ (e); }
  const m = /^\s*([0-9a-f]{64})\b/i.exec(text);
  return m ? m[1].toLowerCase() : new Error(`${file} does not hold a sha256`);
}

/**
 * A zip entry outside Vyre.app, or null when every entry is inside it. Checked before unpacking,
 * so a crafted path never reaches the disk.
 * @param {string[]} names
 */
export function stray(names) {
  return names.find(n => !(n === "Vyre.app" || n === "Vyre.app/" || n.startsWith("Vyre.app/")) || n.split("/").includes("..")) ?? null;
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
 * @param {{ platform?: string, env?: NodeJS.ProcessEnv, pin?: string, io?: { tty: boolean, ask(q: string): Promise<string> } }} [deps]
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
    const pin = readPin(deps.pin);
    if (pin instanceof Error) { out(beacon("  ") + pin.message + ". Nothing was installed."); return 1; }
    const published = expected(sums);
    // With a pin, SHA256SUMS is a cross-check; without one, it is all there is.
    if (!pin && !published) { out(beacon(`  SHA256SUMS has no line for ${ZIP}, so the download cannot be checked. Nothing was installed.`)); return 1; }
    if (pin && published && pin !== published) { out(beacon(`  SHA256SUMS on ${base} disagrees with the hash this package was released with. Nothing was installed.`)); return 1; }
    const want = pin || published;
    const zip = path.join(work, ZIP);
    let got;
    try { got = await fetchTo(`${base}/${ZIP}`, zip); }
    catch (e) { out(beacon("  download failed: ") + /** @type {Error} */ (e).message); return 1; }
    if (got !== want) {
      out(beacon(`  ${ZIP} does not match ${pin ? "the hash this package was released with" : "SHA256SUMS"}. Nothing was installed.`));
      out(dim(`  expected ${want}\n  got      ${got}`));
      return 1;
    }
    out(dim(pin ? "  checked against the hash in this npm package" : "  checked against vyre.run's SHA256SUMS; the app is not signed yet"));
    let names;
    try { names = execFileSync("/usr/bin/zipinfo", ["-1", zip], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).split("\n").filter(Boolean); }
    catch (e) { out(beacon("  could not read the zip: ") + String(/** @type {any} */ (e).stderr || /** @type {Error} */ (e).message).trim()); return 1; }
    const odd = stray(names);
    if (odd !== null) { out(beacon(`  ${ZIP} holds ${odd}, outside Vyre.app. Nothing was installed.`)); return 1; }
    const unpacked = path.join(work, "x");
    fs.mkdirSync(unpacked);
    try { execFileSync("/usr/bin/ditto", ["-x", "-k", zip, unpacked], { stdio: "pipe" }); }
    catch (e) { out(beacon("  could not unpack the zip: ") + String(/** @type {any} */ (e).stderr || /** @type {Error} */ (e).message).trim()); return 1; }
    // Checked again on disk: exactly one thing, Vyre.app, and a real folder, not a link to elsewhere.
    const app = path.join(unpacked, "Vyre.app");
    const top = fs.readdirSync(unpacked);
    let st = null;
    try { st = fs.lstatSync(app); } catch {}
    if (top.length !== 1 || !st || st.isSymbolicLink() || !st.isDirectory()) {
      out(beacon(`  ${ZIP} ${st && st.isSymbolicLink() ? "holds Vyre.app as a link, not the app" : "does not hold exactly one Vyre.app"}. Nothing was installed.`));
      return 1;
    }

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
