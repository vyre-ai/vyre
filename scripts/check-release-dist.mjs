#!/usr/bin/env node
// check-release-dist: what a release folder must be, for the updater that will read it. The release job runs this on dist/ before it signs
// or publishes anything; the rehearsal runs it on a dry run's artifact.
//   node scripts/check-release-dist.mjs <dist-dir> [--pulled] [--installer] [--mac] [--setup] [--pubkey <spki-base64>]
//   --modules   modules.json (scripts/modules-manifest.mjs) must be in the release, listed in SHA256SUMS, { v: 1, counter, release, modules } with the counter scripts/release-counter.mjs makes from VERSION
//   --setup     setup.json (scripts/setup-hashes.mjs) must be in the release, listed in SHA256SUMS and { v: 1, files: [...] }: what scripts/check-served.mjs checks vyre.run against
//   --installer the Windows installer (Vyre_<version>_x64-setup.exe and VyreSetup.exe) must be in the release
//   --android   the Android app (Vyre-android.apk and Vyre_<version>_android.apk) must be in the release
//   --mac       the Lumen Mac app (Vyre-Lumen-aarch64.dmg and Vyre-Lumen-x86_64.dmg, stable names) must be in the release
//   --pulled   the release carries images: release.json names them by digest and compose.yml pins them (required for a release that boxes pull)
//   --pubkey   SHA256SUMS.sig must be a valid Ed25519 signature by this key over "vyre-release-sums\n" + SHA256SUMS (the format every updater reads)
// Exit 0 when everything holds; otherwise every problem is printed, one per line, and the exit is 1.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { SEAMS } from "./strip-wrapper.mjs";
import { releaseCounter } from "./release-counter.mjs";

const DIGEST_REF = /^ghcr\.io\/vyre-ai\/[a-z-]+@sha256:[0-9a-f]{64}$/;
const EXACT_IMAGE = /^[ \t]*image: [A-Za-z0-9._/-]+(:[A-Za-z0-9._-]+)?@sha256:[0-9a-f]{64}$/;
const REQUIRED = ["install-box.sh", "install-mac-server.sh", "compose.yml", "compose.build.yml", "vyre.env.example", "vyre", "Dockerfile", "dockerignore", "vyre.tgz", "VERSION", "release.json", "SHA256SUMS"];

/** @param {string} dir @param {{ pulled?: boolean, pubkey?: string }} [o] @returns {string[]} the problems */
export function check(dir, { pulled = false, pubkey = "", installer = false, android = false, mac = false, setup = false, modules = false } = {}) {
  const problems = [];
  const read = f => { try { return fs.readFileSync(path.join(dir, f)); } catch { return null; } };
  for (const f of REQUIRED) if (read(f) === null) problems.push(`missing ${f}`);
  if (problems.length) return problems;

  // SHA256SUMS lists every file, and every hash is right.
  const sums = read("SHA256SUMS").toString("utf8");
  const listed = new Map();
  for (const line of sums.split("\n").filter(Boolean)) {
    const m = /^([0-9a-f]{64}) [ *](\S+)$/.exec(line);
    if (!m) { problems.push(`SHA256SUMS has a line that is not "<sha256>  <file>": ${line.slice(0, 80)}`); continue; }
    listed.set(m[2], m[1]);
  }
  const files = fs.readdirSync(dir).filter(f => fs.statSync(path.join(dir, f)).isFile() && !/^SHA256SUMS(\.|$)/.test(f) && f !== "notes.md");
  for (const f of files) {
    if (!listed.has(f)) problems.push(`SHA256SUMS does not list ${f}`);
    else if (crypto.createHash("sha256").update(read(f)).digest("hex") !== listed.get(f)) problems.push(`SHA256SUMS has the wrong hash for ${f}`);
  }
  for (const f of listed.keys()) if (!files.includes(f)) problems.push(`SHA256SUMS lists ${f}, which is not in the release`);

  // The Windows installer, both names (the updater looks for the versioned one, install-windows.ps1 fetches VyreSetup.exe), listed in SHA256SUMS.
  if (installer) {
    const v = read("VERSION").toString("utf8").trim();
    for (const f of [`Vyre_${v}_x64-setup.exe`, "VyreSetup.exe"]) if (!listed.has(f)) problems.push(`the Windows installer ${f} is not in the release`);
  }

  // The Android app, both names, listed in SHA256SUMS (sideloaded: no store carries it yet).
  if (android) {
    const v = read("VERSION").toString("utf8").trim();
    for (const f of [`Vyre_${v}_android.apk`, "Vyre-android.apk"]) if (!listed.has(f)) problems.push(`the Android app ${f} is not in the release`);
  }

  // The Lumen Mac app: the stable names the site's picker links to, one per architecture, listed in SHA256SUMS.
  if (mac) {
    for (const f of ["Vyre-Lumen-aarch64.dmg", "Vyre-Lumen-x86_64.dmg"]) if (!listed.has(f)) problems.push(`the Mac app ${f} is not in the release`);
  }

  // appbuild.json: the signed list of the web app's files (lib/app-build.js), listed in SHA256SUMS, naming this version, every hash a sha256 and index.html on it.
  if (modules) {
    const raw = read("appbuild.json");
    if (raw === null || !listed.has("appbuild.json")) problems.push("appbuild.json is not in the release");
    else {
      try {
        const j = JSON.parse(raw.toString("utf8"));
        const v = read("VERSION").toString("utf8").trim();
        if (!j || j.v !== 1 || !j.files || typeof j.files !== "object" || !j.files["index.html"]) problems.push("appbuild.json is not { v: 1, release, files: {...} } with index.html");
        else {
          if (j.release !== v || j.version !== v) problems.push(`appbuild.json says release ${j.release}, VERSION says ${v}`);
          if (j.counter !== releaseCounter(v)) problems.push(`appbuild.json counter is ${j.counter}, this version makes ${releaseCounter(v)}`);
          if (!/^[0-9a-f]{64}$/.test(String(j.tree))) problems.push("appbuild.json has no tree hash");
          for (const [f, h] of Object.entries(j.files)) if (!/^[0-9a-f]{64}$/.test(String(h)) || f.startsWith("/") || f.split("/").includes("..")) problems.push(`appbuild.json has a bad entry for ${f}`);
        }
      } catch (e) { problems.push(`appbuild.json cannot be read: ${/** @type {Error} */ (e).message}`); }
    }
  }

  // modules.json: the signed list of first-party modules, listed in SHA256SUMS (so the release key signs it), at the counter this version makes.
  if (modules) {
    const raw = read("modules.json");
    if (raw === null || !listed.has("modules.json")) problems.push("modules.json is not in the release");
    else {
      try {
        const j = JSON.parse(raw.toString("utf8"));
        const v = read("VERSION").toString("utf8").trim();
        if (!j || j.v !== 1 || !j.modules || typeof j.modules !== "object" || !Object.keys(j.modules).length) problems.push("modules.json is not { v: 1, counter, release, modules: {...} } with modules");
        else {
          if (j.release !== v) problems.push(`modules.json says release ${j.release}, VERSION says ${v}`);
          if (j.counter !== releaseCounter(v)) problems.push(`modules.json counter is ${j.counter}, this version makes ${releaseCounter(v)}`);
        }
      } catch (e) { problems.push(`modules.json cannot be read: ${/** @type {Error} */ (e).message}`); }
    }
    // shell.json carries the module list (and the app record) as exact text, for an old updater that knows only shell.json (lib/release-shell.js): it must be listed, and its text must be the files' bytes.
    const shellRaw = read("shell.json");
    if (shellRaw === null || !listed.has("shell.json")) problems.push("shell.json is not in the release (a 0.2.x server updated to it would receive no module list)");
    else {
      try {
        const sj = JSON.parse(shellRaw.toString("utf8"));
        if (raw !== null && sj.modulesJson !== raw.toString("utf8")) problems.push("shell.json does not carry modules.json as exact text");
        const ab = read("appbuild.json");
        if (ab !== null && sj.appbuildJson !== ab.toString("utf8")) problems.push("shell.json does not carry appbuild.json as exact text");
      } catch { problems.push("shell.json is not JSON"); }
    }
  }

  // setup.json: the hashes of what vyre.run serves for the setup page and the install line, signed by being listed in SHA256SUMS.
  if (setup) {
    const raw = read("setup.json");
    if (raw === null || !listed.has("setup.json")) problems.push("setup.json is not in the release");
    else {
      try { const j = JSON.parse(raw.toString("utf8")); if (!j || j.v !== 1 || !Array.isArray(j.files) || !j.files.length) problems.push("setup.json is not { v: 1, files: [...] } with files"); }
      catch { problems.push("setup.json is not JSON"); }
    }
  }

  // release.json and VERSION agree; the images are named by digest.
  let rj = null;
  try { rj = JSON.parse(read("release.json").toString("utf8")); } catch { problems.push("release.json is not JSON"); }
  const version = read("VERSION").toString("utf8").trim();
  if (rj && rj.version !== version) problems.push(`release.json says ${rj.version}, VERSION says ${version}`);
  const box = rj?.images?.box?.ref, computer = rj?.images?.computer?.ref;
  if (pulled) {
    if (!box || !DIGEST_REF.test(box)) problems.push("release.json names no ghcr.io/vyre-ai digest for the box image (images.box.ref)");
    if (!computer || !DIGEST_REF.test(computer)) problems.push("release.json names no ghcr.io/vyre-ai digest for the computers image (images.computer.ref)");
  }

  // compose.yml: every image line is exactly `image: <name>@sha256:<64 hex>`; the box ref is one of them; the computers ref is the default of
  // VYRE_COMPUTERS_IMAGE on a line that is not a comment. Without images (a release that boxes only build) nothing is pinned and nothing is required.
  const compose = read("compose.yml").toString("utf8");
  if (pulled) {
    const imageLines = compose.split("\n").filter(l => /^[ \t]*image:/.test(l));
    for (const l of imageLines) if (!EXACT_IMAGE.test(l)) problems.push(`compose.yml has an image line that is not pinned exactly by digest: ${l.trim()}`);
    if (box && !imageLines.some(l => l.replace(/^[ \t]*image:[ \t]*/, "") === box)) problems.push(`compose.yml has no image line that is exactly ${box}`);
    // Every VYRE_COMPUTERS_IMAGE default in the file (there may be several services that read it) is the signed computers ref, and there is at least one.
    const defaults = [...compose.replace(/^[ \t]*#.*$/gm, "").matchAll(/VYRE_COMPUTERS_IMAGE:-([^}\s]*)\}/g)].map(m => m[1]);
    if (computer && (defaults.length === 0 || defaults.some(d => d !== computer))) problems.push(`every default of VYRE_COMPUTERS_IMAGE in compose.yml must be ${computer} (found: ${defaults.join(", ") || "none"})`);
    if (/:latest\b/.test(compose.replace(/^[ \t]*#.*$/gm, ""))) problems.push("compose.yml still names a :latest tag");
  }

  // The wrapper is the release build: parses, names no test override.
  const wrapper = read("vyre").toString("utf8");
  for (const n of SEAMS) if (wrapper.includes(n)) problems.push(`the wrapper still names ${n}: it is not the release build (scripts/strip-wrapper.mjs)`);
  if (!wrapper.includes("# >>> release constants")) problems.push("the wrapper is not the stripped release build (no release constants block)");

  // The signature, in the one format every updater reads.
  if (pubkey) {
    const sig = read("SHA256SUMS.sig");
    if (!sig) problems.push("missing SHA256SUMS.sig");
    else {
      try {
        const key = crypto.createPublicKey({ key: Buffer.from(pubkey, "base64"), format: "der", type: "spki" });
        const ok = crypto.verify(null, Buffer.concat([Buffer.from("vyre-release-sums\n"), read("SHA256SUMS")]), key, Buffer.from(sig.toString("utf8").replace(/\s+/g, ""), "base64"));
        if (!ok) problems.push("SHA256SUMS.sig is not a valid Ed25519 signature by the key over the prefix and SHA256SUMS");
      } catch (e) { problems.push(`SHA256SUMS.sig could not be checked: ${e.message}`); }
    }
  }
  return problems;
}

if (process.argv[1] && process.argv[1].endsWith("check-release-dist.mjs")) {
  const args = process.argv.slice(2);
  const dir = args.find(a => !a.startsWith("--") && args[args.indexOf(a) - 1] !== "--pubkey");
  if (!dir) { console.error("usage: node scripts/check-release-dist.mjs <dist-dir> [--pulled] [--pubkey <spki-base64>]"); process.exit(2); }
  const pubkey = args.includes("--pubkey") ? args[args.indexOf("--pubkey") + 1] : "";
  const problems = check(dir, { pulled: args.includes("--pulled"), installer: args.includes("--installer"), android: args.includes("--android"), mac: args.includes("--mac"), setup: args.includes("--setup"), modules: args.includes("--modules"), pubkey });
  for (const p of problems) console.error(`release-dist: ${p}`);
  if (problems.length) process.exit(1);
  console.log(`release-dist: ${dir} is what the updater needs`);
}
